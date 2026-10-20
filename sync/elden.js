'use strict';
/*
 * elden.js - reads the Elden Ring save into <raiz>/elden.json for the page:
 * total deaths of the character, owned items and the progress flags listed in
 * docs/app/eldenring/geral.json. Save file only; the game's memory is never
 * opened (it runs under Easy Anti-Cheat).
 */

const fs = require('fs');
const path = require('path');
const sl2 = require('./sl2');
const ERSave = require('./ersave');

const RAIZ = path.join(__dirname, '..');
const SAIDA = path.join(RAIZ, 'elden.json');
const DADOS = path.join(RAIZ, 'docs', 'app', 'eldenring', 'geral.json');
const FORMATO = 1;

let cacheLeitura = null;

/** Flags e bens conferidos no save (lista do geral.json). */
function leitura(arquivo) {
  if (!arquivo && cacheLeitura) return cacheLeitura;
  const g = JSON.parse(fs.readFileSync(arquivo || DADOS, 'utf8'));
  const l = { flags: g.leitura.flags, bens: g.leitura.bens };
  if (!arquivo) cacheLeitura = l;
  return l;
}

/** O que fica entre leituras para achar o slot em uso. */
function lembrar(res) {
  return {
    activeSlot: res.activeSlot,
    slots: res.slots.map((s) => ({ storedChecksum: s.storedChecksum, playSeconds: s.playSeconds })),
  };
}

function falha(base, error, message) {
  return Object.assign(base, { ok: false, error, message });
}

/**
 * Monta o objeto do elden.json. `estado` guarda o slot entre leituras e é
 * atualizado aqui. Mensagens de erro não levam caminhos de arquivo.
 */
function construir({ file, estado, dados }) {
  const base = { generatedAt: new Date().toISOString(), jogo: 'eldenring', formato: FORMATO };
  if (!file) return falha(base, 'no-save-found', 'No Elden Ring save found.');
  let st;
  let save;
  try {
    st = fs.statSync(file);
    save = sl2.readSave(file, { retries: 3, delayMs: 300 });
  } catch (e) {
    return falha(base, 'read-failed', e instanceof sl2.Sl2Error ? e.message : String(e.code || 'read error'));
  }
  let res;
  try {
    res = ERSave.parse(save.buf, { previous: estado && estado.anterior });
  } catch (e) {
    return falha(base, 'parse-failed', String(e.code || 'unknown layout'));
  }
  save = null;
  const r = ERSave.resumo(res, leitura(dados));
  if (estado) estado.anterior = lembrar(res);
  if (!r) return falha(base, 'no-character', 'No character in the save.');
  return Object.assign(base, {
    ok: true,
    fonte: {
      slot: r.slot,
      escolha: res.activeSlotReason,
      arquivo: path.extname(file).slice(1).toLowerCase(),
      saveModified: new Date(st.mtimeMs).toISOString(),
    },
    mortes: r.mortes,
    itens: { armas: r.armas, armaduras: r.armaduras, talismas: r.talismas, cinzas: r.cinzas, bens: r.bens },
    flags: r.flags,
  });
}

/** Verdadeiro se o save mudou desde a última leitura gravada em `saida`. */
function precisaLer(file, saida) {
  if (!file) return false;
  try {
    const atual = JSON.parse(fs.readFileSync(saida || SAIDA, 'utf8'));
    const lido = atual && atual.fonte && Date.parse(atual.fonte.saveModified);
    return !(lido && Math.floor(fs.statSync(file).mtimeMs) <= lido);
  } catch (e) {
    return true;
  }
}

module.exports = { SAIDA, DADOS, FORMATO, leitura, construir, precisaLer };
