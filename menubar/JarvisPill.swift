// ── JARVIS Pill — "Golden Gate" Siri-style access surface ──
//
// STATUS: PARKED (WIP, 2026-06-27). Working + liked; paused for later.
// Launcher (start-pill.sh) is guarded so it won't run by accident.
// To resume: remove the guard lines in start-pill.sh, then `bash menubar/start-pill.sh`.
// Next ideas: mic button (voice into the pill), scrollable chat history, spoken replies.
//
// A compact, draggable, Liquid-Glass capsule summoned with a global hotkey
// (default ⌥-Space). Type a query; it expands into a streaming answer card.
// Talks to the running JARVIS over the watch WebSocket (ws://127.0.0.1:5225):
//   send  { "type":"command", "text":"...", "noAudio":true }
//   recv  { "type":"token", "text":"..." } / { "type":"status", "state":"..." }
//
// Standalone — does not touch the existing menubar app. Build with start-pill.sh.

import Cocoa
import Carbon.HIToolbox

// Global trampoline so the C hotkey callback can reach the delegate.
var gApp: AppDelegate?

// MARK: - WebSocket client (Foundation-native, no deps)

final class JarvisLink {
    private var task: URLSessionWebSocketTask?
    private let url = URL(string: "ws://127.0.0.1:5225")!
    private var reconnectWork: DispatchWorkItem?
    private(set) var connected = false

    var onToken: ((String) -> Void)?
    var onStatus: ((String) -> Void)?
    var onConn: ((Bool) -> Void)?

    func connect() {
        task?.cancel(with: .goingAway, reason: nil)
        let t = URLSession.shared.webSocketTask(with: url)
        task = t
        t.resume()
        receive()
        // The server sends an initial {status:idle} on connect; treat the first
        // successful receive as "connected".
    }

    private func setConnected(_ v: Bool) {
        if connected != v {
            connected = v
            DispatchQueue.main.async { self.onConn?(v) }
        }
    }

    private func scheduleReconnect() {
        setConnected(false)
        reconnectWork?.cancel()
        let w = DispatchWorkItem { [weak self] in self?.connect() }
        reconnectWork = w
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.0, execute: w)
    }

    private func receive() {
        task?.receive { [weak self] result in
            guard let self = self else { return }
            switch result {
            case .failure:
                self.scheduleReconnect()
            case .success(let message):
                self.setConnected(true)
                if case .string(let text) = message { self.handle(text) }
                self.receive()
            }
        }
    }

    private func handle(_ text: String) {
        guard let data = text.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = obj["type"] as? String else { return }
        switch type {
        case "token":
            if let t = obj["text"] as? String { DispatchQueue.main.async { self.onToken?(t) } }
        case "status":
            if let s = obj["state"] as? String { DispatchQueue.main.async { self.onStatus?(s) } }
        case "error":
            if let m = obj["message"] as? String { DispatchQueue.main.async { self.onToken?("\n⚠︎ \(m)") } }
        default:
            break
        }
    }

    func send(_ query: String) {
        let payload: [String: Any] = ["type": "command", "text": query, "noAudio": true]
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let str = String(data: data, encoding: .utf8) else { return }
        task?.send(.string(str)) { _ in }
    }
}

// MARK: - Glass background + animated glow border

final class GlassCard: NSView {
    private let effect = NSVisualEffectView()
    private var phase: CGFloat = 0
    private var timer: Timer?
    var active = false { didSet { if active { startGlow() } } }

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        layer?.cornerRadius = 20
        layer?.masksToBounds = true

        effect.material = .hudWindow          // frosted "Liquid Glass"
        effect.blendingMode = .behindWindow
        effect.state = .active
        effect.wantsLayer = true
        effect.layer?.cornerRadius = 20
        effect.layer?.masksToBounds = true
        effect.autoresizingMask = [.width, .height]
        effect.frame = bounds
        addSubview(effect, positioned: .below, relativeTo: nil)
    }
    required init?(coder: NSCoder) { fatalError() }

    private func startGlow() {
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: 1.0 / 30.0, repeats: true) { [weak self] _ in
            guard let self = self else { return }
            self.phase += 0.03
            self.needsDisplay = true
        }
    }
    func stopGlow() { timer?.invalidate(); timer = nil; needsDisplay = true }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        let inset: CGFloat = 1.0
        let r = bounds.insetBy(dx: inset, dy: inset)
        let path = NSBezierPath(roundedRect: r, xRadius: 19, yRadius: 19)
        path.lineWidth = active ? 2.2 : 1.0

        if active {
            // Cycle through Siri-ish hues while JARVIS works: blue→purple→pink→amber
            let hue = (sin(phase) * 0.5 + 0.5)            // 0..1
            let mapped = 0.55 + hue * 0.35                // bias toward blue/purple/pink
            let c = NSColor(hue: mapped.truncatingRemainder(dividingBy: 1.0),
                            saturation: 0.85, brightness: 1.0, alpha: 0.9)
            c.setStroke()
        } else {
            NSColor(white: 1.0, alpha: 0.16).setStroke()
        }
        path.stroke()
    }
}

