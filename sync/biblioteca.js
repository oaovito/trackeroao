'use strict';
/*
 * biblioteca.js - jogos instalados nesta máquina e jogados pela conta Steam.
 *
 * Fontes: a biblioteca Steam local, o catálogo geral da Steam (para reconhecer
 * pastas de jogos de outras lojas) e a lista de jogos populares (inclui jogos
 * fora da Steam). Sem Steam, a varredura usa disco, registro do Windows e
 * manifestos da Epic. O resultado fica em biblioteca.json (fora do git).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { execFile } = require('child_process');

const RAIZ = path.join(__dirname, '..');
const ARQUIVO = path.join(RAIZ, 'biblioteca.json');
const CACHE = path.join(RAIZ, 'sync', 'cache');
const POPULARES = path.join(__dirname, 'populares.json');

const DIA = 24 * 60 * 60 * 1000;

/* ------------------------------------------------------------- nomes */

/**
 * Normaliza um nome para comparação: minúsculas, sem marcas registradas e sem
 * pontuação ("Baldurs Gate 3" = "Baldur's Gate 3").
 */
function normalizar(nome) {
  return String(nome || '')
    .replace(/[™®©]/g, '')
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '');
}

/** A chave estável de um jogo: o appId quando há, senão o nome. */
function chaveDe(j) {
  return j.appId ? 'steam-' + j.appId : 'jogo-' + normalizar(j.nome);
}

// Entradas do catálogo que não são jogos (trilhas, SDKs, servidores, demos).
const NAO_JOGO = /\b(soundtrack|ost|sdk|dedicated server|server|demo|playtest|benchmark|editor|tool|redistributable|dlc|season pass|artbook|wallpaper engine|beta)\b/i;

/* ------------------------------------------------------------- VDF */

/**
 * Lê VDF em texto (o formato dos .acf e .vdf da Steam) para um objeto.
 * Chaves em minúscula: a Steam não é consistente entre "apps" e "Apps".
 */
function lerVdf(texto) {
  const raiz = {};
  const pilha = [raiz];
  const re = /"((?:[^"\\]|\\.)*)"|([{}])/g;
  let chave = null;
  let m;
  while ((m = re.exec(texto))) {
    const atual = pilha[pilha.length - 1];
    if (m[2] === '{') {
      const novo = {};
      if (chave !== null) atual[chave.toLowerCase()] = novo;
      pilha.push(novo);
      chave = null;
    } else if (m[2] === '}') {
      if (pilha.length > 1) pilha.pop();
      chave = null;
    } else if (chave === null) {
      chave = m[1];
    } else {
      atual[chave.toLowerCase()] = m[1].replace(/\\\\/g, '\\');
      chave = null;
    }
  }
  return raiz;
}

function lerTexto(arq) {
  try { return fs.readFileSync(arq, 'utf8'); } catch (e) { return null; }
}

function lerJson(arq) {
  try { return JSON.parse(fs.readFileSync(arq, 'utf8')); } catch (e) { return null; }
}

/* ------------------------------------------------------------- Steam local */

/** Jogos instalados pela Steam: um appmanifest por jogo, em cada biblioteca. */
function steamInstalados(steam, bibliotecas) {
  const saida = [];
  for (const lib of bibliotecas) {
    const apps = path.join(lib, 'steamapps');
    let nomes = [];
    try { nomes = fs.readdirSync(apps); } catch (e) { continue; }
    for (const n of nomes) {
      if (!/^appmanifest_\d+\.acf$/.test(n)) continue;
      const txt = lerTexto(path.join(apps, n));
      if (!txt) continue;
      const st = lerVdf(txt).appstate || {};
      if (!st.appid || !st.name || NAO_JOGO.test(st.name)) continue;
      // Ferramentas da própria Steam (Proton, runtime) não são jogo.
      if (/^(proton|steam linux runtime|steamworks common)/i.test(st.name)) continue;
      saida.push({
        appId: String(st.appid),
        nome: st.name,
        pasta: st.installdir ? path.join(apps, 'common', st.installdir) : null,
      });
    }
  }
  return saida;
}

