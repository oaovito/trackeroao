'use strict';
/*
 * deathsmem.js - contagem de mortes lida da memória do jogo, em tempo real.
 *
 * O offset do contador é encontrado por diferença entre fotos da memória:
 *
 *   npm run deaths mark        tira a foto
 *   (morra no jogo)
 *   npm run deaths confirm 1   compara e guarda os candidatos
 *   (repita com outro número)  o cruzamento decide
 *
 * Somente leitura: o handle é aberto sem PROCESS_VM_WRITE.
 */

const fs = require('fs');
const path = require('path');
const memoria = require('./memoria');

const ESTADO = path.join(__dirname, '..', 'deaths-mem.json');
const FOTO = path.join(__dirname, 'snapshots', 'mem-mortes.bin');

function carregar() {
  try { return JSON.parse(fs.readFileSync(ESTADO, 'utf8')); } catch (e) { return null; }
}

function gravar(e) {
  const tmp = ESTADO + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(e, null, 1));
  fs.renameSync(tmp, ESTADO);
}

/** Tira a foto da região estática do módulo do jogo. */
function marcar() {
  const c = memoria.conectar();
  if (!c.ok) return { ok: false, erro: c.erro || 'jogo fechado' };
  fs.mkdirSync(path.dirname(FOTO), { recursive: true });
  const r = memoria.executar([{
    tipo: 'snapshot', nome: 'f', arquivo: FOTO, inicio: c.base, tamanho: c.tamanho,
  }], { timeout: 120000 });
  if (!r.ok) return { ok: false, erro: r.erro };
  const e = carregar() || {};
  e.base = c.base;
  e.tamanho = c.tamanho;
  e.fotoEm = new Date().toISOString();
  gravar(e);
  return { ok: true, bytes: c.tamanho, base: c.base };
}

/**
 * Compara com a foto e mantém os offsets que subiram exatamente `mortes`,
 * cruzando com a rodada anterior.
 */
function confirmar(mortes) {
  const e = carregar();
  if (!e || !e.base) return { ok: false, erro: 'tire a foto primeiro: npm run deaths mark' };
  const c = memoria.conectar();
  if (!c.ok) return { ok: false, erro: c.erro || 'jogo fechado' };
  if (c.base !== e.base) {
    // Módulo carregado em outro endereço (jogo reiniciado): foto inválida.
    return { ok: false, erro: 'o jogo reiniciou desde a foto; tire outra' };
  }
  const r = memoria.executar([{
    tipo: 'diff', nome: 'd', arquivo: FOTO, inicio: e.base, tamanho: e.tamanho, delta: mortes,
  }], { timeout: 180000 });
  if (!r.ok || !r.res || !r.res.d) return { ok: false, erro: r.erro || 'diff falhou' };

  const achados = (r.res.d.offsets || []).map(Number);
  const antes = e.candidatos;
  let candidatos;
  if (Array.isArray(antes) && antes.length) {
    const s = new Set(achados);
    candidatos = antes.filter((o) => s.has(o));
  } else {
    candidatos = achados;
  }

  e.candidatos = candidatos;
  e.ultimaRodada = { mortes, brutos: r.res.d.total, em: new Date().toISOString() };
  if (candidatos.length === 1 && Array.isArray(antes)) {
    e.offset = candidatos[0];
    e.resolvidoEm = new Date().toISOString();
  }
  gravar(e);
  return {
    ok: true,
    brutos: r.res.d.total,
    candidatos: candidatos.length,
    offset: e.offset || null,
    cruzou: Array.isArray(antes) && antes.length > 0,
  };
}

/**
 * Confirmação sem informar o número de mortes. Os offsets são agrupados em
 * baldes pelo quanto subiram (1 a 20); cruzando os baldes de duas rodadas, o
 * contador verdadeiro aparece em exatamente um par.
 */
const TETO_MORTES = 20;

