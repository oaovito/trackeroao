'use strict';
/*
 * serve.js - small static file server for the tracker page, plus the local
 * control routes. Binds 0.0.0.0 so phones on the same network can reach it.
 */

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');


const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
  '.apk': 'application/vnd.android.package-archive',
};

/**
 * Endereços IPv4 alcançáveis pela rede local. Exclui 169.254.0.0/16 (APIPA),
 * atribuído pelo Windows a adaptadores sem DHCP.
 */
// Entrada completa do catálogo (com os processos), a partir da chave.
function doCatalogo(g) {
  try {
    const c = require('./jogos').catalogo().find((x) => x.chave === g.chave);
    return c ? { ...c, ...g, appId: g.appId || c.appId, processos: c.processos || [] } : g;
  } catch (e) { return g; }
}

/*
 * Inicia o jogo: pela Steam quando o jogo é dela e ela está instalada; senão
 * pelo executável achado na pasta do jogo. null quando não há como.
 */
function abrirJogo(g, opts) {
  const o = opts || {};
  const plataforma = o.plataforma || process.platform;
  if (plataforma !== 'win32' || !g || !g.chave) return null;
  const { spawn } = o.spawn ? { spawn: o.spawn } : require('child_process');
  let steam = o.steam;
  if (steam === undefined) { try { steam = require('./instalacao').steamPath(); } catch (e) { steam = null; } }
  const daSteam = (g.fontes || []).some((f) => /^steam/.test(f));
  if (steam && daSteam && /^\d+$/.test(String(g.appId || ''))) {
    spawn('cmd.exe', ['/d', '/c', 'start', '""', 'steam://rungameid/' + g.appId],
      { windowsHide: true, detached: true, stdio: 'ignore' }).unref();
    return { ok: true, como: 'steam' };
  }
  let exe = o.exe;
  if (exe === undefined) { try { exe = require('./biblioteca').executavelDoJogo(g); } catch (e) { exe = null; } }
  if (!exe) return null;
  spawn(exe, [], { cwd: path.dirname(exe), detached: true, stdio: 'ignore' }).unref();
  return { ok: true, como: 'executavel' };
}

function isApipa(ip) {
  return ip.startsWith('169.254.');
}

function localAddresses() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const net of ifaces[name] || []) {
      const family = typeof net.family === 'string' ? net.family : `IPv${net.family}`;
      if (family !== 'IPv4' || net.internal) continue;
      if (isApipa(net.address)) continue;
      out.push({ name, address: net.address, private: isPrivate(net.address) });
    }
  }
  out.sort((a, b) => Number(b.private) - Number(a.private));
  return out;
}

function isPrivate(ip) {
  const p = ip.split('.').map(Number);
  if (p[0] === 10) return true;
  if (p[0] === 192 && p[1] === 168) return true;
  if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
  return false;
}

function safeJoin(root, urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  const rel = decoded.replace(/^\/+/, '');
  const target = path.resolve(root, rel);
  const rootResolved = path.resolve(root);
  // Never serve outside the directory we were pointed at.
  if (target !== rootResolved && !target.startsWith(rootResolved + path.sep)) return null;
  return target;
}

