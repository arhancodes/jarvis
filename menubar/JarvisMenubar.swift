import Cocoa

// ── JARVIS Arc Reactor Overlay + Fullscreen Energy Orb ──
// A floating MCU-style holographic widget in the top-right corner.
// Click it to open a fullscreen energy orb visualization that
// vibrates/pulses when JARVIS speaks. Press Escape or click to dismiss.

// MARK: - Status Model

struct JarvisStatus: Decodable {
    let running: Bool
    let voiceActive: Bool
    let state: String
    let lastCommand: String?
    let lastCommandTime: Double?
    let modulesLoaded: Int?
    let pid: Int?
    // Richer status (optional so older status files still decode)
    let recentCommands: [String]?
    let sidecarReady: Bool?
    let whatsappConnected: Bool?
    let model: String?
    let bootTime: Double?
}

// MARK: - Arc Reactor View (small widget)

protocol ReactorClickDelegate: AnyObject {
    func reactorClicked()
}

class ArcReactorView: NSView {
    weak var clickDelegate: ReactorClickDelegate?
    var rotation: CGFloat = 0
    var innerRotation: CGFloat = 0
    var scanAngle: CGFloat = 0
    var pulsePhase: CGFloat = 0
    var currentState = "offline"
    var voiceActive = false

    var flashBrightness: CGFloat = 0
    private var prevState = "offline"

    struct Particle {
        var angle: CGFloat
        var radius: CGFloat
        var speed: CGFloat
        var size: CGFloat
        var alpha: CGFloat
    }
    var particles: [Particle] = []

    struct Tendril {
        var baseAngle: CGFloat
        var length: CGFloat
        var wobble: CGFloat
        var speed: CGFloat
    }
    var tendrils: [Tendril] = []

    override init(frame: NSRect) {
        super.init(frame: frame)
        for _ in 0..<35 {
            particles.append(Particle(
                angle: .random(in: 0...(.pi * 2)),
                radius: .random(in: 0.15...0.95),
                speed: .random(in: 0.2...2.5),
                size: .random(in: 0.5...2.5),
                alpha: .random(in: 0.3...1.0)
            ))
        }
        for _ in 0..<8 {
            tendrils.append(Tendril(
                baseAngle: .random(in: 0...(.pi * 2)),
                length: .random(in: 0.5...0.9),
                wobble: .random(in: 0.02...0.08),
                speed: .random(in: 0.3...1.2)
            ))
        }
    }

    required init?(coder: NSCoder) { fatalError() }

    // Left-click → toggle fullscreen orb
    override func mouseDown(with event: NSEvent) {
        clickDelegate?.reactorClicked()
    }

    // Right-click → context menu (default NSView behavior with menu set)
    override func rightMouseDown(with event: NSEvent) {
        if let menu = self.menu {
            NSMenu.popUpContextMenu(menu, with: event, for: self)
        }
    }

    func tick(dt: CGFloat) {
        let speed: CGFloat
        switch currentState {
        case "activated":  speed = 3.5
        case "processing": speed = 2.8
        case "speaking":   speed = 2.0
        case "idle":       speed = voiceActive ? 1.0 : 0.25
        default:           speed = 0.1
        }

        rotation += dt * speed * 0.35
        innerRotation -= dt * speed * 0.22
        scanAngle += dt * speed * 1.2
        pulsePhase += dt * (speed * 1.5 + 0.3)

        for i in 0..<particles.count {
            particles[i].angle += dt * particles[i].speed * speed * 0.35
        }
        for i in 0..<tendrils.count {
            tendrils[i].baseAngle += dt * tendrils[i].speed * speed * 0.15
        }

        if currentState != prevState {
            flashBrightness = 1.0
            prevState = currentState
        }
        flashBrightness *= 0.92

        needsDisplay = true
    }

    override func draw(_ dirtyRect: NSRect) {
        guard let ctx = NSGraphicsContext.current?.cgContext else { return }

        let center = CGPoint(x: bounds.midX, y: bounds.midY)
        let maxR = min(bounds.width, bounds.height) / 2 - 8

        let pulse = (1 + sin(pulsePhase)) / 2
        let _ = (1 + sin(pulsePhase * 0.7 + 1.0)) / 2

        var brightness: CGFloat
        switch currentState {
        case "offline":    brightness = 0.08 + 0.02 * pulse
        case "idle":       brightness = voiceActive ? (0.5 + 0.12 * pulse) : (0.15 + 0.04 * pulse)
        case "activated":  brightness = 0.8 + 0.2 * pulse
        case "processing": brightness = 0.7 + 0.2 * pulse
        case "speaking":   brightness = 0.6 + 0.25 * pulse
        default:           brightness = 0.08
        }

        brightness = min(1.0, brightness + flashBrightness * 0.5)

        ctx.saveGState()

        let bgR = maxR + 4
        ctx.setFillColor(CGColor(red: 0.02, green: 0.02, blue: 0.03, alpha: 0.88))
        ctx.fillEllipse(in: CGRect(x: center.x - bgR, y: center.y - bgR, width: bgR * 2, height: bgR * 2))

        ctx.setStrokeColor(CGColor(red: 0.15, green: 0.12, blue: 0.05, alpha: 0.6))
        ctx.setLineWidth(1.0)
        ctx.addEllipse(in: CGRect(x: center.x - bgR, y: center.y - bgR, width: bgR * 2, height: bgR * 2))
        ctx.strokePath()

        if let grad = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: [
            CGColor(red: 1.0, green: 0.65, blue: 0.1, alpha: brightness * 0.08),
            CGColor(red: 0.7, green: 0.4, blue: 0.0, alpha: 0),
        ] as CFArray, locations: [0, 1]) {
            ctx.drawRadialGradient(grad, startCenter: center, startRadius: 0, endCenter: center, endRadius: maxR * 0.9, options: [])
        }

