/**
 * atualizar.js - atualização automática e silenciosa (saída só no log).
 *
 * A unidade de atualização é a release. Dois modos:
 *
 *   - instalação (sem .git): compara a tag de versao.json com a última
 *     release; se mudou, baixa o zip da tag, copia por cima e remove os
 *     arquivos que deixaram de existir.
 *   - clone (com .git): só fast-forward da main, e só com a árvore limpa.
 *
 * O estado local (progress.json, contagens, calibração, seleção de jogos)
 * não é tocado.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { execFile } = require('child_process');

const RAIZ = path.join(__dirname, '..');
const REPO = process.env.TRACKEROAO_REPO_ID || 'oaovito/trackeroao';
const NOME_ESTADO = 'versao.json';

// Vem no zip, mas é gerado localmente.
const PRESERVAR = new Set(['docs/progress.json']);

// Arquivos obrigatórios para considerar o zip válido.
const EXIGIDOS = [
  'trackeroao.html', 'package.json', 'sync/main.js', 'sync/offsets.json',
  'sync/conquistas.json', 'windows/install-sync-service.ps1', 'docs/index.html',
];

// Arquivos legados da raiz, removidos em instalações sem versao.json.
const LEGADO = [
  'install-sync-service.ps1', 'uninstall-sync-service.ps1', 'liberar-porta.ps1',
  'reativar.ps1', 'run.bat', 'instalar.ps1', 'construir-exe.ps1',
  'trackeroao-instalador.exe',
];

// Pastas legadas removidas quando ficam vazias.
const PASTAS_LEGADO = ['instalador', 'android', 'ios', 'altstore', 'releases'];

/** Verdadeiro se não há arquivo nenhum abaixo de `d`, só pastas. */
function soPastas(d) {
  for (const n of fs.readdirSync(d)) {
    const c = path.join(d, n);
    if (!fs.statSync(c).isDirectory() || !soPastas(c)) return false;
  }
  return true;
}

/** Remove, das pastas em `rels`, as que não guardam arquivo nenhum. */
function varrerPastasVazias(raiz, rels) {
  raiz = raiz || RAIZ;
  const removidas = [];
  const ordem = [...new Set(rels)].sort((a, b) => b.split('/').length - a.split('/').length);
  for (const rel of ordem) {
    const alvo = dentro(raiz, rel);
    if (!alvo) continue;
    try {
      if (fs.statSync(alvo).isDirectory() && soPastas(alvo)) {
        fs.rmSync(alvo, { recursive: true });
        removidas.push(rel);
      }
    } catch (e) { /* não existe, ou em uso: fica para a próxima */ }
  }
  return removidas;
}

function lerEstado(raiz) {
  try { return JSON.parse(fs.readFileSync(path.join(raiz, NOME_ESTADO), 'utf8')); } catch (e) { return null; }
}

function gravarEstado(raiz, estado) {
  const alvo = path.join(raiz, NOME_ESTADO);
  const tmp = alvo + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(estado, null, 1));
  fs.renameSync(tmp, alvo);
}

/** Todos os arquivos abaixo de `dir`, como caminhos relativos com barra normal. */
function listar(dir) {
  const saida = [];
  const anda = (d, rel) => {
    for (const n of fs.readdirSync(d)) {
      const c = path.join(d, n);
      const r = rel ? rel + '/' + n : n;
      if (fs.statSync(c).isDirectory()) anda(c, r);
      else saida.push(r);
    }
  };
  anda(dir, '');
  return saida.sort();
}

/** Resolve `rel` dentro de `raiz`, ou null se escapar dela. */
function dentro(raiz, rel) {
  const alvo = path.resolve(raiz, rel);
  const base = path.resolve(raiz);
  return alvo.startsWith(base + path.sep) ? alvo : null;
}

/**
 * Copia uma versão descompactada por cima da instalação. Usado pelo
 * instalador e pela atualização.
 */
