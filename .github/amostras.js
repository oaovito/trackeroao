/*
 * As imagens de amostra do README (docs/amostras/*.png), tiradas da própria
 * página num navegador sem janela. O progresso é o docs/progress.json do
 * repositório; a lista de jogos é fixa, com jogos populares da Steam, para as
 * telas mostrarem arte de verdade. Roda no GitHub (amostras.yml), onde a
 * arte da Steam está ao alcance.
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const RAIZ = path.join(__dirname, '..');
const SAIDA = path.join(RAIZ, 'docs', 'amostras');
const jogo = (id, nome, o) => Object.assign({
  chave: 'steam-' + id, nome, appId: String(id), leitura: 'nenhuma', vigiado: false,
  instalado: true, naSteam: true, popular: null, arte: null, recente: null, andamento: null,
}, o);
const LISTA = [
  jogo(814380, 'Sekiro: Shadows Die Twice', { chave: 'sekiro', leitura: 'completa', vigiado: true, recente: 1, andamento: true }),
  jogo(1245620, 'ELDEN RING', { recente: 2, andamento: true }),
  jogo(367520, 'Hollow Knight', { recente: 3, andamento: false }),
  jogo(374320, 'DARK SOULS III', { recente: 4, andamento: false }),
  jogo(1145360, 'Hades'),
  jogo(1086940, "Baldur's Gate 3"),
  jogo(1091500, 'Cyberpunk 2077', { instalado: false }),
  jogo(504230, 'Celeste', { instalado: false }),
];

let progresso = null;

// O computador abre por 127.0.0.1; o celular, pelo endereço da rede.
const PC = 'http://127.0.0.1:8777/';
const CELULAR = 'http://192.168.0.10:8777/';

async function rotas(pg) {
  await pg.route(/^http:\/\/(127\.0\.0\.1|192\.168\.0\.10):8777\//, (r) => {
    const u = new URL(r.request().url());
    if (u.pathname === '/') return r.fulfill({ body: fs.readFileSync(path.join(RAIZ, 'trackeroao.html')), contentType: 'text/html' });
    if (u.pathname === '/progress.json') return r.fulfill({ body: JSON.stringify(progresso), contentType: 'application/json' });
    if (u.pathname === '/jogos.json') return r.fulfill({ body: JSON.stringify(progresso.jogosVigiados), contentType: 'application/json' });
    if (u.pathname === '/qr.svg') return r.fulfill({ body: require(path.join(RAIZ, 'sync', 'qr')).svg('http://trackeroao.local:8777/'), contentType: 'image/svg+xml' });
    if (u.pathname === '/android.apk') return r.fulfill({ status: 200, body: '' });
    const f = path.join(RAIZ, 'docs', u.pathname);
    if (fs.existsSync(f) && fs.statSync(f).isFile()) return r.fulfill({ body: fs.readFileSync(f) });
    return r.fulfill({ status: 404, body: '' });
  });
}

async function main() {
  fs.mkdirSync(SAIDA, { recursive: true });
  progresso = JSON.parse(fs.readFileSync(path.join(RAIZ, 'docs', 'progress.json'), 'utf8'));
  progresso.jogosVigiados = { lista: LISTA, escolheu: true, varredura: { comSteam: true } };
  const b = await chromium.launch();
  const telas = [
    { arq: 'inicio.png', hash: '', w: 1320, h: 860 },
    { arq: 'sekiro.png', hash: 'sekiro', w: 1320, h: 860 },
    { arq: 'todos.png', hash: 'all', w: 1320, h: 860 },
    // As mesmas telas no celular, em pé: um aparelho grande e um pequeno.
    { arq: 'celular-inicio.png', hash: '', w: 390, h: 844, escala: 2 },
    { arq: 'celular-inicio-pequeno.png', hash: '', w: 375, h: 667, escala: 2 },
    { arq: 'celular-todos.png', hash: 'all', w: 390, h: 844, escala: 2 },
    { arq: 'celular.png', hash: 'sekiro', w: 390, h: 844, escala: 2 },
    { arq: 'celular-qr.png', hash: '', w: 1320, h: 860, qr: true },
  ];
  for (const t of telas) {
    const c = await b.newContext({ viewport: { width: t.w, height: t.h }, deviceScaleFactor: t.escala || 1, colorScheme: 'dark' });
    await c.addInitScript(() => {
      try {
        // Nenhuma marca de "novo" nas amostras: tudo já é conhecido.
        localStorage.setItem('trackeroao-instalados-conhecidos', JSON.stringify(['sekiro', 'steam-1245620', 'steam-367520', 'steam-374320', 'steam-1145360', 'steam-1086940']));
      } catch (e) { /* sem armazenamento */ }
    });
    const pg = await c.newPage();
    await rotas(pg);
    await pg.goto((t.escala ? CELULAR : PC) + (t.hash ? '#' + t.hash : ''));
    await pg.waitForLoadState('networkidle').catch(() => {});
    await pg.waitForTimeout(4000);
    if (t.qr) {
      await pg.click('#celularBt');
      await pg.click('#celAndroidBt');
      await pg.waitForTimeout(900);
    }
    await pg.screenshot({ path: path.join(SAIDA, t.arq) });
    console.log('  ' + t.arq);
    await c.close();
  }
  // O título do jogo em foco não encosta na barra, nos ícones do canto nem nos
  // pinos abaixo dele, em nenhum tamanho de janela.
  const falhas = [];
  for (const [w, h] of [[1920, 1080], [1320, 860], [1305, 760], [1280, 720], [1044, 684], [1280, 600], [900, 560], [1100, 500], [390, 844], [375, 667]]) {
    for (const foco of LISTA.filter((g) => g.instalado).map((g) => g.chave)) {
      const c = await b.newContext({ viewport: { width: w, height: h }, colorScheme: 'dark' });
      const pg = await c.newPage();
      await rotas(pg);
      await pg.goto('http://127.0.0.1:8777/');
      await pg.waitForTimeout(2500);
      await pg.hover('.jogo-card[data-chave="' + foco + '"]', { timeout: 3000 }).catch(() => {});
      await pg.waitForTimeout(1200);
      const r = await pg.evaluate(() => {
        const canto = document.querySelector('#hub > .hub-topo');
        const barra = document.querySelector('.topbar');
        const marca = document.querySelector('#palcoMarca');
        const meta = document.querySelector('.palco-meta');
        const el = marca && marca.firstElementChild;
        if (!canto || !barra || !el || !meta) return null;
        const c = canto.getBoundingClientRect(), m = el.getBoundingClientRect();
        const cruza = !(m.right <= c.left || m.left >= c.right || m.bottom <= c.top || m.top >= c.bottom);
        const rola = document.documentElement.scrollHeight > innerHeight + 1;
        return { cruza, rola, de: m.top, ate: m.bottom, barra: barra.getBoundingClientRect().bottom, meta: meta.getBoundingClientRect().top };
      });
      if (r && (r.cruza || r.rola || r.de < r.barra - 0.5 || r.ate > r.meta + 0.5)) falhas.push(`${w}x${h} ${foco}: ${JSON.stringify(r)}`);
      await c.close();
    }
  }
  if (falhas.length) { console.error('título sobreposto ou tela rolando:\n  ' + falhas.join('\n  ')); process.exitCode = 1; }
  else console.log('  título do jogo sem sobreposição e tela inicial sem rolagem');

  // O passo a passo do iOS, que o código QR do iPhone abre.
  const c = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, locale: 'pt-BR' });
  const pg = await c.newPage();
  await pg.goto('file://' + path.join(RAIZ, 'sync', 'ios.html'));
  await pg.waitForLoadState('networkidle').catch(() => {});
  await pg.waitForTimeout(1500);
  await pg.screenshot({ path: path.join(SAIDA, 'ios.png') });
  console.log('  ios.png');
  await c.close();
  await b.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