        let gold      = CGColor(red: 1.0, green: 0.72, blue: 0.22, alpha: brightness)
        let brightG   = CGColor(red: 1.0, green: 0.9,  blue: 0.5,  alpha: min(1.0, brightness * 1.5))
        let dimGold   = CGColor(red: 0.85, green: 0.55, blue: 0.1,  alpha: brightness * 0.45)
        let glowColor = CGColor(red: 1.0, green: 0.7,  blue: 0.2,  alpha: brightness * 0.5)
        let faintGold = CGColor(red: 0.9, green: 0.6,  blue: 0.15, alpha: brightness * 0.25)

        // Outer ring
        ctx.setStrokeColor(gold)
        ctx.setLineWidth(1.5)
        ctx.setShadow(offset: .zero, blur: 10, color: glowColor)
        ctx.addEllipse(in: CGRect(x: center.x - maxR, y: center.y - maxR, width: maxR * 2, height: maxR * 2))
        ctx.strokePath()

        // Outer tick marks
        ctx.setShadow(offset: .zero, blur: 0, color: nil)
        ctx.setStrokeColor(dimGold)
        ctx.setLineWidth(0.7)
        for i in 0..<36 {
            let angle = CGFloat(i) * (.pi * 2 / 36) + rotation * 0.05
            let long = i % 6 == 0
            let medium = i % 3 == 0
            let inner = maxR * (long ? 0.88 : (medium ? 0.92 : 0.95))
            let outer = maxR * 0.99
            ctx.move(to: CGPoint(x: center.x + cos(angle) * inner, y: center.y + sin(angle) * inner))
            ctx.addLine(to: CGPoint(x: center.x + cos(angle) * outer, y: center.y + sin(angle) * outer))
        }
        ctx.strokePath()

        // 3 rotating bright outer arcs
        ctx.setStrokeColor(brightG)
        ctx.setLineWidth(2.5)
        ctx.setShadow(offset: .zero, blur: 14, color: glowColor)
        for i in 0..<3 {
            let start = rotation + CGFloat(i) * (.pi * 2 / 3)
            ctx.addArc(center: center, radius: maxR * 0.84, startAngle: start, endAngle: start + .pi / 4, clockwise: false)
            ctx.strokePath()
        }

        // Second outer arc set
        ctx.setStrokeColor(gold)
        ctx.setLineWidth(1.2)
        ctx.setShadow(offset: .zero, blur: 8, color: glowColor)
        for i in 0..<3 {
            let start = -rotation * 0.6 + CGFloat(i) * (.pi * 2 / 3) + .pi / 6
            ctx.addArc(center: center, radius: maxR * 0.78, startAngle: start, endAngle: start + .pi / 5, clockwise: false)
            ctx.strokePath()
        }

        // Middle ring
        let midR = maxR * 0.65
        ctx.setStrokeColor(dimGold)
        ctx.setLineWidth(0.8)
        ctx.setShadow(offset: .zero, blur: 6, color: glowColor)
        ctx.addEllipse(in: CGRect(x: center.x - midR, y: center.y - midR, width: midR * 2, height: midR * 2))
        ctx.strokePath()

        // 4 inner rotating arcs
        ctx.setStrokeColor(gold)
        ctx.setLineWidth(2.0)
        ctx.setShadow(offset: .zero, blur: 10, color: glowColor)
        for i in 0..<4 {
            let start = innerRotation + CGFloat(i) * (.pi / 2)
            ctx.addArc(center: center, radius: maxR * 0.52, startAngle: start, endAngle: start + .pi / 7, clockwise: false)
            ctx.strokePath()
        }

        // Inner ring
        let innerR = maxR * 0.38
        ctx.setStrokeColor(gold)
        ctx.setLineWidth(1.0)
        ctx.setShadow(offset: .zero, blur: 8, color: glowColor)
        ctx.addEllipse(in: CGRect(x: center.x - innerR, y: center.y - innerR, width: innerR * 2, height: innerR * 2))
        ctx.strokePath()

        // Innermost ring
        let innermostR = maxR * 0.22
        ctx.setStrokeColor(faintGold)
        ctx.setLineWidth(0.6)
        ctx.setShadow(offset: .zero, blur: 4, color: glowColor)
        ctx.addEllipse(in: CGRect(x: center.x - innermostR, y: center.y - innermostR, width: innermostR * 2, height: innermostR * 2))
        ctx.strokePath()