function aplicarPasta(fonte, tag, raiz) {
  raiz = raiz || RAIZ;
  const faltando = EXIGIDOS.filter((r) => !fs.existsSync(path.join(fonte, r)));
  if (faltando.length) throw new Error('a versão baixada veio incompleta, faltou: ' + faltando.join(', '));

  const novos = listar(fonte);
  const anterior = lerEstado(raiz);

  for (const rel of novos) {
    const destino = dentro(raiz, rel);
    if (!destino) continue;
    if (PRESERVAR.has(rel) && fs.existsSync(destino)) continue;
    fs.mkdirSync(path.dirname(destino), { recursive: true });
    fs.copyFileSync(path.join(fonte, rel), destino);
  }

  // Remove só arquivos da versão anterior que não existem na nova.
  const antigos = anterior && Array.isArray(anterior.arquivos) ? anterior.arquivos : LEGADO;
  const ficam = new Set(novos);
  const removidos = [];
  for (const rel of antigos) {
    if (ficam.has(rel) || PRESERVAR.has(rel)) continue;
    const alvo = dentro(raiz, rel);
    if (!alvo || !fs.existsSync(alvo)) continue;
    try { fs.unlinkSync(alvo); removidos.push(rel); } catch (e) { /* em uso: sai na próxima */ }
  }

  // Pastas que ficaram vazias, da mais funda para a raiz.
  const pastas = [...PASTAS_LEGADO];
  for (const rel of removidos) {
    for (let d = path.posix.dirname(rel); d && d !== '.'; d = path.posix.dirname(d)) pastas.push(d);
  }
  varrerPastasVazias(raiz, pastas);

  gravarEstado(raiz, { tag, arquivos: novos, em: new Date().toISOString() });
  return { copiados: novos.length, removidos };
}

/* ------------------------------------------------------------- rede */

function pedir(url, destino, saltos) {
  saltos = saltos || 0;
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'user-agent': 'trackeroao', accept: 'application/vnd.github+json' },
      timeout: 30000,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && saltos < 5) {
        res.resume();
        resolve(pedir(new URL(res.headers.location, url).toString(), destino, saltos + 1));
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error('HTTP ' + res.statusCode + ' em ' + url));
        return;
      }
      if (destino) {
        const arq = fs.createWriteStream(destino);
        res.pipe(arq);
        arq.on('finish', () => arq.close(() => resolve(destino)));
        arq.on('error', reject);
      } else {
        let corpo = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { corpo += c; });
        res.on('end', () => { try { resolve(JSON.parse(corpo)); } catch (e) { reject(e); } });
      }
    });
    req.on('timeout', () => req.destroy(new Error('tempo esgotado em ' + url)));
    req.on('error', reject);
  });
}

function rodar(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, Object.assign({ windowsHide: true, timeout: 120000 }, opts || {}),
      (err, out, errOut) => (err ? reject(new Error((errOut || err.message).trim())) : resolve(String(out).trim())));
  });
}

async function ultimaRelease() {
  try {
    const r = await pedir(`https://api.github.com/repos/${REPO}/releases/latest`);
    if (r && r.tag_name) return r.tag_name;
    throw new Error('a API não devolveu release nenhuma');
  } catch (e) {
    // Sem cota da API: o redirecionamento de /releases/latest traz a tag.
    const tag = await tagPeloSite().catch(() => null);
    if (tag) return tag;
    throw e;
  }
}

function tagPeloSite() {
  return new Promise((resolve, reject) => {
    const req = https.get(`https://github.com/${REPO}/releases/latest`, {
      headers: { 'user-agent': 'trackeroao' }, timeout: 30000,
    }, (res) => {
      res.resume();
      const m = /\/releases\/tag\/([^/?#]+)/.exec(res.headers.location || '');
      if (m) resolve(decodeURIComponent(m[1]));
      else reject(new Error('HTTP ' + res.statusCode + ' na página da release'));
    });
    req.on('timeout', () => req.destroy(new Error('tempo esgotado na página da release')));
    req.on('error', reject);
  });
}

/** Baixa e descompacta o código de uma tag; devolve a pasta e a limpeza. */
async function baixar(tag) {
  varrerTemporarios();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trackeroao-'));
  const limpar = () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* temp */ } };
  try {
    return await baixarEm(tmp, tag, limpar);
  } catch (e) {
    // Remove a pasta temporária em caso de falha.
    limpar();
    throw e;
  }
}

