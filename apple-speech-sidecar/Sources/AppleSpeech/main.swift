import Foundation
@preconcurrency import AVFoundation
import Speech

// Unbuffered stdout so JSON output reaches the parent before exit().
setvbuf(stdout, nil, _IONBF, 0)

struct CheckResult: Encodable {
    let locale: String
    let resolved: String
    let supported: Bool
    let installed: Bool
    let assetStatus: String
}

struct Segment: Encodable {
    let start: Double
    let end: Double
    let text: String
}

struct TranscribeResult: Encodable {
    let text: String
    let segments: [Segment]
    let locale: String
}

struct StatusResult: Encodable {
    let status: String
}

struct ErrorResult: Encodable {
    let error: String
}

func emit<T: Encodable>(_ value: T) {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    if let data = try? encoder.encode(value),
       let str = String(data: data, encoding: .utf8) {
        print(str)
    }
}

func fail(_ message: String) -> Never {
    emit(ErrorResult(error: message))
    exit(1)
}

func argValue(_ name: String, in args: [String]) -> String? {
    guard let idx = args.firstIndex(of: "--\(name)"), idx + 1 < args.count else {
        return nil
    }
    return args[idx + 1]
}

@available(macOS 26.0, *)
func assetStatusName(_ status: AssetInventory.Status) -> String {
    switch status {
    case .unsupported: return "unsupported"
    case .supported: return "supported"
    case .installed: return "installed"
    case .downloading: return "downloading"
    @unknown default: return "unknown"
    }
}

@available(macOS 26.0, *)
func resolveSupportedLocale(_ locale: Locale) async -> Locale {
    if let equivalent = await SpeechTranscriber.supportedLocale(equivalentTo: locale) {
        return equivalent
    }
    let supported = await SpeechTranscriber.supportedLocales
    if let languageCode = locale.language.languageCode?.identifier,
       let match = supported.first(where: { $0.language.languageCode?.identifier == languageCode }) {
        return match
    }
    return locale
}

@available(macOS 26.0, *)
func runCheck(locale localeID: String) async {
    let locale = Locale(identifier: localeID)

    // Resolve via both modules — SpeechTranscriber covers Apple Intelligence
    // languages, DictationTranscriber covers system Dictation On-Device packs
    // (which extend coverage to Russian and others).
    let speechResolved = await SpeechTranscriber.supportedLocale(equivalentTo: locale)
    let dictResolved = await DictationTranscriber.supportedLocale(equivalentTo: locale)
    let supported = speechResolved != nil || dictResolved != nil

    let speechInstalledLocales = await SpeechTranscriber.installedLocales
    let dictInstalledLocales = await DictationTranscriber.installedLocales

    let speechInstalled = speechResolved.map { r in
        speechInstalledLocales.contains { $0.identifier(.bcp47) == r.identifier(.bcp47) }
    } ?? false
    let dictInstalled = dictResolved.map { r in
        dictInstalledLocales.contains { $0.identifier(.bcp47) == r.identifier(.bcp47) }
    } ?? false
    let installed = speechInstalled || dictInstalled

    // Asset status: prefer the best of the two paths.
    let speechStatus = await AssetInventory.status(
        forModules: [SpeechTranscriber(locale: locale, preset: .transcription)]
    )
    let dictStatus = await AssetInventory.status(
        forModules: [DictationTranscriber(locale: locale, preset: .timeIndexedLongDictation)]
    )

    func rank(_ s: AssetInventory.Status) -> Int {
        switch s {
        case .installed: return 3
        case .downloading: return 2
        case .supported: return 1
        case .unsupported: return 0
        @unknown default: return 0
        }
    }

    let bestStatus = rank(speechStatus) >= rank(dictStatus) ? speechStatus : dictStatus

    // If DictationTranscriber actually has the language installed via system
    // Dictation pack, surface "installed" even when AssetInventory says
    // "unsupported" for both modules (system packs aren't tracked by it).
    let effectiveStatus: AssetInventory.Status = installed ? .installed : bestStatus

    let resolvedBcp47 = (speechResolved ?? dictResolved ?? locale).identifier(.bcp47)

    emit(CheckResult(
        locale: localeID,
        resolved: resolvedBcp47,
        supported: supported,
        installed: installed,
        assetStatus: assetStatusName(effectiveStatus)
    ))
}