        // Energy tendrils
        ctx.setShadow(offset: .zero, blur: 6, color: glowColor)
        ctx.setLineWidth(0.8)
        for t in tendrils {
            let wobbleOffset = sin(pulsePhase * 2 + t.baseAngle * 3) * t.wobble
            let angle = t.baseAngle + wobbleOffset
            let fromR = innerR * 0.8
            let toR = maxR * t.length
            ctx.setStrokeColor(CGColor(red: 1.0, green: 0.75, blue: 0.25, alpha: brightness * 0.35))
            ctx.move(to: CGPoint(x: center.x + cos(angle) * fromR, y: center.y + sin(angle) * fromR))
            ctx.addLine(to: CGPoint(x: center.x + cos(angle) * toR, y: center.y + sin(angle) * toR))
            ctx.strokePath()
        }

        // Radial scan beam
        ctx.setShadow(offset: .zero, blur: 0, color: nil)
        if let scanGrad = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: [
            CGColor(red: 1.0, green: 0.8, blue: 0.3, alpha: brightness * 0.25),
            CGColor(red: 1.0, green: 0.7, blue: 0.2, alpha: 0),
        ] as CFArray, locations: [0, 1]) {
            ctx.saveGState()
            ctx.move(to: center)
            ctx.addArc(center: center, radius: maxR * 0.95, startAngle: scanAngle, endAngle: scanAngle + .pi / 8, clockwise: false)
            ctx.closePath()
            ctx.clip()
            ctx.drawRadialGradient(scanGrad, startCenter: center, startRadius: innermostR, endCenter: center, endRadius: maxR * 0.95, options: [])
            ctx.restoreGState()
        }

        // Particles
        for p in particles {
            let r = maxR * p.radius
            let x = center.x + cos(p.angle) * r
            let y = center.y + sin(p.angle) * r
            let a = brightness * p.alpha
            ctx.setShadow(offset: .zero, blur: 3, color: CGColor(red: 1, green: 0.8, blue: 0.3, alpha: a))
            ctx.setFillColor(CGColor(red: 1.0, green: 0.88, blue: 0.45, alpha: a))
            ctx.fillEllipse(in: CGRect(x: x - p.size / 2, y: y - p.size / 2, width: p.size, height: p.size))
        }

        // Core glow
        if let coreGrad = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: [
            CGColor(red: 1.0, green: 0.95, blue: 0.75, alpha: min(1.0, brightness * 1.6)),
            CGColor(red: 1.0, green: 0.82, blue: 0.35, alpha: brightness * 0.9),
            CGColor(red: 1.0, green: 0.6,  blue: 0.12, alpha: brightness * 0.25),
            CGColor(red: 1.0, green: 0.5,  blue: 0.0,  alpha: 0),
        ] as CFArray, locations: [0, 0.12, 0.35, 1.0]) {
            let coreR = innermostR * (1.2 + 0.2 * pulse)
            ctx.setShadow(offset: .zero, blur: 0, color: nil)
            ctx.drawRadialGradient(coreGrad, startCenter: center, startRadius: 0, endCenter: center, endRadius: coreR, options: [])
        }

        // Core dot
        let dotR = maxR * 0.035 * (1 + 0.15 * pulse)
        ctx.setShadow(offset: .zero, blur: 10, color: brightG)
        ctx.setFillColor(CGColor(red: 1.0, green: 0.97, blue: 0.85, alpha: min(1.0, brightness * 2.0)))
        ctx.fillEllipse(in: CGRect(x: center.x - dotR, y: center.y - dotR, width: dotR * 2, height: dotR * 2))

        // HUD crosshairs
        ctx.setShadow(offset: .zero, blur: 0, color: nil)
        ctx.setStrokeColor(CGColor(red: 1.0, green: 0.72, blue: 0.22, alpha: brightness * 0.18))
        ctx.setLineWidth(0.5)
        ctx.move(to: CGPoint(x: center.x - maxR * 0.15, y: center.y))
        ctx.addLine(to: CGPoint(x: center.x - innerR * 1.2, y: center.y))
        ctx.move(to: CGPoint(x: center.x + maxR * 0.15, y: center.y))
        ctx.addLine(to: CGPoint(x: center.x + innerR * 1.2, y: center.y))
        ctx.move(to: CGPoint(x: center.x, y: center.y - maxR * 0.15))
        ctx.addLine(to: CGPoint(x: center.x, y: center.y - innerR * 1.2))
        ctx.move(to: CGPoint(x: center.x, y: center.y + maxR * 0.15))
        ctx.addLine(to: CGPoint(x: center.x, y: center.y + innerR * 1.2))
        ctx.strokePath()

        // State label
        let label: String
        switch currentState {
        case "idle":       label = voiceActive ? "LISTENING" : "ONLINE"
        case "activated":  label = "ACTIVATED"
        case "processing": label = "PROCESSING"
        case "speaking":   label = "SPEAKING"
        case "offline":    label = "OFFLINE"
        default:           label = "STANDBY"
        }

        let attrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.monospacedSystemFont(ofSize: 7.5, weight: .medium),
            .foregroundColor: NSColor(red: 1.0, green: 0.72, blue: 0.22, alpha: brightness * 0.85),
        ]
        let str = NSAttributedString(string: label, attributes: attrs)
        let strSize = str.size()
        let strPoint = CGPoint(x: center.x - strSize.width / 2, y: center.y - maxR - 1)
        str.draw(at: strPoint)

        ctx.restoreGState()
    }
}

