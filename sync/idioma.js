'use strict';
/**
 * idioma.js - idioma escolhido na página.
 *
 * Gravado em sync/idioma.json como { "idioma": "<código>" }; sem o arquivo,
 * segue o idioma do sistema. Lido pela página, pela bandeja e pela janela.
 */
const fs = require('fs');
const path = require('path');

const ARQUIVO = path.join(__dirname, 'idioma.json');
// Idiomas suportados; outros códigos são recusados.
const IDIOMAS = ['en', 'pt-BR', 'es', 'fr', 'de', 'it', 'ru', 'pl', 'tr', 'ja', 'ko', 'zh-CN'];

function ler() {
  try {
    const v = JSON.parse(fs.readFileSync(ARQUIVO, 'utf8')).idioma;
    return IDIOMAS.includes(v) ? v : null;
  } catch (e) {
    return null;
  }
}

function gravar(v) {
  if (v === null || v === undefined || v === '') {
    try { fs.unlinkSync(ARQUIVO); } catch (e) { /* já não havia */ }
    return null;
  }
  if (!IDIOMAS.includes(v)) throw new Error('idioma desconhecido: ' + v);
  fs.writeFileSync(ARQUIVO, JSON.stringify({ idioma: v }));
  return v;
}

module.exports = { ler, gravar, IDIOMAS, ARQUIVO };