function createServer(options) {
  const root = options.root;
  const indexFile = options.indexFile || 'trackeroao.html';
  // Callback da rota /abrir, definido pelo processo residente.
  const aoAbrir = typeof options.aoAbrir === 'function' ? options.aoAbrir : null;
  const aoVarrer = typeof options.aoVarrer === 'function' ? options.aoVarrer : null;
  const aoAtualizar = typeof options.aoAtualizar === 'function' ? options.aoAtualizar : null;
  const aoEncerrar = typeof options.aoEncerrar === 'function' ? options.aoEncerrar : null;

  /*
   * Versão da página (tamanho + data do arquivo), enviada no cabeçalho das
   * respostas .json para a página aberta se recarregar após uma atualização.
   */
  const versaoDaPagina = () => {
    try {
      const st = fs.statSync(path.join(root, indexFile));
      return st.size + '-' + Math.round(st.mtimeMs);
    } catch (e) { return ''; }
  };

  return http.createServer((req, res) => {
    // Remove a query antes de comparar o caminho.
    let urlPath = (req.url || '/').split('?')[0];

    // Chamado pelo atalho da área de trabalho: acende o ícone da bandeja.
    // Rotas de controle só aceitam requisições da própria máquina.
    if (urlPath === '/abrir') {
      const daMaquina = /^(::1|::ffff:127\.|127\.)/.test(req.socket.remoteAddress || '');
      if (!daMaquina) { res.writeHead(403).end('forbidden'); return; }
      if (aoAbrir) { try { aoAbrir(); } catch (e) { /* abrir nao pode derrubar o servidor */ } }
      res.writeHead(204).end();
      return;
    }

    // Abre o jogo nesta máquina. Só atende a própria máquina.
    if (urlPath === '/abrir-jogo') {
      const daMaquina = /^(::1|::ffff:127\.|127\.)/.test(req.socket.remoteAddress || '');
      if (!daMaquina || req.method !== 'POST') { res.writeHead(403).end('forbidden'); return; }
      const chave = new URL(req.url, 'http://x').searchParams.get('chave') || '';
      let r = null;
      try { r = abrirJogo(doCatalogo({ chave })); } catch (e) { r = null; }
      res.writeHead(r ? 202 : 404, { 'content-type': MIME['.json'], 'cache-control': 'no-store' });
      res.end(JSON.stringify(r || { ok: false }));
      return;
    }

    // Agenda uma nova varredura de jogos para a próxima volta do ciclo.
    if (urlPath === '/varrer') {
      const daMaquina = /^(::1|::ffff:127\.|127\.)/.test(req.socket.remoteAddress || '');
      if (!daMaquina || req.method !== 'POST') { res.writeHead(403).end('forbidden'); return; }
      if (aoVarrer) { try { aoVarrer(); } catch (e) { /* não derruba o servidor */ } }
      res.writeHead(202).end();
      return;
    }

    // Lista de jogos, disponível mesmo sem save lido.
    if (urlPath === '/jogos.json') {
      let corpo = null;
      try { corpo = require('./jogos').paraProgresso(); } catch (e) { corpo = null; }
      res.writeHead(corpo ? 200 : 503, { 'content-type': MIME['.json'], 'cache-control': 'no-store', 'x-trackeroao-pagina': versaoDaPagina() });
      res.end(JSON.stringify(corpo || { ok: false }));
      return;
    }

    // Ícone próprio do jogo (do executável ou da Steam), para o menu da bandeja.
    if (urlPath === '/logo-bandeja') {
      const daMaquina = /^(::1|::ffff:127\.|127\.)/.test(req.socket.remoteAddress || '');
      if (!daMaquina) { res.writeHead(403).end('forbidden'); return; }
      const chave = new URL(req.url, 'http://x').searchParams.get('chave') || '';
      let r = null;
      try { r = require('./icone').doJogo(doCatalogo({ chave })); } catch (e) { r = null; }
      if (!r) { res.writeHead(404).end(); return; }
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store', 'x-trackeroao-origem': r.origem });
      res.end(r.png);
      return;
    }

    // Busca de jogos pelo nome.
    if (urlPath === '/buscar.json') {
      let achados = [];
      try {
        const q = new URL(req.url, 'http://x').searchParams.get('q') || '';
        achados = require('./busca').buscar(q.slice(0, 80), 60);
      } catch (e) { achados = []; }
      res.writeHead(200, { 'content-type': MIME['.json'], 'cache-control': 'no-store' });
      res.end(JSON.stringify({ lista: achados }));
      return;
    }

    /*
     * Até cinco jogos (instalados ou vigiados) para o menu da bandeja, do mais
     * recente ao mais antigo. Formato texto, uma linha por jogo:
     * "chave<TAB>nome<TAB>1 se tem pagina de progresso<TAB>executavel".
     */
    if (urlPath === '/bandeja.txt') {
      const daMaquina = /^(::1|::ffff:127\.|127\.)/.test(req.socket.remoteAddress || '');
      if (!daMaquina) { res.writeHead(403).end('forbidden'); return; }
      let lista = [];
      try { lista = ((require('./jogos').paraProgresso() || {}).lista) || []; } catch (e) { lista = []; }
      const ordem = (g) => (g.recente ? g.recente : 1e9);
      const linhas = lista
        .filter((g) => g.instalado || g.vigiado)
        .sort((a, b) => ordem(a) - ordem(b) || String(a.nome).localeCompare(String(b.nome)))
        .slice(0, 5)
        .map((g) => {
          // Executável do jogo, de onde a bandeja extrai o ícone.
          let exe = '';
          try { exe = require('./biblioteca').executavelDoJogo(doCatalogo(g)) || ''; } catch (e) { exe = ''; }
          return [g.chave, g.nome, g.leitura === 'completa' ? '1' : '0', exe].map((v) => String(v).replace(/[\t\r\n]/g, ' ')).join('\t');
        });
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      res.end(linhas.join('\n'));
      return;
    }

    // IP desta máquina na rede local, para o passo a passo do celular.
    if (urlPath === '/rede') {
      const addrs = localAddresses();
      const corpo = { ip: addrs.length ? addrs[0].address : null, porta: req.socket.localPort || null };
      res.writeHead(200, { 'content-type': MIME['.json'], 'cache-control': 'no-store' });
      res.end(JSON.stringify(corpo));
      return;
    }

    // Código QR com o endereço atual desta máquina na rede local.
    if (urlPath === '/qr.svg') {
      const daMaquina = /^(::1|::ffff:127\.|127\.)/.test(req.socket.remoteAddress || '');
      if (!daMaquina) { res.writeHead(403).end('forbidden'); return; }
      const addrs = localAddresses();
      const host = addrs.length ? addrs[0].address : 'trackeroao.local';
      const base = 'http://' + host + ':' + (req.socket.localPort || 8777);
      const para = new URL(req.url, 'http://x').searchParams.get('para');
      // iPhone: passo a passo de instalação pelo SideStore (/ios).
      const alvo = para === 'android' ? base + '/android.apk' : para === 'web' ? base + '/' : base + '/ios';
      res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'no-store' });
      res.end(require('./qr').svg(alvo));
      return;
    }

    // Passo a passo do aplicativo de iOS.
    if (urlPath === '/ios') {
      fs.readFile(path.join(__dirname, 'ios.html'), (err, corpo) => {
        if (err) { res.writeHead(404).end('404'); return; }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
        res.end(corpo);
      });
      return;
    }

    // Idioma escolhido na página, compartilhado com a bandeja e a janela.
    // null segue o idioma do sistema. Gravar só da própria máquina.
    if (urlPath === '/idioma') {
      const idioma = require('./idioma');
      if (req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ idioma: idioma.ler() }));
        return;
      }
      const daMaquina = /^(::1|::ffff:127\.|127\.)/.test(req.socket.remoteAddress || '');
      if (!daMaquina || req.method !== 'POST') { res.writeHead(403).end('forbidden'); return; }
      let corpo = '';
      req.on('data', (c) => { corpo += c; if (corpo.length > 256) req.destroy(); });
      req.on('end', () => {
        try {
          const escolhido = idioma.gravar(JSON.parse(corpo).idioma);
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ idioma: escolhido }));
        } catch (e) {
          res.writeHead(400, { 'content-type': 'application/json' }).end('{"erro":"pedido malformado"}');
        }
      });
      return;
    }

    // "Forçar atualização" do menu da bandeja: verifica a release na próxima volta.
    if (urlPath === '/atualizar') {
      const daMaquina = /^(::1|::ffff:127\.|127\.)/.test(req.socket.remoteAddress || '');
      if (!daMaquina || req.method !== 'POST') { res.writeHead(403).end('forbidden'); return; }
      // {atual: true} se já está na última versão; {atual: false} se há
      // versão nova, aplicada na próxima volta.
      require('./atualizar').situacao().then((s) => {
        if (!s.atual && aoAtualizar) { try { aoAtualizar(); } catch (e) { /* não derruba o servidor */ } }
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(s));
      }, (e) => {
        res.writeHead(502, { 'content-type': 'application/json' }).end(JSON.stringify({ erro: e.message }));
      });
      return;
    }

    // "Fechar" do menu da bandeja: encerra o serviço até a próxima abertura manual.
    if (urlPath === '/encerrar') {
      const daMaquina = /^(::1|::ffff:127\.|127\.)/.test(req.socket.remoteAddress || '');
      if (!daMaquina || req.method !== 'POST') { res.writeHead(403).end('forbidden'); return; }
      res.writeHead(202).end();
      if (aoEncerrar) setTimeout(() => { try { aoEncerrar(); } catch (e) { /* sai de qualquer jeito */ } }, 200);
      return;
    }

    // Nome exibido no cabeçalho, definido na página (alternativa à Steam).
    if (urlPath === '/jogador') {
      const daMaquina = /^(::1|::ffff:127\.|127\.)/.test(req.socket.remoteAddress || '');
      if (!daMaquina || req.method !== 'POST') { res.writeHead(403).end('forbidden'); return; }
      let corpo = '';
      req.on('data', (c) => { corpo += c; if (corpo.length > 1024) req.destroy(); });
      req.on('end', () => {
        try {
          const jogador = require('./jogador');
          jogador.escolher(JSON.parse(corpo).nick);
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(jogador.quem()));
        } catch (e) {
          res.writeHead(400, { 'content-type': 'application/json' }).end('{"erro":"pedido malformado"}');
        }
      });
      return;
    }

    // Seleção de jogos vigiados: única preferência gravada pela página, e só
    // aceita da própria máquina.
    if (urlPath === '/selecao') {
      const daMaquina = /^(::1|::ffff:127\.|127\.)/.test(req.socket.remoteAddress || '');
      if (!daMaquina) {
        res.writeHead(403, { 'content-type': 'application/json' })
           .end('{"erro":"a escolha só pode ser feita no próprio computador"}');
        return;
      }
      const jogos = require('./jogos');
      if (req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' })
           .end(JSON.stringify(jogos.paraProgresso()));
        return;
      }
      if (req.method === 'POST') {
        let corpo = '';
        req.on('data', (c) => {
          corpo += c;
          // Limita o tamanho do corpo.
          if (corpo.length > 65536) { req.destroy(); }
        });
        req.on('end', () => {
          try {
            const pedido = JSON.parse(corpo);
            jogos.selecionar(pedido.jogos);
            res.writeHead(200, { 'content-type': 'application/json' })
               .end(JSON.stringify(jogos.paraProgresso()));
          } catch (e) {
            res.writeHead(400, { 'content-type': 'application/json' })
               .end('{"erro":"pedido malformado"}');
          }
        });
        return;
      }
      res.writeHead(405).end('method not allowed');
      return;
    }
    if (urlPath === '/' || urlPath === '') urlPath = '/' + indexFile;

    /*
     * APK do Android, instalado em <instalacao>/app e baixado pelo celular
     * pela rede local. O restante de app/ não é servido.
     */
    if (urlPath === '/android.apk') urlPath = '/app/trackeroao.apk';

    let file = safeJoin(root, urlPath);
    if (!file) {
      res.writeHead(403).end('forbidden');
      return;
    }

    // Caminhos relativos da página (icones/, arquivos do app) são servidos a
    // partir de docs/, pois aqui a página vem da raiz do projeto.
    const daJanela = /^\/app\//.test(urlPath) && urlPath !== '/app/trackeroao.apk';
    if (/^\/(icones\/|app\/|sw\.js$|manifest\.webmanifest$)/.test(urlPath) && (daJanela || !fs.existsSync(file))) {
      const noSite = safeJoin(path.join(root, 'docs'), urlPath);
      if (noSite && fs.existsSync(noSite)) file = noSite;
      else if (daJanela) file = path.join(root, 'docs', '.nada');
    }

    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) {
        // progress.json may not exist yet; answer in a form the page handles.
        if (path.basename(file) === 'progress.json') {
          res.writeHead(404, { 'content-type': MIME['.json'], 'cache-control': 'no-store' });
          res.end(JSON.stringify({ ok: false, error: 'not-generated-yet' }));
          return;
        }
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('404');
        return;
      }
      const ext = path.extname(file).toLowerCase();
      const headers = { 'content-type': MIME[ext] || 'application/octet-stream' };
      // The page polls progress.json; it must never be served from cache.
      headers['cache-control'] = ext === '.json' ? 'no-store' : 'no-cache';
      if (ext === '.json') headers['x-trackeroao-pagina'] = versaoDaPagina();
      res.writeHead(200, headers);
      fs.createReadStream(file).pipe(res);
    });
  });
}