/**
 * Jogos que a conta já jogou, instalados ou não. O nome vem do catálogo;
 * appIds sem nome são ignorados.
 */
function steamConta(steam) {
  const ids = new Set();
  let contas = [];
  try { contas = fs.readdirSync(path.join(steam, 'userdata')); } catch (e) { return []; }
  for (const c of contas) {
    const txt = lerTexto(path.join(steam, 'userdata', c, 'config', 'localconfig.vdf'));
    if (!txt) continue;
    const v = lerVdf(txt);
    const apps = (((v.userlocalconfigstore || {}).software || {}).valve || {}).steam;
    const lista = apps && (apps.apps || apps.Apps);
    if (!lista) continue;
    for (const [id, dados] of Object.entries(lista)) {
      if (!/^\d+$/.test(id) || !dados || typeof dados !== 'object') continue;
      if (dados.lastplayed || dados.playtime) ids.add(id);
    }
  }
  return [...ids];
}

/**
 * Última abertura de cada jogo pela conta, em segundos, por appId. Sem Steam,
 * a ordem vem de jogos.js.
 */
function steamRecentes(steam) {
  const vez = {};
  let contas = [];
  try { contas = fs.readdirSync(path.join(steam, 'userdata')); } catch (e) { return vez; }
  for (const c of contas) {
    const txt = lerTexto(path.join(steam, 'userdata', c, 'config', 'localconfig.vdf'));
    if (!txt) continue;
    const v = lerVdf(txt);
    const apps = (((v.userlocalconfigstore || {}).software || {}).valve || {}).steam;
    const lista = apps && (apps.apps || apps.Apps);
    if (!lista) continue;
    for (const [id, dados] of Object.entries(lista)) {
      const n = dados && Number(dados.lastplayed || dados.LastPlayed);
      if (/^\d+$/.test(id) && n > 0 && (!vez[id] || n > vez[id])) vez[id] = n;
    }
  }
  return vez;
}

/* ------------------------------------------------------------- catálogo e populares */

function pedir(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'user-agent': 'trackeroao' }, timeout: 30000 }, (res) => {
      if (res.statusCode !== 200) { res.resume(); reject(new Error('HTTP ' + res.statusCode)); return; }
      let corpo = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { corpo += c; });
      res.on('end', () => { try { resolve(JSON.parse(corpo)); } catch (e) { reject(e); } });
    });
    req.on('timeout', () => req.destroy(new Error('tempo esgotado')));
    req.on('error', reject);
  });
}

function guardar(nome, dados) {
  try {
    fs.mkdirSync(CACHE, { recursive: true });
    fs.writeFileSync(path.join(CACHE, nome), JSON.stringify(dados));
  } catch (e) { /* cache é conveniência */ }
}

function doCache(nome, validade) {
  const arq = path.join(CACHE, nome);
  try {
    const st = fs.statSync(arq);
    const dados = JSON.parse(fs.readFileSync(arq, 'utf8'));
    return { dados, fresco: Date.now() - st.mtimeMs < validade };
  } catch (e) { return null; }
}

/**
 * Catálogo geral da Steam, { appId: nome }. Fontes: lista de apps da Steam,
 * com o SteamSpy de reserva. Cache de uma semana.
 */
async function catalogoGeral(opts) {
  const o = opts || {};
  if (o.catalogo) return o.catalogo;
  // Base incluída na release (sync/catalogo-jogos.json.gz), complementada
  // pelo que vier da rede.
  const base = o.semBase ? {} : ((require('./gerar-catalogo').ler() || {}).jogos || {});
  const junto = (extra) => Object.assign({}, base, extra || {});
  const c = doCache('catalogo-steam.json', 7 * DIA);
  if (c && c.fresco && !o.forcar) return junto(c.dados);
  if (o.semRede) return junto(c ? c.dados : {});
  const mapa = {};
  try {
    const r = await pedir('https://api.steampowered.com/ISteamApps/GetAppList/v2/');
    for (const a of ((r.applist || {}).apps || [])) {
      if (a && a.appid && a.name && !NAO_JOGO.test(a.name)) mapa[String(a.appid)] = a.name;
    }
  } catch (e) { /* segue para a reserva */ }
  if (!Object.keys(mapa).length) {
    for (let pagina = 0; pagina < 5; pagina++) {
      try {
        const r = await pedir('https://steamspy.com/api.php?request=all&page=' + pagina);
        for (const a of Object.values(r || {})) {
          if (a && a.appid && a.name && !NAO_JOGO.test(a.name)) mapa[String(a.appid)] = a.name;
        }
      } catch (e) { break; }
    }
  }
  if (Object.keys(mapa).length) { guardar('catalogo-steam.json', mapa); return junto(mapa); }
  return junto(c ? c.dados : {});
}

