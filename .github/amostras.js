/*
 * As imagens de amostra do README (docs/amostras/{computador,celular}/*.png), tiradas da própria
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
  jogo(1245620, 'ELDEN RING', { leitura: 'completa', vigiado: true, progresso: 'elden.json', recente: 2, andamento: true }),
  jogo(2680010, 'The First Berserker: Khazan', { leitura: 'pagina', vigiado: true, recente: 3, andamento: true }),
  jogo(367520, 'Hollow Knight', { recente: 4, andamento: false }),
  jogo(374320, 'DARK SOULS III', { recente: 5, andamento: false }),
  jogo(1145360, 'Hades'),
  jogo(1086940, "Baldur's Gate 3"),
  jogo(1091500, 'Cyberpunk 2077', { instalado: false }),
  jogo(504230, 'Celeste', { instalado: false }),
];

let progresso = null;

// Marcas de exemplo do Khazan: as primeiras missões e o que há nelas.
function marcasKhazan() {
  const d = JSON.parse(fs.readFileSync(path.join(RAIZ, 'docs', 'app', 'khazan', 'dados.json'), 'utf8'));
  const m = [];
  for (const x of d.missoes.slice(0, 6)) m.push('missoes:' + x.id, 'soulstones:' + x.id, 'jarlings:' + x.id, ...x.chefes.map((c) => 'chefes:' + c));
  for (const x of d.secundarias.slice(0, 4)) m.push('secundarias:' + x.id);
  for (const i of d.colecionaveis.find((c) => c.id === 'golden-collection').itens.slice(0, 3)) m.push('dourados:' + i.id);
  return m;
}

// Leitura de exemplo do Elden Ring: uma parte de cada lista, tirada dos próprios dados.
function leituraElden() {
  const g = JSON.parse(fs.readFileSync(path.join(RAIZ, 'docs', 'app', 'eldenring', 'geral.json'), 'utf8'));
  const parte = (l, n) => l.filter((_, i) => i % n === 0);
  return {
    generatedAt: new Date().toISOString(), jogo: 'eldenring', formato: 1, ok: true,
    fonte: { slot: 0, escolha: 'auto', arquivo: 'sl2' }, mortes: 1287,
    itens: {
      armas: parte(g.ids.armas, 3).concat(parte(g.ids.escudos, 4)), armaduras: parte(g.ids.armaduras, 5),
      talismas: parte(g.ids.talismas, 2), cinzas: parte(g.ids['cinzas-de-guerra'], 3),
      bens: parte(g.ids.feiticos, 2).concat(parte(g.ids.encantamentos, 3), parte(g.ids['cinzas-espirituais'], 2)),
    },
    flags: parte(g.ids.chefes, 2).concat(parte(g.ids.locais, 2), parte(g.ids.mapas, 2)),
  };
}

// O computador abre por 127.0.0.1; o celular, pelo endereço da rede.
const PC = 'http://127.0.0.1:8777/';
const CELULAR = 'http://192.168.0.10:8777/';

async function rotas(pg) {
  await pg.route(/^http:\/\/(127\.0\.0\.1|192\.168\.0\.10):8777\//, (r) => {
    const u = new URL(r.request().url());
    if (u.pathname === '/') return r.fulfill({ body: fs.readFileSync(path.join(RAIZ, 'trackeroao.html')), contentType: 'text/html' });
    if (u.pathname === '/progress.json') return r.fulfill({ body: JSON.stringify(progresso), contentType: 'application/json' });
    if (u.pathname === '/elden.json') return r.fulfill({ body: JSON.stringify(leituraElden()), contentType: 'application/json' });
    if (u.pathname === '/marcas') return r.fulfill({ body: JSON.stringify({ jogo: 'khazan', marcas: marcasKhazan() }), contentType: 'application/json' });
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
    { arq: 'computador/inicio.png', hash: '', w: 1320, h: 860 },
    { arq: 'computador/sekiro.png', hash: 'sekiro', w: 1320, h: 860 },
    { arq: 'computador/eldenring.png', hash: 'steam-1245620', w: 1320, h: 860 },
    { arq: 'computador/eldenring-lista.png', hash: 'steam-1245620', w: 1320, h: 860, bloco: 'chefes' },
    { arq: 'computador/khazan.png', hash: 'steam-2680010', w: 1320, h: 860 },
    { arq: 'computador/khazan-lista.png', hash: 'steam-2680010', w: 1320, h: 860, kz: 'missoes' },
    { arq: 'computador/todos.png', hash: 'all', w: 1320, h: 860 },
    // As mesmas telas no celular, em pé: um aparelho grande e um pequeno.
    { arq: 'celular/inicio.png', hash: '', w: 390, h: 844, escala: 2 },
    { arq: 'celular/inicio-pequeno.png', hash: '', w: 375, h: 667, escala: 2 },
    { arq: 'celular/todos.png', hash: 'all', w: 390, h: 844, escala: 2 },
    { arq: 'celular/sekiro.png', hash: 'sekiro', w: 390, h: 844, escala: 2 },
    { arq: 'celular/eldenring.png', hash: 'steam-1245620', w: 390, h: 844, escala: 2 },
    { arq: 'celular/khazan.png', hash: 'steam-2680010', w: 390, h: 844, escala: 2 },
    { arq: 'computador/qr.png', hash: '', w: 1320, h: 860, qr: true },
  ];
  for (const t of telas) {
    const c = await b.newContext({ viewport: { width: t.w, height: t.h }, deviceScaleFactor: t.escala || 1, colorScheme: 'dark' });
    await c.addInitScript(() => {
      try {
        // Nenhuma marca de "novo" nas amostras: tudo já é conhecido.
        localStorage.setItem('trackeroao-instalados-conhecidos', JSON.stringify(['sekiro', 'steam-1245620', 'steam-2680010', 'steam-367520', 'steam-374320', 'steam-1145360', 'steam-1086940']));
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
    if (t.bloco) {
      // Uma lista aberta, com o primeiro registro escolhido.
      await pg.click('.er-bloco[data-er="' + t.bloco + '"]');
      await pg.waitForTimeout(1200);
      await pg.click('#erLista li:first-child .er-linha').catch(() => {});
      await pg.waitForTimeout(400);
    }
    if (t.kz) {
      await pg.click('.kz-bloco[data-kz="' + t.kz + '"]');
      await pg.waitForTimeout(1200);
      await pg.click('#kzLista li:first-child .kz-linha').catch(() => {});
      await pg.waitForTimeout(400);
    }
    fs.mkdirSync(path.dirname(path.join(SAIDA, t.arq)), { recursive: true });
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

  // Novidades na página do jogo: o botão de marcar como visto recebe o clique,
  // o painel some depois dele e a página não rola com ele aberto.
  const historico = Array.from({ length: 36 }, (_, i) => ({
    at: new Date(Date.parse('2026-10-05T10:00:00Z') + i * 60000).toISOString(),
    tipo: 'counter', label: 'Scrap Iron', texto: (30 + i) + ' → ' + (31 + i),
  }));
  const semHistorico = progresso.history;
  progresso.history = historico;
  const falhasNov = [];
  for (const [w, h] of [[1920, 1080], [1305, 760], [1057, 829], [1280, 600], [900, 560], [390, 844]]) {
    const c = await b.newContext({ viewport: { width: w, height: h }, colorScheme: 'dark' });
    const pg = await c.newPage();
    await rotas(pg);
    await pg.goto((w < 641 ? CELULAR : PC) + '#sekiro');
    await pg.waitForTimeout(3000);
    const r = await pg.evaluate(() => {
      const bt = document.querySelector('.visto-btn');
      if (!bt) return { erro: 'sem botão' };
      bt.scrollIntoView({ block: 'center' });
      const q = bt.getBoundingClientRect();
      const topo = document.elementFromPoint(q.left + q.width / 2, q.top + q.height / 2);
      return { recebe: topo === bt || bt.contains(topo), rola: innerWidth > 640 && document.documentElement.scrollHeight > innerHeight + 1 };
    });
    let some = false;
    try { await pg.click('.visto-btn', { timeout: 3000 }); await pg.waitForTimeout(500); some = !(await pg.$('.novidades')); } catch (e) { some = false; }
    if (r.erro || !r.recebe || r.rola || !some) falhasNov.push(`${w}x${h}: ${JSON.stringify({ ...r, some })}`);
    await c.close();
  }
  progresso.history = semHistorico;
  if (falhasNov.length) { console.error('novidades com problema:\n  ' + falhasNov.join('\n  ')); process.exitCode = 1; }
  else console.log('  novidades: o botão de marcar como visto funciona');

  // Página do Elden Ring: nada rola no computador nem no celular grande, com ou
  // sem a janela de lista aberta.
  const falhasEr = [];
  for (const [w, h] of [[1920, 1080], [1320, 860], [1305, 760], [1280, 600], [1044, 684], [900, 560], [390, 844]]) {
    const c = await b.newContext({ viewport: { width: w, height: h }, colorScheme: 'dark' });
    const pg = await c.newPage();
    await rotas(pg);
    await pg.goto((w < 641 ? CELULAR : PC) + '#steam-1245620');
    await pg.waitForTimeout(2500);
    const mede = () => pg.evaluate(() => ({
      rola: document.documentElement.scrollHeight > innerHeight + 1,
      mortes: (document.getElementById('erMortesNum') || {}).textContent,
      corta: [...document.querySelectorAll('.er-bloco')].some((e) => e.getBoundingClientRect().bottom > innerHeight + 1),
    }));
    const r = await mede();
    await pg.click('.er-bloco[data-er="armas"]').catch(() => {});
    await pg.waitForTimeout(1200);
    const lista = await pg.evaluate(() => {
      const l = document.getElementById('erLista');
      return { linhas: l ? l.children.length : 0, rola: document.documentElement.scrollHeight > innerHeight + 1, sobra: l ? l.scrollHeight > l.clientHeight + 1 : true };
    });
    if (r.rola || r.corta || r.mortes !== '1,287' || !lista.linhas || lista.rola || lista.sobra) falhasEr.push(`${w}x${h}: ${JSON.stringify({ ...r, lista })}`);
    await c.close();
  }
  if (falhasEr.length) { console.error('página do Elden Ring com problema:\n  ' + falhasEr.join('\n  ')); process.exitCode = 1; }
  else console.log('  Elden Ring: sem rolagem, mortes do save e lista paginada');

  // Página do Khazan: o mesmo, com as marcas vindas do computador.
  const falhasKz = [];
  for (const [w, h] of [[1920, 1080], [1320, 860], [1305, 760], [1280, 600], [1044, 684], [900, 560], [390, 844]]) {
    const c = await b.newContext({ viewport: { width: w, height: h }, colorScheme: 'dark' });
    const pg = await c.newPage();
    await rotas(pg);
    await pg.goto((w < 641 ? CELULAR : PC) + '#steam-2680010');
    await pg.waitForTimeout(2500);
    const r = await pg.evaluate(() => ({
      rola: document.documentElement.scrollHeight > innerHeight + 1,
      missoes: ((document.getElementById('kzMissoesNum') || {}).textContent || '').replace(/\s/g, ''),
      corta: [...document.querySelectorAll('.kz-bloco')].some((e) => e.getBoundingClientRect().bottom > innerHeight + 1),
    }));
    await pg.click('.kz-bloco[data-kz="chefes"]').catch(() => {});
    await pg.waitForTimeout(1200);
    const lista = await pg.evaluate(() => {
      const l = document.getElementById('kzLista');
      return { linhas: l ? l.children.length : 0, rola: document.documentElement.scrollHeight > innerHeight + 1, sobra: l ? l.scrollHeight > l.clientHeight + 1 : true };
    });
    if (r.rola || r.corta || r.missoes !== '10/40' || !lista.linhas || lista.rola || lista.sobra) falhasKz.push(`${w}x${h}: ${JSON.stringify({ ...r, lista })}`);
    await c.close();
  }
  if (falhasKz.length) { console.error('página do Khazan com problema:\n  ' + falhasKz.join('\n  ')); process.exitCode = 1; }
  else console.log('  Khazan: sem rolagem, marcas do computador e lista paginada');

  // O passo a passo do iOS, que o código QR do iPhone abre.
  const c = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, locale: 'pt-BR' });
  const pg = await c.newPage();
  await pg.goto('file://' + path.join(RAIZ, 'sync', 'ios.html'));
  await pg.waitForLoadState('networkidle').catch(() => {});
  await pg.waitForTimeout(1500);
  await pg.screenshot({ path: path.join(SAIDA, 'celular', 'ios.png') });
  console.log('  celular/ios.png');
  await c.close();
  await b.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
