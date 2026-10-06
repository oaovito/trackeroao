'use strict';
/*
 * bosskills.js - quantas vezes cada chefe foi morto.
 *
 * O jogo não guarda essa contagem (as flags são booleanas), então ela é
 * construída:
 *
 *   - Semente: chefe já morto no ciclo atual conta como 1.
 *   - Cada transição da flag de desligada para ligada (ex.: a cada NG+) soma 1.
 *
 * Exato a partir do início da observação; antes disso, um piso.
 */

const fs = require('fs');
const path = require('path');

const ARQUIVO = path.join(__dirname, '..', 'bosskills.json');

function carregar(arquivo) {
  try { return JSON.parse(fs.readFileSync(arquivo || ARQUIVO, 'utf8')); } catch (e) { return null; }
}

function gravar(estado, arquivo) {
  const alvo = arquivo || ARQUIVO;
  const tmp = alvo + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(estado, null, 1));
  fs.renameSync(tmp, alvo);
}

/**
 * Atualiza a contagem a partir da lista de chefes da leitura atual.
 *
 * `bosses` é o array que o parse monta: cada item com `key` e `defeated`.
 * Devolve um mapa chave -> { vezes, desde, semeado }.
 */
function atualizar(bosses, opts) {
  const o = opts || {};
  const arquivo = o.arquivo || ARQUIVO;
  let estado = carregar(arquivo);
  const agora = new Date().toISOString();

  if (!estado) {
    estado = { iniciadoEm: agora, chefes: {} };
    for (const b of bosses) {
      if (typeof b.defeated !== 'boolean') continue;
      estado.chefes[b.key] = {
        vezes: b.defeated ? 1 : 0,
        // `semeado`: o 1 veio da semente, não de uma morte observada.
        semeado: b.defeated === true,
        ultima: b.defeated ? null : null,
        estava: b.defeated,
      };
    }
    gravar(estado, arquivo);
    return estado;
  }

  let mudou = false;
  for (const b of bosses) {
    if (typeof b.defeated !== 'boolean') continue;
    let c = estado.chefes[b.key];
    if (!c) {
      // Chefe novo no config: mesma regra da semente.
      c = estado.chefes[b.key] = { vezes: b.defeated ? 1 : 0, semeado: b.defeated, ultima: null, estava: b.defeated };
      mudou = true;
      continue;
    }
    // Só desligado -> ligado conta (o inverso é o NG+ zerando as flags).
    if (b.defeated && !c.estava) {
      c.vezes += 1;
      c.ultima = agora;
      c.semeado = false;
      mudou = true;
    }
    if (c.estava !== b.defeated) { c.estava = b.defeated; mudou = true; }
  }
  if (mudou) gravar(estado, arquivo);
  return estado;
}

/** O formato que a página consome: uma entrada por chefe, na ordem recebida. */
function paraProgresso(bosses, estado) {
  const e = estado || carregar() || { chefes: {} };
  return bosses.map((b) => {
    const c = e.chefes[b.key] || { vezes: 0, semeado: false, ultima: null };
    return {
      key: b.key,
      label: b.label,
      area: b.area || null,
      defeated: b.defeated === true,
      emblema: b.emblema || null,
      emblemaPorque: b.emblemaPorque || null,
      enquadre: b.enquadre || null,
      vezes: c.vezes || 0,
      // `semeado`: o número é um piso.
      semeado: c.semeado === true,
      ultima: c.ultima || null,
    };
  });
}

module.exports = { atualizar, paraProgresso, carregar, ARQUIVO };
