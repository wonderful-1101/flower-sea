import AppKit
import CoreGraphics
import Foundation
import ImageIO
import QuartzCore

private let kBundleID = "com.flora.jardin-wallpaper"

// MARK: - Species & Asset Store

struct SpeciesSpec: Decodable {
    let id: String
    let zhName: String
    let enName: String
    let pollenColor: String
    let weight: Double
    let frameDir: String
    let frameCount: Int
    let headYRatio: Double
    let stemBottomRatio: Double
}

final class AssetStore {
    let species: [SpeciesSpec]
    let backdrop: CGImage?
    private let framesBySpecies: [String: [CGImage]]

    init?(assetsRoot: URL) {
        let jsonURL = assetsRoot.appendingPathComponent("species.json")
        guard let jsonData = try? Data(contentsOf: jsonURL),
              let decoded = try? JSONDecoder().decode([SpeciesSpec].self, from: jsonData),
              !decoded.isEmpty else {
            return nil
        }
        self.species = decoded

        let bgURL = assetsRoot.appendingPathComponent("bg-foliage.webp")
        if let src = CGImageSourceCreateWithURL(bgURL as CFURL, nil) {
            self.backdrop = CGImageSourceCreateImageAtIndex(src, 0, nil)
        } else {
            self.backdrop = nil
        }

        // Flatten all frame load jobs and decode concurrently via ImageIO.
        struct LoadJob {
            let speciesIndex: Int
            let frameIndex: Int
            let url: URL
        }
        var jobs: [LoadJob] = []
        var storage: [[CGImage?]] = decoded.map { Array(repeating: nil, count: $0.frameCount) }

        for (sIdx, sp) in decoded.enumerated() {
            var relDir = sp.frameDir
            while relDir.hasPrefix("/") { relDir.removeFirst() }
            let dirURL = assetsRoot.appendingPathComponent(relDir)
            for fIdx in 0..<sp.frameCount {
                let fileName = String(format: "frame_%03d.webp", fIdx)
                jobs.append(LoadJob(speciesIndex: sIdx, frameIndex: fIdx, url: dirURL.appendingPathComponent(fileName)))
            }
        }

        let lock = NSLock()
        DispatchQueue.concurrentPerform(iterations: jobs.count) { jobIdx in
            let job = jobs[jobIdx]
            guard let src = CGImageSourceCreateWithURL(job.url as CFURL, nil),
                  let cg = CGImageSourceCreateImageAtIndex(src, 0, nil) else {
                return
            }
            lock.lock()
            storage[job.speciesIndex][job.frameIndex] = cg
            lock.unlock()
        }

        var map: [String: [CGImage]] = [:]
        for (sIdx, sp) in decoded.enumerated() {
            let valid = storage[sIdx].compactMap { $0 }
            if !valid.isEmpty {
                map[sp.id] = valid
            }
        }
        self.framesBySpecies = map
    }

    func frame(speciesId: String, bloom01: Double) -> (index: Int, image: CGImage)? {
        guard let frames = framesBySpecies[speciesId], !frames.isEmpty else { return nil }
        let clamped = max(0.0, min(1.0, bloom01))
        let idx = min(frames.count - 1, Int((clamped * Double(frames.count - 1)).rounded()))
        return (idx, frames[idx])
    }
}

// MARK: - Deterministic Tapestry Layout

struct SeededRng {
    private var state: UInt32
    init(seed: UInt32) { self.state = seed }

    mutating func next() -> Double {
        state = state &* 1664525 &+ 1013904223
        return Double(state) / 4294967296.0
    }
}

final class FlowerNode {
    let speciesId: String
    let stemBottomRatio: Double
    let x: Double
    let baseY: Double
    let headX: Double
    let headY: Double
    let size: Double
    let flipX: Double
    let baseLean: Double
    let depthShade: Double
    let swayPhase: Double
    let swaySpeed: Double

    var bloom: Double = 0.0
    var pushLean: Double = 0.0
    var lastFrameIndex: Int = -1
    var lastRenderedAngle: Double = 999.0
    var lastOpacity: Float = -1.0

    let layer: CALayer