// MARK: - Fullscreen Energy Orb View

class EnergyOrbView: NSView {
    var currentState = "offline"
    var voiceActive = false
    var time: CGFloat = 0

    // Speaking pulse (gentle glow)
    var speakingAmplitude: CGFloat = 0
    var speakingTarget: CGFloat = 0

    // Orb particles — lots of them for the dense energy sphere look
    struct OrbParticle {
        var angle: CGFloat       // orbital angle
        var elevation: CGFloat   // -pi/2 to pi/2 — latitude on sphere
        var radius: CGFloat      // distance from center (0..1)
        var speed: CGFloat       // orbital speed
        var size: CGFloat
        var alpha: CGFloat
        var drift: CGFloat       // radial wobble speed
    }
    var particles: [OrbParticle] = []

    // Energy filaments — radial lines that shoot outward
    struct Filament {
        var angle: CGFloat
        var length: CGFloat      // 0..1
        var speed: CGFloat
        var wobbleFreq: CGFloat
        var wobbleAmp: CGFloat
        var thickness: CGFloat
    }
    var filaments: [Filament] = []

    // Ring distortion data
    struct EnergyRing {
        var baseRadius: CGFloat   // 0..1 fraction of orbR
        var thickness: CGFloat
        var speed: CGFloat
        var segments: Int
        var alpha: CGFloat
    }
    let rings: [EnergyRing] = [
        EnergyRing(baseRadius: 0.92, thickness: 2.5, speed: 0.15, segments: 120, alpha: 0.7),
        EnergyRing(baseRadius: 0.78, thickness: 2.0, speed: -0.22, segments: 100, alpha: 0.55),
        EnergyRing(baseRadius: 0.62, thickness: 1.8, speed: 0.30, segments: 90, alpha: 0.45),
        EnergyRing(baseRadius: 0.45, thickness: 1.5, speed: -0.18, segments: 80, alpha: 0.35),
        EnergyRing(baseRadius: 0.30, thickness: 1.2, speed: 0.25, segments: 60, alpha: 0.3),
    ]

    override init(frame: NSRect) {
        super.init(frame: frame)

        // Generate sphere particles — dense cloud
        for _ in 0..<250 {
            particles.append(OrbParticle(
                angle: .random(in: 0...(.pi * 2)),
                elevation: .random(in: -(.pi / 2)...(.pi / 2)),
                radius: .random(in: 0.08...1.0),
                speed: .random(in: 0.1...1.8),
                size: .random(in: 1.0...4.5),
                alpha: .random(in: 0.15...0.9),
                drift: .random(in: 0.3...2.0)
            ))
        }

        // Generate filaments — energy tendrils shooting outward
        for _ in 0..<40 {
            filaments.append(Filament(
                angle: .random(in: 0...(.pi * 2)),
                length: .random(in: 0.3...1.0),
                speed: .random(in: 0.05...0.5),
                wobbleFreq: .random(in: 1.0...4.0),
                wobbleAmp: .random(in: 0.02...0.12),
                thickness: .random(in: 0.5...2.5)
            ))
        }
    }

    required init?(coder: NSCoder) { fatalError() }

    // Delegate for dismissing
    weak var dismissDelegate: FullScreenDismissDelegate?

    override var acceptsFirstResponder: Bool { true }

    // Click anywhere to dismiss
    override func mouseDown(with event: NSEvent) {
        dismissDelegate?.dismissFullScreen()
    }

    // Escape to dismiss
    override func keyDown(with event: NSEvent) {
        if event.keyCode == 53 {
            dismissDelegate?.dismissFullScreen()
        }
    }

    func tick(dt: CGFloat) {
        // Base speed from state
        let speed: CGFloat
        switch currentState {
        case "activated":  speed = 3.0
        case "processing": speed = 2.2
        case "speaking":   speed = 1.8
        case "idle":       speed = voiceActive ? 0.8 : 0.3
        default:           speed = 0.08
        }

        time += dt * speed

        // Speaking pulse — smooth sine wave, no jitter
        if currentState == "speaking" {
            speakingTarget = 0.5 + 0.5 * sin(time * 3.0)  // gentle ~0.5Hz sine
        } else {
            speakingTarget = 0
        }
        speakingAmplitude += (speakingTarget - speakingAmplitude) * min(1.0, dt * 6.0)

        // Animate particles — orbit only, no radial drift
        for i in 0..<particles.count {
            particles[i].angle += dt * particles[i].speed * speed * 0.4
        }

        // Animate filaments
        for i in 0..<filaments.count {
            filaments[i].angle += dt * filaments[i].speed * speed
        }

        needsDisplay = true
    }