/**
 * Jogos mais jogados: [{ appId, nome, posicao }]. Steam, com SteamSpy de
 * reserva; cache de um dia. populares.json sempre entra (jogos fora da Steam).
 */
async function populares(catalogo, opts) {
  const o = opts || {};
  const semente = (lerJson(POPULARES) || {}).lista || [];
  let daRede = [];
  const c = doCache('populares-steam.json', DIA);
  if (c && (c.fresco || o.semRede)) daRede = c.dados;
  else if (!o.semRede) {
    try {
      const r = await pedir('https://api.steampowered.com/ISteamChartsService/GetMostPlayedGames/v1/');
      daRede = ((r.response || {}).ranks || []).slice(0, 100)
        .map((x) => ({ appId: String(x.appid), posicao: x.rank }));
    } catch (e) {
      try {
        const r = await pedir('https://steamspy.com/api.php?request=top100in2weeks');
        daRede = Object.values(r || {}).map((a, i) => ({ appId: String(a.appid), nome: a.name, posicao: i + 1 }));
      } catch (e2) { daRede = c ? c.dados : []; }
    }
    if (daRede.length) guardar('populares-steam.json', daRede);
  }
  const lista = semente.map((s, i) => ({ ...s, appId: s.appId ? String(s.appId) : null, posicao: null, semente: i }));
  for (const p of daRede) {
    const nome = p.nome || catalogo[p.appId];
    if (!nome || NAO_JOGO.test(nome)) continue;
    const ja = lista.find((x) => (x.appId && x.appId === p.appId) || normalizar(x.nome) === normalizar(nome));
    if (ja) ja.posicao = ja.posicao || p.posicao;
    else lista.push({ appId: p.appId, nome, posicao: p.posicao, pastas: [], processos: [] });
  }
  return lista;
}

/* ------------------------------------------------------------- disco */

/**
 * Pastas de instalação em cada disco. Nas pastas de jogos (Games, XboxGames,
 * Epic Games, GOG, steamapps\common) vale o catálogo geral; em Program Files
 * só a biblioteca da conta e os populares.
 */
function raizesDoDisco() {
  if (process.platform !== 'win32') return [];
  const deJogo = [
    'Games', 'XboxGames', 'Epic Games', 'GOG Games', 'Riot Games', 'SteamLibrary\\steamapps\\common',
    'Program Files\\Epic Games', 'Program Files (x86)\\GOG Galaxy\\Games', 'Program Files\\EA Games',
    'Program Files (x86)\\Ubisoft\\Ubisoft Game Launcher\\games', 'Program Files (x86)\\Steam\\steamapps\\common',
    'Program Files\\Steam\\steamapps\\common', 'Program Files\\ModifiableWindowsApps',
  ];
  // Pastas de jogos criadas manualmente, em vários idiomas.
  const deJogoLocal = ['Jogos', 'Juegos', 'Jeux', 'Spiele', 'Giochi', 'Gry', 'Oyunlar', 'Игры', 'ゲーム', '游戏', '게임',
    'Games\\Steam\\steamapps\\common', 'Program Files (x86)\\Games', 'Program Files\\Games'];
  const dePrograma = ['Program Files', 'Program Files (x86)'];
  const raizes = [];
  for (const letra of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
    const disco = letra + ':\\';
    try { if (!fs.existsSync(disco)) continue; } catch (e) { continue; }
    for (const p of deJogo.concat(deJogoLocal)) raizes.push({ pasta: path.join(disco, p), tipo: 'jogo' });
    for (const p of dePrograma) raizes.push({ pasta: path.join(disco, p), tipo: 'programa' });
    // Raiz do disco: catálogo inteiro, desde que a pasta tenha um executável.
    raizes.push({ pasta: disco, tipo: 'raiz' });
  }
  const casa = process.env.USERPROFILE;
  if (casa) {
    for (const p of ['Games', 'Jogos', 'Documents\\Games', 'Documents\\Jogos', 'Desktop\\Jogos', 'Desktop\\Games']) {
      raizes.push({ pasta: path.join(casa, p), tipo: 'jogo' });
    }
  }
  return raizes;
}