@available(macOS 26.0, *)
func runDownload(locale localeID: String) async throws {
    let locale = Locale(identifier: localeID)
    let transcriber = SpeechTranscriber(locale: locale, preset: .transcription)
    let status = await AssetInventory.status(forModules: [transcriber])
    if status == .unsupported {
        fail("Locale \(localeID) is not downloadable via API. Install language pack via System Settings → Keyboard → Dictation → On-Device.")
    }
    if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
        let progress = request.progress
        let observation = progress.observe(\.fractionCompleted, options: [.new]) { p, _ in
            let line = "progress: \(p.fractionCompleted)\n"
            FileHandle.standardError.write(Data(line.utf8))
        }
        try await request.downloadAndInstall()
        observation.invalidate()
    }
    emit(StatusResult(status: "ok"))
}

@available(macOS 26.0, *)
@preconcurrency
func prepareCompatibleAudioFile(at url: URL, targetFormat: AVAudioFormat) async throws -> URL {
    let asset = AVURLAsset(url: url)
    let tracks = try await asset.loadTracks(withMediaType: .audio)
    guard let audioTrack = tracks.first else {
        throw NSError(domain: "AppleSpeech", code: 20, userInfo: [
            NSLocalizedDescriptionKey: "No audio track in input"
        ])
    }

    var outputSettings: [String: Any] = [
        AVFormatIDKey: kAudioFormatLinearPCM,
        AVSampleRateKey: targetFormat.sampleRate,
        AVNumberOfChannelsKey: Int(targetFormat.channelCount),
        AVLinearPCMIsBigEndianKey: false,
        AVLinearPCMIsNonInterleaved: false
    ]
    switch targetFormat.commonFormat {
    case .pcmFormatFloat32:
        outputSettings[AVLinearPCMBitDepthKey] = 32
        outputSettings[AVLinearPCMIsFloatKey] = true
    case .pcmFormatFloat64:
        outputSettings[AVLinearPCMBitDepthKey] = 64
        outputSettings[AVLinearPCMIsFloatKey] = true
    case .pcmFormatInt32:
        outputSettings[AVLinearPCMBitDepthKey] = 32
        outputSettings[AVLinearPCMIsFloatKey] = false
    case .pcmFormatInt16:
        outputSettings[AVLinearPCMBitDepthKey] = 16
        outputSettings[AVLinearPCMIsFloatKey] = false
    default:
        outputSettings[AVLinearPCMBitDepthKey] = 32
        outputSettings[AVLinearPCMIsFloatKey] = true
    }

    let reader = try AVAssetReader(asset: asset)
    let trackOutput = AVAssetReaderTrackOutput(track: audioTrack, outputSettings: outputSettings)
    trackOutput.alwaysCopiesSampleData = false
    guard reader.canAdd(trackOutput) else {
        throw NSError(domain: "AppleSpeech", code: 21, userInfo: [
            NSLocalizedDescriptionKey: "Unable to configure audio reader"
        ])
    }
    reader.add(trackOutput)

    let outputURL = FileManager.default.temporaryDirectory
        .appendingPathComponent("apple-speech-\(UUID().uuidString)")
        .appendingPathExtension("caf")
    if FileManager.default.fileExists(atPath: outputURL.path) {
        try FileManager.default.removeItem(at: outputURL)
    }

    let writer = try AVAssetWriter(outputURL: outputURL, fileType: .caf)
    let writerInput = AVAssetWriterInput(mediaType: .audio, outputSettings: outputSettings)
    writerInput.expectsMediaDataInRealTime = false
    guard writer.canAdd(writerInput) else {
        throw NSError(domain: "AppleSpeech", code: 22, userInfo: [
            NSLocalizedDescriptionKey: "Unable to configure audio writer"
        ])
    }
    writer.add(writerInput)

    guard reader.startReading() else {
        throw reader.error ?? NSError(domain: "AppleSpeech", code: 23, userInfo: [
            NSLocalizedDescriptionKey: "Failed to start audio reader"
        ])
    }
    guard writer.startWriting() else {
        throw writer.error ?? NSError(domain: "AppleSpeech", code: 24, userInfo: [
            NSLocalizedDescriptionKey: "Failed to start audio writer"
        ])
    }
    writer.startSession(atSourceTime: .zero)

    nonisolated(unsafe) let unsafeWriter = writer
    nonisolated(unsafe) let unsafeReader = reader
    nonisolated(unsafe) let unsafeWriterInput = writerInput
    nonisolated(unsafe) let unsafeTrackOutput = trackOutput

    try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
        let queue = DispatchQueue(label: "apple-speech.audio.convert")
        unsafeWriterInput.requestMediaDataWhenReady(on: queue) {
            while unsafeWriterInput.isReadyForMoreMediaData {
                if let buffer = unsafeTrackOutput.copyNextSampleBuffer() {
                    if !unsafeWriterInput.append(buffer) {
                        unsafeReader.cancelReading()
                        unsafeWriter.cancelWriting()
                        cont.resume(throwing: unsafeWriter.error ?? NSError(
                            domain: "AppleSpeech", code: 25,
                            userInfo: [NSLocalizedDescriptionKey: "Failed to append audio buffer"]
                        ))
                        return
                    }
                } else {
                    unsafeWriterInput.markAsFinished()
                    unsafeWriter.finishWriting {
                        if let err = unsafeWriter.error {
                            cont.resume(throwing: err)
                        } else {
                            cont.resume(returning: ())
                        }
                    }
                    break
                }
            }
        }
    }

    if reader.status != .completed {
        throw reader.error ?? NSError(domain: "AppleSpeech", code: 26, userInfo: [
            NSLocalizedDescriptionKey: "Audio conversion did not complete"
        ])
    }

    return outputURL
}

