import AppKit
import SwiftRs

private final class LevelMeterView: NSView {
    private let barCount = 12
    private var level: Float = 0

    func setLevel(_ value: Float) {
        let clamped = max(0, min(1, value))
        if abs(clamped - level) < 0.005 { return }
        level = clamped
        needsDisplay = true
    }

    override func draw(_ dirtyRect: NSRect) {
        guard let ctx = NSGraphicsContext.current?.cgContext else { return }
        let barWidth: CGFloat = 4
        let gap: CGFloat = 3
        let totalWidth = CGFloat(barCount) * barWidth + CGFloat(barCount - 1) * gap
        let startX = (bounds.width - totalWidth) / 2
        let activeBars = Int(round(Float(barCount) * level))
        let active = NSColor.controlAccentColor.cgColor
        let dim = NSColor.tertiaryLabelColor.cgColor
        for i in 0..<barCount {
            let x = startX + CGFloat(i) * (barWidth + gap)
            let rect = CGRect(x: x, y: bounds.midY - 6, width: barWidth, height: 12)
            ctx.setFillColor(i < activeBars ? active : dim)
            ctx.addPath(CGPath(roundedRect: rect, cornerWidth: 1, cornerHeight: 1, transform: nil))
            ctx.fillPath()
        }
    }
}

private final class IconHitView: NSImageView {
    var onClick: (() -> Void)?
    override func mouseDown(with event: NSEvent) {
        onClick?()
    }
    override var acceptsFirstResponder: Bool { true }
}

@MainActor
final class MinitrayController {
    static let shared = MinitrayController()

    private var panel: NSPanel?
    private var meterView: LevelMeterView?
    fileprivate var onStop: (@convention(c) () -> Void)?
    fileprivate var onIcon: (@convention(c) () -> Void)?

    func show() {
        if panel == nil {
            buildPanel()
        }
        positionAtTopCenter()
        panel?.alphaValue = 1
        panel?.orderFrontRegardless()
    }

    func hide() {
        panel?.orderOut(nil)
    }

    func updateLevel(_ level: Float) {
        meterView?.setLevel(level)
    }

    private func buildPanel() {
        let width: CGFloat = 200
        let height: CGFloat = 36
        let panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: width, height: height),
            styleMask: [.nonactivatingPanel, .borderless],
            backing: .buffered,
            defer: false
        )
        panel.isMovable = false
        panel.isMovableByWindowBackground = false
        panel.hasShadow = true
        panel.level = .statusBar
        panel.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle, .fullScreenAuxiliary]
        panel.isOpaque = false
        panel.backgroundColor = .clear

        let blur = NSVisualEffectView(frame: NSRect(x: 0, y: 0, width: width, height: height))
        blur.material = .hudWindow
        blur.blendingMode = .behindWindow
        blur.state = .active
        blur.wantsLayer = true
        blur.layer?.cornerRadius = 12
        blur.layer?.masksToBounds = true

        let icon = IconHitView()
        icon.image = NSApp.applicationIconImage
        icon.imageScaling = .scaleProportionallyUpOrDown
        icon.translatesAutoresizingMaskIntoConstraints = false
        icon.onClick = { [weak self] in self?.onIcon?() }

        let meter = LevelMeterView()
        meter.translatesAutoresizingMaskIntoConstraints = false
        meterView = meter

        let stop = NSButton()
        stop.bezelStyle = .accessoryBar
        stop.image = NSImage(systemSymbolName: "stop.fill", accessibilityDescription: "Stop recording")
        stop.imagePosition = .imageOnly
        stop.target = self
        stop.action = #selector(stopClicked)
        stop.translatesAutoresizingMaskIntoConstraints = false

        blur.addSubview(icon)
        blur.addSubview(meter)
        blur.addSubview(stop)

        NSLayoutConstraint.activate([
            icon.leadingAnchor.constraint(equalTo: blur.leadingAnchor, constant: 8),
            icon.centerYAnchor.constraint(equalTo: blur.centerYAnchor),
            icon.widthAnchor.constraint(equalToConstant: 22),
            icon.heightAnchor.constraint(equalToConstant: 22),

            meter.leadingAnchor.constraint(equalTo: icon.trailingAnchor, constant: 8),
            meter.centerYAnchor.constraint(equalTo: blur.centerYAnchor),
            meter.heightAnchor.constraint(equalToConstant: 16),
            meter.trailingAnchor.constraint(equalTo: stop.leadingAnchor, constant: -8),

            stop.trailingAnchor.constraint(equalTo: blur.trailingAnchor, constant: -8),
            stop.centerYAnchor.constraint(equalTo: blur.centerYAnchor),
            stop.widthAnchor.constraint(equalToConstant: 22),
            stop.heightAnchor.constraint(equalToConstant: 22),
        ])

        panel.contentView = blur
        self.panel = panel
    }

    private func positionAtTopCenter() {
        guard let panel = panel else { return }
        let cursorScreen = NSScreen.screens.first { NSPointInRect(NSEvent.mouseLocation, $0.frame) }
            ?? NSScreen.main
            ?? NSScreen.screens.first
        guard let screen = cursorScreen else { return }
        let frame = panel.frame
        let x = screen.frame.midX - frame.width / 2
        let y = screen.frame.maxY - frame.height - 8
        panel.setFrameOrigin(NSPoint(x: x, y: y))
    }

    @objc private func stopClicked() {
        onStop?()
    }
}

@_cdecl("bigecho_minitray_show")
public func bigecho_minitray_show() {
    DispatchQueue.main.async { MinitrayController.shared.show() }
}

@_cdecl("bigecho_minitray_hide")
public func bigecho_minitray_hide() {
    DispatchQueue.main.async { MinitrayController.shared.hide() }
}

@_cdecl("bigecho_minitray_update_level")
public func bigecho_minitray_update_level(_ level: Float) {
    DispatchQueue.main.async { MinitrayController.shared.updateLevel(level) }
}

@_cdecl("bigecho_minitray_set_callbacks")
public func bigecho_minitray_set_callbacks(
    onStop: @convention(c) () -> Void,
    onIcon: @convention(c) () -> Void
) {
    DispatchQueue.main.async {
        MinitrayController.shared.onStop = onStop
        MinitrayController.shared.onIcon = onIcon
    }
}