    override func draw(_ dirtyRect: NSRect) {
        guard let ctx = NSGraphicsContext.current?.cgContext else { return }

        let W = bounds.width
        let H = bounds.height
        let center = CGPoint(x: W / 2, y: H / 2)
        let orbR = min(W, H) * 0.28  // Main orb radius

        // No position shifting — orb stays centered
        let orbCenter = center

        // Dynamic radius — gentle breathing, soft pulse when speaking
        let breathe = sin(time * 0.8) * 0.03
        let speakPulse = speakingAmplitude * 0.05  // gentle ~5% radius swell
        let dynamicR = orbR * (1.0 + breathe + speakPulse)

        // Brightness
        var brightness: CGFloat
        switch currentState {
        case "offline":    brightness = 0.06
        case "idle":       brightness = voiceActive ? 0.55 : 0.2
        case "activated":  brightness = 0.9
        case "processing": brightness = 0.75
        case "speaking":   brightness = 0.7 + speakingAmplitude * 0.3
        default:           brightness = 0.06
        }

        ctx.saveGState()

        // ── Black background ──
        ctx.setFillColor(CGColor(red: 0, green: 0, blue: 0, alpha: 1))
        ctx.fill(bounds)

        // ── Outer ambient glow (large, soft) ──
        if let outerGlow = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: [
            CGColor(red: 1.0, green: 0.6, blue: 0.1, alpha: brightness * 0.12),
            CGColor(red: 0.8, green: 0.4, blue: 0.05, alpha: brightness * 0.04),
            CGColor(red: 0, green: 0, blue: 0, alpha: 0),
        ] as CFArray, locations: [0, 0.4, 1]) {
            ctx.drawRadialGradient(outerGlow, startCenter: orbCenter, startRadius: 0, endCenter: orbCenter, endRadius: dynamicR * 2.5, options: [])
        }

        // ── Energy filaments (radial tendrils shooting from core) ──
        for f in filaments {
            let wobble = sin(time * f.wobbleFreq + f.angle * 3.0) * f.wobbleAmp
            let angle = f.angle + wobble
            let fromR = dynamicR * 0.15
            let finalToR = dynamicR * (0.6 + f.length * 0.8)

            let alpha = brightness * 0.2 * (0.3 + f.length * 0.7)
            ctx.setStrokeColor(CGColor(red: 1.0, green: 0.7, blue: 0.2, alpha: alpha))
            ctx.setLineWidth(f.thickness)
            ctx.setShadow(offset: .zero, blur: 8, color: CGColor(red: 1, green: 0.6, blue: 0.1, alpha: alpha * 0.5))

            ctx.move(to: CGPoint(x: orbCenter.x + cos(angle) * fromR, y: orbCenter.y + sin(angle) * fromR))
            ctx.addLine(to: CGPoint(x: orbCenter.x + cos(angle) * finalToR, y: orbCenter.y + sin(angle) * finalToR))
            ctx.strokePath()
        }

        // ── Distorted energy rings ──
        for ring in rings {
            let ringR = dynamicR * ring.baseRadius
            let ringAlpha = brightness * ring.alpha
            let ringTime = time * ring.speed

            ctx.setStrokeColor(CGColor(red: 1.0, green: 0.72, blue: 0.22, alpha: ringAlpha))
            ctx.setLineWidth(ring.thickness)
            ctx.setShadow(offset: .zero, blur: 12, color: CGColor(red: 1, green: 0.65, blue: 0.15, alpha: ringAlpha * 0.6))

            // Draw distorted circle — each segment displaced by noise
            let segCount = ring.segments
            for s in 0..<segCount {
                let angle = CGFloat(s) * (.pi * 2 / CGFloat(segCount)) + ringTime
                let nextAngle = CGFloat(s + 1) * (.pi * 2 / CGFloat(segCount)) + ringTime

                // Noise displacement — subtle organic distortion
                let noiseBase = sin(angle * 3.0 + time * 2.0) * 0.04 + sin(angle * 7.0 - time * 3.5) * 0.025
                let displacement = 1.0 + noiseBase

                let r1 = ringR * displacement
                let noiseBase2 = sin(nextAngle * 3.0 + time * 2.0) * 0.04 + sin(nextAngle * 7.0 - time * 3.5) * 0.025
                let r2 = ringR * (1.0 + noiseBase2)

                let p1 = CGPoint(x: orbCenter.x + cos(angle) * r1, y: orbCenter.y + sin(angle) * r1)
                let p2 = CGPoint(x: orbCenter.x + cos(nextAngle) * r2, y: orbCenter.y + sin(nextAngle) * r2)
                ctx.move(to: p1)
                ctx.addLine(to: p2)
            }
            ctx.strokePath()
        }