    init(
        species: SpeciesSpec,
        x: Double,
        baseY: Double,
        headX: Double,
        headY: Double,
        size: Double,
        flipX: Double,
        baseLean: Double,
        depthShade: Double,
        swayPhase: Double,
        swaySpeed: Double,
        initialImage: CGImage?
    ) {
        self.speciesId = species.id
        self.stemBottomRatio = species.stemBottomRatio
        self.x = x
        self.baseY = baseY
        self.headX = headX
        self.headY = headY
        self.size = size
        self.flipX = flipX
        self.baseLean = baseLean
        self.depthShade = depthShade
        self.swayPhase = swayPhase
        self.swaySpeed = swaySpeed

        let l = CALayer()
        l.bounds = CGRect(x: 0, y: 0, width: size, height: size)
        // Cocoa bottom-left coordinates: stemBottomRatio measured from top => anchorY = 1 - stemBottomRatio.
        l.anchorPoint = CGPoint(x: 0.5, y: 1.0 - species.stemBottomRatio)
        l.position = CGPoint(x: x, y: baseY)
        l.contents = initialImage
        l.contentsGravity = .resize
        self.layer = l
    }
}

// MARK: - Procedural Overlays (Sunbeam & Vignette)

private func makeSunbeamCGImage(size: Int = 512) -> CGImage? {
    let cs = CGColorSpaceCreateDeviceRGB()
    guard let ctx = CGContext(
        data: nil,
        width: size,
        height: size,
        bitsPerComponent: 8,
        bytesPerRow: size * 4,
        space: cs,
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    ) else { return nil }

    let colors = [
        CGColor(red: 1.0, green: 0.90, blue: 0.68, alpha: 0.16),
        CGColor(red: 0.92, green: 0.74, blue: 0.45, alpha: 0.06),
        CGColor(red: 0.92, green: 0.74, blue: 0.45, alpha: 0.0),
    ] as CFArray
    let locations: [CGFloat] = [0.0, 0.52, 1.0]
    guard let grad = CGGradient(colorsSpace: cs, colors: colors, locations: locations) else { return nil }

    let center = CGPoint(x: Double(size) * 0.5, y: Double(size) * 0.5)
    ctx.drawRadialGradient(
        grad,
        startCenter: center,
        startRadius: 0,
        endCenter: center,
        endRadius: Double(size) * 0.5,
        options: []
    )
    return ctx.makeImage()
}

private func makeVignetteCGImage(width: Int = 512, height: Int = 320) -> CGImage? {
    let cs = CGColorSpaceCreateDeviceRGB()
    guard let ctx = CGContext(
        data: nil,
        width: width,
        height: height,
        bitsPerComponent: 8,
        bytesPerRow: width * 4,
        space: cs,
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    ) else { return nil }

    let colors = [
        CGColor(red: 0.03, green: 0.05, blue: 0.035, alpha: 0.0),
        CGColor(red: 0.03, green: 0.05, blue: 0.035, alpha: 0.36),
    ] as CFArray
    let locations: [CGFloat] = [0.0, 1.0]
    guard let grad = CGGradient(colorsSpace: cs, colors: colors, locations: locations) else { return nil }

    let center = CGPoint(x: Double(width) * 0.5, y: Double(height) * 0.54)
    let rStart = Double(min(width, height)) * 0.35
    let rEnd = hypot(Double(width), Double(height)) * 0.60
    ctx.drawRadialGradient(
        grad,
        startCenter: center,
        startRadius: rStart,
        endCenter: center,
        endRadius: rEnd,
        options: [.drawsAfterEndLocation]
    )
    return ctx.makeImage()
}

// MARK: - CoreAnimation Desktop Wallpaper Surface

final class TapestrySurface {
    let screen: NSScreen
    let window: NSWindow
    private let rootView: NSView
    private let rootLayer: CALayer
    private let backdropLayer = CALayer()
    private let glazeLayer = CALayer()
    private let flowersContainer = CALayer()
    private let sunbeamLayer = CALayer()
    private let vignetteLayer = CALayer()

    private let assets: AssetStore
    private var flowers: [FlowerNode] = []

    private var pointerX: Double? = nil
    private var pointerY: Double? = nil
    private var pointerVX: Double = 0.0
    private var pointerVY: Double = 0.0
    private var hasPrevPointer = false
    private var prevPointerX: Double = 0.0
    private var prevPointerY: Double = 0.0