function varrer() {
  const e = carregar();
  if (!e || !e.base) return { ok: false, erro: 'tire a foto primeiro: npm run deaths mark' };
  const c = memoria.conectar();
  if (!c.ok) return { ok: false, erro: c.erro || 'jogo fechado' };
  if (c.base !== e.base) return { ok: false, erro: 'o jogo reiniciou desde a foto; tire outra' };

  const r = memoria.executar([{
    tipo: 'varredura', nome: 'v', arquivo: FOTO,
    inicio: e.base, tamanho: e.tamanho, maxDelta: TETO_MORTES,
  }], { timeout: 240000 });
  if (!r.ok || !r.res || !r.res.v) return { ok: false, erro: r.erro || 'varredura falhou' };

  const baldes = {};
  for (const [d, offs] of Object.entries(r.res.v.baldes || {})) {
    baldes[d] = (offs || []).map(Number);
  }

  const rodadas = Array.isArray(e.rodadas) ? e.rodadas : [];
  rodadas.push({ baldes, em: new Date().toISOString() });
  e.rodadas = rodadas.slice(-3);          // mantém as três últimas rodadas
  e.fotoEm = null;                        // foto consumida por esta rodada

  // Cruza a última rodada com cada anterior, balde a balde.
  let achado = null;
  const pares = [];
  for (let i = 0; i < e.rodadas.length - 1; i++) {
    const antiga = e.rodadas[i].baldes;
    for (const [da, offsA] of Object.entries(antiga)) {
      const setA = new Set(offsA);
      for (const [db, offsB] of Object.entries(baldes)) {
        const comum = offsB.filter((o) => setA.has(o));
        if (!comum.length) continue;
        pares.push({ da: Number(da), db: Number(db), n: comum.length, offsets: comum });
        if (comum.length === 1) achado = { offset: comum[0], da: Number(da), db: Number(db) };
      }
    }
  }

  // Mais de um par com um só deslocamento: ambíguo, não grava.
  const unicos = pares.filter((p) => p.n === 1);
  if (unicos.length === 1) {
    e.offset = unicos[0].offsets[0];
    e.resolvidoEm = new Date().toISOString();
    achado = { offset: e.offset, da: unicos[0].da, db: unicos[0].db };
  } else {
    achado = null;
  }

  e.candidatos = achado ? [achado.offset] : [];
  e.ultimaRodada = {
    baldes: Object.keys(baldes).length,
    total: Object.values(baldes).reduce((a, b) => a + b.length, 0),
    em: new Date().toISOString(),
  };
  gravar(e);

  return {
    ok: true,
    rodadas: e.rodadas.length,
    baldes: Object.keys(baldes).length,
    total: e.ultimaRodada.total,
    pares: pares.length,
    unicos: unicos.length,
    offset: achado ? achado.offset : null,
    mortes: achado ? { rodada1: achado.da, rodada2: achado.db } : null,
  };
}

/**
 * Contagem total do save, lida do GameDataMan (carregado do arquivo de save).
 * A mesma struct tem o tempo de jogo interno.
 */
function daJornada() {
  const c = memoria.conectar();
  if (!c.ok) return null;
  const r = memoria.executar([Object.assign(
    { tipo: 'scanRel', nome: 'g' }, memoria.PADROES.GameDataMan
  )]);
  if (!r.ok || !r.res || !r.res.g || !r.res.g.alvo) return null;

  const p = memoria.ler(r.res.g.alvo, 8);
  if (!p) return null;
  const inst = Number(p.readBigUInt64LE(0));
  // No menu principal a instância ainda não existe.
  if (!inst) return null;

  const campo = (off) => {
    const b = memoria.ler(inst + off, 4);
    return b ? b.readUInt32LE(0) : null;
  };
  const mortes = campo(memoria.GAME_DATA.mortes);
  const igtMs = campo(memoria.GAME_DATA.igt);
  if (mortes === null || mortes > 100000) return null;

  const leitura = {
    mortes,
    fonte: 'memoria',
    escopo: 'jornada',
    igtHoras: igtMs === null ? null : igtMs / 3600000,
    em: new Date().toISOString(),
  };
  registrar(leitura);
  return leitura;
}

/**
 * Guarda a última leitura boa. Grava só quando muda ou a cada dez minutos.
 */
function registrar(j) {
  const e = carregar() || {};
  const antes = e.ultimaObservacao;
  const mudou = !antes || antes.mortes !== j.mortes;
  const velha = antes && (Date.now() - new Date(antes.em).getTime()) > 600000;
  if (!mudou && !velha) return;
  const s = (() => { try { return daSessao(); } catch (err) { return null; } })();
  e.ultimaObservacao = {
    mortes: j.mortes,
    igtHoras: j.igtHoras,
    sessao: s ? s.mortes : null,
    em: j.em,
  };
  gravar(e);
}

/** Última contagem lida, usada com o jogo fechado (`aoVivo: false`). */
function ultimaConhecida() {
  const e = carregar();
  const o = e && e.ultimaObservacao;
  if (!o || typeof o.mortes !== 'number') return null;
  return {
    mortes: o.mortes,
    fonte: 'memoria',
    escopo: 'jornada',
    igtHoras: o.igtHoras === undefined ? null : o.igtHoras,
    aoVivo: false,
    em: o.em,
  };
}