        // ── Particles — dense energy cloud ──
        for p in particles {
            let r = dynamicR * p.radius
            // Project sphere particle: use elevation to scale radius (closer to poles = smaller orbit)
            let projectedR = r * cos(p.elevation)
            let x = orbCenter.x + cos(p.angle) * projectedR
            let y = orbCenter.y + sin(p.angle) * projectedR + sin(p.elevation) * r * 0.3

            let depthFade = (1.0 + cos(p.elevation)) / 2.0  // fade at edges
            let a = brightness * p.alpha * depthFade

            let sz = p.size * (0.8 + 0.4 * depthFade)

            ctx.setShadow(offset: .zero, blur: 4, color: CGColor(red: 1, green: 0.75, blue: 0.25, alpha: a * 0.4))
            ctx.setFillColor(CGColor(red: 1.0, green: 0.85, blue: 0.4, alpha: a))
            ctx.fillEllipse(in: CGRect(x: x - sz / 2, y: y - sz / 2, width: sz, height: sz))
        }

        // ── Inner glow sphere (the bright core mass) ──
        let coreR = dynamicR * (0.35 + speakingAmplitude * 0.03)
        if let coreGrad = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: [
            CGColor(red: 1.0, green: 0.97, blue: 0.85, alpha: min(1.0, brightness * 1.8)),
            CGColor(red: 1.0, green: 0.85, blue: 0.45, alpha: brightness * 1.2),
            CGColor(red: 1.0, green: 0.65, blue: 0.15, alpha: brightness * 0.5),
            CGColor(red: 1.0, green: 0.5,  blue: 0.05, alpha: brightness * 0.15),
            CGColor(red: 0.8, green: 0.3,  blue: 0.0,  alpha: 0),
        ] as CFArray, locations: [0, 0.1, 0.3, 0.6, 1.0]) {
            ctx.drawRadialGradient(coreGrad, startCenter: orbCenter, startRadius: 0, endCenter: orbCenter, endRadius: coreR, options: [])
        }

        // ── Bright center point ──
        let dotR = dynamicR * 0.04 * (1.0 + speakingAmplitude * 0.15)
        ctx.setShadow(offset: .zero, blur: 20, color: CGColor(red: 1, green: 0.9, blue: 0.5, alpha: brightness))
        ctx.setFillColor(CGColor(red: 1.0, green: 0.98, blue: 0.9, alpha: min(1.0, brightness * 2.0)))
        ctx.fillEllipse(in: CGRect(x: orbCenter.x - dotR, y: orbCenter.y - dotR, width: dotR * 2, height: dotR * 2))

        // ── Subtle HUD frame corners ──
        ctx.setShadow(offset: .zero, blur: 0, color: nil)
        let frameAlpha = brightness * 0.12
        ctx.setStrokeColor(CGColor(red: 1.0, green: 0.72, blue: 0.22, alpha: frameAlpha))
        ctx.setLineWidth(1.0)
        let margin: CGFloat = 40
        let cornerLen: CGFloat = 60

        // Top-left
        ctx.move(to: CGPoint(x: margin, y: H - margin - cornerLen))
        ctx.addLine(to: CGPoint(x: margin, y: H - margin))
        ctx.addLine(to: CGPoint(x: margin + cornerLen, y: H - margin))
        // Top-right
        ctx.move(to: CGPoint(x: W - margin - cornerLen, y: H - margin))
        ctx.addLine(to: CGPoint(x: W - margin, y: H - margin))
        ctx.addLine(to: CGPoint(x: W - margin, y: H - margin - cornerLen))
        // Bottom-left
        ctx.move(to: CGPoint(x: margin, y: margin + cornerLen))
        ctx.addLine(to: CGPoint(x: margin, y: margin))
        ctx.addLine(to: CGPoint(x: margin + cornerLen, y: margin))
        // Bottom-right
        ctx.move(to: CGPoint(x: W - margin - cornerLen, y: margin))
        ctx.addLine(to: CGPoint(x: W - margin, y: margin))
        ctx.addLine(to: CGPoint(x: W - margin, y: margin + cornerLen))
        ctx.strokePath()

        // ── State label at bottom ──
        let label: String
        switch currentState {
        case "idle":       label = voiceActive ? "LISTENING" : "ONLINE"
        case "activated":  label = "ACTIVATED"
        case "processing": label = "PROCESSING"
        case "speaking":   label = "SPEAKING"
        case "offline":    label = "OFFLINE"
        default:           label = "STANDBY"
        }

        let labelFont = NSFont.monospacedSystemFont(ofSize: 14, weight: .medium)
        let labelAttrs: [NSAttributedString.Key: Any] = [
            .font: labelFont,
            .foregroundColor: NSColor(red: 1.0, green: 0.72, blue: 0.22, alpha: brightness * 0.7),
        ]
        let labelStr = NSAttributedString(string: "J.A.R.V.I.S.  //  \(label)", attributes: labelAttrs)
        let labelSize = labelStr.size()
        labelStr.draw(at: CGPoint(x: center.x - labelSize.width / 2, y: margin + 10))

        ctx.restoreGState()
    }
}

// MARK: - Dismiss Protocol

protocol FullScreenDismissDelegate: AnyObject {
    func dismissFullScreen()
}

// MARK: - Floating Widget Window

