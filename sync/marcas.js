'use strict';
/*
 * marcas.js - progresso marcado pelo jogador nas páginas de jogos sem leitura
 * do save (hoje, o Khazan).
 *
 * Gravado em marcas.json, na raiz da instalação, como { "<jogo>": [chaves] }.
 * A página só manda chaves curtas ("missoes:banished-hero"); nada do jogo nem
 * da máquina é lido para isso.
 */

const fs = require('fs');
const path = require('path');

const ARQUIVO = path.join(__dirname, '..', 'marcas.json');
const JOGOS = new Set(['khazan']);
const CHAVE = /^[a-z][a-z-]{1,24}:[a-z0-9][a-z0-9-]{0,80}$/;
const MAXIMO = 2000;

function tudo(arquivo) {
  try {
    const j = JSON.parse(fs.readFileSync(arquivo || ARQUIVO, 'utf8'));
    return j && typeof j === 'object' && !Array.isArray(j) ? j : {};
  } catch (e) {
    return {};
  }
}

/** As marcas de um jogo, ou null para um jogo que não tem página de marcas. */
function ler(jogo, arquivo) {
  if (!JOGOS.has(jogo)) return null;
  const l = tudo(arquivo)[jogo];
  return Array.isArray(l) ? l.filter((c) => typeof c === 'string' && CHAVE.test(c)) : [];
}

/** Troca as marcas de um jogo pela lista recebida, já conferida. */
function gravar(jogo, marcas, arquivo) {
  if (!JOGOS.has(jogo)) throw new Error('jogo sem marcas: ' + jogo);
  if (!Array.isArray(marcas) || marcas.length > MAXIMO) throw new Error('lista de marcas inválida');
  const limpas = [...new Set(marcas)].filter((c) => typeof c === 'string' && CHAVE.test(c));
  if (limpas.length !== new Set(marcas).size) throw new Error('marca com formato inválido');
  const destino = arquivo || ARQUIVO;
  const todas = tudo(destino);
  todas[jogo] = limpas.sort();
  const tmp = destino + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(todas));
  fs.renameSync(tmp, destino);
  return todas[jogo];
}

module.exports = { ler, gravar, ARQUIVO };