// Remove pastas temporárias de atualizações interrompidas (com mais de 1 h).
function varrerTemporarios() {
  const agora = Date.now();
  let nomes = [];
  try { nomes = fs.readdirSync(os.tmpdir()); } catch (e) { return; }
  for (const nome of nomes) {
    if (!/^trackeroao-[A-Za-z0-9]{6}$/.test(nome)) continue;
    const cheio = path.join(os.tmpdir(), nome);
    try {
      if (agora - fs.statSync(cheio).mtimeMs < 60 * 60 * 1000) continue;
      fs.rmSync(cheio, { recursive: true, force: true });
    } catch (e) { /* em uso: sai na proxima */ }
  }
}

async function baixarEm(tmp, tag, limpar) {
  const zip = path.join(tmp, 'fonte.zip');
  await pedir(`https://codeload.github.com/${REPO}/zip/refs/tags/${encodeURIComponent(tag)}`, zip);
  const pasta = path.join(tmp, 'x');
  // Windows: ZipFile do .NET (Expand-Archive é lento demais no PowerShell 5).
  // Fora do Windows: unzip do sistema.
  if (process.platform === 'win32') {
    const z = zip.replace(/'/g, "''");
    const p = pasta.replace(/'/g, "''");
    await rodar('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      "$ProgressPreference = 'SilentlyContinue'; " +
      "try { Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::ExtractToDirectory('" + z + "', '" + p + "') } " +
      "catch { Expand-Archive -LiteralPath '" + z + "' -DestinationPath '" + p + "' -Force }"], { timeout: 10 * 60 * 1000 });
  } else {
    await rodar('unzip', ['-q', zip, '-d', pasta]);
  }
  const sub = fs.readdirSync(pasta).map((n) => path.join(pasta, n)).find((c) => fs.statSync(c).isDirectory());
  if (!sub) throw new Error('o zip da ' + tag + ' veio vazio');
  return { pasta: sub, limpar };
}

/* ------------------------------------------------------------- modos */

async function viaGit(raiz) {
  const git = (...a) => rodar('git', a, { cwd: raiz });
  const ramo = await git('rev-parse', '--abbrev-ref', 'HEAD');
  if (ramo !== 'main') return { atualizou: false, motivo: 'clone fora da main (' + ramo + ')' };
  if (await git('status', '--porcelain', '--untracked-files=no')) {
    return { atualizou: false, motivo: 'clone com alterações locais; espera' };
  }
  await git('fetch', '--quiet', 'origin', 'main');
  const de = await git('rev-parse', 'HEAD');
  const para = await git('rev-parse', 'origin/main');
  if (de === para) return { atualizou: false };
  try { await git('merge-base', '--is-ancestor', 'HEAD', 'origin/main'); } catch (e) {
    return { atualizou: false, motivo: 'clone com commits que a origem não tem; espera' };
  }
  await git('merge', '--ff-only', '--quiet', 'origin/main');
  return { atualizou: true, de: de.slice(0, 7), para: para.slice(0, 7) };
}

async function viaRelease(raiz) {
  const tag = await ultimaRelease();
  const estado = lerEstado(raiz);
  if (estado && estado.tag === tag) {
    const j = await trocarJanela(raiz, tag);
    return j ? { atualizou: false, motivo: 'janela ' + j } : { atualizou: false };
  }
  const b = await baixar(tag);
  let r;
  try {
    r = aplicarPasta(b.pasta, tag, raiz);
  } finally {
    b.limpar();
  }
  const j = await trocarJanela(raiz, tag);
  return { atualizou: true, de: estado ? estado.tag : null, para: tag, removidos: r.removidos, janela: j };
}

/*
 * A janela (app\Trackeroao.exe) vem só no instalador da release. Quando
 * app\versao.txt está desatualizado, o instalador roda com /so-janela, que
 * troca apenas a pasta app. Não se aplica a clones.
 */
function numeroDaTag(tag) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(tag || '');
  return m ? `${m[1]}.${m[2]}.${m[3]}.0` : null;
}

// Só troca por uma versão mais nova.
function maisNova(a, b) {
  const x = String(a || '').split('.').map(Number);
  const y = String(b || '').split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d > 0;
  }
  return false;
}

// Callback para liberar o .exe antes da troca (ícone da bandeja).
let envolverTroca = (trocar) => trocar();
function aoTrocarJanela(fn) { if (typeof fn === 'function') envolverTroca = fn; }

