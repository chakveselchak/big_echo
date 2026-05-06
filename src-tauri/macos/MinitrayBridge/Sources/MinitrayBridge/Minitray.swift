import AppKit
import SwiftRs

// Direct calls into Rust. Rust exports `bigecho_minitray_rust_on_*` via
// `#[no_mangle] pub extern "C" fn`; we resolve the symbols at link time.
// This replaces the older "register a function pointer at boot" dance,
// which had race-prone state and didn't reliably propagate.
@_silgen_name("bigecho_minitray_rust_on_stop")
private func _bigecho_minitray_rust_on_stop()

@_silgen_name("bigecho_minitray_rust_on_icon")
private func _bigecho_minitray_rust_on_icon()

/// Live audio wave matching the main tray's `AudioWave` style. Mirrors the
/// thresholds, amplitude/frequency curves and phase animation defined in
/// `src/lib/trayAudio.ts`. Single sine path stroked in the system accent
/// colour over a flat baseline.
private final class LevelMeterView: NSView {
    // Tunables — keep in sync with TRAY_AUDIO_* in src/lib/trayAudio.ts.
    private let activeThreshold: Double = 0.08
    private let strongThreshold: Double = 0.58
    /// Reference height used by the tray to tune amplitudes (28px). Our
    /// minitray meter is shorter, so we scale amplitudes proportionally.
    private let referenceHeight: CGFloat = 28

    private var level: Double = 0
    private var phase: Double = 0
    private var animTimer: Timer?

    deinit {
        animTimer?.invalidate()
    }

    func setLevel(_ value: Float) {
        let clamped = max(0, min(1, Double(value)))
        // Always update so a steady non-zero level still drives animation.
        level = clamped
        ensureAnimation()
        needsDisplay = true
    }

    private enum WaveMode { case flat, gentle, strong }
    private struct WaveMetrics {
        let mode: WaveMode
        let amplitude: Double
        let secondaryAmplitude: Double
        let frequency: Double
        let speed: Double
        let strokeWidth: CGFloat
    }

    private func metrics() -> WaveMetrics {
        if level < activeThreshold {
            return WaveMetrics(
                mode: .flat,
                amplitude: 0,
                secondaryAmplitude: 0,
                frequency: 0,
                speed: 0,
                strokeWidth: 1.55
            )
        }
        let activity = max(0, min(1, (level - activeThreshold) / (1 - activeThreshold)))
        let mode: WaveMode = activity >= strongThreshold ? .strong : .gentle
        let amplitude = 1.4 + pow(activity, 1.18) * 8.6
        let secondaryAmplitude = amplitude * (mode == .strong ? 0.42 : 0.2)
        let frequency = mode == .strong ? 2.4 + activity * 1.25 : 1.4 + activity * 0.95
        let speed = 0.85 + activity * 1.95
        let strokeWidth: CGFloat = mode == .strong ? 1.85 : 1.6
        return WaveMetrics(
            mode: mode,
            amplitude: amplitude,
            secondaryAmplitude: secondaryAmplitude,
            frequency: frequency,
            speed: speed,
            strokeWidth: strokeWidth
        )
    }

    private func ensureAnimation() {
        let isAnimated = level >= activeThreshold
        if isAnimated {
            if animTimer == nil {
                let timer = Timer(timeInterval: 1.0 / 60.0, repeats: true) { [weak self] _ in
                    guard let self else { return }
                    let m = self.metrics()
                    let modeMul: Double = m.mode == .strong ? 0.16 : 0.11
                    self.phase = (self.phase + m.speed * modeMul)
                        .truncatingRemainder(dividingBy: .pi * 2)
                    self.needsDisplay = true
                }
                RunLoop.main.add(timer, forMode: .common)
                animTimer = timer
            }
        } else {
            animTimer?.invalidate()
            animTimer = nil
            phase = 0
        }
    }

    override func draw(_ dirtyRect: NSRect) {
        guard let ctx = NSGraphicsContext.current?.cgContext else { return }
        let m = metrics()
        let centerY = bounds.midY
        let scale = max(bounds.height / referenceHeight, 0.001)

        ctx.setStrokeColor(NSColor.controlAccentColor.cgColor)
        ctx.setLineWidth(m.strokeWidth)
        ctx.setLineJoin(.round)

        let path = CGMutablePath()
        if m.mode == .flat || m.amplitude <= 0 {
            path.move(to: CGPoint(x: 0, y: centerY))
            path.addLine(to: CGPoint(x: bounds.width, y: centerY))
        } else {
            let samples = 32
            let step = bounds.width / CGFloat(samples)
            let twoPi: Double = .pi * 2
            let scaledAmp = m.amplitude * Double(scale)
            let scaledSecAmp = m.secondaryAmplitude * Double(scale)
            path.move(to: CGPoint(x: 0, y: centerY))
            for i in 1...samples {
                let progress = Double(i) / Double(samples)
                let x = step * CGFloat(i)
                let taper = pow(sin(progress * .pi), 0.9)
                let primary = sin(progress * m.frequency * twoPi + phase)
                let secondary = sin(progress * m.frequency * 3.6 * .pi - phase * 1.35)
                let offset = taper * (primary * scaledAmp + secondary * scaledSecAmp)
                let yRaw = Double(centerY) - offset
                let y = max(2, min(Double(bounds.height) - 2, yRaw))
                path.addLine(to: CGPoint(x: x, y: CGFloat(y)))
            }
        }
        ctx.addPath(path)
        ctx.strokePath()
    }
}

private final class IconHitView: NSImageView {
    override func mouseDown(with event: NSEvent) {
        _bigecho_minitray_rust_on_icon()
    }
    override var acceptsFirstResponder: Bool { true }
    /// Required for nonactivating panels — without this the first click
    /// on the icon is swallowed by AppKit trying to "activate" the panel.
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

/// NSButton subclass that fires its action on the first click even when
/// the parent NSPanel is `.nonactivatingPanel`. Without overriding
/// `acceptsFirstMouse`, AppKit consumes the initial click to "activate"
/// the panel and never delivers the action.
private final class FirstMouseButton: NSButton {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

@MainActor
final class MinitrayController: NSObject {
    static let shared = MinitrayController()

    private var panel: NSPanel?
    private var meterView: LevelMeterView?

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
        // Draggable from anywhere on the panel background (icon and stop
        // button consume their own clicks, so drag only fires on empty
        // padding / level meter area).
        panel.isMovable = true
        panel.isMovableByWindowBackground = true
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

        let meter = LevelMeterView()
        meter.translatesAutoresizingMaskIntoConstraints = false
        meterView = meter

        let stop = FirstMouseButton()
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
            meter.heightAnchor.constraint(equalToConstant: 22),
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
        // 43px от верха экрана: с запасом, чтобы panel не залезала под
        // menu bar / notch на маках с экранным вырезом.
        let y = screen.frame.maxY - frame.height - 43
        panel.setFrameOrigin(NSPoint(x: x, y: y))
    }

    @objc private func stopClicked() {
        _bigecho_minitray_rust_on_stop()
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

