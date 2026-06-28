// ── JARVIS Pill — "Golden Gate" Siri-style access surface ──
//
// A compact, draggable capsule summoned with a global hotkey (default ⌥-Space).
// Type a query; it expands into a streaming answer card. Talks to the running
// JARVIS over the watch WebSocket (ws://127.0.0.1:5225):
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
        ping()
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

    private func ping() {
        task?.sendPing { [weak self] err in
            if err != nil { return }
            DispatchQueue.main.asyncAfter(deadline: .now() + 20) { self?.ping() }
        }
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

// MARK: - Glass card: frosted material + opaque-ish tint + animated glow border

final class GlassCard: NSView {
    private let effect = NSVisualEffectView()
    private let tint = NSView()
    private var phase: CGFloat = 0
    private var timer: Timer?

    var active = false {
        didSet {
            if active { startGlow() } else { stopGlow() }
        }
    }

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        layer?.cornerRadius = 22
        layer?.masksToBounds = true
        layer?.borderWidth = 1
        layer?.borderColor = NSColor(white: 1, alpha: 0.14).cgColor

        effect.material = .hudWindow
        effect.blendingMode = .behindWindow
        effect.state = .active
        effect.translatesAutoresizingMaskIntoConstraints = false
        addSubview(effect)

        // Opaque-ish tint so the blurred desktop doesn't bleed through as a
        // muddy wallpaper-coloured blob — gives a clean dark glass surface.
        tint.wantsLayer = true
        tint.layer?.backgroundColor = NSColor(calibratedRed: 0.08, green: 0.08, blue: 0.10, alpha: 0.62).cgColor
        tint.translatesAutoresizingMaskIntoConstraints = false
        addSubview(tint)

        NSLayoutConstraint.activate([
            effect.leadingAnchor.constraint(equalTo: leadingAnchor),
            effect.trailingAnchor.constraint(equalTo: trailingAnchor),
            effect.topAnchor.constraint(equalTo: topAnchor),
            effect.bottomAnchor.constraint(equalTo: bottomAnchor),
            tint.leadingAnchor.constraint(equalTo: leadingAnchor),
            tint.trailingAnchor.constraint(equalTo: trailingAnchor),
            tint.topAnchor.constraint(equalTo: topAnchor),
            tint.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
    }
    required init?(coder: NSCoder) { fatalError() }

    private func startGlow() {
        if timer != nil { return }
        timer = Timer.scheduledTimer(withTimeInterval: 1.0 / 30.0, repeats: true) { [weak self] _ in
            guard let self = self else { return }
            self.phase += 0.045
            // Gentle Siri-ish hue band: blue -> indigo -> violet -> pink.
            let hue = 0.55 + (sin(self.phase) * 0.5 + 0.5) * 0.18
            let c = NSColor(hue: hue.truncatingRemainder(dividingBy: 1.0), saturation: 0.85, brightness: 1.0, alpha: 0.95)
            self.layer?.borderColor = c.cgColor
            self.layer?.borderWidth = 2
        }
    }
    private func stopGlow() {
        timer?.invalidate(); timer = nil
        layer?.borderColor = NSColor(white: 1, alpha: 0.14).cgColor
        layer?.borderWidth = 1
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
    private var divider: NSBox!
    private var answerScroll: NSScrollView!
    private var answerView: NSTextView!
    private var answerHeight: NSLayoutConstraint!
    private let link = JarvisLink()
    private var hotKeyRef: EventHotKeyRef?
    private var clickMonitor: Any?

    private let pillW: CGFloat = 660
    private let collapsedH: CGFloat = 62
    private let expandedH: CGFloat = 380
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
        showPill()
    }

    // MARK: build UI
    private func buildPanel() {
        let screen = NSScreen.main ?? NSScreen.screens[0]
        let sf = screen.frame
        panel = PillPanel(
            contentRect: NSRect(x: sf.midX - pillW / 2, y: sf.maxY - 200, width: pillW, height: collapsedH),
            styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.appearance = NSAppearance(named: .darkAqua)   // consistent dark glass in any system theme
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

        let cream = NSColor(calibratedRed: 0.96, green: 0.94, blue: 0.90, alpha: 1.0)

        icon = NSImageView()
        icon.translatesAutoresizingMaskIntoConstraints = false
        if let img = NSImage(systemSymbolName: "sparkles", accessibilityDescription: "JARVIS") {
            icon.image = img.withSymbolConfiguration(NSImage.SymbolConfiguration(pointSize: 19, weight: .medium))
        }
        icon.contentTintColor = .white
        card.addSubview(icon)

        field = NSTextField()
        field.translatesAutoresizingMaskIntoConstraints = false
        field.isBordered = false
        field.drawsBackground = false
        field.focusRingType = .none
        field.font = NSFont.systemFont(ofSize: 21, weight: .regular)
        field.textColor = cream
        field.placeholderString = ""   // no "Ask JARVIS" label — clean bar
        field.delegate = self
        field.cell?.usesSingleLineMode = true
        field.cell?.wraps = false
        field.cell?.isScrollable = true
        card.addSubview(field)

        statusDot = NSView()
        statusDot.translatesAutoresizingMaskIntoConstraints = false
        statusDot.wantsLayer = true
        statusDot.layer?.cornerRadius = 4
        statusDot.layer?.backgroundColor = NSColor.systemRed.cgColor
        card.addSubview(statusDot)

        divider = NSBox()
        divider.boxType = .separator
        divider.translatesAutoresizingMaskIntoConstraints = false
        divider.isHidden = true
        card.addSubview(divider)

        answerScroll = NSScrollView()
        answerScroll.translatesAutoresizingMaskIntoConstraints = false
        answerScroll.drawsBackground = false
        answerScroll.hasVerticalScroller = true
        answerScroll.borderType = .noBorder
        answerScroll.isHidden = true

        answerView = NSTextView()
        answerView.isEditable = false
        answerView.isSelectable = true
        answerView.drawsBackground = false
        answerView.textColor = NSColor(white: 1, alpha: 0.92)
        answerView.font = NSFont.systemFont(ofSize: 15)
        answerView.textContainerInset = NSSize(width: 6, height: 8)
        // Correct NSTextView-in-scrollview setup so text actually lays out.
        answerView.minSize = NSSize(width: 0, height: 0)
        answerView.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        answerView.isVerticallyResizable = true
        answerView.isHorizontallyResizable = false
        answerView.autoresizingMask = [.width]
        answerView.textContainer?.widthTracksTextView = true
        answerScroll.documentView = answerView
        card.addSubview(answerScroll)

        answerHeight = answerScroll.heightAnchor.constraint(equalToConstant: 0)

        NSLayoutConstraint.activate([
            icon.leadingAnchor.constraint(equalTo: card.leadingAnchor, constant: 22),
            icon.topAnchor.constraint(equalTo: card.topAnchor, constant: 18),
            icon.widthAnchor.constraint(equalToConstant: 26),
            icon.heightAnchor.constraint(equalToConstant: 26),

            statusDot.trailingAnchor.constraint(equalTo: card.trailingAnchor, constant: -22),
            statusDot.centerYAnchor.constraint(equalTo: icon.centerYAnchor),
            statusDot.widthAnchor.constraint(equalToConstant: 8),
            statusDot.heightAnchor.constraint(equalToConstant: 8),

            field.leadingAnchor.constraint(equalTo: icon.trailingAnchor, constant: 12),
            field.trailingAnchor.constraint(equalTo: statusDot.leadingAnchor, constant: -12),
            field.centerYAnchor.constraint(equalTo: icon.centerYAnchor),

            divider.leadingAnchor.constraint(equalTo: card.leadingAnchor, constant: 18),
            divider.trailingAnchor.constraint(equalTo: card.trailingAnchor, constant: -18),
            divider.topAnchor.constraint(equalTo: icon.bottomAnchor, constant: 14),

            answerScroll.leadingAnchor.constraint(equalTo: card.leadingAnchor, constant: 16),
            answerScroll.trailingAnchor.constraint(equalTo: card.trailingAnchor, constant: -16),
            answerScroll.topAnchor.constraint(equalTo: divider.bottomAnchor, constant: 8),
            answerHeight,
        ])
    }

    // MARK: hotkey (⌥-Space)
    private func registerHotKey() {
        var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        InstallEventHandler(GetApplicationEventTarget(), { (_, _, _) -> OSStatus in
            DispatchQueue.main.async { gApp?.togglePill() }
            return noErr
        }, 1, &spec, nil, nil)
        let id = EventHotKeyID(signature: OSType(0x4A505431) /* 'JPT1' */, id: 1)
        RegisterEventHotKey(UInt32(kVK_Space), UInt32(optionKey), id, GetApplicationEventTarget(), 0, &hotKeyRef)
    }

    // MARK: show / hide
    func togglePill() { panel.isVisible ? hidePill() : showPill() }

    func showPill() {
        collapse()
        positionTopCenter()
        NSApp.activate(ignoringOtherApps: true)
        panel.makeKeyAndOrderFront(nil)
        panel.makeFirstResponder(field)
        installClickMonitor()
    }

    func hidePill() {
        removeClickMonitor()
        panel.orderOut(nil)
        field.stringValue = ""
        collapse()
    }

    private func positionTopCenter() {
        let screen = NSScreen.main ?? NSScreen.screens[0]
        let sf = screen.frame
        let h = panel.frame.height
        panel.setFrame(NSRect(x: sf.midX - pillW / 2, y: sf.maxY - 200 - (h - collapsedH), width: pillW, height: h), display: true)
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
        divider.isHidden = false
        answerScroll.isHidden = false
        answerHeight.constant = expandedH - collapsedH - 24
        setWindowHeight(expandedH, animate: true)
    }
    private func collapse() {
        expanded = false
        divider.isHidden = true
        answerScroll.isHidden = true
        answerView.string = ""
        answerHeight.constant = 0
        setWindowHeight(collapsedH, animate: false)
    }
    private func setWindowHeight(_ h: CGFloat, animate: Bool) {
        let f = panel.frame
        let newFrame = NSRect(x: f.minX, y: f.maxY - h, width: pillW, height: h)
        if animate {
            NSAnimationContext.runAnimationGroup { ctx in
                ctx.duration = 0.2
                ctx.timingFunction = CAMediaTimingFunction(name: .easeOut)
                panel.animator().setFrame(newFrame, display: true)
            }
        } else {
            panel.setFrame(newFrame, display: true)
        }
    }

    // MARK: submit + stream
    private func submit() {
        let q = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !q.isEmpty else { return }
        expand()
        answerView.string = ""
        if !link.connected {
            answerView.string = "JARVIS isn’t running. Start it (npm run dev), then try again."
            return
        }
        streaming = true
        card.active = true
        link.send(q)
    }

    private func appendToken(_ t: String) {
        answerView.textStorage?.append(NSAttributedString(
            string: t,
            attributes: [.foregroundColor: NSColor(white: 1, alpha: 0.92),
                         .font: NSFont.systemFont(ofSize: 15)]))
        answerView.scrollToEndOfDocument(nil)
    }

    private func onStatus(_ s: String) {
        switch s {
        case "processing", "speaking", "activated": card.active = true
        case "idle": if streaming { streaming = false; card.active = false }
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
