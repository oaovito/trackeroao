import UIKit
import WebKit

/*
 * Aplicativo de iOS: uma tela com a página servida pelo computador, carregada
 * pelo esquema trackeroao:// da Ponte.
 */
@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?

    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        let w = UIWindow(frame: UIScreen.main.bounds)
        w.backgroundColor = Principal.fundo
        w.rootViewController = Principal()
        w.makeKeyAndVisible()
        window = w
        return true
    }
}

final class Principal: UIViewController, WKNavigationDelegate {
    static let fundo = UIColor(red: 6 / 255, green: 7 / 255, blue: 10 / 255, alpha: 1)
    static let inicio = URL(string: "trackeroao://app/")!

    private var web: WKWebView!
    private let ponte = Ponte()

    override var preferredStatusBarStyle: UIStatusBarStyle { .lightContent }

    override func loadView() {
        let cfg = WKWebViewConfiguration()
        cfg.setURLSchemeHandler(ponte, forURLScheme: "trackeroao")
        cfg.websiteDataStore = .default()
        // Gestos de voltar/avançar tratados pela página (ligarGestos); a página
        // também esconde o acesso pelo celular dentro do aplicativo.
        let aviso = WKUserScript(source: "window.TRACKEROAO_GESTOS = true; window.TRACKEROAO_APP = true;",
                                 injectionTime: .atDocumentStart, forMainFrameOnly: true)
        cfg.userContentController.addUserScript(aviso)
        web = WKWebView(frame: .zero, configuration: cfg)
        web.navigationDelegate = self
        web.allowsBackForwardNavigationGestures = false
        web.isOpaque = false
        web.backgroundColor = Principal.fundo
        web.scrollView.backgroundColor = Principal.fundo
        web.scrollView.contentInsetAdjustmentBehavior = .never
        view = web
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        web.load(URLRequest(url: Principal.inicio))
    }

    // Links externos abrem no Safari.
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url, let esquema = url.scheme?.lowercased() else {
            decisionHandler(.allow)
            return
        }
        if esquema == "trackeroao" || esquema == "about" || !action.targetFrameIsMain {
            decisionHandler(.allow)
            return
        }
        UIApplication.shared.open(url)
        decisionHandler(.cancel)
    }
}

private extension WKNavigationAction {
    var targetFrameIsMain: Bool { targetFrame?.isMainFrame ?? true }
}
