'use strict';
/*
 * efeitos.js - efeitos temporários acionados por eventos da sessão.
 *
 * Gatilhos declarados em tabela: fogo no anel por 6 h após duas conquistas
 * na sessão; podridão no bloco de mortes por 6 h após cinco mortes.
 *
 * A sessão é identificada pelo pid do jogo. Um efeito aceso continua até
 * vencer, mesmo com o jogo fechado. Publica-se o tempo restante, não o horário.
 */

const fs = require('fs');
const path = require('path');

const ESTADO = path.join(__dirname, '..', 'efeitos.json');
const SEIS_HORAS = 6 * 60 * 60 * 1000;

/**
 * `medir` devolve o acumulado na sessão atual; `limiar` é onde acende;
 * `duracao` conta a partir do cruzamento do limiar.
 */
const EFEITOS = {
  // Cinco mortes na sessão: podridão (竜咳).
  podridao: {
    limiar: 5,
    duracao: SEIS_HORAS,
    medir: (agora) => (typeof agora.mortesNaSessao === 'number' ? agora.mortesNaSessao : null),
  },
  // Duas conquistas na sessão: fogo no anel.
  fogo: {
    limiar: 2,
    duracao: SEIS_HORAS,
    medir: (agora, inicio) => {
      if (typeof agora.conquistas !== 'number') return null;
      if (typeof inicio.conquistas !== 'number') return 0;
      return Math.max(0, agora.conquistas - inicio.conquistas);
    },
  },
};

function carregar() {
  try { return JSON.parse(fs.readFileSync(ESTADO, 'utf8')); } catch (e) { return null; }
}

function gravar(e) {
  const tmp = ESTADO + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(e, null, 1));
  fs.renameSync(tmp, ESTADO);
}

/**
 * Atualiza o estado e devolve os efeitos acesos. `agora` traz
 * `{ pid, mortesNaSessao, conquistas }`; `pid` nulo = jogo fechado.
 */
function atualizar(agora, quando) {
  const t = quando || Date.now();
  const e = carregar() || { sessao: null, inicio: {}, ate: {} };

  // Sessão nova: as medidas partem do estado atual.
  if (agora.pid && e.sessao !== agora.pid) {
    e.sessao = agora.pid;
    e.inicio = { conquistas: agora.conquistas, em: new Date(t).toISOString() };
  }
  if (!agora.pid) e.sessao = null;

  const aceso = {};
  for (const [nome, cfg] of Object.entries(EFEITOS)) {
    const ate = e.ate[nome] ? new Date(e.ate[nome]).getTime() : 0;

    // Só acende com o jogo aberto.
    if (agora.pid) {
      const quanto = cfg.medir(agora, e.inicio || {});
      // Novo acionamento renova a duração.
      if (typeof quanto === 'number' && quanto >= cfg.limiar) {
        e.ate[nome] = new Date(t + cfg.duracao).toISOString();
      }
    }

    const fim = e.ate[nome] ? new Date(e.ate[nome]).getTime() : 0;
    const resta = Math.max(0, Math.round((fim - t) / 1000));
    if (resta > 0) aceso[nome] = resta;
    else if (e.ate[nome] && fim <= t) delete e.ate[nome];   // venceu: some do estado
  }

  gravar(e);
  return aceso;
}

/** O que está aceso agora, sem mexer no estado. */
function ativos(quando) {
  const t = quando || Date.now();
  const e = carregar();
  if (!e || !e.ate) return {};
  const aceso = {};
  for (const [nome, iso] of Object.entries(e.ate)) {
    const resta = Math.max(0, Math.round((new Date(iso).getTime() - t) / 1000));
    if (resta > 0) aceso[nome] = resta;
  }
  return aceso;
}

module.exports = { atualizar, ativos, carregar, EFEITOS, ESTADO, SEIS_HORAS };
