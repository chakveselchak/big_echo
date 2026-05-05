import AppKit
import SwiftRs

// Stubs — real UI lands in Task 10.
@_cdecl("bigecho_minitray_show")
public func bigecho_minitray_show() {
    // TODO: implement in Task 10
}

@_cdecl("bigecho_minitray_hide")
public func bigecho_minitray_hide() {
    // TODO: implement in Task 10
}

@_cdecl("bigecho_minitray_update_level")
public func bigecho_minitray_update_level(_ level: Float) {
    _ = level  // suppress unused warning in stub
    // TODO: implement in Task 10
}

@_cdecl("bigecho_minitray_set_callbacks")
public func bigecho_minitray_set_callbacks(
    onStop: @convention(c) () -> Void,
    onIcon: @convention(c) () -> Void
) {
    _ = onStop
    _ = onIcon
    // TODO: implement in Task 10
}