// Pastas de sistema na raiz do disco que nunca são jogos.
const RAIZ_DE_SISTEMA = /^(windows|users|usuarios|program ?files.*|programdata|perflogs|recovery|intel|amd|nvidia|drivers|temp|tmp|\$.*|system volume information|msocache|onedrivetemp|xboxgames|games|jogos|steamlibrary|epic games|gog games|riot games|found\.\d+|config\.msi|boot|efi|documents and settings|inetpub|python\d*|msys64|cygwin64|android|go|node_modules|backup|backups|downloads|musica|music|videos|pictures|imagens|documents|documentos|desktop|dados|data)$/i;

/*
 * Variações de um nome de pasta: inteiro, sem parênteses/colchetes e sem a
 * versão ("Hollow Knight v1.5.78", "Celeste [GOG]", "Hades - Repack").
 */
function formasDoNome(nomePasta) {
  const f = new Set();
  const add = (x) => { const n = normalizar(x); if (n.length >= 4) f.add(n); };
  add(nomePasta);
  const limpo = nomePasta.replace(/[([{].*?[)\]}]/g, ' ').trim();
  add(limpo);
  add(limpo.replace(/[\s._-]+v?\d+(\.\d+)+.*$/i, ''));
  add(limpo.replace(/\s+-\s+.*$/, ''));
  add(limpo.replace(/[._]+/g, ' ').replace(/\s+(repack|goty|gog|steam|build \d+|update \d+).*$/i, ''));
  return [...f];
}

function subpastas(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch (e) { return []; }
}

/* Executáveis auxiliares na pasta do jogo. */
const NAO_E_O_JOGO = /(unins|uninstall|setup|install|redist|vc_?redist|dxsetup|directx|crash|report|launcher|helper|updater|update|prereq|easyanticheat|eac|battleye|be_service|dotnet|vcredist|ue4prereq|unitycrashhandler|cefprocess|webhelper|overlay|config|settings|server|editor)/i;

/**
 * Executável do jogo: o maior .exe que não seja auxiliar, até três níveis de
 * profundidade (Binaries\Win64, bin\x64).
 */
function executaveis(pasta) {
  const achados = [];
  const andar = (dir, prof) => {
    if (prof > 3 || achados.length > 60) return;
    let itens = [];
    try { itens = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const it of itens) {
      const c = path.join(dir, it.name);
      if (it.isDirectory()) {
        if (!/^(_commonredist|redist|redistributables|directx|support|tools|docs|__installer|engine\\extras)$/i.test(it.name)) andar(c, prof + 1);
      } else if (/\.exe$/i.test(it.name) && !NAO_E_O_JOGO.test(it.name)) {
        try { achados.push({ nome: it.name, tam: fs.statSync(c).size }); } catch (e) { /* sumiu */ }
      }
    }
  };
  andar(pasta, 0);
  return achados.sort((a, b) => b.tam - a.tam).slice(0, 2).map((a) => a.nome);
}

/* ------------------------------------------------------------- registro e Epic */

function rodar(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout: 60000, maxBuffer: 16 * 1024 * 1024 },
      (err, out) => resolve(err ? '' : String(out)));
  });
}

