'use strict';
/*
 * deaths.js - contagem de mortes estimada pelo save (reserva do deathsmem.js).
 *
 * Conta as gravações em que o Sen caiu sem entrada de itens. Como o Unseen
 * Aid às vezes evita a perda, o número é um piso.
 */

const fs = require('fs');
const path = require('path');

const STATE_FILE = path.join(__dirname, '..', 'deaths.json');

/** Estado da contagem. */
function estadoVazio(slot) {
  return {
    startedAt: new Date().toISOString(),
    slot,
    gravacoes: 0,
    mortesCertas: 0,
    contadas: 0,
    contandoDesde: new Date().toISOString(),
  };
}

function load(stateFile) {
  try {
    return JSON.parse(fs.readFileSync(stateFile || STATE_FILE, 'utf8'));
  } catch (e) {
    return null;
  }
}

function save(estado, stateFile) {
  const alvo = stateFile || STATE_FILE;
  const tmp = alvo + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(estado, null, 1));
  fs.renameSync(tmp, alvo);
}

/** Payload anterior, mantido só em memória (1 MiB). */
let anterior = null;

/**
 * Uma gravação do save foi vista. Devolve o estado atualizado.
 *
 * `goods` e `weapons` são os do parse; servem para separar morte de compra.
 */
function observar(opts) {
  const { payload, goods, weapons, slot, senOffset, stateFile } = opts;
  let estado = load(stateFile);
  if (!estado || estado.slot !== slot) estado = estadoVazio(slot);
  // A fase "nada" não interrompe a contagem.
  if (estado.fase === 'resolvido') return estado;

  const agora = {
    payload,
    sen: senOffset != null && senOffset + 4 <= payload.length ? payload.readUInt32LE(senOffset) : null,
    goods: new Map(goods),
    weapons: new Set(weapons),
  };

  if (!anterior) { anterior = agora; return estado; }

  // Mesma gravação relida: ignora.
  if (anterior.payload.equals(payload)) { anterior = agora; return estado; }

  const limite = Math.min(anterior.payload.length, payload.length);
  const ganhouItem = [...agora.goods].some(([id, q]) => q > (anterior.goods.get(id) || 0));
  const ganhouArma = [...agora.weapons].some((id) => !anterior.weapons.has(id));
  const senCaiu = agora.sen !== null && anterior.sen !== null && agora.sen < anterior.sen;
  const morteCerta = senCaiu && !ganhouItem && !ganhouArma;

  estado.gravacoes++;
  if (morteCerta) {
    estado.mortesCertas++;
    // Contador exibido pela página.
    estado.contadas = (estado.contadas || 0) + 1;
    if (!estado.contandoDesde) estado.contandoDesde = new Date().toISOString();
  }

  // A busca de offset fica no deathsmem.js.
  anterior = agora;
  save(estado, stateFile);
  return estado;
}

/** Mortes vistas pelo save; usado enquanto a leitura de memória não está calibrada. */
function paraProgresso(estado) {
  const e = estado || {};
  if (typeof e.contadas === 'number' && e.contadas > 0) {
    return {
      known: true,
      count: e.contadas,
      confidence: 'likely',
      how: 'counted',
      desde: e.contandoDesde || null,
    };
  }
  return {
    known: false,
    count: null,
    confidence: 'unknown',
    how: 'learning',
    contadas: 0,
  };
}

/** Zera o payload em memória (testes). */
function reset() { anterior = null; }

module.exports = { observar, load, paraProgresso, reset, STATE_FILE };
