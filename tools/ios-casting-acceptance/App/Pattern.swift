import UIKit
import AVFoundation

// Dedicated, non-sensitive moving picture and continuous synthetic tone.
// This is an actual Apple screen-mirroring source, not injected receiver media.
@main final class App: UIResponder, UIApplicationDelegate {
    var window: UIWindow?
    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        application.isIdleTimerDisabled = true
        let controller = UIViewController()
        controller.view = Pattern()
        window = UIWindow(frame: UIScreen.main.bounds)
        window?.rootViewController = controller
        window?.makeKeyAndVisible()
        return true
    }
}

final class Pattern: UIView {
    private var player: AVAudioPlayer?
    private var audioFailure = false
    private var routeObserver: NSObjectProtocol?
    private var link: CADisplayLink?
    private var frameNumber = 0
    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = .black
        startTone()
        // AirPlay changes the output route after the app has started. A
        // source-node engine can stop on that change; test the receiver with
        // actual looping PCM, and expose source liveness in the test picture.
        routeObserver = NotificationCenter.default.addObserver(
            forName: AVAudioSession.routeChangeNotification,
            object: nil, queue: .main) { [weak self] _ in self?.startTone() }
        let ticker = CADisplayLink(target: self, selector: #selector(tick))
        ticker.preferredFrameRateRange = CAFrameRateRange(minimum: 30, maximum: 30, preferred: 30)
        ticker.add(to: .main, forMode: .common)
        link = ticker
        accessibilityIdentifier = "dedicated-casting-pattern"
    }
    private func startTone() {
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.playback, mode: .default)
            try session.setActive(true)
            if player == nil {
                // Two-second 660 Hz stereo S16LE WAV, generated only in RAM.
                let frames = 96000, bytes = frames * 4
                var wav = Data()
                func word(_ value: UInt16) {
                    var little = value.littleEndian
                    withUnsafeBytes(of: &little) { wav.append(contentsOf: $0) }
                }
                func dword(_ value: UInt32) {
                    var little = value.littleEndian
                    withUnsafeBytes(of: &little) { wav.append(contentsOf: $0) }
                }
                wav.append(contentsOf: Array("RIFF".utf8)); dword(UInt32(36 + bytes))
                wav.append(contentsOf: Array("WAVEfmt ".utf8)); dword(16)
                word(1); word(2); dword(48000); dword(192000); word(4); word(16)
                wav.append(contentsOf: Array("data".utf8)); dword(UInt32(bytes))
                for i in 0..<frames {
                    let value = Int16(sin(Double(i) * 2 * .pi * 660 / 48000) * 5000)
                    word(UInt16(bitPattern: value)); word(UInt16(bitPattern: value))
                }
                player = try AVAudioPlayer(data: wav)
                player?.numberOfLoops = -1
                player?.volume = 0.5
            }
            audioFailure = player?.play() != true
        } catch {
            audioFailure = true
        }
    }
    required init?(coder: NSCoder) { fatalError("unused") }
    @objc private func tick() { frameNumber += 1; setNeedsDisplay() }
    override func draw(_ rect: CGRect) {
        guard let c = UIGraphicsGetCurrentContext() else { return }
        c.setFillColor(UIColor(red: 0.05, green: 0.10, blue: 0.16, alpha: 1).cgColor)
        c.fill(bounds)
        c.setStrokeColor(UIColor.white.cgColor)
        c.setLineWidth(3)
        c.stroke(bounds.insetBy(dx: 20, dy: 60))
        // Circles and squares make squeezing/cropping visible without user content.
        let side = min(bounds.width, bounds.height) * 0.28
        let y = bounds.midY + sin(Double(frameNumber) / 30) * Double(bounds.height * 0.20)
        c.setFillColor(UIColor.systemGreen.cgColor)
        c.fillEllipse(in: CGRect(x: bounds.midX - side / 2, y: y - side / 2, width: side, height: side))
        c.setStrokeColor(UIColor.systemYellow.cgColor)
        c.stroke(CGRect(x: bounds.midX - side / 2, y: bounds.midY - side / 2, width: side, height: side))
        let sound = audioFailure ? "AUDIO FAILED" : (player?.isPlaying == true ? "AUDIO PLAYING" : "AUDIO STOPPED")
        let volume = Int(AVAudioSession.sharedInstance().outputVolume * 100)
        let text = "TEAM AI BOX\nDEDICATED MEDIA TEST\nFRAME \(frameNumber) · 30 FPS\n\(sound) · VOLUME \(volume)%"
        let paragraph = NSMutableParagraphStyle(); paragraph.alignment = .center
        (text as NSString).draw(in: CGRect(x: 24, y: 100, width: bounds.width - 48, height: 140),
            withAttributes: [.font: UIFont.monospacedSystemFont(ofSize: 20, weight: .bold),
                             .foregroundColor: UIColor.white, .paragraphStyle: paragraph])
    }
}