class ReactorWindow: NSPanel {
    init(size: CGFloat) {
        let screen = NSScreen.main ?? NSScreen.screens[0]
        let screenFrame = screen.frame
        let padding: CGFloat = 4
        let x = screenFrame.maxX - size - padding
        let y = screenFrame.maxY - 38 - size

        super.init(
            contentRect: NSRect(x: x, y: y, width: size, height: size),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )

        isOpaque = false
        backgroundColor = .clear
        level = .statusBar  // Higher than .floating — survives app activation changes
        collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary, .ignoresCycle]
        hasShadow = false
        isMovableByWindowBackground = true
        hidesOnDeactivate = false
    }
}

// MARK: - Fullscreen Orb Window

class FullScreenOrbWindow: NSWindow {
    init() {
        let screen = NSScreen.main ?? NSScreen.screens[0]
        super.init(
            contentRect: screen.frame,
            styleMask: [.borderless],
            backing: .buffered,
            defer: false
        )

        isOpaque = true
        backgroundColor = .black
        level = .init(rawValue: NSWindow.Level.floating.rawValue + 1)
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        hasShadow = false
    }
}

// MARK: - App Delegate

class JarvisOverlayApp: NSObject, NSApplicationDelegate, ReactorClickDelegate, FullScreenDismissDelegate {
    var window: ReactorWindow!
    var reactorView: ArcReactorView!
    var animTimer: Timer?
    var pollTimer: Timer?

    // Fullscreen orb
    var fullScreenWindow: FullScreenOrbWindow?
    var orbView: EnergyOrbView?
    var isFullScreenOpen = false
    var globalEscMonitor: Any?

