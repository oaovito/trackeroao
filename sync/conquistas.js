'use strict';
/*
 * conquistas.js - ícones e dificuldade das conquistas.
 *
 *   ÍCONE       — baixado do CDN da Steam para dentro do repositório.
 *   DIFICULDADE — derivada da porcentagem global de jogadores que têm a
 *                 conquista, publicada pela Steam.
 *
 * Fonte: página pública de estatísticas do jogo (sem chave de API).
 * Executado manualmente com `npm run conquistas`.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const PAGINA = 'https://steamcommunity.com/stats/814380/achievements/';
const DESTINO = path.join(__dirname, '..', 'docs', 'icones', 'conquistas');
const TABELA = path.join(__dirname, 'conquistas.json');

// Cortes de dificuldade, em % de jogadores, nos degraus da distribuição do Sekiro.
const CORTES = [
  ['facil', 50],
  ['media', 20],
  ['dificil', 0],
];

/**
 * Nome normalizado (minúsculas, sem pontuação), usado como chave de ligação
 * e como nome de arquivo.
 */
function slug(nome) {
  return String(nome).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function dificuldade(percent) {
  for (const [nome, piso] of CORTES) if (percent >= piso) return nome;
  return 'dificil';
}

/*
 * Descrições das 23 conquistas ocultas, copiadas dos troféus equivalentes do
 * PlayStation. Usadas só quando o jogo não fornece descrição.
 *
 * Fonte: lista de troféus de Sekiro: Shadows Die Twice (PowerPyx).
 */
const DESCRICOES_DE_RESERVA = {
  'sekiro': 'All achievements have been unlocked.',
  'man-without-equal': 'Defeated all bosses',
  'ashina-traveler': 'Traveled to all areas of the game',
  'master-of-the-prosthetic': 'Upgraded all Prosthetic Tools to their limit',
  'height-of-technique': 'Acquired all skills',
  'all-prosthetic-tools': 'Acquired all Prosthetic Tools',
  'all-ninjutsu-techniques': 'Acquired all Ninjutsu Techniques',
  'peak-physical-strength': 'Upgraded Vitality and Posture to their limit',
  'ultimate-healing-gourd': "Fully upgraded the 'Healing Gourd'",
  'immortal-severance': "Attained the 'Immortal Severance' ending",
  'purification': "Attained the 'Purification' ending",
  'dragon-s-homecoming': "Attained the 'Return' ending",
  'shura': "Attained the 'Shura' ending",
  'sword-saint-isshin-ashina': "Defeated 'Sword Saint Isshin Ashina'",
  'master-of-the-arts': 'Grasped the inner mysteries of any combat style',
  'lazuline-upgrade': 'Used Lapis Lazuli to upgrade any tool to its limit',
  'revered-blade': "Received the 'Kusabimaru' from Kuro",
  'shinobi-prosthetic': 'Acquired the Shinobi Prosthetic',
  'memorial-mob': 'Encountered the Memorial Mob',
  'resurrection': "Returned from the dead using 'Resurrection' for the first time",
  'gyoubu-masataka-oniwa': "Defeated 'Gyoubu Masataka Oniwa'",
  'the-phantom-lady-butterfly': "Defeated 'Lady Butterfly'",
  'genichiro-ashina': "Defeated 'Genichiro Ashina'",
  'guardian-ape': "Defeated the 'Guardian Ape'",
  'guardian-ape-immortality-severed': "Used the Mortal Blade to sever the Guardian Ape's undying",
  'folding-screen-monkeys': 'Caught the Folding Screen Monkeys',
  'great-shinobi-owl': "Defeated 'Great Shinobi – Owl'",
  'father-surpassed': "Defeated 'Great Shinobi – Owl' at the Hirata Estate",
  'corrupted-monk': "Defeated the 'Corrupted Monk'",
  'gracious-gift-of-tears': "Defeated the 'Divine Dragon' and obtained the 'Divine Dragon's Tears'",
  'isshin-ashina': "Defeated 'Isshin Ashina'",
  'demon-of-hatred': "Defeated the 'Demon of Hatred'",
  'great-serpent': "Defeated the 'Great Serpent'",
  'great-colored-carp': "Defeated the 'Great Colored Carp'",
};

/** A descrição de reserva, se houver, para um nome de conquista. */
function descricaoDeReserva(nome) {
  return DESCRICOES_DE_RESERVA[slug(nome)] || null;
}

function buscar(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'trackeroao' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(buscar(res.headers.location));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error('HTTP ' + res.statusCode + ' em ' + url));
      }
      const pedacos = [];
      res.on('data', (c) => pedacos.push(c));
      res.on('end', () => resolve(Buffer.concat(pedacos)));
    }).on('error', reject);
  });
}

