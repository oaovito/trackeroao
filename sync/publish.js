'use strict';
/*
 * publish.js - prepara a versão pública da página, para o GitHub Pages.
 *
 * O progress.json interno contém o caminho do save, com o nome de usuário do
 * Windows e o Steam ID:
 *
 *     C:\Users\<usuario>\AppData\Roaming\Sekiro\<steamid64>\S0000.sl2
 *
 * A versão pública é montada por lista de campos permitidos, de modo que um
 * campo novo é privado por padrão. Os despejos crus (goodsRaw, weaponsRaw)
 * ficam de fora.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const RAIZ = path.join(__dirname, '..');

/**
 * Campos publicados. O selftest confere esta lista contra os campos que a
 * página lê de `sync`.
 */
const CAMPOS_PUBLICOS = [
  'generatedAt', 'ok', 'error', 'message', 'stale',
  'essentials', 'deaths', 'playtime', 'bossKills', 'achievements',
  'prayerBeadList', 'gourdSeedList',
  'bosses', 'miniBosses', 'headless', 'idols', 'idolCalibration',
  'tools', 'arts', 'goodsUnlocks', 'history', 'notes', 'efeitos',
  'jogador', 'demonBell', 'dragonrot', 'jogosVigiados',
];

/** O que sobra de `source` depois de tirar o que identifica a máquina. */
function fonteLimpa(source) {
  if (!source) return null;
  return {
    slot: source.slot,
    slotSelection: source.slotSelection,
    // saveModified fica de fora: equivale à data da última partida.
    itemsRead: source.itemsRead,
  };
}

/**
 * Campos publicados parcialmente. Horários (última partida, desbloqueios,
 * leituras) não são publicados.
 */
const PODAS = {
  // Conquistas sem `em` (hora do desbloqueio).
  achievements: (a) => (a ? Object.assign({}, a, {
    lista: a.lista.map((x) => ({
      bloco: x.bloco, stat: x.stat, nome: x.nome, descricao: x.descricao,
      oculta: x.oculta, conquistada: x.conquistada,
      icone: x.icone, dificuldade: x.dificuldade, raridade: x.raridade, shinobi: x.shinobi,
      descricaoOculta: x.descricaoOculta,
      fonte: x.fonte, incerta: x.incerta, confere: x.confere,
    })),
  }) : a),
  // Mortes sem `em`: com o jogo fechado, equivale à hora da última partida.
  deaths: (d) => (d ? {
    known: d.known, count: d.count, confidence: d.confidence,
    how: d.how, escopo: d.escopo, aoVivo: d.aoVivo,
  } : d),
  // Do jogador, só o apelido público e a fonte.
  jogador: (j) => (j ? { nick: j.nick, fonte: j.fonte } : j),  // sem o apelido de conferência
  // Jogos sem a hora da varredura.
  jogosVigiados: (j) => (j && Array.isArray(j.lista) ? {
    escolheu: !!j.escolheu,
    lista: j.lista.map((g) => ({
      chave: g.chave, nome: g.nome, leitura: g.leitura, vigiado: !!g.vigiado,
      instalado: g.instalado === undefined ? null : g.instalado,
      naSteam: !!g.naSteam, semSteam: !!g.semSteam, popular: g.popular || null,
      arte: g.arte || null,
    })),
  } : j),
  // Podridão: nomes, sem os ids de item.
  dragonrot: (d) => (d ? {
    ativo: d.ativo, quantos: d.quantos, total: d.total,
    essencias: (d.essencias || []).map((e) => ({ item: e.item, npc: e.npc })),
  } : d),
  demonBell: (b) => (b ? { ativo: b.ativo, label: b.label } : b),
  playtime: (p) => (p ? { minutos: p.minutos, horas: p.horas, fonte: p.fonte, internoSegundos: p.internoSegundos } : p),
};

function sanitizar(progresso) {
  const out = {};
  for (const campo of CAMPOS_PUBLICOS) {
    if (progresso[campo] === undefined) continue;
    out[campo] = PODAS[campo] ? PODAS[campo](progresso[campo]) : progresso[campo];
  }
  out.source = fonteLimpa(progresso.source);
  return out;
}

/** Monta a pasta servida pelo Pages; `index.html` é a própria página. */
function montar(destino) {
  const dir = destino || path.join(RAIZ, 'docs');
  fs.mkdirSync(dir, { recursive: true });

  const pagina = fs.readFileSync(path.join(RAIZ, 'trackeroao.html'), 'utf8');
  fs.writeFileSync(path.join(dir, 'index.html'), pagina);

  let progresso = null;
  try {
    progresso = JSON.parse(fs.readFileSync(path.join(RAIZ, 'progress.json'), 'utf8'));
  } catch (e) {
    progresso = { ok: false, error: 'no-progress', message: 'Nothing read yet.' };
  }
  const limpo = sanitizar(progresso);
  fs.writeFileSync(path.join(dir, 'progress.json'), JSON.stringify(limpo));

  // Desativa o Jekyll no Pages.
  fs.writeFileSync(path.join(dir, '.nojekyll'), '');

  // Pode não haver progress.json local ainda.
  let antes = 0;
  try { antes = fs.statSync(path.join(RAIZ, 'progress.json')).size; } catch (e) { /* nada lido */ }
  const depois = fs.statSync(path.join(dir, 'progress.json')).size;
  return { dir, antes, depois, campos: Object.keys(limpo).length };
}