@available(macOS 26.0, *)
func runTranscribe(input: String, locale localeID: String) async throws {
    let url = URL(fileURLWithPath: input)
    guard FileManager.default.fileExists(atPath: url.path) else {
        fail("Input file not found: \(input)")
    }

    let requested = Locale(identifier: localeID)

    // Apple has two transcription modules on macOS 26:
    // - SpeechTranscriber: new Apple Intelligence stack, limited language coverage
    //   (no Russian as of 26.4). Used for languages where it has assets.
    // - DictationTranscriber: backed by the system Dictation On-Device pack;
    //   covers more languages including Russian when the user installed the
    //   pack via System Settings → Keyboard → Dictation → On-Device.
    // We prefer SpeechTranscriber when its assets are available, otherwise
    // fall back to DictationTranscriber.

    let speechResolved = await SpeechTranscriber.supportedLocale(equivalentTo: requested)
        ?? requested
    let speechTranscriber = SpeechTranscriber(locale: speechResolved, preset: .transcription)
    let speechFormats = await speechTranscriber.availableCompatibleAudioFormats

    if !speechFormats.isEmpty {
        // Best-effort asset install for SpeechTranscriber.
        if let request = try? await AssetInventory.assetInstallationRequest(
            supporting: [speechTranscriber]
        ) {
            try? await request.downloadAndInstall()
        }
        let bestFormat = await SpeechAnalyzer.bestAvailableAudioFormat(
            compatibleWith: [speechTranscriber],
            considering: nil
        )
        let targetFormat = bestFormat ?? speechFormats.first!
        FileHandle.standardError.write(Data(
            "[debug] using SpeechTranscriber locale=\(speechResolved.identifier) targetFormat=\(targetFormat)\n".utf8
        ))
        try await transcribeWithSpeechModule(
            url: url,
            transcriber: speechTranscriber,
            targetFormat: targetFormat,
            resolvedLocaleID: speechResolved.identifier
        )
        return
    }

    // Fallback: DictationTranscriber (used by system Dictation, covers Russian)
    let dictResolved = await DictationTranscriber.supportedLocale(equivalentTo: requested)
        ?? requested
    let dictTranscriber = DictationTranscriber(
        locale: dictResolved,
        preset: .timeIndexedLongDictation
    )
    let dictFormats = await dictTranscriber.availableCompatibleAudioFormats

    FileHandle.standardError.write(Data(
        "[debug] SpeechTranscriber formats=0; trying DictationTranscriber locale=\(dictResolved.identifier) formats=\(dictFormats.count)\n".utf8
    ))

    guard !dictFormats.isEmpty else {
        throw NSError(domain: "AppleSpeech", code: 27, userInfo: [
            NSLocalizedDescriptionKey:
                "No transcription model available for this locale. Open System Settings → Keyboard → Dictation, add the language and enable On-Device."
        ])
    }

    let dictBest = await SpeechAnalyzer.bestAvailableAudioFormat(
        compatibleWith: [dictTranscriber],
        considering: nil
    )
    let targetFormat = dictBest ?? dictFormats.first!

    try await transcribeWithDictationModule(
        url: url,
        transcriber: dictTranscriber,
        targetFormat: targetFormat,
        resolvedLocaleID: dictResolved.identifier
    )
}