    private var previewTimer: Double = 0.0
    private var radiusPx: Double = 270.0
    private var closeDurationSec: Double = 1.0
    private var ambientBreeze: Bool = false
    private var isPaused: Bool = false
    private var sunbeamOpacity: Float = 0.0
    private var seed: UInt32 = 20261123

    private(set) var isAwake: Bool = false
    private var lastStepTime: CFTimeInterval = CACurrentMediaTime()

    init(screen: NSScreen, assets: AssetStore) {
        self.screen = screen
        self.assets = assets

        let win = NSWindow(
            contentRect: screen.frame,
            styleMask: .borderless,
            backing: .buffered,
            defer: false,
            screen: screen
        )
        let desktopLevel = Int(CGWindowLevelForKey(.desktopWindow))
        win.level = NSWindow.Level(rawValue: desktopLevel + 1)
        win.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle]
        win.ignoresMouseEvents = true
        win.hasShadow = false
        win.animationBehavior = .none
        win.isOpaque = true
        win.canHide = false
        win.isReleasedWhenClosed = false
        win.backgroundColor = NSColor(red: 0.08, green: 0.11, blue: 0.08, alpha: 1.0)

        let view = NSView(frame: NSRect(origin: .zero, size: screen.frame.size))
        view.autoresizingMask = [.width, .height]
        view.wantsLayer = true
        let root = CALayer()
        root.frame = view.bounds
        root.masksToBounds = true
        root.backgroundColor = NSColor(red: 0.08, green: 0.11, blue: 0.08, alpha: 1.0).cgColor
        view.layer = root

        self.window = win
        self.rootView = view
        self.rootLayer = root

