import UIKit
import AVFoundation

// A separate test app: the accepted continuous-pattern source is unchanged.
// AVPlayer renders a locally generated, verified muxed A/V file. Disallowing
// external playback keeps this an actual screen-mirroring test, not remote-file
// AirPlay playback. No camera, microphone, account or user-content access.
@main final class SyncApp: UIResponder, UIApplicationDelegate {
    var window: UIWindow?
    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        application.isIdleTimerDisabled = true
        window = UIWindow(frame: UIScreen.main.bounds)
        window?.rootViewController = SyncController()
        window?.makeKeyAndVisible()
        return true
    }
}

final class SyncController: UIViewController {
    private var player: AVPlayer?
    private let surface = AVPlayerLayer()
    private let status = UILabel()
    private var observation: NSKeyValueObservation?
    private var routeObserver: NSObjectProtocol?
    private var endObserver: NSObjectProtocol?

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        surface.videoGravity = .resizeAspect
        view.layer.addSublayer(surface)
        status.textColor = .white
        status.font = .monospacedSystemFont(ofSize: 18, weight: .bold)
        status.textAlignment = .center
        status.numberOfLines = 3
        status.text = "音画同步测试 · 32 秒\n白框亮起时应听到短滴声\n点一下从头播放"
        status.accessibilityIdentifier = "casting-sync-status"
        view.addSubview(status)
        view.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(restart)))
        do {
            try AVAudioSession.sharedInstance().setCategory(.playback, mode: .moviePlayback)
            try AVAudioSession.sharedInstance().setActive(true)
            guard let url = Bundle.main.url(forResource: "Browser-Sync-Test-32s", withExtension: "mp4") else {
                status.text = "测试片缺失，不能测试"
                return
            }
            let item = AVPlayerItem(url: url)
            let playback = AVPlayer(playerItem: item)
            playback.allowsExternalPlayback = false
            player = playback
            surface.player = playback
            observation = item.observe(\.status, options: [.initial, .new]) { [weak self] item, _ in
                DispatchQueue.main.async {
                    if item.status == .readyToPlay { self?.player?.play() }
                    if item.status == .failed { self?.status.text = "测试片播放失败，不能测试" }
                }
            }
            endObserver = NotificationCenter.default.addObserver(forName: .AVPlayerItemDidPlayToEndTime,
                object: item, queue: .main) { [weak self] _ in
                    self?.status.text = "本轮播放结束\n点一下重播 · 白框与短滴声同步"
                }
            routeObserver = NotificationCenter.default.addObserver(forName: AVAudioSession.routeChangeNotification,
                object: nil, queue: .main) { [weak self] _ in self?.restart() }
        } catch {
            status.text = "音频无法启动，不能测试"
        }
    }

    @objc private func restart() {
        status.text = "音画同步测试 · 32 秒\n白框亮起时应听到短滴声\n点一下从头播放"
        player?.seek(to: .zero, toleranceBefore: .zero, toleranceAfter: .zero) { [weak self] ok in
            if ok { self?.player?.play() }
        }
    }
    override var prefersStatusBarHidden: Bool { true }
    override var supportedInterfaceOrientations: UIInterfaceOrientationMask { .landscape }
    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        surface.frame = view.bounds
        status.frame = CGRect(x: 16, y: view.bounds.height - 76, width: view.bounds.width - 32, height: 70)
    }
    deinit {
        if let observer = routeObserver { NotificationCenter.default.removeObserver(observer) }
        if let observer = endObserver { NotificationCenter.default.removeObserver(observer) }
    }
}