/**
 * Contagem da sessão, pelo offset achado por diferença. Reserva para quando o
 * padrão do GameDataMan não for encontrado.
 */
function daSessao() {
  const e = carregar();
  if (!e || typeof e.offset !== 'number') return null;
  const c = memoria.conectar();
  if (!c.ok) return null;
  const b = memoria.ler(c.base + e.offset, 4);
  if (!b) return null;
  const n = b.readUInt32LE(0);
  if (n > 100000) return null;                     // valor absurdo: offset errado
  return { mortes: n, fonte: 'memoria', escopo: 'sessao', offset: e.offset, em: new Date().toISOString() };
}

/** A melhor contagem disponível: a jornada inteira, ou a sessão como reserva. */
function contagem() {
  try {
    const j = daJornada();
    if (j) return j;
  } catch (e) { /* padrão não casou nesta versão; cai na reserva */ }
  return daSessao();
}

function estado() {
  const e = carregar();
  if (!e) return { calibrado: false, candidatos: 0 };
  return {
    calibrado: typeof e.offset === 'number',
    offset: e.offset || null,
    candidatos: (e.candidatos || []).length,
    ultimaRodada: e.ultimaRodada || null,
  };
}

module.exports = { marcar, confirmar, varrer, contagem, daJornada, daSessao, ultimaConhecida, estado, carregar, ESTADO, FOTO, TETO_MORTES };

if (require.main === module) {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === 'mark') {
    const r = marcar();
    console.log(r.ok
      ? `  foto de ${(r.bytes / 1048576).toFixed(1)} MB tirada.\n  Agora morra no jogo e rode: npm run deaths confirm <quantas vezes>`
      : `  ${r.erro}`);
    process.exitCode = r.ok ? 0 : 1;
  } else if (cmd === 'confirm') {
    const n = Number(arg);
    if (!Number.isInteger(n) || n < 1) { console.log('  use: deaths confirm <quantas mortes>'); process.exitCode = 1; }
    else {
      const r = confirmar(n);
      if (!r.ok) { console.log('  ' + r.erro); process.exitCode = 1; }
      else if (r.offset !== null) console.log(`  resolvido: offset 0x${r.offset.toString(16)} — o contador está no ar`);
      else if (r.cruzou) console.log(`  ${r.candidatos} candidatos depois do cruzamento; rode outra rodada com número diferente`);
      else console.log(`  ${r.candidatos} candidatos (de ${r.brutos}). Tire outra foto e repita com número diferente.`);
    }
  } else {
    /*
     * Estado e comparação com a leitura anterior, para indicar se a contagem
     * sobrevive ao reinício do jogo (jornada) ou zera (sessão).
     */
    const e = estado();
    console.log(`  calibrado: ${e.calibrado ? 'sim, offset de sessão 0x' + e.offset.toString(16) : 'não'}`);
    const j = daJornada();
    const s = daSessao();
    const guardado = carregar() || {};
    const antes = guardado.ultimaObservacao || null;

    if (j) {
      console.log(`  jornada  : ${j.mortes} mortes` +
        (j.igtHoras ? `  |  tempo interno ${j.igtHoras.toFixed(2)} h` : ''));
      if (s) console.log(`  sessão   : ${s.mortes} mortes desde que o jogo abriu`);
      if (antes) {
        const reiniciou = s && antes.sessao !== null && s.mortes < antes.sessao;
        console.log(`  antes    : ${antes.mortes} mortes em ${new Date(antes.em).toLocaleString()}`);
        if (reiniciou) {
          console.log(j.mortes >= antes.mortes
            ? '  -> o jogo reiniciou e a contagem se manteve: é da jornada, confirmado'
            : '  -> o jogo reiniciou e a contagem caiu: NÃO é da jornada');
        } else if (j.mortes > antes.mortes) {
          console.log(`  -> subiu ${j.mortes - antes.mortes} desde a última olhada`);
        }
      }
      guardado.ultimaObservacao = {
        mortes: j.mortes,
        igtHoras: j.igtHoras,
        sessao: s ? s.mortes : null,
        em: new Date().toISOString(),
      };
      gravar(guardado);
    } else if (s) {
      console.log(`  sessão   : ${s.mortes} (a struct da jornada não respondeu; jogo no menu?)`);
    } else {
      console.log('  jogo fechado, ou ainda sem calibração');
    }
  }
}
