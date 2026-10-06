'use strict';
/*
 * Ícone próprio de cada jogo, em PNG, para o menu da bandeja.
 *
 * Ordem: o ícone embutido no executável do jogo (recursos do arquivo PE); o
 * ícone que a Steam guarda em steam\games\<hash>.ico, quando ela existe; senão
 * nada, e a bandeja desenha o selo com a inicial.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ---------------------------------------------------------------- PNG

const TABELA_CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = TABELA_CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function bloco(tipo, dados) {
  const t = Buffer.from(tipo, 'ascii');
  const tam = Buffer.alloc(4);
  tam.writeUInt32BE(dados.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, dados])));
  return Buffer.concat([tam, t, dados, crc]);
}

// RGBA (largura x altura x 4) para PNG.
function png(rgba, w, h) {
  const linhas = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    linhas[y * (w * 4 + 1)] = 0;
    rgba.copy(linhas, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    bloco('IHDR', ihdr), bloco('IDAT', zlib.deflateSync(linhas)), bloco('IEND', Buffer.alloc(0)),
  ]);
}

const ehPng = (b) => b.length > 8 && b.readUInt32BE(0) === 0x89504e47;

/*
 * Um quadro de ícone (PNG pronto ou DIB com máscara) em PNG. Aceita DIB de
 * 32, 24, 8, 4 e 1 bits por pixel.
 */
function quadroParaPng(d) {
  if (ehPng(d)) return d;
  if (d.length < 40) return null;
  const tamCab = d.readUInt32LE(0);
  const w = d.readInt32LE(4);
  const h = Math.abs(d.readInt32LE(8)) / 2;
  const bits = d.readUInt16LE(14);
  if (w <= 0 || h <= 0 || w > 1024 || h > 1024) return null;
  let cores = d.readUInt32LE(32);
  if (!cores && bits <= 8) cores = 1 << bits;
  const paleta = tamCab;
  const inicio = tamCab + cores * 4;
  const passo = Math.ceil((w * bits) / 32) * 4;
  const passoMasc = Math.ceil(w / 32) * 4;
  const mascara = inicio + passo * h;
  if (mascara > d.length) return null;
  const temMascara = mascara + passoMasc * h <= d.length;
  const rgba = Buffer.alloc(w * h * 4);
  let algumAlfa = false;
  for (let y = 0; y < h; y++) {
    const linha = inicio + (h - 1 - y) * passo;
    for (let x = 0; x < w; x++) {
      let r, g, b, a = 255;
      if (bits === 32) {
        const o = linha + x * 4;
        b = d[o]; g = d[o + 1]; r = d[o + 2]; a = d[o + 3];
        if (a) algumAlfa = true;
      } else if (bits === 24) {
        const o = linha + x * 3;
        b = d[o]; g = d[o + 1]; r = d[o + 2];
      } else if (bits <= 8) {
        const porByte = 8 / bits;
        const byte = d[linha + Math.floor(x / porByte)];
        const desloc = 8 - bits * (1 + (x % porByte));
        const i = (byte >> desloc) & ((1 << bits) - 1);
        const o = paleta + i * 4;
        b = d[o]; g = d[o + 1]; r = d[o + 2];
      } else return null;
      const p = (y * w + x) * 4;
      rgba[p] = r; rgba[p + 1] = g; rgba[p + 2] = b; rgba[p + 3] = a;
    }
  }
  // Sem canal alfa, a máscara AND diz o que é transparente.
  if ((bits !== 32 || !algumAlfa) && temMascara) {
    for (let y = 0; y < h; y++) {
      const linha = mascara + (h - 1 - y) * passoMasc;
      for (let x = 0; x < w; x++) {
        const fundo = (d[linha + (x >> 3)] >> (7 - (x & 7))) & 1;
        rgba[(y * w + x) * 4 + 3] = fundo ? 0 : 255;
      }
    }
  } else if (bits === 32 && !algumAlfa) {
    for (let p = 3; p < rgba.length; p += 4) rgba[p] = 255;
  }
  return png(rgba, w, h);
}

/*
 * Escolhe o melhor quadro: o maior até 256 px, e no empate o de mais cores.
 * entradas: [{ w, h, bits, dados() }]
 */
function melhorQuadro(entradas) {
  const nota = (e) => Math.min(e.w, 256) * 1000 + (e.bits || 0);
  const ordem = entradas.slice().sort((a, b) => nota(b) - nota(a));
  for (const e of ordem) {
    let d = null;
    try { d = e.dados(); } catch (x) { d = null; }
    const p = d && quadroParaPng(d);
    if (p) return p;
  }
  return null;
}

// ---------------------------------------------------------------- .ico

