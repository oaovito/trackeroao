'use strict';
/*
 * hibernar.js - desliga o serviço quando o jogo é desinstalado.
 *
 * Remove a tarefa agendada e encerra o processo, mas antes guarda o progresso,
 * as calibrações e uma cópia do save. Nada é apagado. Para voltar, use
 * reativar.ps1.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const RAIZ = path.join(__dirname, '..');
const ARQUIVO = path.join(RAIZ, 'arquivo');
// Nomes da tarefa agendada: o atual e o legado `SekiroProgressSync`.
const TAREFA = 'TrackeroaoSync';
const TAREFAS = [TAREFA, 'SekiroProgressSync'];

/** Arquivos do projeto que valem a pena guardar, e por quê. */
const GUARDAR = [
  ['progress.json', 'a última leitura boa do progresso'],
  ['deaths.json', 'o que a busca do contador de mortes já descobriu'],
  ['sync/offsets.json', 'os offsets e nomes verificados'],
  ['sync/.state.json', 'qual slot é o seu'],
];

function copiar(de, para) {
  fs.mkdirSync(path.dirname(para), { recursive: true });
  fs.copyFileSync(de, para);
  return fs.statSync(para).size;
}

/**
 * Guarda tudo numa pasta nova, nomeada pela data. Devolve o relatório.
 */
function arquivar(opts) {
  const o = opts || {};
  const quando = new Date();
  const base = quando.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  // Evita colisão de duas hibernações no mesmo segundo.
  const raizArquivo = o.destino || ARQUIVO;
  let nome = base;
  let n = 2;
  while (fs.existsSync(path.join(raizArquivo, nome))) nome = `${base}-${n++}`;
  const destino = path.join(raizArquivo, nome);
  fs.mkdirSync(destino, { recursive: true });

  const guardados = [];
  for (const [rel, porque] of GUARDAR) {
    const de = path.join(RAIZ, rel);
    try {
      if (!fs.existsSync(de)) continue;
      const bytes = copiar(de, path.join(destino, 'projeto', rel));
      guardados.push({ arquivo: rel, bytes, porque });
    } catch (e) {
      guardados.push({ arquivo: rel, erro: e.message, porque });
    }
  }

  // Cópia do save.
  const saves = [];
  for (const s of (o.saves || [])) {
    try {
      if (!fs.existsSync(s)) continue;
      const bytes = copiar(s, path.join(destino, 'save', path.basename(s)));
      saves.push({ arquivo: path.basename(s), bytes });
    } catch (e) {
      saves.push({ arquivo: path.basename(s), erro: e.message });
    }
  }

  const manifesto = {
    hibernadoEm: quando.toISOString(),
    motivo: o.motivo || 'Sekiro não está mais instalado nesta máquina',
    evidencias: o.evidencias || [],
    projeto: guardados,
    save: saves,
    comoVoltar: 'Reinstale o Sekiro e rode: powershell -ExecutionPolicy Bypass -File windows\\reativar.ps1',
    observacao:
      'Nada foi apagado. Esta pasta é cópia. O save original segue em %APPDATA%\\Sekiro ' +
      'se ninguém o removeu, e a cópia aqui existe para o caso de ele ter sido removido.',
  };
  fs.writeFileSync(path.join(destino, 'manifesto.json'), JSON.stringify(manifesto, null, 2));
  return { destino, manifesto };
}

/** Remove a tarefa agendada do logon. */
function removerTarefa() {
  const removidas = [];
  for (const nome of TAREFAS) {
    try {
      execFileSync('schtasks', ['/Delete', '/TN', nome, '/F'],
        { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      removidas.push(nome);
    } catch (e) { /* esta não existe nesta máquina; a outra pode existir */ }
  }
  if (!removidas.length) {
    return { ok: false, erro: 'a tarefa não existia ou não pôde ser removida' };
  }
  return { ok: true, removidas };
}

module.exports = { arquivar, removerTarefa, ARQUIVO, TAREFA, TAREFAS, GUARDAR };
