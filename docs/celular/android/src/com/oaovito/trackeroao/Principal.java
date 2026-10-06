package com.oaovito.trackeroao;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.graphics.drawable.ColorDrawable;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.ValueCallback;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

/*
 * Principal - tela única com um WebView em http://trackeroao.local/, atendido
 * pela Ponte. Links externos abrem no navegador do sistema.
 */
public final class Principal extends Activity {

    static final String INICIO = "http://" + Localizador.NOME + "/";
    private static final int FUNDO = 0xFF06070A;

    private WebView web;
    private Ponte ponte;

    @Override
    protected void onCreate(Bundle salvo) {
        super.onCreate(salvo);
        getWindow().setBackgroundDrawable(new ColorDrawable(FUNDO));

        ponte = new Ponte(this, new Localizador(this));

        web = new WebView(this);
        web.setBackgroundColor(FUNDO);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);    // a página guarda preferências no localStorage
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setCacheMode(WebSettings.LOAD_NO_CACHE);
        // A página esconde o acesso pelo celular quando já está no aplicativo.
        s.setUserAgentString(s.getUserAgentString() + " TrackeroaoApp");
        web.setWebViewClient(new Cliente(this, ponte));
        setContentView(web);

        if (salvo == null || web.restoreState(salvo) == null) web.loadUrl(INICIO);
    }

    // Classe aninhada estática: classes internas quebram algumas versões do d8.
    private static final class Cliente extends WebViewClient {
        private final Activity dono;
        private final Ponte ponte;

        Cliente(Activity dono, Ponte ponte) {
            this.dono = dono;
            this.ponte = ponte;
        }

        @Override
        public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest req) {
            // Só requisições da própria página passam pela Ponte.
            if (!Localizador.NOME.equalsIgnoreCase(req.getUrl().getHost())) return null;
            return ponte.atender(req);
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest req) {
            Uri u = req.getUrl();
            if (Localizador.NOME.equalsIgnoreCase(u.getHost())) return false;
            try {
                dono.startActivity(new Intent(Intent.ACTION_VIEW, u).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            } catch (ActivityNotFoundException e) {
                // nenhum aplicativo para abrir; ignora
            }
            return true;
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    @Override
    protected void onResume() {
        super.onResume();
        web.onResume();
    }

    @Override
    protected void onPause() {
        web.onPause();
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        web.destroy();
        super.onDestroy();
    }

    // Voltar: a página fecha primeiro o que estiver aberto por cima; senão,
    // volta no histórico ou sai.
    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        web.evaluateJavascript(
            "(function(){try{return !!(window.trackeroaoVoltar&&window.trackeroaoVoltar());}catch(e){return false;}})()",
            new Resposta(this));
    }

    void voltarDeTela() {
        if (web.canGoBack()) web.goBack();
        else sair();
    }

    @SuppressWarnings("deprecation")
    private void sair() {
        super.onBackPressed();
    }

    private static final class Resposta implements ValueCallback<String> {
        private final Principal dono;

        Resposta(Principal dono) {
            this.dono = dono;
        }

        @Override
        public void onReceiveValue(String valor) {
            if (!"true".equals(valor)) dono.voltarDeTela();
        }
    }
}