    let statusPath = "/tmp/jarvis-status.json"
    let widgetSize: CGFloat = 70

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)

        // Create floating widget window
        window = ReactorWindow(size: widgetSize)
        reactorView = ArcReactorView(frame: NSRect(x: 0, y: 0, width: widgetSize, height: widgetSize))
        reactorView.clickDelegate = self
        window.contentView = reactorView

        // Right-click context menu
        let menu = NSMenu()

        let titleItem = NSMenuItem(title: "J.A.R.V.I.S.", action: nil, keyEquivalent: "")
        titleItem.isEnabled = false
        titleItem.attributedTitle = NSAttributedString(
            string: "J.A.R.V.I.S.",
            attributes: [.font: NSFont.boldSystemFont(ofSize: 13), .foregroundColor: NSColor.labelColor]
        )
        menu.addItem(titleItem)
        menu.addItem(.separator())

        // Helper to add a disabled, tagged info row.
        func infoRow(_ title: String, _ tag: Int) {
            let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
            item.isEnabled = false
            item.tag = tag
            menu.addItem(item)
        }

        infoRow("Status: Checking...", 100)
        infoRow("Voice: \u{2014}", 101)

        menu.addItem(.separator())

        // Connection indicators
        infoRow("Sidecar: \u{2014}", 103)
        infoRow("WhatsApp: \u{2014}", 104)
        infoRow("Model: \u{2014}", 105)
        infoRow("Modules: \u{2014}", 106)

        menu.addItem(.separator())

        // Recent activity
        let recentHeader = NSMenuItem(title: "Recent", action: nil, keyEquivalent: "")
        recentHeader.isEnabled = false
        recentHeader.attributedTitle = NSAttributedString(
            string: "RECENT",
            attributes: [.font: NSFont.systemFont(ofSize: 10, weight: .semibold), .foregroundColor: NSColor.secondaryLabelColor]
        )
        menu.addItem(recentHeader)
        infoRow("  \u{2014}", 110)
        infoRow("  ", 111)
        infoRow("  ", 112)

        menu.addItem(.separator())

        let quitItem = NSMenuItem(title: "Quit Overlay", action: #selector(quitApp), keyEquivalent: "q")
        quitItem.target = self
        menu.addItem(quitItem)

        reactorView.menu = menu
        window.orderFront(nil)

        // Animation: ~30fps — drives both widget and fullscreen orb
        animTimer = Timer.scheduledTimer(withTimeInterval: 1.0 / 30.0, repeats: true) { [weak self] _ in
            let dt: CGFloat = 1.0 / 30.0
            self?.reactorView.tick(dt: dt)
            self?.orbView?.tick(dt: dt)
        }

        // Poll status + keep widget visible
        pollTimer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
            self?.pollStatus()
            // Re-assert widget visibility when fullscreen is NOT open
            if self?.isFullScreenOpen != true {
                self?.window.orderFront(nil)
            }
        }

        // Local Escape monitor (works when app is active)
        NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            if event.keyCode == 53 && self?.isFullScreenOpen == true {
                self?.dismissFullScreen()
                return nil
            }
            return event
        }

        pollStatus()
    }

    // MARK: - Click handler — open fullscreen orb

    func reactorClicked() {
        if !isFullScreenOpen {
            openFullScreen()
        }
    }

    func openFullScreen() {
        guard !isFullScreenOpen else { return }

        // Hide the small widget while fullscreen is open
        window.orderOut(nil)

        let fsWindow = FullScreenOrbWindow()
        let screen = NSScreen.main ?? NSScreen.screens[0]
        let orbV = EnergyOrbView(frame: NSRect(origin: .zero, size: screen.frame.size))
        orbV.currentState = reactorView.currentState
        orbV.voiceActive = reactorView.voiceActive
        orbV.dismissDelegate = self

        fsWindow.contentView = orbV
        fsWindow.makeKeyAndOrderFront(nil)
        fsWindow.makeFirstResponder(orbV)

        // Activate app so key events (Escape) are delivered to us
        NSApp.activate(ignoringOtherApps: true)

        fullScreenWindow = fsWindow
        orbView = orbV
        isFullScreenOpen = true

        // Global Escape monitor — catches Escape even if app loses focus
        globalEscMonitor = NSEvent.addGlobalMonitorForEvents(matching: .keyDown) { [weak self] event in
            if event.keyCode == 53 && self?.isFullScreenOpen == true {
                DispatchQueue.main.async {
                    self?.dismissFullScreen()
                }
            }
        }
    }

    // MARK: - FullScreenDismissDelegate

    func dismissFullScreen() {
        guard isFullScreenOpen else { return }

        // Remove global monitor
        if let monitor = globalEscMonitor {
            NSEvent.removeMonitor(monitor)
            globalEscMonitor = nil
        }

        fullScreenWindow?.orderOut(nil)
        fullScreenWindow?.close()
        fullScreenWindow = nil
        orbView = nil
        isFullScreenOpen = false

        // Bring back the small widget
        window.orderFront(nil)
    }

    // MARK: - Status polling

    func pollStatus() {
        guard FileManager.default.fileExists(atPath: statusPath),
              let data = try? Data(contentsOf: URL(fileURLWithPath: statusPath)),
              let status = try? JSONDecoder().decode(JarvisStatus.self, from: data) else {
            reactorView.currentState = "offline"
            reactorView.voiceActive = false
            orbView?.currentState = "offline"
            orbView?.voiceActive = false
            updateMenu(state: "Offline", voice: "\u{2014}")
            return
        }

        if let pid = status.pid {
            if kill(Int32(pid), 0) != 0 {
                reactorView.currentState = "offline"
                reactorView.voiceActive = false
                orbView?.currentState = "offline"
                orbView?.voiceActive = false
                updateMenu(state: "Offline (stale)", voice: "\u{2014}")
                return
            }
        }

        let state = status.running ? status.state : "offline"
        reactorView.voiceActive = status.voiceActive
        reactorView.currentState = state
        orbView?.voiceActive = status.voiceActive
        orbView?.currentState = state

        let stateDesc: String
        switch status.state {
        case "idle":       stateDesc = status.voiceActive ? "Listening" : "Running"
        case "activated":  stateDesc = "Wake word detected"
        case "processing": stateDesc = "Processing..."
        case "speaking":   stateDesc = "Speaking"
        default:           stateDesc = status.state.capitalized
        }

        let voiceDesc = status.voiceActive ? "Active" : "Inactive"
        let sidecarDesc = (status.sidecarReady ?? false) ? "\u{25CF} ready" : "\u{25CB} off"
        let waDesc = (status.whatsappConnected ?? false) ? "\u{25CF} linked" : "\u{25CB} offline"
        let modelDesc = (status.model.flatMap { $0.isEmpty ? nil : $0 }) ?? "\u{2014}"
        var modulesDesc = "\(status.modulesLoaded ?? 0) modules"
        if let bt = status.bootTime, bt > 0 {
            let mins = Int((Date().timeIntervalSince1970 * 1000 - bt) / 60000)
            modulesDesc += mins >= 60 ? " \u{00B7} up \(mins / 60)h \(mins % 60)m" : " \u{00B7} up \(max(0, mins))m"
        }
        let recent = (status.recentCommands ?? []).map { $0.count > 30 ? String($0.prefix(30)) + "\u{2026}" : $0 }

        updateMenu(state: stateDesc, voice: voiceDesc, sidecar: sidecarDesc, whatsapp: waDesc, model: modelDesc, modules: modulesDesc, recent: recent)
    }

    func updateMenu(state: String, voice: String, sidecar: String = "\u{2014}", whatsapp: String = "\u{2014}",
                    model: String = "\u{2014}", modules: String = "\u{2014}", recent: [String] = []) {
        guard let menu = reactorView.menu else { return }
        menu.item(withTag: 100)?.title = "Status: \(state)"
        menu.item(withTag: 101)?.title = "Voice: \(voice)"
        menu.item(withTag: 103)?.title = "Sidecar: \(sidecar)"
        menu.item(withTag: 104)?.title = "WhatsApp: \(whatsapp)"
        menu.item(withTag: 105)?.title = "Model: \(model)"
        menu.item(withTag: 106)?.title = modules
        let tags = [110, 111, 112]
        for (i, tag) in tags.enumerated() {
            menu.item(withTag: tag)?.title = i < recent.count ? "  \(recent[i])" : "  \u{2014}"
        }
    }

    @objc func quitApp() {
        NSApp.terminate(nil)
    }
}

// MARK: - Entry Point

let delegate = JarvisOverlayApp()
let app = NSApplication.shared
app.delegate = delegate
app.run()