/**
 * Confere o código do repositório. Nos dados, qualquer caminho de save é
 * vazamento; no código, procura-se pelos valores concretos desta máquina.
 */
const FORA = new Set(['node_modules', '.git', 'docs', 'redirect', 'snapshots', 'arquivo', 'icones']);
const EXTS = new Set(['.js', '.ps1', '.vbs', '.html', '.md', '.bat', '.gitignore']);
// JSON versionados (de projeto). Os demais são estado local, com horários,
// e ficam fora do git.
const JSON_DE_PROJETO = new Set(['package.json', path.join('sync', 'offsets.json')]);

/** Percorre o projeto e devolve os arquivos que não podem ser publicados. */
function conferirFontes() {
  const sujos = [];
  let vistos = 0;

  const anda = (de) => {
    for (const nome of fs.readdirSync(de)) {
      if (FORA.has(nome)) continue;
      const cheio = path.join(de, nome);
      if (fs.statSync(cheio).isDirectory()) { anda(cheio); continue; }
      const ext = path.extname(nome) || nome;
      const relativo = path.relative(RAIZ, cheio);
      if (ext === '.json') {
        if (!JSON_DE_PROJETO.has(relativo)) continue;
      } else if (!EXTS.has(ext)) continue;
      if (/\.log(\.\d+)?$/.test(nome)) continue;
      vistos++;
      const achados = vazamentosNoCodigo(fs.readFileSync(cheio, 'utf8'));
      if (achados.length) sujos.push({ arquivo: relativo, achados });
    }
  };

  anda(RAIZ);
  return { vistos, sujos };
}

/** Confere que nada que identifica a máquina passou. */
function vazamentos(texto) {
  const achados = [];
  const padroes = [
    [/[A-Za-z]:\\\\?Users\\\\?[^"\\/]+/i, 'caminho de usuário do Windows'],
    [/\b7656119\d{10}\b/, 'Steam ID'],
    [/AppData/i, 'caminho de AppData'],
    [/\bS0000\.sl2\b/i, 'nome do arquivo de save'],
    [/\b192\.168\.\d+\.\d+\b/, 'IP da rede local'],
    [/goodsRaw|weaponsRaw/, 'despejo cru do inventário'],
    [/"ultimaVez"/, 'data da última partida'],
  ];
  for (const [re, nome] of padroes) if (re.test(texto)) achados.push(nome);
  return achados;
}

/** Os endereços IPv4 desta máquina na rede, para procurar por eles no código. */
function ipsDaMaquina() {
  const fora = [];
  const faces = os.networkInterfaces();
  for (const nome of Object.keys(faces)) {
    for (const f of faces[nome] || []) {
      if (f.family === 'IPv4' && !f.internal) fora.push(f.address);
    }
  }
  return fora;
}

/**
 * Procura no código valores concretos desta máquina: pasta pessoal, IPs,
 * Steam IDs reais e caminhos de usuário com nome no lugar de `<usuario>`.
 */
function vazamentosNoCodigo(texto) {
  const achados = [];
  // 76561197960265728 é a base do SteamID64 e não identifica ninguém.
  for (const m of texto.matchAll(/7656119\d{10}/g)) {
    if (m[0] !== '76561197960265728') { achados.push('Steam ID'); break; }
  }

  // Pasta pessoal por extenso (o nome da conta sozinho pode coincidir com o
  // apelido publicado).
  let casa = '';
  try { casa = os.homedir() || ''; } catch (e) { /* sem casa, sem problema */ }
  if (casa && texto.toLowerCase().includes(casa.toLowerCase())) achados.push('pasta pessoal desta máquina');

  for (const ip of ipsDaMaquina()) if (texto.includes(ip)) achados.push('IP desta máquina (' + ip + ')');

  // Caminho de usuário com nome concreto; marcadores como `<usuario>`,
  // `...` e `%USERNAME%` são aceitos.
  for (const m of texto.matchAll(/[A-Za-z]:\\+Users\\+([^\\"'\s]+)/g)) {
    const quem = m[1];
    if (/^(\.{2,}|<[^>]*>|%[^%]*%|SEU[-_]?USU[AÁ]RIO)$/i.test(quem)) continue;
    achados.push('caminho de usuário do Windows: ' + quem);
  }

  return [...new Set(achados)];
}

module.exports = { sanitizar, fonteLimpa, montar, conferirFontes, vazamentos, vazamentosNoCodigo, CAMPOS_PUBLICOS };

if (require.main === module) {
  const r = montar(process.argv[2]);
  const texto = fs.readFileSync(path.join(r.dir, 'progress.json'), 'utf8');
  const achados = vazamentos(texto);
  console.log(`  pasta     : ${r.dir}`);
  console.log(`  progresso : ${(r.antes / 1024).toFixed(1)} KB -> ${(r.depois / 1024).toFixed(1)} KB, ${r.campos} campos`);
  if (achados.length) {
    console.error(`  VAZAMENTO : ${achados.join(', ')} - não publique assim`);
    process.exitCode = 1;
  } else {
    console.log('  conferido : nada de máquina, conta ou rede no arquivo público');
  }
}