// MARK: - The floating panel

final class PillPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { true }
}

// MARK: - App

final class AppDelegate: NSObject, NSApplicationDelegate, NSTextFieldDelegate {
    private var panel: PillPanel!
    private var card: GlassCard!
    private var field: NSTextField!
    private var icon: NSImageView!
    private var statusDot: NSView!
    private var answerScroll: NSScrollView!
    private var answerView: NSTextView!
    private let link = JarvisLink()
    private var hotKeyRef: EventHotKeyRef?
    private var clickMonitor: Any?

    private let pillW: CGFloat = 640
    private let collapsedH: CGFloat = 66
    private let expandedH: CGFloat = 420
    private var expanded = false
    private var streaming = false

    func applicationDidFinishLaunching(_ note: Notification) {
        gApp = self
        NSApp.setActivationPolicy(.accessory)
        buildPanel()
        registerHotKey()
        link.onToken = { [weak self] t in self?.appendToken(t) }
        link.onStatus = { [weak self] s in self?.onStatus(s) }
        link.onConn = { [weak self] c in self?.onConn(c) }
        link.connect()
        // Show once on launch so the look is immediately visible.
        showPill()
    }

    // MARK: build UI
    private func buildPanel() {
        let screen = NSScreen.main ?? NSScreen.screens[0]
        let sf = screen.frame
        let x = sf.midX - pillW / 2
        let y = sf.maxY - 200
        panel = PillPanel(contentRect: NSRect(x: x, y: y, width: pillW, height: collapsedH),
                          styleMask: [.borderless, .nonactivatingPanel],
                          backing: .buffered, defer: false)
        panel.isFloatingPanel = true
        panel.level = .modalPanel
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.isMovableByWindowBackground = true
        panel.hidesOnDeactivate = false
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]

        card = GlassCard(frame: NSRect(x: 0, y: 0, width: pillW, height: collapsedH))
        card.autoresizingMask = [.width, .height]
        panel.contentView = card

        // Left icon (sparkles = AI)
        icon = NSImageView(frame: NSRect(x: 22, y: collapsedH/2 - 13, width: 26, height: 26))
        icon.autoresizingMask = [.maxXMargin, .minYMargin]
        if let img = NSImage(systemSymbolName: "sparkles", accessibilityDescription: "JARVIS") {
            let cfg = NSImage.SymbolConfiguration(pointSize: 20, weight: .medium)
            icon.image = img.withSymbolConfiguration(cfg)
        }
        icon.contentTintColor = NSColor(calibratedRed: 1.0, green: 0.75, blue: 0.3, alpha: 1.0)
        card.addSubview(icon)

        // Text field
        field = NSTextField(frame: NSRect(x: 60, y: collapsedH/2 - 18, width: pillW - 120, height: 36))
        field.autoresizingMask = [.width, .minYMargin]
        field.isBordered = false
        field.drawsBackground = false
        field.focusRingType = .none
        field.font = NSFont.systemFont(ofSize: 22, weight: .regular)
        field.textColor = .white
        field.placeholderAttributedString = NSAttributedString(
            string: "Ask JARVIS…",
            attributes: [.foregroundColor: NSColor(white: 1.0, alpha: 0.45),
                         .font: NSFont.systemFont(ofSize: 22, weight: .regular)])
        field.delegate = self
        field.cell?.usesSingleLineMode = true
        field.cell?.wraps = false
        field.cell?.isScrollable = true
        card.addSubview(field)

        // Connection dot (right)
        statusDot = NSView(frame: NSRect(x: pillW - 34, y: collapsedH/2 - 4, width: 8, height: 8))
        statusDot.autoresizingMask = [.minXMargin, .minYMargin]
        statusDot.wantsLayer = true
        statusDot.layer?.cornerRadius = 4
        statusDot.layer?.backgroundColor = NSColor.systemRed.cgColor
        card.addSubview(statusDot)