async function trocarJanela(raiz, tag) {
  if (process.platform !== 'win32') return null;
  if (!fs.existsSync(path.join(raiz, 'app', 'Trackeroao.exe'))) return null;
  let atual = null;
  try { atual = fs.readFileSync(path.join(raiz, 'app', 'versao.txt'), 'utf8').trim(); } catch (e) { /* anterior a versao.txt */ }
  if (atual && !maisNova(numeroDaTag(tag), atual)) return null;
  // Com a janela visível, a troca espera.
  let estado = null;
  try { estado = fs.readFileSync(path.join(raiz, 'sync', 'janela.estado'), 'utf8').trim(); } catch (e) { /* fechada */ }
  if (estado === 'vista') return 'adiada (janela à vista)';
  varrerTemporarios();
  /*
   * Código de saída 3: janela visível, tenta de novo na próxima verificação.
   * O instalador baixado fica em cache até a troca terminar ou sair outra versão.
   */
  const nome = 'trackeroao-janela-' + String(tag).replace(/[^\w.-]/g, '') + '.exe';
  const exe = path.join(os.tmpdir(), nome);
  try {
    for (const n of fs.readdirSync(os.tmpdir())) {
      if (/^trackeroao-janela-.*\.exe$/.test(n) && n !== nome) { try { fs.rmSync(path.join(os.tmpdir(), n), { force: true }); } catch (e) { /* em uso */ } }
    }
  } catch (e) { /* temp */ }
  try {
    if (!fs.existsSync(exe)) {
      const parcial = exe + '.parcial';
      await pedir(`https://github.com/${REPO}/releases/download/${encodeURIComponent(tag)}/trackeroao-instalador.exe`, parcial);
      fs.renameSync(parcial, exe);
    }
    await envolverTroca(() => rodar(exe, ['/so-janela', '/destino=' + raiz]));
    try { fs.rmSync(exe, { force: true }); } catch (e) { /* temp */ }
    return 'atualizada para ' + tag;
  } catch (e) {
    try { fs.rmSync(exe + '.parcial', { force: true }); } catch (x) { /* temp */ }
    return 'adiada (' + e.message.split('\n')[0] + ')';
  }
}

/** Verifica e aplica uma versão nova, se houver. Nunca lança exceção. */
async function verificar(raiz) {
  raiz = raiz || RAIZ;
  if (process.env.TRACKEROAO_SEM_ATUALIZAR) return { atualizou: false, motivo: 'desligada por variável de ambiente' };
  try {
    return fs.existsSync(path.join(raiz, '.git')) ? await viaGit(raiz) : await viaRelease(raiz);
  } catch (e) {
    return { atualizou: false, erro: e.message };
  }
}

/**
 * Compara a versão instalada com a última publicada, sem aplicar. Usado pelo
 * "Forçar atualização" da bandeja.
 */
async function situacao(raiz) {
  raiz = raiz || RAIZ;
  if (fs.existsSync(path.join(raiz, '.git'))) return { git: true };
  const ultima = await ultimaRelease();
  const estado = lerEstado(raiz);
  const instalada = estado ? estado.tag : null;
  return { instalada, ultima, atual: instalada === ultima };
}

module.exports = { verificar, situacao, aoTrocarJanela, baixar, ultimaRelease, maisNova, aplicarPasta, listar, lerEstado, varrerPastasVazias, EXIGIDOS, LEGADO, PASTAS_LEGADO, PRESERVAR, NOME_ESTADO };

/*
 * Linha de comando.
 *
 *   node sync/atualizar.js                                confere e aplica
 *   node sync/atualizar.js --aplicar <pasta> <tag> <destino>   (instalador)
 */
if (require.main === module) {
  const a = process.argv.slice(2);
  if (a[0] === '--aplicar') {
    try {
      const r = aplicarPasta(path.resolve(a[1]), a[2], path.resolve(a[3] || RAIZ));
      console.log(`${a[2]}: ${r.copiados} arquivos` + (r.removidos.length ? `, removidos: ${r.removidos.join(', ')}` : ''));
    } catch (e) {
      console.error(e.message);
      process.exit(1);
    }
  } else {
    verificar().then((r) => {
      console.log(r.atualizou ? `atualizado: ${r.de || '?'} -> ${r.para}` : (r.erro || r.motivo || 'já está na versão atual'));
      if (r.erro) process.exit(1);
    });
  }
}