/** Programas registrados no Windows: { nome, pasta, editora }. */
async function registro() {
  if (process.platform !== 'win32') return [];
  const ps = [
    "$ErrorActionPreference='SilentlyContinue'",
    "$k='HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'",
    'Get-ItemProperty $k | Where-Object { $_.DisplayName } | Select-Object DisplayName,InstallLocation,Publisher | ConvertTo-Json -Compress',
  ].join('; ');
  const out = await rodar('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps]);
  try {
    const j = JSON.parse(out);
    return (Array.isArray(j) ? j : [j]).map((x) => ({ nome: x.DisplayName, pasta: x.InstallLocation || null, editora: x.Publisher || '' }));
  } catch (e) { return []; }
}

/** Jogos da Epic: um manifesto .item por jogo, com nome e executável. */
function epic() {
  if (process.platform !== 'win32') return [];
  const dir = path.join(process.env.ProgramData || 'C:\\ProgramData', 'Epic', 'EpicGamesLauncher', 'Data', 'Manifests');
  const saida = [];
  let nomes = [];
  try { nomes = fs.readdirSync(dir); } catch (e) { return []; }
  for (const n of nomes) {
    if (!/\.item$/i.test(n)) continue;
    const j = lerJson(path.join(dir, n));
    if (!j || !j.DisplayName || NAO_JOGO.test(j.DisplayName)) continue;
    if (Array.isArray(j.AppCategories) && j.AppCategories.length && !j.AppCategories.includes('games')) continue;
    saida.push({
      nome: j.DisplayName,
      pasta: j.InstallLocation || null,
      processos: j.LaunchExecutable ? [path.basename(j.LaunchExecutable)] : [],
    });
  }
  return saida;
}

/* ------------------------------------------------------------- a varredura */

/**
 * Junta as fontes numa lista, um jogo por entrada. `fontes` registra a origem
 * ('steam', 'steam-conta', 'disco', 'registro', 'epic') e define os pinos.
 */
async function varrer(opts) {
  const o = opts || {};
  const instalacao = require('./instalacao');
  const steam = o.steam !== undefined ? o.steam : instalacao.steamPath();
  const catalogo = await catalogoGeral(o);
  const porNome = new Map();
  for (const [id, nome] of Object.entries(catalogo)) {
    const n = normalizar(nome);
    if (n.length >= 4 && !porNome.has(n)) porNome.set(n, { appId: id, nome });
  }
  const pops = await populares(catalogo, o);
  const popPorPasta = new Map();
  for (const p of pops) {
    for (const pasta of [p.nome, ...(p.pastas || [])]) popPorPasta.set(normalizar(pasta), p);
  }

  const jogos = new Map();
  const juntar = (j, fonte) => {
    const k = chaveDe(j);
    const ja = jogos.get(k) || jogos.get('jogo-' + normalizar(j.nome));
    const alvo = ja || { chave: k, nome: j.nome, appId: j.appId || null, fontes: [], instalado: false, pasta: null, processos: [] };
    if (!alvo.appId && j.appId) { alvo.appId = j.appId; }
    if (!alvo.fontes.includes(fonte)) alvo.fontes.push(fonte);
    if (j.pasta && !alvo.pasta) alvo.pasta = j.pasta;
    if (j.instalado) alvo.instalado = true;
    for (const p of j.processos || []) if (!alvo.processos.includes(p)) alvo.processos.push(p);
    jogos.delete('jogo-' + normalizar(alvo.nome));
    alvo.chave = chaveDe(alvo);
    jogos.set(alvo.chave, alvo);
  };

  // 1. Steam, quando existe.
  if (steam) {
    const libs = instalacao.bibliotecas(steam);
    for (const j of steamInstalados(steam, libs)) juntar({ ...j, instalado: true }, 'steam');
    for (const id of steamConta(steam)) {
      const nome = catalogo[id] || (pops.find((p) => p.appId === id) || {}).nome;
      if (nome) juntar({ appId: id, nome }, 'steam-conta');
    }
  }

  // 2. O disco, com ou sem Steam.
  const raizes = o.raizes || raizesDoDisco();
  const reconhecer = (nomePasta, tipo) => {
    for (const n of formasDoNome(nomePasta)) {
      const pop = popPorPasta.get(n);
      const doCat = tipo !== 'programa' ? porNome.get(n) : null;
      const naConta = [...jogos.values()].find((j) => normalizar(j.nome) === n);
      const achado = pop || naConta || doCat;
      if (achado) return { achado, doCatalogo: !pop && !naConta };
    }
    return null;
  };
  const visto = new Set();
  const olhar = (dir, tipo, nivel) => {
    for (const nomePasta of subpastas(dir)) {
      if (tipo === 'raiz' && RAIZ_DE_SISTEMA.test(nomePasta)) continue;
      const pasta = path.join(dir, nomePasta);
      if (visto.has(pasta.toLowerCase())) continue;
      visto.add(pasta.toLowerCase());
      const r = reconhecer(nomePasta, tipo);
      if (r) {
        // Fora de pastas de jogos, o catálogo geral exige um executável.
        const exes = r.achado.processos && r.achado.processos.length ? r.achado.processos : executaveis(pasta);
        if (tipo === 'raiz' && r.doCatalogo && !exes.length) continue;
        juntar({
          appId: r.achado.appId || null, nome: r.achado.nome, pasta,
          instalado: true, processos: exes,
        }, 'disco');
      } else if (tipo === 'jogo' && nivel === 0) {
        // Um nível abaixo (D:\Jogos\RPG\..., D:\Games\Steam\...).
        olhar(pasta, tipo, 1);
      }
    }
  };
  for (const r of raizes) olhar(r.pasta, r.tipo, 0);

  // 3. O registro do Windows e a Epic.
  for (const e of epic()) juntar({ ...e, instalado: true }, 'epic');
  for (const reg of (o.registro || await registro())) {
    const n = normalizar(reg.nome);
    const pop = popPorPasta.get(n);
    const doCat = porNome.get(n);
    if (!pop && !doCat) continue;
    if (/microsoft|nvidia|intel|amd|adobe|google|mozilla/i.test(reg.editora) && !pop) continue;
    const base = pop || doCat;
    juntar({ appId: base.appId || null, nome: base.nome, pasta: reg.pasta, instalado: !!reg.pasta, processos: (pop && pop.processos) || [] }, 'registro');
  }

  // Executável dos jogos instalados, para vigiar o processo.
  for (const j of jogos.values()) {
    if (j.instalado && j.pasta && !j.processos.length) j.processos = executaveis(j.pasta);
    const pop = pops.find((p) => (p.appId && p.appId === j.appId) || normalizar(p.nome) === normalizar(j.nome));
    j.popular = pop && pop.posicao ? pop.posicao : null;
    if (pop && pop.arte) j.arteFonte = pop.arte;
  }

  // Banner de cada jogo (ver arte.js).
  try {
    await require('./arte').resolver([...jogos.values()], { semRede: o.semRede, normalizar, pedir: o.pedirArte });
  } catch (e) { /* arte é enfeite: a varredura não cai por ela */ }
  for (const j of jogos.values()) delete j.arteFonte;

  const lista = [...jogos.values()].sort((a, b) => a.nome.localeCompare(b.nome));
  const resultado = {
    em: new Date().toISOString(),
    comSteam: !!steam,
    catalogo: Object.keys(catalogo).length,
    jogos: lista,
    populares: pops.filter((p) => p.posicao).sort((a, b) => a.posicao - b.posicao).slice(0, 20)
      .map((p) => ({ appId: p.appId, nome: p.nome, posicao: p.posicao })),
  };
  if (!o.naoGravar) {
    const tmp = ARQUIVO + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(resultado, null, 1));
    fs.renameSync(tmp, ARQUIVO);
  }
  return resultado;
}

