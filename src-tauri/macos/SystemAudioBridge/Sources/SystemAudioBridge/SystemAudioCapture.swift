import AppKit
import CoreGraphics
import Foundation
import SwiftRs

private let captureRegistryLock = NSLock()
private var nextCaptureHandle: Int64 = 1
private var activeCaptures: [Int64: String] = [:]
private let permissionRequestAttemptedKey = "com.bigecho.system_audio.permission_requested"
private let permissionRequestTccDbMtimeKey = "com.bigecho.system_audio.permission_requested_tcc_db_mtime"

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

private func openScreenCapturePrivacySettings() -> Bool {
    guard
        let url = URL(
            string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
        )
    else {
        return false
    }

    return NSWorkspace.shared.open(url)
}

@_cdecl("bigecho_system_audio_permission_status")
public func bigecho_system_audio_permission_status() -> Int32 {
    if let code = overriddenPermissionCode() {
        return code
    }

    if #available(macOS 10.15, *) {
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
        if CGPreflightScreenCaptureAccess() {
            return openScreenCapturePrivacySettings()
        }

        if CGRequestScreenCaptureAccess() {
            return true
        }

        recordPermissionRequestState()

        return openScreenCapturePrivacySettings()
    }

    return false
}

@_cdecl("bigecho_start_system_audio_capture")
public func bigecho_start_system_audio_capture(path: SRString) -> Int64 {
    let capturePath = path.toString()

    captureRegistryLock.lock()
    defer { captureRegistryLock.unlock() }

    let handle = nextCaptureHandle
    nextCaptureHandle += 1
    activeCaptures[handle] = capturePath
    return handle
}

@_cdecl("bigecho_stop_system_audio_capture")
public func bigecho_stop_system_audio_capture(handle: Int64) -> Bool {
    captureRegistryLock.lock()
    defer { captureRegistryLock.unlock() }

    return activeCaptures.removeValue(forKey: handle) != nil
}
