import XCTest
import Network

final class CastingAcceptance: XCTestCase {
    private let pattern = XCUIApplication(bundleIdentifier: "com.teamaibox.casting.pattern")
    override func setUp() { super.setUp(); continueAfterFailure = false }

    func testControlledSource() throws {
        // Never listen on Wi-Fi/LAN interfaces or carry arbitrary UI commands.
        guard let bind = ProcessInfo.processInfo.environment["TEAMAIBOX_PROBE_BIND"],
              bind.range(of: "^fd[0-9a-f:]+$", options: .regularExpression) != nil else {
            throw NSError(domain: "probe_bind_missing", code: 1)
        }
        pattern.launch()
        XCTAssertTrue(pattern.wait(for: .runningForeground, timeout: 15))
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: NWEndpoint.Host(bind), port: 48654)
        let listener = try NWListener(using: parameters)
        let queue = DispatchQueue(label: "casting.acceptance.tunnel")
        let lock = NSLock(), signal = DispatchSemaphore(value: 0)
        var pending: ([String: String], NWConnection)?
        listener.newConnectionHandler = { connection in
            connection.start(queue: queue)
            connection.receive(minimumIncompleteLength: 1, maximumLength: 2048) { bytes, _, _, _ in
                guard let bytes = bytes, let request = try? JSONDecoder().decode([String: String].self, from: bytes)
                    else { connection.cancel(); return }
                lock.lock()
                guard pending == nil else { lock.unlock(); connection.cancel(); return }
                pending = (request, connection); lock.unlock(); signal.signal()
            }
        }
        listener.start(queue: queue)
        defer { listener.cancel(); pattern.terminate() }
        let deadline = Date().addingTimeInterval(900)
        var running = true
        while running && Date() < deadline {
            guard signal.wait(timeout: .now() + 1) == .success else { continue }
            lock.lock(); let job = pending; pending = nil; lock.unlock()
            guard let (request, connection) = job else { continue }
            let result: String
            switch request["action"] {
            case "status": result = "ready"
            case "connect": result = connect(request)
            case "stop": result = stop()
            case "portrait": XCUIDevice.shared.orientation = .portrait; result = "portrait"
            case "landscape": XCUIDevice.shared.orientation = .landscapeLeft; result = "landscape"
            case "pattern": pattern.activate(); result = "pattern"
            case "finish": running = false; result = "finished"
            default: result = "rejected"
            }
            let bytes = try JSONEncoder().encode(["status": result])
            connection.send(content: bytes, completion: .contentProcessed { _ in connection.cancel() })
        }
    }

    private func sheet() -> XCUIApplication? {
        pattern.activate()
        let board = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        board.coordinate(withNormalizedOffset: CGVector(dx: 0.96, dy: 0.01))
            .press(forDuration: 0.1, thenDragTo: board.coordinate(withNormalizedOffset: CGVector(dx: 0.96, dy: 0.60)))
        let center = XCUIApplication(bundleIdentifier: "com.apple.ControlCenter")
        let query = NSPredicate(format: "label CONTAINS %@ OR label CONTAINS %@ OR identifier CONTAINS[c] %@",
                                "屏幕镜像", "Screen Mirroring", "mirroring")
        let control = center.descendants(matching: .any).matching(query).firstMatch
        guard control.waitForExistence(timeout: 8) else { return nil }
        control.tap(); return center
    }
    private func connect(_ request: [String: String]) -> String {
        guard let name = request["receiver"], name.range(of: "^Team-AI-[A-Fa-f0-9]{10}$", options: .regularExpression) != nil,
              let pin = request["pin"], pin.range(of: "^[0-9]{4}$", options: .regularExpression) != nil else { return "input_rejected" }
        guard let center = sheet() else { return "control_unavailable" }
        let receiver = center.descendants(matching: .any).matching(NSPredicate(format: "label == %@", name)).firstMatch
        guard receiver.waitForExistence(timeout: 15) else { return "receiver_not_found" }
        receiver.tap()
        for host in [center, XCUIApplication(bundleIdentifier: "com.apple.springboard")] {
            let field = host.secureTextFields.firstMatch
            if field.waitForExistence(timeout: 2) {
                field.tap(); field.typeText(pin)
                let confirm = host.buttons.matching(NSPredicate(format: "label IN %@", ["好", "确定", "OK", "连接", "Connect"])).firstMatch
                if confirm.exists { confirm.tap() }
            }
        }
        pattern.activate(); return "connection_requested"
    }
    private func stop() -> String {
        guard let center = sheet() else { return "control_unavailable" }
        let stop = center.descendants(matching: .any).matching(NSPredicate(format: "label IN %@",
            ["停止镜像", "停止屏幕镜像", "Stop Mirroring"])).firstMatch
        guard stop.waitForExistence(timeout: 8) else { return "stop_control_missing" }
        stop.tap(); pattern.activate(); return "source_stop_requested"
    }
}