        setupLayers()
        win.contentView = view
        win.orderFront(nil)
        relayout(newSeed: false)
    }

    private func setupLayers() {
        let bounds = rootLayer.bounds

        backdropLayer.frame = bounds
        backdropLayer.contents = assets.backdrop
        backdropLayer.contentsGravity = .resizeAspectFill
        backdropLayer.masksToBounds = true
        rootLayer.addSublayer(backdropLayer)

        glazeLayer.frame = bounds
        glazeLayer.backgroundColor = NSColor(red: 12.0 / 255.0, green: 17.0 / 255.0, blue: 13.0 / 255.0, alpha: 0.28).cgColor
        rootLayer.addSublayer(glazeLayer)

        flowersContainer.frame = bounds
        rootLayer.addSublayer(flowersContainer)

        sunbeamLayer.bounds = CGRect(x: 0, y: 0, width: radiusPx * 2.1, height: radiusPx * 2.1)
        sunbeamLayer.contents = makeSunbeamCGImage()
        sunbeamLayer.contentsGravity = .resize
        sunbeamLayer.opacity = 0.0
        rootLayer.addSublayer(sunbeamLayer)

        vignetteLayer.frame = bounds
        vignetteLayer.contents = makeVignetteCGImage()
        vignetteLayer.contentsGravity = .resize
        rootLayer.addSublayer(vignetteLayer)
    }

    func relayout(newSeed: Bool = true) {
        if newSeed {
            seed = seed &+ 7919
        }
        let w = Double(screen.frame.width)
        let h = Double(screen.frame.height)
        guard w >= 80, h >= 80, !assets.species.isEmpty else { return }

        var rng = SeededRng(seed: seed)
        let targetCount = Int((96.0 * min(1.25, max(0.55, (w * h) / (1440.0 * 900.0)))).rounded())
        let rows = max(5, min(8, Int((sqrt(Double(targetCount) * (h / max(1.0, w)) * 0.65)).rounded())))
        let baseUnit = max(170.0, min(265.0, sqrt((w * h) / Double(max(36, targetCount))) * 1.72))
        let perRowBase = max(6, Int((Double(targetCount) / Double(rows)).rounded()))

        var nodes: [FlowerNode] = []

        for r in 0..<rows {
            let rowNorm = rows > 1 ? Double(r) / Double(rows - 1) : 0.5
            // Back row (r=0) near top (0.80*H in Cocoa coords) down to front row (-0.08*H).
            let rowBaseY = h * (0.80 - rowNorm * 0.88)
            let cols = max(5, perRowBase + (r % 2 == 0 ? 1 : -1) + (r == rows - 1 ? 1 : 0))
            let depthScale = 0.80 + rowNorm * 0.44
            let depthShade = (1.0 - rowNorm) * 0.22

            for c in 0..<cols {
                let stagger = (r % 2 == 1) ? 0.5 / Double(cols) : 0.0
                let u = (Double(c) + 0.5) / Double(cols) + stagger - 0.5 / Double(cols * 2)
                let x = w * (-0.02 + u * 1.04) + (rng.next() - 0.5) * (w / Double(cols)) * 0.42
                let baseY = rowBaseY + (rng.next() - 0.5) * (h / Double(rows)) * 0.36

                let sp = pickDiverseSpecies(existing: nodes, x: x, baseY: baseY, rng: &rng)
                let size = baseUnit * depthScale * (0.90 + rng.next() * 0.22)
                let flipX = rng.next() < 0.5 ? 1.0 : -1.0
                let baseLean = (rng.next() - 0.5) * 0.46

                let stemOffset = size * (sp.stemBottomRatio - sp.headYRatio)
                let headX = x + sin(baseLean) * stemOffset
                let headY = baseY + cos(baseLean) * stemOffset
                let initialImg = assets.frame(speciesId: sp.id, bloom01: 0.0)?.image

                let node = FlowerNode(
                    species: sp,
                    x: x,
                    baseY: baseY,
                    headX: headX,
                    headY: headY,
                    size: size,
                    flipX: flipX,
                    baseLean: baseLean,
                    depthShade: depthShade,
                    swayPhase: rng.next() * .pi * 2.0,
                    swaySpeed: 0.70 + rng.next() * 0.45,
                    initialImage: initialImg
                )
                nodes.append(node)
            }
        }

        // Back-to-front painter's order in Cocoa coords: descending baseY.
        nodes.sort { $0.baseY > $1.baseY }

        CATransaction.begin()
        CATransaction.setDisableActions(true)
        flowersContainer.sublayers?.forEach { $0.removeFromSuperlayer() }
        for node in nodes {
            flowersContainer.addSublayer(node.layer)
        }
        flowers = nodes
        applyNodeVisuals(timeSec: CACurrentMediaTime())
        CATransaction.commit()
    }

    private func pickDiverseSpecies(existing: [FlowerNode], x: Double, baseY: Double, rng: inout SeededRng) -> SpeciesSpec {
        let startIdx = max(0, existing.count - 18)
        let weights: [Double] = assets.species.map { sp in
            var penalty = 1.0
            for i in startIdx..<existing.count {
                let other = existing[i]
                if other.speciesId == sp.id {
                    let d = hypot(other.x - x, other.baseY - baseY)
                    if d < 220.0 {
                        penalty *= 0.12
                    }
                }
            }
            return sp.weight * penalty
        }
        let total = weights.reduce(0, +)
        var roll = rng.next() * total
        for (i, sp) in assets.species.enumerated() {
            roll -= weights[i]
            if roll <= 0.0 { return sp }
        }
        return assets.species[0]
    }

    func setPointer(cocoaLocalX: Double, cocoaLocalY: Double) {
        guard !isPaused else { return }
        if hasPrevPointer {
            pointerVX = (cocoaLocalX - prevPointerX) * 24.0
            pointerVY = (cocoaLocalY - prevPointerY) * 24.0
        } else {
            pointerVX = 0.0
            pointerVY = 0.0
        }
        pointerX = cocoaLocalX
        pointerY = cocoaLocalY
        prevPointerX = cocoaLocalX
        prevPointerY = cocoaLocalY
        hasPrevPointer = true
        wake()
    }

    func clearPointer() {
        if pointerX != nil || pointerY != nil {
            pointerX = nil
            pointerY = nil
            hasPrevPointer = false
            wake()
        }
    }

    func configure(radius: Double, closeDuration: Double, ambientBreeze: Bool, paused: Bool) {
        let radiusChanged = abs(radiusPx - radius) > 0.5
        radiusPx = radius
        closeDurationSec = closeDuration
        self.ambientBreeze = ambientBreeze
        isPaused = paused

        if radiusChanged {
            CATransaction.begin()
            CATransaction.setDisableActions(true)
            sunbeamLayer.bounds = CGRect(x: 0, y: 0, width: radiusPx * 2.1, height: radiusPx * 2.1)
            CATransaction.commit()
        }

        if isPaused {
            pointerX = nil
            pointerY = nil
            hasPrevPointer = false
            isAwake = false
        } else {
            wake()
        }
    }

    func bloomPreview(durationSec: Double = 3.0) {
        previewTimer = max(0.5, durationSec)
        wake()
    }

    func wake() {
        guard !isPaused else { return }
        if !isAwake {
            isAwake = true
            lastStepTime = CACurrentMediaTime()
        }
    }

    func stepAnimation(now: CFTimeInterval) {
        guard isAwake, !isPaused else { return }

        let dt = min(0.05, max(0.001, now - lastStepTime))
        lastStepTime = now

        if previewTimer > 0 {
            previewTimer = max(0.0, previewTimer - dt)
        }

        let tauOpen = 0.19
        let tauClose = max(0.12, closeDurationSec * 0.34)
        let openFactor = 1.0 - exp(-dt / tauOpen)
        let closeFactor = 1.0 - exp(-dt / tauClose)
        let leanLerp = 1.0 - exp(-8.0 * dt)

        var anyMoving = ambientBreeze || pointerX != nil || previewTimer > 0

        for f in flowers {
            var target = 0.0
            var targetLean = 0.0

            if let px = pointerX, let py = pointerY {
                let dx = f.headX - px
                let dy = f.headY - py
                let dist = hypot(dx, dy)
                if dist < radiusPx {
                    let t = max(0.0, min(1.0, (dist - 0.0) / radiusPx))
                    let smooth = t * t * (3.0 - 2.0 * t)
                    let falloff = 1.0 - smooth
                    target = min(1.0, falloff * 1.25)

                    let dirX = dist > 4.0 ? dx / dist : 0.0
                    let vxNorm = max(-1.0, min(1.0, pointerVX / 900.0))
                    targetLean = (dirX * 0.055 + vxNorm * 0.06) * falloff
                }
            }

            if previewTimer > 0 {
                target = 1.0
            }

            f.pushLean += (targetLean - f.pushLean) * leanLerp
            if abs(f.pushLean) < 0.0008 && targetLean == 0.0 {
                f.pushLean = 0.0
            }

            let factor = target >= f.bloom ? openFactor : closeFactor
            f.bloom += (target - f.bloom) * factor
            if target == 0.0 && f.bloom < 0.004 {
                f.bloom = 0.0
            }
            f.bloom = max(0.0, min(1.0, f.bloom))

            if f.bloom > 0.002 || abs(f.pushLean) > 0.001 {
                anyMoving = true
            }
        }

        if pointerX != nil {
            pointerVX *= exp(-10.0 * dt)
            pointerVY *= exp(-10.0 * dt)
        }

        let targetSunAlpha: Float = pointerX != nil ? 1.0 : 0.0
        sunbeamOpacity += (targetSunAlpha - sunbeamOpacity) * Float(1.0 - exp(-10.0 * dt))
        if targetSunAlpha == 0.0 && sunbeamOpacity < 0.01 {
            sunbeamOpacity = 0.0
        }
        if sunbeamOpacity > 0.01 {
            anyMoving = true
        }

        CATransaction.begin()
        CATransaction.setDisableActions(true)
        applyNodeVisuals(timeSec: now)
        if let px = pointerX, let py = pointerY {
            sunbeamLayer.position = CGPoint(x: px, y: py)
        }
        sunbeamLayer.opacity = sunbeamOpacity
        CATransaction.commit()

        if !anyMoving {
            isAwake = false
        }
    }

    private func applyNodeVisuals(timeSec: CFTimeInterval) {
        for f in flowers {
            if let frame = assets.frame(speciesId: f.speciesId, bloom01: f.bloom),
               frame.index != f.lastFrameIndex {
                f.layer.contents = frame.image
                f.lastFrameIndex = frame.index
            }

            let swayAmp = (ambientBreeze || f.bloom > 0.01) ? 0.024 : 0.0
            let wind = swayAmp > 0.0 ? sin(timeSec * f.swaySpeed + f.swayPhase) * swayAmp : 0.0
            let angle = f.baseLean + wind + f.pushLean

            if abs(angle - f.lastRenderedAngle) > 0.0005 {
                var t = CATransform3DMakeRotation(-angle, 0, 0, 1)
                t = CATransform3DScale(t, f.flipX, 1.0, 1.0)
                f.layer.transform = t
                f.lastRenderedAngle = angle
            }

            let targetOpacity: Float = (f.depthShade > 0.02 && f.bloom < 0.7)
                ? Float(1.0 - f.depthShade * (1.0 - f.bloom) * 0.45)
                : 1.0
            if abs(targetOpacity - f.lastOpacity) > 0.01 {
                f.layer.opacity = targetOpacity
                f.lastOpacity = targetOpacity
            }
        }
    }

    func close() {
        window.orderOut(nil)
        window.close()
    }
}