/**
 * Vigia (sem recursão) as pastas onde jogos novos aparecem: steamapps de cada
 * biblioteca, manifestos da Epic, pastas de jogos e raiz de cada disco.
 * Devolve a função que desliga as vigias.
 */
function vigiarInstalacoes(aoMudar, opts) {
  const o = opts || {};
  const pastas = [];
  try {
    const instalacao = require('./instalacao');
    const steam = o.steam !== undefined ? o.steam : instalacao.steamPath();
    if (steam) for (const lib of instalacao.bibliotecas(steam)) pastas.push({ dir: path.join(lib, 'steamapps'), filtro: /^appmanifest_\d+\.acf$/i });
  } catch (e) { /* sem Steam, segue sem ela */ }
  if (process.platform === 'win32') {
    pastas.push({ dir: path.join(process.env.ProgramData || 'C:\\ProgramData', 'Epic', 'EpicGamesLauncher', 'Data', 'Manifests'), filtro: /\.item$/i });
  }
  for (const r of (o.raizes || raizesDoDisco())) if (r.tipo !== 'programa') pastas.push({ dir: r.pasta, filtro: null });

  const vigias = [];
  let espera = null;
  const avisar = () => {
    clearTimeout(espera);
    // Debounce: um aviso só depois que as escritas param.
    espera = setTimeout(aoMudar, o.esperaMs || 4000);
    if (espera.unref) espera.unref();
  };
  for (const p of pastas) {
    try {
      if (!fs.existsSync(p.dir)) continue;
      const w = fs.watch(p.dir, { persistent: false }, (tipo, nome) => {
        if (!nome) return avisar();
        if (p.filtro ? p.filtro.test(String(nome)) : tipo === 'rename') avisar();
      });
      w.on('error', () => { try { w.close(); } catch (e) { /* já fechado */ } });
      vigias.push(w);
    } catch (e) { /* pasta sem permissão: fica de fora */ }
  }
  return () => {
    clearTimeout(espera);
    for (const w of vigias) { try { w.close(); } catch (e) { /* já fechado */ } }
  };
}