        // Answer area (hidden until expanded)
        answerScroll = NSScrollView(frame: NSRect(x: 18, y: 16, width: pillW - 36, height: expandedH - collapsedH - 16))
        answerScroll.autoresizingMask = [.width, .height]
        answerScroll.hasVerticalScroller = true
        answerScroll.drawsBackground = false
        answerScroll.borderType = .noBorder
        answerView = NSTextView(frame: answerScroll.bounds)
        answerView.isEditable = false
        answerView.isSelectable = true
        answerView.drawsBackground = false
        answerView.textColor = NSColor(white: 1.0, alpha: 0.92)
        answerView.font = NSFont.systemFont(ofSize: 15)
        answerView.textContainerInset = NSSize(width: 6, height: 8)
        answerScroll.documentView = answerView
        answerScroll.isHidden = true
        card.addSubview(answerScroll)
    }

    // MARK: hotkey (⌥-Space)
    private func registerHotKey() {
        var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard),
                                 eventKind: UInt32(kEventHotKeyPressed))
        InstallEventHandler(GetApplicationEventTarget(), { (_, _, _) -> OSStatus in
            DispatchQueue.main.async { gApp?.togglePill() }
            return noErr
        }, 1, &spec, nil, nil)

        let id = EventHotKeyID(signature: OSType(0x4A505431) /* 'JPT1' */, id: 1)
        RegisterEventHotKey(UInt32(kVK_Space), UInt32(optionKey),
                            id, GetApplicationEventTarget(), 0, &hotKeyRef)
    }

    // MARK: show/hide
    func togglePill() { panel.isVisible ? hidePill() : showPill() }

    func showPill() {
        positionTopCenter()
        NSApp.activate(ignoringOtherApps: true)
        panel.makeKeyAndOrderFront(nil)
        panel.makeFirstResponder(field)
        installClickMonitor()
    }

    func hidePill() {
        removeClickMonitor()
        panel.orderOut(nil)
        collapse()
        field.stringValue = ""
    }

    private func positionTopCenter() {
        let screen = NSScreen.main ?? NSScreen.screens[0]
        let sf = screen.frame
        let h = panel.frame.height
        panel.setFrame(NSRect(x: sf.midX - pillW / 2, y: sf.maxY - 200 - (h - collapsedH),
                              width: pillW, height: h), display: true)
    }

    private func installClickMonitor() {
        clickMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self] _ in
            self?.hidePill()
        }
    }
    private func removeClickMonitor() {
        if let m = clickMonitor { NSEvent.removeMonitor(m); clickMonitor = nil }
    }

    // MARK: expand / collapse
    private func expand() {
        guard !expanded else { return }
        expanded = true
        answerScroll.isHidden = false
        animateHeight(to: expandedH)
    }
    private func collapse() {
        expanded = false
        answerScroll.isHidden = true
        answerView.string = ""
        let f = panel.frame
        panel.setFrame(NSRect(x: f.minX, y: f.maxY - collapsedH, width: pillW, height: collapsedH), display: true)
    }
    private func animateHeight(to h: CGFloat) {
        let f = panel.frame
        let newFrame = NSRect(x: f.minX, y: f.maxY - h, width: pillW, height: h)
        NSAnimationContext.runAnimationGroup { ctx in
            ctx.duration = 0.22
            ctx.timingFunction = CAMediaTimingFunction(name: .easeOut)
            panel.animator().setFrame(newFrame, display: true)
        }
    }

    // MARK: submit + stream
    private func submit() {
        let q = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !q.isEmpty else { return }
        guard link.connected else {
            expand(); answerView.string = "JARVIS isn't running. Start it, then try again."
            return
        }
        expand()
        answerView.string = ""
        streaming = true
        card.active = true
        link.send(q)
    }

    private func appendToken(_ t: String) {
        answerView.textStorage?.append(NSAttributedString(
            string: t,
            attributes: [.foregroundColor: NSColor(white: 1.0, alpha: 0.92),
                         .font: NSFont.systemFont(ofSize: 15)]))
        answerView.scrollToEndOfDocument(nil)
    }

    private func onStatus(_ s: String) {
        switch s {
        case "processing", "speaking", "activated":
            card.active = true
        case "idle":
            if streaming { streaming = false; card.active = false; card.stopGlow() }
        default: break
        }
    }

    private func onConn(_ c: Bool) {
        statusDot.layer?.backgroundColor = (c ? NSColor.systemGreen : NSColor.systemRed).cgColor
    }

    // MARK: NSTextFieldDelegate — Enter submits, Esc hides
    func control(_ control: NSControl, textView: NSTextView, doCommandBy sel: Selector) -> Bool {
        if sel == #selector(NSResponder.insertNewline(_:)) { submit(); return true }
        if sel == #selector(NSResponder.cancelOperation(_:)) { hidePill(); return true }
        return false
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
