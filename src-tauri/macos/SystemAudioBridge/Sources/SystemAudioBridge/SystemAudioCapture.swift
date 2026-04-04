import AppKit
import AudioToolbox
import CoreGraphics
import CoreMedia
import Foundation
import ScreenCaptureKit
import SwiftRs

private let captureRegistryLock = NSLock()
private var nextCaptureHandle: Int64 = 1
private var activeCaptures: [Int64: AnyObject] = [:]
private let permissionRequestAttemptedKey = "com.bigecho.system_audio.permission_requested"
private let permissionRequestTccDbMtimeKey = "com.bigecho.system_audio.permission_requested_tcc_db_mtime"
private let confirmedPermissionTccDbMtimeKey = "com.bigecho.system_audio.permission_confirmed_tcc_db_mtime"
private let nativeCaptureSampleRate = 48_000
private let nativeCaptureChannelCount = 2

private func overriddenPermissionCode() -> Int32? {
    guard
        let raw = ProcessInfo.processInfo.environment["BIGECHO_SYSTEM_AUDIO_PERMISSION_CODE"],
        let code = Int32(raw)
    else {
        return nil
    }

    return code
}

private func hasAttemptedPermissionRequest() -> Bool {
    UserDefaults.standard.bool(forKey: permissionRequestAttemptedKey)
}

private func markPermissionRequestAttempted() {
    UserDefaults.standard.set(true, forKey: permissionRequestAttemptedKey)
}

private func currentTccDatabaseMtime() -> TimeInterval? {
    guard
        let homeDirectory = FileManager.default.homeDirectoryForCurrentUser as URL?
    else {
        return nil
    }

    let databaseURL = homeDirectory
        .appendingPathComponent("Library")
        .appendingPathComponent("Application Support")
        .appendingPathComponent("com.apple.TCC")
        .appendingPathComponent("TCC.db")

    guard
        let attributes = try? FileManager.default.attributesOfItem(atPath: databaseURL.path),
        let modifiedAt = attributes[.modificationDate] as? Date
    else {
        return nil
    }

    return modifiedAt.timeIntervalSince1970
}

private func recordPermissionRequestState() {
    markPermissionRequestAttempted()
    if let modifiedAt = currentTccDatabaseMtime() {
        UserDefaults.standard.set(modifiedAt, forKey: permissionRequestTccDbMtimeKey)
    } else {
        UserDefaults.standard.removeObject(forKey: permissionRequestTccDbMtimeKey)
    }
}

private func isDeniedStateStillCurrent() -> Bool {
    guard hasAttemptedPermissionRequest() else {
        return false
    }

    guard let currentMtime = currentTccDatabaseMtime() else {
        return true
    }

    let recordedMtime = UserDefaults.standard.object(forKey: permissionRequestTccDbMtimeKey) as? Double
    return recordedMtime == nil || currentMtime == recordedMtime
}

private func hasConfirmedPermissionState() -> Bool {
    guard let recordedMtime = UserDefaults.standard.object(forKey: confirmedPermissionTccDbMtimeKey) as? Double else {
        return false
    }

    guard let currentMtime = currentTccDatabaseMtime() else {
        return true
    }

    return currentMtime == recordedMtime
}

private func recordConfirmedPermissionState() {
    if let modifiedAt = currentTccDatabaseMtime() {
        UserDefaults.standard.set(modifiedAt, forKey: confirmedPermissionTccDbMtimeKey)
    } else {
        UserDefaults.standard.removeObject(forKey: confirmedPermissionTccDbMtimeKey)
    }
}

private func openSystemAudioPrivacySettings() -> Bool {
    let candidates = [
        "x-apple.systempreferences:com.apple.preference.security?Privacy_AudioCapture",
        "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
        "x-apple.systempreferences:com.apple.preference.security?Privacy",
    ]

    for candidate in candidates {
        guard let url = URL(string: candidate) else {
            continue
        }

        if NSWorkspace.shared.open(url) {
            return true
        }
    }

    return false
}

private func logSystemAudioError(_ message: String, error: Error? = nil) {
    if let error {
        NSLog("[BigEcho:SystemAudio] %@: %@", message, String(describing: error))
    } else {
        NSLog("[BigEcho:SystemAudio] %@", message)
    }
}