/** A última varredura gravada, ou null. */
function ultima() {
  return lerJson(ARQUIVO);
}

/*
 * Caminho do executável de um jogo instalado, para a bandeja extrair o ícone.
 * Usa o processo anotado pela varredura ou o maior .exe da pasta; cache por pasta.
 */
const exeLembrado = new Map();
function executavelDoJogo(jogo) {
  if (!jogo) return null;
  const achados = ((ultima() || {}).jogos) || [];
  let b = achados.find((a) => a.chave === jogo.chave && a.pasta) ||
    achados.find((a) => a.appId && jogo.appId && String(a.appId) === String(jogo.appId) && a.pasta);
  // Sem pasta na varredura: o manifesto da Steam, quando ela existe.
  if (!b && jogo.appId) {
    try {
      const instalacao = require('./instalacao');
      const steam = instalacao.steamPath();
      if (steam) b = steamInstalados(steam, instalacao.bibliotecas(steam)).find((a) => String(a.appId) === String(jogo.appId)) || null;
    } catch (e) { b = null; }
  }
  const pasta = b && b.pasta;
  if (!pasta || !fs.existsSync(pasta)) return null;
  const nomes = ((b.processos || []).concat(jogo.processos || [])).map((n) => String(n).toLowerCase());
  const chave = pasta + '|' + nomes.join(',');
  if (exeLembrado.has(chave)) return exeLembrado.get(chave);
  let achado = null;
  const andar = (dir, prof) => {
    if (achado || prof > 3) return;
    let itens = [];
    try { itens = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const it of itens) if (!it.isDirectory() && nomes.includes(it.name.toLowerCase())) { achado = path.join(dir, it.name); return; }
    for (const it of itens) if (it.isDirectory()) andar(path.join(dir, it.name), prof + 1);
  };
  if (nomes.length) andar(pasta, 0);
  if (!achado) {
    const maior = executaveis(pasta)[0];
    if (maior) { nomes.push(maior.toLowerCase()); andar(pasta, 0); }
  }
  exeLembrado.set(chave, achado);
  return achado;
}

module.exports = {
  varrer, ultima, executavelDoJogo, vigiarInstalacoes, normalizar, chaveDe, lerVdf, steamInstalados, steamConta, steamRecentes, executaveis,
  catalogoGeral, populares, ARQUIVO, NAO_JOGO,
};

if (require.main === module) {
  varrer({ semRede: process.argv.includes('--sem-rede') }).then((r) => {
    console.log(`  ${r.jogos.length} jogo(s)${r.comSteam ? ', com Steam' : ', sem Steam'}; catálogo com ${r.catalogo} nomes`);
    for (const j of r.jogos) {
      console.log(`  ${j.instalado ? '[instalado]' : '[na conta] '} ${j.nome}  (${j.fontes.join(', ')})` +
        (j.processos.length ? '  ' + j.processos.join(', ') : ''));
    }
  }).catch((e) => { console.error(e.message); process.exit(1); });
}
