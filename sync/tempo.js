'use strict';
/*
 * tempo.js - tempo de jogo.
 *
 * Fonte principal: o localconfig.vdf da Steam (Playtime em minutos,
 * LastPlayed em época unix):
 *
 *     Steam/userdata/<conta>/config/localconfig.vdf
 *       "814380" { "Playtime" "4386"  "LastPlayed" "1790527827" }
 *
 * Sem Steam, usa o tempo interno gravado no save (`slotFields.igtSegundos`,
 * ver offsets.json). As duas medidas são diferentes:
 *
 *   steam : relógio de parede, inclui menus, pausas e carregamentos
 *   jogo  : tempo interno do jogo
 *
 * Com as duas, vale a da Steam e a interna serve de conferência (não pode ser
 * maior). A Steam só atualiza o arquivo ao fechar o jogo ou sincronizar.
 */

const fs = require('fs');
const path = require('path');
const instalacao = require('./instalacao');

const APP_ID = '814380';
// SteamID64 = Steam3 + esta base. A pasta em userdata usa o Steam3.
const BASE_STEAMID64 = 76561197960265728n;

/** Deriva o id de conta (Steam3) a partir do caminho do save, que usa o ID64. */
function contaDoSave(caminhoSave) {
  if (!caminhoSave) return null;
  const m = /(\d{17})/.exec(caminhoSave.replace(/\\/g, '/'));
  if (!m) return null;
  try { return Number(BigInt(m[1]) - BASE_STEAMID64); } catch (e) { return null; }
}

/** Todas as contas que têm userdata, para o caso de o caminho do save não ajudar. */
function contasDisponiveis(steam) {
  try {
    return fs.readdirSync(path.join(steam, 'userdata'), { withFileTypes: true })
      .filter((d) => d.isDirectory() && /^\d+$/.test(d.name))
      .map((d) => Number(d.name));
  } catch (e) { return []; }
}

/**
 * Lê Playtime e LastPlayed do bloco do app. O id aparece mais de uma vez no
 * arquivo; vale a ocorrência seguida dos campos de tempo.
 */
function lerLocalConfig(arquivo) {
  let txt;
  try { txt = fs.readFileSync(arquivo, 'utf8'); } catch (e) { return null; }
  const alvo = `"${APP_ID}"`;
  let i = -1;
  while ((i = txt.indexOf(alvo, i + 1)) !== -1) {
    const trecho = txt.slice(i, i + 400);
    const pt = /"Playtime"\s+"(\d+)"/.exec(trecho);
    if (!pt) continue;
    const lp = /"LastPlayed"\s+"(\d+)"/.exec(trecho);
    return {
      minutos: Number(pt[1]),
      ultimaVez: lp ? new Date(Number(lp[1]) * 1000).toISOString() : null,
    };
  }
  return null;
}

/** Tempo interno lido do save, em segundos, do slot escolhido pelo parse. */
function doSave(payload, config) {
  const campo = config && config.slotFields && config.slotFields.igtSegundos;
  if (!campo || !payload) return null;
  const off = campo.offset;
  if (!(off >= 0) || off + 4 > payload.length) return null;
  const seg = payload.readUInt32LE(off);
  // Acima de 10 mil horas, considera a leitura inválida.
  if (!(seg > 0) || seg > 10000 * 3600) return null;
  return seg;
}

/** { minutos, horas, ultimaVez, fonte, conferencia } ou null quando não dá para saber. */
function tempoDeJogo(opts) {
  const o = opts || {};
  const doJogo = (typeof o.internoSegundos === "number" && o.internoSegundos > 0)
    ? o.internoSegundos : null;
  const semSteam = () => (doJogo === null ? null : {
    minutos: Math.round(doJogo / 60),
    horas: doJogo / 3600,
    ultimaVez: null,
    fonte: "jogo",
    internoSegundos: doJogo,
  });

  const steam = o.steam || instalacao.steamPath();
  if (!steam) return semSteam();
  const contas = [];
  const daSave = contaDoSave(o.save);
  if (daSave) contas.push(daSave);
  for (const c of contasDisponiveis(steam)) if (!contas.includes(c)) contas.push(c);

  for (const conta of contas) {
    const arquivo = path.join(steam, 'userdata', String(conta), 'config', 'localconfig.vdf');
    const r = lerLocalConfig(arquivo);
    if (r && r.minutos > 0) {
      return {
        minutos: r.minutos,
        horas: r.minutos / 60,
        ultimaVez: r.ultimaVez,
        fonte: 'steam',
        internoSegundos: doJogo,
        // O relógio de parede deve ser maior que o tempo interno.
        conferencia: doJogo === null ? null : {
          relogioSegundos: r.minutos * 60,
          jogoSegundos: doJogo,
          coerente: doJogo <= r.minutos * 60,
        },
      };
    }
  }
  return semSteam();
}

module.exports = { tempoDeJogo, lerLocalConfig, contaDoSave, doSave, APP_ID };

if (require.main === module) {
  const sl2 = require('./sl2');
  const t = tempoDeJogo({ save: sl2.findSavePath() });
  if (!t) { console.log('  não consegui ler o tempo de jogo'); process.exitCode = 1; }
  else console.log(`  ${t.minutos} min = ${t.horas.toFixed(1)} h  (última vez: ${t.ultimaVez})`);
}