/**
 * Escuta extra numa porta (usada para a 80). Falha não é erro: resolve com
 * { ok: false } e a porta principal continua valendo.
 */
function listenExtra(options) {
  const server = createServer({ root: options.root, indexFile: options.indexFile, aoAbrir: options.aoAbrir, aoVarrer: options.aoVarrer, aoAtualizar: options.aoAtualizar, aoEncerrar: options.aoEncerrar });
  return new Promise((resolve) => {
    const desistir = (err) => resolve({ ok: false, port: options.port, error: err && err.message });
    server.once('error', desistir);
    try {
      server.listen(options.port, '0.0.0.0', () => resolve({ ok: true, port: options.port, server }));
    } catch (err) {
      desistir(err);
    }
  });
}

/**
 * Start listening on every interface and print how to reach it.
 * Resolves with { server, port, urls }.
 */
function start(options) {
  const root = options.root;
  const port = options.port || 8777;
  const indexFile = options.indexFile || 'trackeroao.html';
  const server = createServer({ root, indexFile, aoAbrir: options.aoAbrir, aoVarrer: options.aoVarrer, aoAtualizar: options.aoAtualizar, aoEncerrar: options.aoEncerrar });

  // Sem IP de LAN ainda: o anúncio fica a cargo de quem chama.
  const quiet = options.quiet === true;

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', () => {
      const addrs = localAddresses();
      const lanIp = addrs.length ? addrs[0].address : null;
      const lanUrl = lanIp ? `http://${lanIp}:${port}/${indexFile}` : null;
      const localUrl = `http://localhost:${port}/${indexFile}`;

      if (quiet) {
        console.log(`  [http] escutando em 0.0.0.0:${port}`);
        resolve({ server, port, urls: { local: localUrl, lan: lanUrl } });
        return;
      }

      console.log('');
      console.log('  Servidor no ar (escutando em 0.0.0.0, toda a rede local)');
      console.log(`     nesta máquina : ${localUrl}`);
      if (lanUrl) {
        console.log(`     pelo celular  : ${lanUrl}`);
      }
      for (const a of addrs.slice(1)) {
        console.log(`     (outra placa) : http://${a.address}:${port}/${indexFile}  [${a.name}]`);
      }

      if (lanUrl) {
        console.log('');
        console.log(`  na rede local: ${lanUrl}`);
      } else {
        console.log('');
        console.log('  Nenhum IP de rede local encontrado - só dá para abrir nesta máquina.');
      }
      console.log('');
      console.log('  O celular precisa estar no mesmo Wi-Fi. Se não abrir, libere a porta');
      console.log(`  ${port} no Firewall do Windows para redes privadas.`);
      console.log('');

      resolve({ server, port, urls: { local: localUrl, lan: lanUrl } });
    });
  });
}

/** Endereço desta máquina na rede local, ou null enquanto não houver IP. */
function lanUrl(porta, indice) {
  const addrs = localAddresses();
  if (!addrs.length) return null;
  const p = porta || Number(process.env.PORT || 8777);
  return `http://${addrs[0].address}:${p}/${indice || 'trackeroao.html'}`;
}

module.exports = { start, listenExtra, createServer, localAddresses, lanUrl, isPrivate, isApipa, abrirJogo };

// ----------------------------------------------------------------------- CLI
if (require.main === module) {
  const port = Number(process.env.PORT || 8777);
  start({ root: path.join(__dirname, '..'), port }).catch((err) => {
    console.error('Não consegui subir o servidor:', err.message);
    process.exit(1);
  });
}