@available(macOS 26.0, *)
func transcribeWithSpeechModule(
    url: URL,
    transcriber: SpeechTranscriber,
    targetFormat: AVAudioFormat,
    resolvedLocaleID: String
) async throws {
    let preparedURL = try await prepareCompatibleAudioFile(at: url, targetFormat: targetFormat)
    defer { try? FileManager.default.removeItem(at: preparedURL) }
    let preparedFile = try AVAudioFile(forReading: preparedURL)

    let analyzer = try await SpeechAnalyzer(
        inputAudioFile: preparedFile,
        modules: [transcriber],
        finishAfterFile: true
    )

    let collector = Task<(String, [Segment]), Error> { [transcriber] in
        var fullText = ""
        var segments: [Segment] = []
        for try await result in transcriber.results {
            guard result.isFinal else { continue }
            let plain = String(result.text.characters).trimmingCharacters(in: .whitespacesAndNewlines)
            guard !plain.isEmpty else { continue }
            if !fullText.isEmpty { fullText += " " }
            fullText += plain
            let s = result.range.start.seconds
            let e = result.range.end.seconds
            segments.append(Segment(
                start: s.isFinite ? s : 0,
                end: e.isFinite ? e : (s.isFinite ? s : 0),
                text: plain
            ))
        }
        return (fullText.trimmingCharacters(in: .whitespacesAndNewlines), segments)
    }

    try await analyzer.finalizeAndFinishThroughEndOfInput()
    let (fullText, segments) = try await collector.value
    emit(TranscribeResult(text: fullText, segments: segments, locale: resolvedLocaleID))
}

@available(macOS 26.0, *)
func transcribeWithDictationModule(
    url: URL,
    transcriber: DictationTranscriber,
    targetFormat: AVAudioFormat,
    resolvedLocaleID: String
) async throws {
    let preparedURL = try await prepareCompatibleAudioFile(at: url, targetFormat: targetFormat)
    defer { try? FileManager.default.removeItem(at: preparedURL) }
    let preparedFile = try AVAudioFile(forReading: preparedURL)

    let analyzer = try await SpeechAnalyzer(
        inputAudioFile: preparedFile,
        modules: [transcriber],
        finishAfterFile: true
    )

    let collector = Task<(String, [Segment]), Error> { [transcriber] in
        var fullText = ""
        var segments: [Segment] = []
        for try await result in transcriber.results {
            let plain = String(result.text.characters).trimmingCharacters(in: .whitespacesAndNewlines)
            guard !plain.isEmpty else { continue }
            if !fullText.isEmpty { fullText += " " }
            fullText += plain
            let s = result.range.start.seconds
            let e = result.range.end.seconds
            segments.append(Segment(
                start: s.isFinite ? s : 0,
                end: e.isFinite ? e : (s.isFinite ? s : 0),
                text: plain
            ))
        }
        return (fullText.trimmingCharacters(in: .whitespacesAndNewlines), segments)
    }

    try await analyzer.finalizeAndFinishThroughEndOfInput()
    let (fullText, segments) = try await collector.value
    emit(TranscribeResult(text: fullText, segments: segments, locale: resolvedLocaleID))
}

let args = Array(CommandLine.arguments.dropFirst())
guard let command = args.first else {
    fail("usage: apple-speech <check|download|transcribe> [--locale <bcp47>] [--input <path>]")
}

guard #available(macOS 26.0, *) else {
    fail("macOS 26.0 or later is required")
}

let rest = Array(args.dropFirst())

let mainTask = Task {
    do {
        switch command {
        case "check":
            guard let locale = argValue("locale", in: rest) else { fail("--locale is required") }
            await runCheck(locale: locale)
        case "download":
            guard let locale = argValue("locale", in: rest) else { fail("--locale is required") }
            try await runDownload(locale: locale)
        case "transcribe":
            guard let locale = argValue("locale", in: rest) else { fail("--locale is required") }
            guard let input = argValue("input", in: rest) else { fail("--input is required") }
            try await runTranscribe(input: input, locale: locale)
        default:
            fail("unknown command: \(command)")
        }
        exit(0)
    } catch {
        fail(String(describing: error))
    }
}

RunLoop.main.run()
_ = mainTask