function deIco(buf) {
  if (!buf || buf.length < 6 || buf.readUInt16LE(0) !== 0 || buf.readUInt16LE(2) !== 1) return null;
  const n = buf.readUInt16LE(4);
  const entradas = [];
  for (let i = 0; i < n; i++) {
    const o = 6 + i * 16;
    if (o + 16 > buf.length) break;
    const tam = buf.readUInt32LE(o + 8);
    const ini = buf.readUInt32LE(o + 12);
    if (ini + tam > buf.length) continue;
    entradas.push({ w: buf[o] || 256, h: buf[o + 1] || 256, bits: buf.readUInt16LE(o + 6), dados: () => buf.subarray(ini, ini + tam) });
  }
  return melhorQuadro(entradas);
}

// ---------------------------------------------------------------- executável

const RT_ICON = 3;
const RT_GROUP_ICON = 14;

/*
 * Lê só as partes do arquivo que interessam (cabeçalhos e a seção de
 * recursos), sem carregar o executável inteiro na memória.
 */
function doExe(arquivo) {
  let fd;
  try { fd = fs.openSync(arquivo, 'r'); } catch (e) { return null; }
  try {
    const ler = (pos, n) => {
      const b = Buffer.alloc(n);
      const lidos = fs.readSync(fd, b, 0, n, pos);
      return lidos === n ? b : b.subarray(0, lidos);
    };
    const dos = ler(0, 64);
    if (dos.length < 64 || dos.readUInt16LE(0) !== 0x5a4d) return null;
    const pe = dos.readUInt32LE(60);
    const cab = ler(pe, 24);
    if (cab.length < 24 || cab.readUInt32LE(0) !== 0x00004550) return null;
    const nSecoes = cab.readUInt16LE(6);
    const tamOpc = cab.readUInt16LE(20);
    const opc = ler(pe + 24, tamOpc);
    const magia = opc.readUInt16LE(0);
    const dirs = magia === 0x20b ? 112 : 96;
    if (opc.length < dirs + 24) return null;
    const rvaRec = opc.readUInt32LE(dirs + 16);
    const tamRec = opc.readUInt32LE(dirs + 20);
    if (!rvaRec || !tamRec) return null;
    const secoes = ler(pe + 24 + tamOpc, nSecoes * 40);
    let base = -1, rvaSecao = 0, tamSecao = 0;
    for (let i = 0; i < nSecoes; i++) {
      const o = i * 40;
      const va = secoes.readUInt32LE(o + 12);
      const tamV = Math.max(secoes.readUInt32LE(o + 8), secoes.readUInt32LE(o + 16));
      if (rvaRec >= va && rvaRec < va + tamV) {
        base = secoes.readUInt32LE(o + 20) + (rvaRec - va);
        rvaSecao = rvaRec;
        tamSecao = Math.min(tamV - (rvaRec - va), 64 * 1024 * 1024);
        break;
      }
    }
    if (base < 0) return null;
    const rec = ler(base, tamSecao);
    const noRec = (rva) => rva - rvaSecao;

    // Entradas de um diretório de recursos: [{ id, nome, dir, pos }].
    const entradas = (pos) => {
      if (pos + 16 > rec.length) return [];
      const n = rec.readUInt16LE(pos + 12) + rec.readUInt16LE(pos + 14);
      const lista = [];
      for (let i = 0; i < n; i++) {
        const o = pos + 16 + i * 8;
        if (o + 8 > rec.length) break;
        const nome = rec.readUInt32LE(o);
        const alvo = rec.readUInt32LE(o + 4);
        lista.push({ id: nome & 0x80000000 ? null : nome, dir: !!(alvo & 0x80000000), pos: alvo & 0x7fffffff });
      }
      return lista;
    };
    // Primeiro dado folha abaixo de uma entrada (idioma qualquer).
    const folha = (e) => {
      let atual = e;
      for (let i = 0; i < 4 && atual && atual.dir; i++) atual = entradas(atual.pos)[0];
      if (!atual || atual.dir || atual.pos + 8 > rec.length) return null;
      const rva = rec.readUInt32LE(atual.pos);
      const tam = rec.readUInt32LE(atual.pos + 4);
      const ini = noRec(rva);
      if (ini < 0 || ini + tam > rec.length) return null;
      return rec.subarray(ini, ini + tam);
    };

    const raiz = entradas(0);
    const grupos = raiz.find((e) => e.id === RT_GROUP_ICON);
    const icones = raiz.find((e) => e.id === RT_ICON);
    if (!grupos || !icones || !grupos.dir || !icones.dir) return null;
    const porId = new Map(entradas(icones.pos).map((e) => [e.id, e]));
    // O primeiro grupo é o que o Windows mostra para o arquivo.
    const grupo = folha(entradas(grupos.pos)[0]);
    if (!grupo || grupo.length < 6) return null;
    const n = grupo.readUInt16LE(4);
    const lista = [];
    for (let i = 0; i < n; i++) {
      const o = 6 + i * 14;
      if (o + 14 > grupo.length) break;
      const e = porId.get(grupo.readUInt16LE(o + 12));
      if (!e) continue;
      lista.push({ w: grupo[o] || 256, h: grupo[o + 1] || 256, bits: grupo.readUInt16LE(o + 6), dados: () => folha(e) });
    }
    return melhorQuadro(lista);
  } catch (e) {
    return null;
  } finally {
    try { fs.closeSync(fd); } catch (e) { /* já fechado */ }
  }
}