@available(macOS 13.0, *)
private final class SystemAudioCaptureSession: NSObject, SCStreamOutput, SCStreamDelegate {
    private let outputURL: URL
    private let fileHandle: FileHandle
    private let audioQueue: DispatchQueue
    private let stateLock = NSLock()
    private var runtimeError: Error?
    private var stream: SCStream?
    private var closedFile = false

    init(outputURL: URL) throws {
        self.outputURL = outputURL
        self.audioQueue = DispatchQueue(label: "com.bigecho.system-audio.capture.\(UUID().uuidString)")

        FileManager.default.createFile(atPath: outputURL.path, contents: nil)
        self.fileHandle = try FileHandle(forWritingTo: outputURL)

        super.init()

        let contentFilter = try Self.makeContentFilter()
        let configuration = Self.makeStreamConfiguration()
        let stream = SCStream(filter: contentFilter, configuration: configuration, delegate: self)

        do {
            try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: audioQueue)
        } catch {
            throw error
        }

        self.stream = stream
    }

    deinit {
        closeFileIfNeeded()
    }

    func start() throws {
        guard let stream else {
            throw NSError(
                domain: "BigEcho.SystemAudio",
                code: -2,
                userInfo: [NSLocalizedDescriptionKey: "ScreenCaptureKit stream is unavailable"],
            )
        }

        let semaphore = DispatchSemaphore(value: 0)
        var startError: Error?
        stream.startCapture { error in
            startError = error
            semaphore.signal()
        }
        semaphore.wait()

        if let startError {
            throw startError
        }
    }

    func stop() throws {
        defer {
            closeFileIfNeeded()
        }

        guard let stream else {
            if let runtimeError = takeRuntimeError() {
                throw runtimeError
            }
            return
        }

        let semaphore = DispatchSemaphore(value: 0)
        var stopError: Error?
        stream.stopCapture { error in
            stopError = error
            semaphore.signal()
        }
        semaphore.wait()

        if let stopError {
            throw stopError
        }
        if let runtimeError = takeRuntimeError() {
            throw runtimeError
        }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        recordRuntimeError(error)
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .audio else {
            return
        }
        guard CMSampleBufferIsValid(sampleBuffer), CMSampleBufferDataIsReady(sampleBuffer) else {
            return
        }

        do {
            let pcmData = try Self.extractMonoPCMData(from: sampleBuffer)
            guard !pcmData.isEmpty else {
                return
            }
            try fileHandle.write(contentsOf: pcmData)
        } catch {
            recordRuntimeError(error)
        }
    }

    private func recordRuntimeError(_ error: Error) {
        stateLock.lock()
        defer { stateLock.unlock() }
        if runtimeError == nil {
            runtimeError = error
        }
    }

    private func takeRuntimeError() -> Error? {
        stateLock.lock()
        defer { stateLock.unlock() }
        return runtimeError
    }

    private func closeFileIfNeeded() {
        stateLock.lock()
        defer { stateLock.unlock() }

        guard !closedFile else {
            return
        }

        do {
            try fileHandle.synchronize()
        } catch {
            if runtimeError == nil {
                runtimeError = error
            }
        }

        do {
            try fileHandle.close()
        } catch {
            if runtimeError == nil {
                runtimeError = error
            }
        }

        closedFile = true
    }

    private static func makeContentFilter() throws -> SCContentFilter {
        let shareableContent = try loadShareableContent()
        guard let display = shareableContent.displays.first else {
            throw NSError(
                domain: "BigEcho.SystemAudio",
                code: -3,
                userInfo: [NSLocalizedDescriptionKey: "No shareable display found for system audio capture"],
            )
        }

        return SCContentFilter(display: display, excludingWindows: [])
    }

    private static func makeStreamConfiguration() -> SCStreamConfiguration {
        let configuration = SCStreamConfiguration()
        configuration.width = 2
        configuration.height = 2
        configuration.minimumFrameInterval = CMTime(value: 1, timescale: 1)
        configuration.queueDepth = 3
        configuration.showsCursor = false
        configuration.capturesAudio = true
        configuration.sampleRate = nativeCaptureSampleRate
        configuration.channelCount = nativeCaptureChannelCount
        configuration.excludesCurrentProcessAudio = false
        return configuration
    }

    private static func loadShareableContent() throws -> SCShareableContent {
        let semaphore = DispatchSemaphore(value: 0)
        var result: Result<SCShareableContent, Error>?

        SCShareableContent.getWithCompletionHandler { shareableContent, error in
            if let shareableContent {
                result = .success(shareableContent)
            } else if let error {
                result = .failure(error)
            } else {
                result = .failure(
                    NSError(
                        domain: "BigEcho.SystemAudio",
                        code: -4,
                        userInfo: [NSLocalizedDescriptionKey: "ScreenCaptureKit returned no shareable content"],
                    )
                )
            }
            semaphore.signal()
        }

        semaphore.wait()
        guard let result else {
            throw NSError(
                domain: "BigEcho.SystemAudio",
                code: -4,
                userInfo: [NSLocalizedDescriptionKey: "Failed to load ScreenCaptureKit shareable content"],
            )
        }

        switch result {
        case let .success(shareableContent):
            return shareableContent
        case let .failure(error):
            throw error
        }
    }

    private static func extractMonoPCMData(from sampleBuffer: CMSampleBuffer) throws -> Data {
        guard
            let formatDescription = CMSampleBufferGetFormatDescription(sampleBuffer),
            let asbdPointer = CMAudioFormatDescriptionGetStreamBasicDescription(formatDescription)
        else {
            throw NSError(
                domain: "BigEcho.SystemAudio",
                code: -5,
                userInfo: [NSLocalizedDescriptionKey: "Missing audio format description"],
            )
        }

        let asbd = asbdPointer.pointee
        guard asbd.mFormatID == kAudioFormatLinearPCM else {
            throw NSError(
                domain: "BigEcho.SystemAudio",
                code: -6,
                userInfo: [NSLocalizedDescriptionKey: "ScreenCaptureKit audio format is not linear PCM"],
            )
        }

        let frameCount = CMSampleBufferGetNumSamples(sampleBuffer)
        guard frameCount > 0 else {
            return Data()
        }

        let expectedBufferCount = max(Int(asbd.mChannelsPerFrame), 1)
        let bufferListSize = MemoryLayout<AudioBufferList>.size + MemoryLayout<AudioBuffer>.size * max(expectedBufferCount - 1, 0)
        let rawAudioBufferList = UnsafeMutableRawPointer.allocate(
            byteCount: bufferListSize,
            alignment: MemoryLayout<AudioBufferList>.alignment
        )
        defer {
            rawAudioBufferList.deallocate()
        }

        let audioBufferListPointer = rawAudioBufferList.assumingMemoryBound(to: AudioBufferList.self)
        var blockBuffer: CMBlockBuffer?
        let status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
            sampleBuffer,
            bufferListSizeNeededOut: nil,
            bufferListOut: audioBufferListPointer,
            bufferListSize: bufferListSize,
            blockBufferAllocator: nil,
            blockBufferMemoryAllocator: nil,
            flags: UInt32(kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment),
            blockBufferOut: &blockBuffer
        )
        guard status == noErr else {
            throw NSError(
                domain: NSOSStatusErrorDomain,
                code: Int(status),
                userInfo: [NSLocalizedDescriptionKey: "Failed to extract audio buffer list from ScreenCaptureKit sample"],
            )
        }

        let audioBuffers = UnsafeMutableAudioBufferListPointer(audioBufferListPointer)
        let channelCount = max(Int(asbd.mChannelsPerFrame), 1)
        let isNonInterleaved = (asbd.mFormatFlags & kAudioFormatFlagIsNonInterleaved) != 0

        var monoSamples = [Int16]()
        monoSamples.reserveCapacity(frameCount)

        if isNonInterleaved {
            for frameIndex in 0..<frameCount {
                var accumulator = Float(0)
                var usedChannels = 0

                for channelIndex in 0..<min(audioBuffers.count, channelCount) {
                    guard let baseAddress = audioBuffers[channelIndex].mData else {
                        continue
                    }

                    accumulator += normalizedSample(
                        from: baseAddress,
                        sampleIndex: frameIndex,
                        asbd: asbd
                    )
                    usedChannels += 1
                }

                let averaged = usedChannels > 0 ? accumulator / Float(usedChannels) : 0
                monoSamples.append(int16Sample(fromNormalized: averaged))
            }
        } else {
            guard let firstBuffer = audioBuffers.first, let baseAddress = firstBuffer.mData else {
                return Data()
            }

            for frameIndex in 0..<frameCount {
                var accumulator = Float(0)
                for channelIndex in 0..<channelCount {
                    let interleavedSampleIndex = frameIndex * channelCount + channelIndex
                    accumulator += normalizedSample(
                        from: baseAddress,
                        sampleIndex: interleavedSampleIndex,
                        asbd: asbd
                    )
                }
                monoSamples.append(int16Sample(fromNormalized: accumulator / Float(channelCount)))
            }
        }

        return monoSamples.withUnsafeBytes { Data($0) }
    }

    private static func normalizedSample(
        from baseAddress: UnsafeMutableRawPointer,
        sampleIndex: Int,
        asbd: AudioStreamBasicDescription
    ) -> Float {
        let isFloat = (asbd.mFormatFlags & AudioFormatFlags(kAudioFormatFlagIsFloat)) != 0
        let isSignedInteger = (asbd.mFormatFlags & AudioFormatFlags(kAudioFormatFlagIsSignedInteger)) != 0

        if isFloat {
            switch asbd.mBitsPerChannel {
            case 32:
                return baseAddress
                    .assumingMemoryBound(to: Float.self)[sampleIndex]
                    .clamped(to: -1...1)
            case 64:
                return Float(
                    baseAddress
                        .assumingMemoryBound(to: Double.self)[sampleIndex]
                )
                .clamped(to: -1...1)
            default:
                return 0
            }
        }

        if isSignedInteger {
            switch asbd.mBitsPerChannel {
            case 16:
                return Float(baseAddress.assumingMemoryBound(to: Int16.self)[sampleIndex]) / Float(Int16.max)
            case 32:
                return Float(baseAddress.assumingMemoryBound(to: Int32.self)[sampleIndex]) / Float(Int32.max)
            default:
                return 0
            }
        }

        return 0
    }

    private static func int16Sample(fromNormalized sample: Float) -> Int16 {
        Int16((sample.clamped(to: -1...1) * Float(Int16.max)).rounded())
    }
}

