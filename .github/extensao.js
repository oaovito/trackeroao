/*
 * Extensão do navegador (Chrome e Edge, Manifest V3) com a página do Elden
 * Ring, para usar sem instalar o Trackeroao. O save é escolhido pela pessoa e
 * lido no próprio navegador pelo mesmo leitor do serviço (sync/ersave.js).
 *
 * Uso: node .github/extensao.js <saida.zip> [versão]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const RAIZ = path.join(__dirname, '..');
const ER = 'app/eldenring';

/** Arquivos da extensão: [caminho dentro do .zip, conteúdo]. */
function arquivos(versao) {
  const html = fs.readFileSync(path.join(RAIZ, 'trackeroao.html'), 'utf8');
  const blocos = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  if (blocos.length !== 1) throw new Error('esperava um único <script> na página, achei ' + blocos.length);
  // Extensões não rodam script embutido: o da página vira pagina.js.
  const pagina = html
    .replace(blocos[0][0], '<script src="ersave.js"></script>\n<script src="pagina.js"></script>')
    .replace(/<link rel="manifest"[^>]*>\n?/, '');
  const manifesto = {
    manifest_version: 3,
    name: 'Trackeroao',
    version: versao,
    description: 'Elden Ring progress read from the save file, entirely in the browser.',
    icons: { 128: 'app/icone-192.png' },
    action: { default_title: 'Trackeroao', default_icon: { 128: 'app/icone-192.png' } },
    background: { service_worker: 'fundo.js' },
  };
  const fundo = '// O ícone da extensão abre a página do Elden Ring numa aba.\n' +
    'chrome.action.onClicked.addListener(() => {\n' +
    '  chrome.tabs.create({ url: chrome.runtime.getURL("index.html#steam-1245620") });\n' +
    '});\n';
  const lista = [
    ['manifest.json', JSON.stringify(manifesto, null, 2) + '\n'],
    ['fundo.js', fundo],
    ['index.html', pagina],
    ['pagina.js', blocos[0][1]],
    ['ersave.js', fs.readFileSync(path.join(RAIZ, 'sync', 'ersave.js'))],
  ];
  for (const f of ['icone-192.png', 'icone-512.png', 'apple-touch-icon.png']) {
    lista.push(['app/' + f, fs.readFileSync(path.join(RAIZ, 'docs', 'app', f))]);
  }
  for (const f of fs.readdirSync(path.join(RAIZ, 'docs', ER)).filter((n) => n.endsWith('.json')).sort()) {
    lista.push([ER + '/' + f, fs.readFileSync(path.join(RAIZ, 'docs', ER, f))]);
  }
  return lista.map(([nome, dados]) => [nome, Buffer.isBuffer(dados) ? dados : Buffer.from(dados, 'utf8')]);
}

const TABELA = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(b) {
  let c = 0xffffffff;
  for (const x of b) c = TABELA[(c ^ x) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** .zip comprimido (deflate), com data fixa: a mesma entrada gera o mesmo arquivo. */
function zip(lista) {
  const partes = [];
  const central = [];
  let pos = 0;
  for (const [nome, dados] of lista) {
    const n = Buffer.from(nome, 'utf8');
    const comp = zlib.deflateRawSync(dados, { level: 9 });
    const crc = crc32(dados);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(dados.length, 22);
    local.writeUInt16LE(n.length, 26);
    partes.push(local, n, comp);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0x0800, 8);
    c.writeUInt16LE(8, 10);
    c.writeUInt16LE(0, 12);
    c.writeUInt16LE(0x21, 14);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(comp.length, 20);
    c.writeUInt32LE(dados.length, 24);
    c.writeUInt16LE(n.length, 28);
    c.writeUInt32LE(pos, 42);
    central.push(c, n);
    pos += 30 + n.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const fim = Buffer.alloc(22);
  fim.writeUInt32LE(0x06054b50, 0);
  fim.writeUInt16LE(lista.length, 8);
  fim.writeUInt16LE(lista.length, 10);
  fim.writeUInt32LE(cd.length, 12);
  fim.writeUInt32LE(pos, 16);
  return Buffer.concat([...partes, cd, fim]);
}

/** Versão do manifesto a partir da tag (v1.10.0 -> 1.10.0). */
function versaoDe(tag) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(tag || ''));
  return m ? m.slice(1, 4).map(Number).join('.') : '0.0.0';
}

if (require.main === module) {
  const saida = process.argv[2];
  if (!saida) {
    console.error('uso: node .github/extensao.js <saida.zip> [versão]');
    process.exit(2);
  }
  const lista = arquivos(versaoDe(process.argv[3] || require(path.join(RAIZ, 'package.json')).version));
  fs.mkdirSync(path.dirname(path.resolve(saida)), { recursive: true });
  fs.writeFileSync(saida, zip(lista));
  console.log('extensão: ' + saida + ' (' + lista.length + ' arquivos)');
}

module.exports = { arquivos, zip, versaoDe };
