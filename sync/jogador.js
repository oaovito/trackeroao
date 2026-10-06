'use strict';
/*
 * jogador.js - nome do jogador exibido no cabeçalho.
 *
 * Usa o apelido público da Steam (PersonaName):
 *
 *     Steam/config/loginusers.vdf
 *       "76561198xxxxxxxxx" { "AccountName" "..." "PersonaName" "fulano" }
 *
 * `AccountName` (login) nunca é lido. Sem Steam e sem nome escolhido, devolve
 * null. Com várias contas, vale a do SteamID64 do save lido.
 */

const fs = require('fs');
const path = require('path');
const instalacao = require('./instalacao');

/**
 * Blocos de conta do loginusers.vdf: { id64, persona }. Casa o id com o
 * PersonaName do mesmo bloco, sem interpretar o VDF inteiro.
 */
function contasDoArquivo(texto) {
  const fora = [];
  const re = /"(7656119\d{10})"\s*\{([\s\S]*?)\}/g;
  let m;
  while ((m = re.exec(texto))) {
    const persona = /"PersonaName"\s+"([^"]*)"/.exec(m[2]);
    if (persona && persona[1].trim()) fora.push({ id64: m[1], persona: persona[1].trim() });
  }
  return fora;
}

/** SteamID64 extraído do caminho do save. */
function id64DoSave(caminhoSave) {
  if (!caminhoSave) return null;
  const m = /(7656119\d{10})/.exec(String(caminhoSave).replace(/\\/g, '/'));
  return m ? m[1] : null;
}

/*
 * Nome escolhido na página, gravado em jogador.json. Tem prioridade sobre o
 * apelido da Steam, que vai junto como conferência.
 */
const ESCOLHIDO = path.join(__dirname, '..', 'jogador.json');

function escolhido(arq) {
  try {
    const j = JSON.parse(fs.readFileSync(arq || ESCOLHIDO, 'utf8'));
    const nick = limpar(j.nick);
    return nick || null;
  } catch (e) { return null; }
}

/** Nome de cabeçalho: uma linha, sem controle, até 32 caracteres. */
function limpar(nick) {
  return String(nick || '').replace(/[\u0000-\u001f]/g, ' ').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 32);
}

/** Grava (ou apaga, com nome vazio) o nome escolhido. */
function escolher(nick, arq) {
  const n = limpar(nick);
  const alvo = arq || ESCOLHIDO;
  if (!n) { try { fs.unlinkSync(alvo); } catch (e) { /* já não havia */ } return null; }
  fs.writeFileSync(alvo, JSON.stringify({ nick: n }, null, 2) + '\n');
  return n;
}

/** { nick, fonte } ou null; `fonte` indica a origem do nome. */
function quem(opts) {
  const o = opts || {};
  const meu = escolhido(o.arquivo);
  const daSteam = doSteam(o);
  if (meu) return { nick: meu, fonte: 'escolhido', steam: daSteam ? daSteam.nick : null };
  return daSteam;
}

function doSteam(opts) {
  const o = opts || {};
  const steam = o.steam || instalacao.steamPath();
  if (!steam) return null;

  let texto;
  try { texto = fs.readFileSync(path.join(steam, 'config', 'loginusers.vdf'), 'utf8'); } catch (e) { return null; }

  const contas = contasDoArquivo(texto);
  if (!contas.length) return null;

  const alvo = id64DoSave(o.save);
  const escolhida = (alvo && contas.find((c) => c.id64 === alvo)) || (contas.length === 1 ? contas[0] : null);
  if (!escolhida) return null;

  return { nick: escolhida.persona, fonte: 'steam' };
}

module.exports = { quem, escolher, escolhido, limpar, contasDoArquivo, id64DoSave, ESCOLHIDO };

if (require.main === module) {
  const sl2 = require('./sl2');
  const r = quem({ save: sl2.findSavePath() });
  if (!r) console.log('  sem Steam identificado: o cabeçalho fica só com o título');
  else console.log(`  ${r.nick}  (${r.fonte})`);
}
