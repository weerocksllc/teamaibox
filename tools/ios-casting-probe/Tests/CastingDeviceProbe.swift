import XCTest
import Network

/// Runs only on the specifically selected, user-authorized wired device.
/// Never touches social actions, messages, purchases, device networking or VPN.
final class CastingDeviceProbe: XCTestCase {
    private let douyinID = "com.ss.iphone.ugc.Aweme"
    override func setUp() {
        super.setUp()
        continueAfterFailure = false
    }

    func testControlCenterIsAccessible() {
        let douyin = XCUIApplication(bundleIdentifier: "com.ss.iphone.ugc.Aweme")
        douyin.activate()
        XCTAssertTrue(douyin.wait(for: .runningForeground, timeout: 15))
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let top = springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.96, dy: 0.01))
        let bottom = springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.96, dy: 0.60))
        top.press(forDuration: 0.1, thenDragTo: bottom)
        let center = XCUIApplication(bundleIdentifier: "com.apple.ControlCenter")
        let predicate = NSPredicate(
            format: "label CONTAINS %@ OR label CONTAINS %@ OR identifier CONTAINS[c] %@",
            "屏幕镜像", "Screen Mirroring", "mirroring"
        )
        let centerControl = center.descendants(matching: .any).matching(predicate).firstMatch
        let fallback = springboard.descendants(matching: .any).matching(predicate).firstMatch
        let mirroring = centerControl.waitForExistence(timeout: 5) ? centerControl : fallback
        XCTAssertTrue(mirroring.waitForExistence(timeout: 10), "mirroring_control_not_found")
        print("CASTING_DEVICE_PROBE control_center_accessible=true")
        // Leave Control Center without changing the current casting connection.
        springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.97))
            .press(forDuration: 0.1, thenDragTo: springboard.coordinate(
                withNormalizedOffset: CGVector(dx: 0.5, dy: 0.20)))
        douyin.activate()
    }

    /// A short-lived controller on the paired USB tunnel, not a LAN server.
    /// The desktop sends only the small allowlisted actions below. No shell,
    /// arbitrary application, screenshot, account or social operation exists.
    func testUSBControlledCasting() throws {
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(
            host: "fd1f:db40:6920::1", port: 48653)
        let listener = try NWListener(using: parameters)
        let queue = DispatchQueue(label: "casting.device.usb")
        let lock = NSLock()
        var pending: ([String: String], NWConnection)?
        let incoming = DispatchSemaphore(value: 0)
        listener.newConnectionHandler = { connection in
            connection.start(queue: queue)
            connection.receive(minimumIncompleteLength: 1, maximumLength: 2048) { data, _, _, _ in
                guard let data = data,
                      let request = try? JSONDecoder().decode([String: String].self, from: data) else {
                    connection.cancel(); return
                }
                lock.lock()
                guard pending == nil else { lock.unlock(); connection.cancel(); return }
                pending = (request, connection)
                lock.unlock()
                incoming.signal()
            }
        }
        listener.start(queue: queue)
        defer { listener.cancel() }
        let deadline = Date().addingTimeInterval(1200)
        var running = true
        while running && Date() < deadline {
            guard incoming.wait(timeout: .now() + 1) == .success else { continue }
            lock.lock(); let job = pending; pending = nil; lock.unlock()
            guard let (request, connection) = job else { continue }
            let result: [String: String]
            switch request["action"] {
            case "status": result = ["status": "ready", "transport": "paired-usb-only"]
            case "douyin":
                XCUIApplication(bundleIdentifier: douyinID).activate()
                result = ["status": "opened"]
            case "next-video":
                let app = XCUIApplication(bundleIdentifier: douyinID)
                app.activate()
                app.coordinate(withNormalizedOffset: CGVector(dx: 0.45, dy: 0.75))
                    .press(forDuration: 0.05, thenDragTo: app.coordinate(
                        withNormalizedOffset: CGVector(dx: 0.45, dy: 0.25)))
                result = ["status": "swiped"]
            case "portrait":
                XCUIDevice.shared.orientation = .portrait
                result = ["status": "portrait"]
            case "landscape":
                XCUIDevice.shared.orientation = .landscapeLeft
                result = ["status": "landscape"]
            case "connect": result = connectReceiver(request)
            case "stop-mirroring": result = stopMirroring()
            case "finish": running = false; result = ["status": "finished"]
            default: result = ["status": "rejected"]
            }
            let reply = try JSONEncoder().encode(result)
            connection.send(content: reply, completion: .contentProcessed { _ in connection.cancel() })
        }
    }

    private func mirroringSheet() -> XCUIApplication? {
        let app = XCUIApplication(bundleIdentifier: douyinID)
        app.activate()
        let board = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        board.coordinate(withNormalizedOffset: CGVector(dx: 0.96, dy: 0.01))
            .press(forDuration: 0.1, thenDragTo: board.coordinate(
                withNormalizedOffset: CGVector(dx: 0.96, dy: 0.60)))
        let center = XCUIApplication(bundleIdentifier: "com.apple.ControlCenter")
        let match = NSPredicate(format: "label CONTAINS %@ OR label CONTAINS %@ OR identifier CONTAINS[c] %@",
                                "屏幕镜像", "Screen Mirroring", "mirroring")
        let control = center.descendants(matching: .any).matching(match).firstMatch
        guard control.waitForExistence(timeout: 8) else { return nil }
        control.tap()
        return center
    }

    private func connectReceiver(_ request: [String: String]) -> [String: String] {
        guard let name = request["receiver"], name.range(of: "^Team-AI-[A-Fa-f0-9]{10}$", options: .regularExpression) != nil,
              let pin = request["pin"], pin.range(of: "^[0-9]{4}$", options: .regularExpression) != nil else {
            return ["status": "invalid-pairing-input"]
        }
        guard let center = mirroringSheet() else { return ["status": "control-unavailable"] }
        let receiver = center.descendants(matching: .any).matching(NSPredicate(format: "label == %@", name)).firstMatch
        guard receiver.waitForExistence(timeout: 15) else { return ["status": "receiver-not-found"] }
        receiver.tap()
        let board = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        for host in [center, board] {
            let input = host.secureTextFields.firstMatch
            if input.waitForExistence(timeout: 2) {
                input.tap(); input.typeText(pin)
                let confirm = host.buttons.matching(NSPredicate(format: "label IN %@", ["好", "确定", "OK", "连接", "Connect"])).firstMatch
                if confirm.exists { confirm.tap() }
            }
        }
        XCUIApplication(bundleIdentifier: douyinID).activate()
        return ["status": "connection-requested"]
    }

    private func stopMirroring() -> [String: String] {
        guard let center = mirroringSheet() else { return ["status": "control-unavailable"] }
        let stop = center.descendants(matching: .any).matching(NSPredicate(
            format: "label IN %@", ["停止镜像", "停止屏幕镜像", "Stop Mirroring"])).firstMatch
        guard stop.waitForExistence(timeout: 8) else { return ["status": "stop-control-not-found"] }
        stop.tap()
        XCUIApplication(bundleIdentifier: douyinID).activate()
        return ["status": "source-stop-requested"]
    }
}