/** Lê a página e devolve uma linha por conquista, na ordem em que aparecem. */
function extrair(html) {
  const linhas = [];
  const re = /<div class="achieveRow[^"]*">([\s\S]*?)<div style="clear: both;">/g;
  let m;
  while ((m = re.exec(html))) {
    const bloco = m[1];
    const icone = /<img src="([^"]+)"/.exec(bloco);
    const pct = /<div class="achievePercent">([\d.]+)%/.exec(bloco);
    const nome = /<h3>([\s\S]*?)<\/h3>/.exec(bloco);
    const desc = /<h5>([\s\S]*?)<\/h5>/.exec(bloco);
    if (!icone || !nome) continue;
    const limpo = (s) => s.replace(/&quot;/g, '"').replace(/&amp;/g, '&')
      .replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
    linhas.push({
      nome: limpo(nome[1]),
      descricao: desc ? limpo(desc[1]) : '',
      icone: icone[1],
      percent: pct ? Number(pct[1]) : null,
    });
  }
  return linhas;
}

async function colher(opts) {
  const o = opts || {};
  const html = (await buscar(PAGINA)).toString('utf8');
  const linhas = extrair(html);
  if (!linhas.length) throw new Error('a página mudou de forma: nenhuma conquista reconhecida');

  fs.mkdirSync(DESTINO, { recursive: true });
  const tabela = {};
  let baixados = 0;

  for (const l of linhas) {
    // Ligação pelo nome normalizado; a ordem da página não segue as chaves internas.
    const chave = slug(l.nome);
    const arquivo = chave + '.jpg';
    const caminho = path.join(DESTINO, arquivo);

    if (!fs.existsSync(caminho) || o.forcar) {
      try {
        fs.writeFileSync(caminho, await buscar(l.icone));
        baixados++;
      } catch (e) {
        if (!o.quieto) console.log(`  ${chave}: não baixou (${e.message})`);
      }
    }

    tabela[chave] = {
      nome: l.nome,
      percent: l.percent,
      dificuldade: l.percent === null ? null : dificuldade(l.percent),
      icone: fs.existsSync(caminho) ? 'icones/conquistas/' + arquivo : null,
    };
  }

  fs.writeFileSync(TABELA, JSON.stringify(tabela, null, 1));
  return { total: linhas.length, baixados, tabela: TABELA };
}

/** A tabela já colhida, ou null se ainda não rodou. */
function carregar() {
  try { return JSON.parse(fs.readFileSync(TABELA, 'utf8')); } catch (e) { return null; }
}

module.exports = { colher, carregar, extrair, dificuldade, slug, descricaoDeReserva, DESCRICOES_DE_RESERVA, CORTES, TABELA, DESTINO };

if (require.main === module) {
  colher({ forcar: process.argv.includes('--forcar') }).then((r) => {
    const t = carregar() || {};
    const conta = {};
    for (const v of Object.values(t)) conta[v.dificuldade] = (conta[v.dificuldade] || 0) + 1;
    console.log(`  ${r.total} conquistas, ${r.baixados} ícones baixados agora`);
    console.log(`  fácil ${conta.facil || 0}  |  média ${conta.media || 0}  |  difícil ${conta.dificil || 0}`);
  }).catch((e) => {
    console.error('  ' + e.message);
    process.exitCode = 1;
  });
}