// MARK: - Application & Menu Bar Controller

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem!
    private var assets: AssetStore!
    private var surfaces: [TapestrySurface] = []
    private var frameTimer: Timer?

    private var isPaused = false
    private var isSystemSleeping = false
    private var ecoSleepEnabled = true
    private var radiusPx = 270
    private var closeDurationSec = 1.0

    private var lastMouseLoc = NSPoint(x: -1, y: -1)
    private var activeSurfaceIndex: Int? = nil
    private var occlusionCheckCounter = 0

    private var pauseMenuItem: NSMenuItem!
    private var ecoMenuItem: NSMenuItem!
    private var launchAgentMenuItem: NSMenuItem!
    private var radiusItems: [Int: NSMenuItem] = [:]
    private var closeItems: [Double: NSMenuItem] = [:]

    private let myPID = ProcessInfo.processInfo.processIdentifier

    func applicationDidFinishLaunching(_ notification: Notification) {
        guard let assetsDir = Bundle.main.resourceURL?.appendingPathComponent("assets"),
              let store = AssetStore(assetsRoot: assetsDir) else {
            fputs("Failed to load JARDIN assets from app bundle.\n", stderr)
            NSApp.terminate(nil)
            return
        }
        assets = store

        setupMenuBar()
        rebuildSurfaces()
        startFrameTimer()

        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleScreenChange),
            name: NSApplication.didChangeScreenParametersNotification,
            object: nil
        )

        let wsNc = NSWorkspace.shared.notificationCenter
        wsNc.addObserver(self, selector: #selector(handleSleep), name: NSWorkspace.screensDidSleepNotification, object: nil)
        wsNc.addObserver(self, selector: #selector(handleWake), name: NSWorkspace.screensDidWakeNotification, object: nil)
    }

    func applicationWillTerminate(_ notification: Notification) {
        frameTimer?.invalidate()
        for s in surfaces { s.close() }
    }

    private func setupMenuBar() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let btn = statusItem.button {
            if let sym = NSImage(systemSymbolName: "camera.macro", accessibilityDescription: "JARDIN") {
                sym.isTemplate = true
                btn.image = sym
            } else {
                btn.title = "❀"
            }
            btn.toolTip = "JARDIN · 繁花油画交互壁纸"
        }

        let menu = NSMenu()

        let header = NSMenuItem(title: "JARDIN · 繁花油画壁纸", action: nil, keyEquivalent: "")
        header.isEnabled = false
        menu.addItem(header)
        menu.addItem(.separator())

        pauseMenuItem = NSMenuItem(title: "暂停互动", action: #selector(togglePause), keyEquivalent: "")
        pauseMenuItem.target = self
        menu.addItem(pauseMenuItem)

        ecoMenuItem = NSMenuItem(title: "极致省电（静止 0 FPS 休眠）", action: #selector(toggleEcoSleep), keyEquivalent: "")
        ecoMenuItem.target = self
        ecoMenuItem.state = .on
        menu.addItem(ecoMenuItem)

        let radiusMenu = NSMenu()
        for (px, label) in [(200, "小 (200px)"), (270, "中 (270px)"), (360, "大 (360px)")] {
            let item = NSMenuItem(title: label, action: #selector(selectRadius(_:)), keyEquivalent: "")
            item.target = self
            item.tag = px
            item.state = px == radiusPx ? .on : .off
            radiusMenu.addItem(item)
            radiusItems[px] = item
        }
        let radiusRoot = NSMenuItem(title: "绽放半径", action: nil, keyEquivalent: "")
        radiusRoot.submenu = radiusMenu
        menu.addItem(radiusRoot)

        let closeMenu = NSMenu()
        for (sec, label) in [(0.6, "轻快 (0.6s)"), (1.0, "自然 (1.0s)"), (1.8, "舒缓 (1.8s)")] {
            let item = NSMenuItem(title: label, action: #selector(selectCloseDuration(_:)), keyEquivalent: "")
            item.target = self
            item.representedObject = NSNumber(value: sec)
            item.state = abs(sec - closeDurationSec) < 0.05 ? .on : .off
            closeMenu.addItem(item)
            closeItems[sec] = item
        }
        let closeRoot = NSMenuItem(title: "合拢速度", action: nil, keyEquivalent: "")
        closeRoot.submenu = closeMenu
        menu.addItem(closeRoot)

        menu.addItem(.separator())

        let previewItem = NSMenuItem(title: "全屏盛放预览 (3 秒)", action: #selector(previewBloom), keyEquivalent: "")
        previewItem.target = self
        menu.addItem(previewItem)

        let relayoutItem = NSMenuItem(title: "重新排布花丛", action: #selector(relayoutFlowers), keyEquivalent: "")
        relayoutItem.target = self
        menu.addItem(relayoutItem)

        menu.addItem(.separator())

        launchAgentMenuItem = NSMenuItem(title: "开机自动启动", action: #selector(toggleLaunchAtLogin), keyEquivalent: "")
        launchAgentMenuItem.target = self
        launchAgentMenuItem.state = FileManager.default.fileExists(atPath: launchAgentURL().path) ? .on : .off
        menu.addItem(launchAgentMenuItem)

        menu.addItem(.separator())

        let quitItem = NSMenuItem(title: "退出 JARDIN 壁纸", action: #selector(quitApp), keyEquivalent: "q")
        quitItem.target = self
        menu.addItem(quitItem)

        statusItem.menu = menu
    }

    private func rebuildSurfaces() {
        for s in surfaces { s.close() }
        surfaces.removeAll()
        activeSurfaceIndex = nil

        for screen in NSScreen.screens {
            let surface = TapestrySurface(screen: screen, assets: assets)
            surface.configure(
                radius: Double(radiusPx),
                closeDuration: closeDurationSec,
                ambientBreeze: !ecoSleepEnabled,
                paused: isPaused || isSystemSleeping
            )
            surfaces.append(surface)
        }
    }

    private func syncAllSurfaces() {
        for s in surfaces {
            s.configure(
                radius: Double(radiusPx),
                closeDuration: closeDurationSec,
                ambientBreeze: !ecoSleepEnabled,
                paused: isPaused || isSystemSleeping
            )
        }
    }

    private func startFrameTimer() {
        frameTimer?.invalidate()
        let timer = Timer(timeInterval: 1.0 / 60.0, repeats: true) { [weak self] _ in
            self?.tick()
        }
        RunLoop.main.add(timer, forMode: .common)
        frameTimer = timer
    }

    private func tick() {
        guard !isPaused, !isSystemSleeping, !surfaces.isEmpty else {
            clearActiveSurfaceIfNeeded()
            return
        }

        let mouseLoc = NSEvent.mouseLocation
        let moved = abs(mouseLoc.x - lastMouseLoc.x) > 0.4 || abs(mouseLoc.y - lastMouseLoc.y) > 0.4
        occlusionCheckCounter = (occlusionCheckCounter + 1) % 6

        if moved || occlusionCheckCounter == 0 {
            if let hit = locateVisibleWallpaperPoint(mouseLoc) {
                if moved || activeSurfaceIndex != hit.surfaceIndex {
                    if let prev = activeSurfaceIndex, prev != hit.surfaceIndex, prev < surfaces.count {
                        surfaces[prev].clearPointer()
                    }
                    activeSurfaceIndex = hit.surfaceIndex
                    lastMouseLoc = mouseLoc
                    surfaces[hit.surfaceIndex].setPointer(cocoaLocalX: hit.localX, cocoaLocalY: hit.localY)
                }
            } else {
                lastMouseLoc = mouseLoc
                clearActiveSurfaceIfNeeded()
            }
        }

        let now = CACurrentMediaTime()
        for s in surfaces where s.isAwake {
            s.stepAnimation(now: now)
        }
    }

    private func clearActiveSurfaceIfNeeded() {
        if let prev = activeSurfaceIndex {
            activeSurfaceIndex = nil
            if prev < surfaces.count {
                surfaces[prev].clearPointer()
            }
        }
    }

    private func locateVisibleWallpaperPoint(_ mouseLoc: NSPoint) -> (surfaceIndex: Int, localX: Double, localY: Double)? {
        guard let idx = surfaces.firstIndex(where: { $0.screen.frame.contains(mouseLoc) }) else {
            return nil
        }
        let screen = surfaces[idx].screen
        guard screen.visibleFrame.contains(mouseLoc) else {
            return nil
        }

        let primaryHeight = NSScreen.screens.first(where: { $0.frame.origin == .zero })?.frame.height
            ?? NSScreen.screens.first?.frame.height
            ?? screen.frame.height
        let cgPoint = CGPoint(x: mouseLoc.x, y: primaryHeight - mouseLoc.y)

        if let windowList = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] {
            for info in windowList {
                let ownerPid = info[kCGWindowOwnerPID as String] as? Int32 ?? 0
                if ownerPid == myPID { continue }

                let layer = info[kCGWindowLayer as String] as? Int ?? 0
                if layer < 0 { continue }

                if layer == 20 { continue }
                if let app = NSRunningApplication(processIdentifier: ownerPid),
                   app.bundleIdentifier == "com.apple.dock" {
                    continue
                }

                let alpha = info[kCGWindowAlpha as String] as? Double ?? 0.0
                if alpha <= 0.01 { continue }

                guard let boundsDict = info[kCGWindowBounds as String] as? NSDictionary,
                      let bounds = CGRect(dictionaryRepresentation: boundsDict) else {
                    continue
                }
                if bounds.width <= 2 || bounds.height <= 2 { continue }

                if bounds.contains(cgPoint) {
                    return nil
                }
            }
        }

        let localX = Double(mouseLoc.x - screen.frame.minX)
        let localY = Double(mouseLoc.y - screen.frame.minY)
        return (idx, localX, localY)
    }

    @objc private func handleScreenChange() {
        rebuildSurfaces()
    }

    @objc private func handleSleep() {
        isSystemSleeping = true
        clearActiveSurfaceIfNeeded()
        syncAllSurfaces()
    }

    @objc private func handleWake() {
        isSystemSleeping = false
        syncAllSurfaces()
    }

    @objc private func togglePause() {
        isPaused.toggle()
        pauseMenuItem.title = isPaused ? "恢复互动" : "暂停互动"
        if isPaused {
            clearActiveSurfaceIfNeeded()
        }
        syncAllSurfaces()
    }

    @objc private func toggleEcoSleep() {
        ecoSleepEnabled.toggle()
        ecoMenuItem.state = ecoSleepEnabled ? .on : .off
        syncAllSurfaces()
    }

    @objc private func selectRadius(_ sender: NSMenuItem) {
        radiusPx = sender.tag
        for (px, item) in radiusItems {
            item.state = px == radiusPx ? .on : .off
        }
        syncAllSurfaces()
    }

    @objc private func selectCloseDuration(_ sender: NSMenuItem) {
        guard let val = sender.representedObject as? NSNumber else { return }
        closeDurationSec = val.doubleValue
        for (sec, item) in closeItems {
            item.state = abs(sec - closeDurationSec) < 0.05 ? .on : .off
        }
        syncAllSurfaces()
    }

    @objc private func previewBloom() {
        for s in surfaces { s.bloomPreview(durationSec: 3.0) }
    }

    @objc private func relayoutFlowers() {
        for s in surfaces { s.relayout(newSeed: true) }
    }

    private func launchAgentURL() -> URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/LaunchAgents/\(kBundleID).plist")
    }

    @objc private func toggleLaunchAtLogin() {
        let plistURL = launchAgentURL()
        let fm = FileManager.default
        if fm.fileExists(atPath: plistURL.path) {
            try? fm.removeItem(at: plistURL)
            launchAgentMenuItem.state = .off
            return
        }

        let execPath = Bundle.main.executableURL?.path ?? Bundle.main.bundlePath
        let plist: [String: Any] = [
            "Label": kBundleID,
            "ProgramArguments": [execPath],
            "RunAtLoad": true,
            "KeepAlive": false,
        ]
        try? fm.createDirectory(at: plistURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        if let data = try? PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0) {
            try? data.write(to: plistURL)
            launchAgentMenuItem.state = .on
        }
    }

    @objc private func quitApp() {
        NSApp.terminate(nil)
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let delegate = AppDelegate()
app.delegate = delegate
app.run()
