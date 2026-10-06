'use strict';
/*
 * memoria.js - interface Node para a leitura de memória do jogo.
 *
 * A leitura em si está em mem.ps1 (P/Invoke de OpenProcess e
 * ReadProcessMemory, varredura por padrão de bytes, resolução de ponteiros).
 * Este módulo serializa as operações em JSON, chama o PowerShell e lê a
 * resposta. Evita dependências nativas.
 *
 * Somente leitura: o handle é aberto sem PROCESS_VM_WRITE.
 */

const path = require('path');
const { execFileSync } = require('child_process');

const SCRIPT = path.join(__dirname, 'mem.ps1');
const PROCESSO = 'sekiro';

/** Padrões AOB do SoulSplitter, que resolvem por varredura e não por versão. */
const PADROES = {
  WorldChrManImp: { padrao: '48 8B 35 ? ? ? ? 44 0F 28 18', desloc: 3, instrucao: 7 },
  PlayerGameData: { padrao: '48 8b 0d ? ? ? ? 48 8b 41 20 c6 04 02 00', desloc: 3, instrucao: 7 },
  EventFlagMan: {
    padrao: '48 8b 0d ? ? ? ? 48 89 5c 24 50 48 89 6c 24 58 48 89 74 24 60',
    desloc: 3, instrucao: 7,
  },
  /*
   * GameDataMan: dados carregados do save, incluindo a contagem total de
   * mortes e o tempo de jogo (IGT). Padrão do SoulSplitter; a busca por
   * padrão resiste a atualizações do jogo.
   */
  GameDataMan: {
    padrao: '48 8b 05 ? ? ? ? 32 d2 48 8b 48 08 48 85 c9 74 13 80 b9 ba',
    desloc: 3, instrucao: 7,
  },
};

/** Campos de GameDataMan, em bytes a partir da instância. */
const GAME_DATA = {
  mortes: 0x90,
  igt: 0x9c,
};

/**
 * Executa uma lista de operações numa única chamada ao PowerShell (cada
 * chamada custa centenas de milissegundos).
 */
function executar(ops, opts) {
  const o = opts || {};
  const req = JSON.stringify({ processo: o.processo || PROCESSO, ops });
  let saida;
  try {
    saida = execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT], {
      input: req,
      encoding: 'utf8',
      windowsHide: true,
      timeout: o.timeout || 30000,
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (e) {
    return { ok: false, erro: 'powershell falhou: ' + (e.message || '').split('\n')[0] };
  }
  try {
    return JSON.parse(saida.trim());
  } catch (e) {
    return { ok: false, erro: 'resposta ilegível: ' + saida.slice(0, 120) };
  }
}

/** O jogo está aberto e legível? Devolve { ok, pid, base, tamanho }. */
function conectar() {
  return executar([]);
}

/** Resolve os ponteiros conhecidos por varredura de padrão. */
function resolverPonteiros(nomes) {
  const ops = (nomes || Object.keys(PADROES)).map((n) => Object.assign(
    { tipo: 'scanRel', nome: n }, PADROES[n]
  ));
  return executar(ops);
}

/** Lê `bytes` a partir de `endereco`. Devolve Buffer ou null. */
function ler(endereco, bytes) {
  const r = executar([{ tipo: 'ler', nome: 'x', endereco, bytes }]);
  if (!r.ok || !r.res || !r.res.x) return null;
  return Buffer.from(r.res.x, 'base64');
}

/** Várias leituras de uma vez: { nome: Buffer|null }. */
function lerVarios(pedidos) {
  const ops = pedidos.map((p) => ({ tipo: 'ler', nome: p.nome, endereco: p.endereco, bytes: p.bytes }));
  const r = executar(ops);
  const out = {};
  if (!r.ok) return { ok: false, erro: r.erro, res: out };
  for (const p of pedidos) {
    const v = r.res[p.nome];
    out[p.nome] = v ? Buffer.from(v, 'base64') : null;
  }
  return { ok: true, base: r.base, tamanho: r.tamanho, pid: r.pid, res: out };
}

module.exports = { executar, conectar, resolverPonteiros, ler, lerVarios, PADROES, GAME_DATA, PROCESSO };

if (require.main === module) {
  const c = conectar();
  if (!c.ok) { console.log('  jogo fechado ou ilegível: ' + (c.erro || '')); process.exitCode = 1; }
  else {
    console.log(`  sekiro.exe  pid ${c.pid}  base 0x${c.base.toString(16)}  ${(c.tamanho / 1048576).toFixed(1)} MB`);
    const p = resolverPonteiros();
    for (const [k, v] of Object.entries(p.res || {})) {
      console.log(`  ${k.padEnd(16)} ${v ? '0x' + v.alvo.toString(16) : 'não encontrado'}`);
    }
  }
}