private extension Comparable {
    func clamped(to limits: ClosedRange<Self>) -> Self {
        min(max(self, limits.lowerBound), limits.upperBound)
    }
}

@_cdecl("bigecho_system_audio_permission_status")
public func bigecho_system_audio_permission_status() -> Int32 {
    if let code = overriddenPermissionCode() {
        return code
    }

    if #available(macOS 10.15, *) {
        if hasConfirmedPermissionState() {
            return 1
        }

        if CGPreflightScreenCaptureAccess() {
            return 1
        }

        return isDeniedStateStillCurrent() ? 2 : 0
    }

    return 3
}

@_cdecl("bigecho_open_system_audio_settings")
public func bigecho_open_system_audio_settings() -> Bool {
    if #available(macOS 10.15, *) {
        recordPermissionRequestState()
        return openSystemAudioPrivacySettings()
    }

    return false
}

@_cdecl("bigecho_start_system_audio_capture")
public func bigecho_start_system_audio_capture(path: SRString) -> Int64 {
    let capturePath = path.toString()

    guard #available(macOS 13.0, *) else {
        return 0
    }

    let captureURL = URL(fileURLWithPath: capturePath)
    let captureSession: SystemAudioCaptureSession
    do {
        captureSession = try SystemAudioCaptureSession(outputURL: captureURL)
        try captureSession.start()
    } catch {
        logSystemAudioError("Failed to start native ScreenCaptureKit system audio capture", error: error)
        return 0
    }

    captureRegistryLock.lock()
    defer { captureRegistryLock.unlock() }

    recordConfirmedPermissionState()
    let handle = nextCaptureHandle
    nextCaptureHandle += 1
    activeCaptures[handle] = captureSession
    return handle
}

@_cdecl("bigecho_stop_system_audio_capture")
public func bigecho_stop_system_audio_capture(handle: Int64) -> Bool {
    captureRegistryLock.lock()
    let captureSession = activeCaptures.removeValue(forKey: handle)
    captureRegistryLock.unlock()

    guard #available(macOS 13.0, *) else {
        return false
    }
    guard let captureSession = captureSession as? SystemAudioCaptureSession else {
        return false
    }

    do {
        try captureSession.stop()
        return true
    } catch {
        logSystemAudioError("Failed to stop native ScreenCaptureKit system audio capture", error: error)
        return false
    }
}