// ---------------------------------------------------------------- Steam

/*
 * Hashes de 40 caracteres guardados na entrada do appinfo.vdf de cada appId
 * pedido. O arquivo é percorrido entrada por entrada, lendo só as dos jogos
 * pedidos. Formatos 27, 28 e 29 (29 com tabela de textos ao final).
 */
function hashesDoAppinfo(arquivo, appIds) {
  const queridos = new Set(appIds.map((a) => Number(a)).filter(Boolean));
  const achados = {};
  if (!queridos.size) return achados;
  let fd;
  try { fd = fs.openSync(arquivo, 'r'); } catch (e) { return achados; }
  try {
    const tamanho = fs.fstatSync(fd).size;
    const cab = Buffer.alloc(16);
    fs.readSync(fd, cab, 0, 16, 0);
    const versao = cab[0];
    if (cab[1] !== 0x44 || cab[2] !== 0x56 || cab[3] !== 0x07) return achados;
    let pos = versao >= 0x29 ? 16 : 8;
    const oito = Buffer.alloc(8);
    while (pos + 8 <= tamanho && queridos.size) {
      fs.readSync(fd, oito, 0, 8, pos);
      const app = oito.readUInt32LE(0);
      const tam = oito.readUInt32LE(4);
      if (!app) break;
      if (queridos.has(app)) {
        const dados = Buffer.alloc(Math.min(tam, 4 * 1024 * 1024));
        fs.readSync(fd, dados, 0, dados.length, pos + 8);
        const texto = dados.toString('latin1');
        achados[app] = [...new Set(texto.match(/[0-9a-f]{40}(?=\0)/g) || [])];
        queridos.delete(app);
      }
      pos += 8 + tam;
    }
  } catch (e) {
    /* appinfo.vdf ilegível: fica sem o ícone da Steam */
  } finally {
    try { fs.closeSync(fd); } catch (e) { /* já fechado */ }
  }
  return achados;
}

// O .ico do cliente da Steam: o único desses hashes salvo em steam\games.
function daSteam(steam, appId) {
  if (!steam || !appId) return null;
  const hashes = hashesDoAppinfo(path.join(steam, 'appcache', 'appinfo.vdf'), [appId])[Number(appId)] || [];
  for (const h of hashes) {
    const ico = path.join(steam, 'steam', 'games', h + '.ico');
    if (fs.existsSync(ico)) {
      try { return deIco(fs.readFileSync(ico)); } catch (e) { return null; }
    }
  }
  return null;
}

// ---------------------------------------------------------------- jogo

const lembrado = new Map();

/** { png, origem: 'exe' | 'steam' } ou null. Guarda o resultado por jogo. */
function doJogo(jogo, opts) {
  const o = opts || {};
  if (!jogo) return null;
  let exe = o.exe;
  if (exe === undefined) {
    try { exe = require('./biblioteca').executavelDoJogo(jogo); } catch (e) { exe = null; }
  }
  let steam = o.steam;
  if (steam === undefined) {
    try { steam = require('./instalacao').steamPath(); } catch (e) { steam = null; }
  }
  let marca = '';
  try { if (exe) { const s = fs.statSync(exe); marca = exe + '|' + s.size + '|' + s.mtimeMs; } } catch (e) { marca = ''; }
  const chave = jogo.chave + '|' + marca + '|' + (steam || '');
  if (lembrado.has(chave)) return lembrado.get(chave);
  let r = null;
  const deExe = exe ? doExe(exe) : null;
  if (deExe) r = { png: deExe, origem: 'exe' };
  else {
    const s = daSteam(steam, jogo.appId);
    if (s) r = { png: s, origem: 'steam' };
  }
  if (lembrado.size > 32) lembrado.clear();
  lembrado.set(chave, r);
  return r;
}

module.exports = { doJogo, doExe, deIco, daSteam, hashesDoAppinfo, quadroParaPng, png };

if (require.main === module) {
  const arq = process.argv[2];
  const r = arq && doExe(arq);
  if (!r) { console.error('sem ícone'); process.exit(1); }
  if (process.argv[3]) fs.writeFileSync(process.argv[3], r);
  console.log(r.length + ' bytes de PNG');
}
