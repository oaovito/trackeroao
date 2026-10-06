'use strict';
/*
 * main.js - processo residente.
 *
 * Com o jogo fechado, só um poll leve (padrão 5s) verifica se o processo está
 * rodando. Com o jogo aberto, um fs.watch na pasta do save relê e processa o
 * save após cada autosave. O servidor web fica no ar o tempo todo.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const sl2 = require('./sl2');
const parse = require('./parse');
const serve = require('./serve');
const mdns = require('./mdns');
const instalacao = require('./instalacao');
const hibernar = require('./hibernar');
const jogos = require('./jogos');
const atualizar = require('./atualizar');

// --------------------------------------------------------------------- log
// Como tarefa agendada o processo roda oculto; o log espelha o console em arquivo.
const LOG_FILE = path.join(__dirname, 'trackeroao.log');
const LOG_MAX = 512 * 1024;

function rotateLog() {
  try {
    if (fs.statSync(LOG_FILE).size > LOG_MAX) {
      fs.renameSync(LOG_FILE, LOG_FILE + '.1');
    }
  } catch (e) {
    /* ainda não existe */
  }
}

const ANSI = /\x1b\[[0-9;]*m/g;

function hookConsole() {
  rotateLog();
  try {
    // BOM para o Bloco de Notas e o Get-Content lerem os acentos direito.
    if (!fs.existsSync(LOG_FILE)) fs.writeFileSync(LOG_FILE, '﻿');
  } catch (e) {
    /* segue sem log */
  }
  for (const nivel of ['log', 'error']) {
    const original = console[nivel].bind(console);
    console[nivel] = (...args) => {
      original(...args);
      try {
        const bruto = args
          .map((a) => (typeof a === 'string' ? a : require('util').inspect(a)))
          .join(' ');
        const limpo = bruto.replace(ANSI, '');
        // Ignora linhas que só continham sequências de controle do terminal.
        if (limpo.trim() === '' && bruto.length > 40) return;
        fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${limpo}\n`);
      } catch (e) {
        /* falha no log não derruba o serviço */
      }
    };
  }
}

// Processo usado quando o catálogo de jogos não pode ser lido.
const PROCESS_FALLBACK = 'sekiro.exe';
const POLL_MS = Number(process.env.SEKIRO_POLL_MS || 5000);
const DEBOUNCE_MS = Number(process.env.SEKIRO_DEBOUNCE_MS || 900);
const PORT = Number(process.env.PORT || 8777);

/**
 * Nomes anunciados por mDNS na rede local. O sufixo `.local` é o único que o
 * mDNS resolve. `trackeroao.local` é o usado pelos aplicativos do celular; os
 * demais são mantidos por compatibilidade.
 */
const NOMES_REDE = ['trackeroao.local', 'oaovito.sekiro.local', 'sekiro.local', 'oaovito.local'];

const ROOT = path.join(__dirname, '..');
const OUT_FILE = path.join(ROOT, 'progress.json');

// --------------------------------------------------------- process detection
/** Os nomes de imagem a procurar agora, relidos a cada volta do poll. */
function alvos() {
  const lista = jogos.processos();
  return lista.length ? lista : [PROCESS_FALLBACK];
}

/** Nome do processo do jogo vigiado que está aberto, ou null. */
function jogoAberto() {
  const nomes = alvos();
  if (!nomes.length) return Promise.resolve(null);

  if (process.platform === 'win32') {
    return new Promise((resolve) => {
      /*
       * Lista todos os processos e filtra aqui: vários /FI no tasklist são
       * combinados com E, não com OU. Custa ~190 ms por chamada.
       */
      execFile('tasklist', ['/NH', '/FO', 'CSV'],
        { windowsHide: true, timeout: 8000, maxBuffer: 4 * 1024 * 1024 },
        (err, stdout) => {
          if (err) return resolve(null);
          const saida = String(stdout).toLowerCase();
          // Compara com as aspas do CSV para casar só o nome exato.
          resolve(nomes.find((n) => saida.includes('"' + n + '"')) || null);
        });
    });
  }

  // Linux / Steam Deck: lê /proc diretamente.
  return new Promise((resolve) => {
    fs.readdir('/proc', (err, entries) => {
      if (err) return resolve(null);
      for (const e of entries) {
        if (!/^\d+$/.test(e)) continue;
        try {
          const comm = fs.readFileSync('/proc/' + e + '/comm', 'utf8').trim().toLowerCase();
          const achou = nomes.find((n) => comm === n || comm === n.replace(/\.exe$/, ''));
          if (achou) return resolve(achou);
        } catch (err2) {
          /* process vanished between readdir and read; ignore */
        }
      }
      resolve(null);
    });
  });
}

/** Versão booleana de jogoAberto(). */
function isGameRunning() {
  return jogoAberto().then((n) => !!n);
}

// ------------------------------------------------------------ bandeja
/*
 * Ícone na área de notificação: indica que a aplicação está aberta. Acende
 * sem janela quando um jogo vigiado começa, para não tirar o foco do jogo.
 */
let bandeja = null;

function abrirBandeja(motivo) {
  if (bandeja && !bandeja.killed) return;
  if (process.platform !== 'win32') return;
  // Instalado, usa Trackeroao.exe /bandeja; num clone, o bandeja.ps1.
  const exe = path.join(__dirname, '..', 'app', 'Trackeroao.exe');
  const script = path.join(__dirname, 'bandeja.ps1');
  const comExe = fs.existsSync(exe);
  const instalado = !fs.existsSync(path.join(__dirname, '..', '.git'));
  if (!comExe && instalado) {
    // A janela pode estar no meio de uma troca; o ícone volta com o executável.
    setTimeout(() => abrirBandeja(motivo), 5000);
    return;
  }
  if (!comExe && !fs.existsSync(script)) return;
  try {
    bandeja = comExe
      ? require('child_process').spawn(exe, ['/bandeja', '/porta=' + PORT, '/pai=' + process.pid]
        .concat(atualizandoPelaBandeja ? ['/atualizando'] : []),
        { windowsHide: false, detached: false, stdio: 'ignore' })
      : require('child_process').spawn('powershell.exe', [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
        '-File', script, '-Porta', String(PORT), '-ProcessoPai', String(process.pid),
      ], { windowsHide: true, detached: false, stdio: 'ignore' });
    bandeja.on('exit', () => { bandeja = null; });
    console.log('  [bandeja] icone aceso (' + motivo + ')');
  } catch (e) {
    console.log('  [bandeja] nao consegui acender: ' + e.message);
  }
}

function fecharBandeja() {
  if (!bandeja || bandeja.killed) return;
  try { bandeja.kill(); } catch (e) { /* ja morreu */ }
  bandeja = null;
  console.log('  [bandeja] icone apagado');
}

// A troca do .exe na atualização exige fechar o ícone da bandeja (mesmo .exe).
atualizar.aoTrocarJanela(async (trocar) => {
  const acesa = !!(bandeja && !bandeja.killed);
  fecharBandeja();
  if (acesa) await new Promise((r) => setTimeout(r, 1500));
  try { return await trocar(); } finally { if (acesa) abrirBandeja('depois da troca da janela'); }
});

// ------------------------------------------------------------- slot learning
/**
 * Guarda o checksum de cada slot. Quando só um muda entre duas leituras, esse
 * é o slot em uso pelo jogo.
 */
function learnActiveSlot(save, state) {
  const digests = {};
  for (const entry of sl2.slotEntries(save)) {
    digests[entry.index] = sl2
      .blockChecksums(save.buf, entry)
      .stored.toString('hex');
  }
  const previous = state.slotDigests;
  state.slotDigests = digests;

  if (!previous) return null;
  const changed = Object.keys(digests).filter((k) => previous[k] && previous[k] !== digests[k]);
  if (changed.length === 1) {
    const idx = Number(changed[0]);
    if (state.activeSlot !== idx) {
      state.activeSlot = idx;
      return idx;
    }
  }
  return null;
}

// ------------------------------------------------------------------ the sync
let config = parse.loadConfig();
let state = parse.loadState();
let lastWrittenHash = null;

/* --------------------------------------------------------- hibernação */

// Verifica a cada 10 min e só age após 3 confirmações seguidas e 30 min, para
// ignorar ausências temporárias (disco não montado, Steam atualizando).
const CHECAR_INSTALACAO_MS = 10 * 60 * 1000;
const CONFIRMACOES = 3;
const ESPERA_MINIMA_MS = 30 * 60 * 1000;
let ausenteDesde = null;
let ausenteVezes = 0;

function vigiarInstalacao(aoSumir) {
  const checar = () => {
    let e;
    try { e = instalacao.estado(); } catch (err) { return; }

    // Só `false` conta; `null` significa estado desconhecido.
    if (e.instalado !== false || !e.checagemValida) {
      if (ausenteVezes) console.log('  [jogo] voltou a aparecer; hibernação cancelada');
      ausenteDesde = null;
      ausenteVezes = 0;
      return;
    }

    ausenteVezes++;
    if (!ausenteDesde) {
      ausenteDesde = Date.now();
      console.log('  [jogo] não encontrei o Sekiro instalado; confirmando antes de agir');
      return;
    }
    const tempo = Date.now() - ausenteDesde;
    if (ausenteVezes < CONFIRMACOES || tempo < ESPERA_MINIMA_MS) {
      console.log(`  [jogo] segue ausente (${ausenteVezes}/${CONFIRMACOES})`);
      return;
    }
    aoSumir(e);
  };
  checar();
  const t = setInterval(checar, CHECAR_INSTALACAO_MS);
  if (t.unref) t.unref();
  return { checar, timer: t };
}

/** Guarda tudo, tira a tarefa do login e encerra o processo. */
function hibernarAgora(e) {
  console.log('');
  console.log('  O Sekiro não está mais instalado. Guardando tudo e saindo.');
  let saves = [];
  try {
    for (const s of sl2.listSavePaths()) {
      saves.push(s.file);
      if (fs.existsSync(s.file + '.bak')) saves.push(s.file + '.bak');
    }
  } catch (err) { /* sem save: guarda o resto do mesmo jeito */ }

  let r = null;
  try {
    r = hibernar.arquivar({ saves, evidencias: e.evidencias });
    console.log(`  [guardado] ${r.destino}`);
    for (const g of r.manifesto.projeto) {
      console.log(`     ${g.arquivo} — ${g.porque}`);
    }
    for (const g of r.manifesto.save) {
      console.log(`     save/${g.arquivo} — ${(g.bytes / 1048576).toFixed(1)} MB`);
    }
  } catch (err) {
    console.log(`  [guardado] FALHOU: ${err.message} — não vou remover a tarefa sem ter guardado`);
    return;                           // sem cópia, nada é desligado
  }

  const t = hibernar.removerTarefa();
  console.log(t.ok ? '  [tarefa] removida do login' : `  [tarefa] ${t.erro}`);
  console.log('');
  console.log('  Para voltar, depois de reinstalar o jogo:');
  console.log('      powershell -ExecutionPolicy Bypass -File windows\\reativar.ps1');
  console.log('');
  process.exit(0);
}

function syncNow(reason) {
  let progress;
  try {
    const file = sl2.findSavePath();
    if (!file) {
      progress = {
        generatedAt: new Date().toISOString(),
        ok: false,
        error: 'no-save-found',
        message: sl2.MENSAGEM_SEM_SAVE,
      };
    } else {
      const save = sl2.readSave(file);
      const learned = learnActiveSlot(save, state);
      if (learned !== null) {
        console.log(`  [slot] o jogo está gravando no slot ${learned}; usando esse a partir de agora`);
      }
      parse.saveState(state);
      // observe: só o processo residente acompanha as gravações em sequência,
      // o que alimenta a busca do contador de mortes.
      progress = parse.buildProgress({ config, state, file, save, observe: true });
    }
  } catch (err) {
    progress = {
      generatedAt: new Date().toISOString(),
      ok: false,
      error: 'read-failed',
      message: err.message,
    };
  }

  // Uma falha mantém o último resultado bom; o hash é do que será gravado.
  progress = parse.finalizeProgress(OUT_FILE, progress);

  // Skip the write when nothing changed apart from the timestamp.
  const body = JSON.stringify(progress);
  const hash = crypto.createHash('md5').update(body.replace(/"generatedAt":"[^"]*"/, '')).digest('hex');
  if (hash === lastWrittenHash) return;
  lastWrittenHash = hash;

  parse.writeProgress(OUT_FILE, progress);
  const stamp = new Date().toLocaleTimeString();
  if (progress.ok) {
    const e = progress.essentials;
    const dead = progress.bosses.filter((b) => b.defeated).length;
    console.log(
      `  [${stamp}] ${reason}: slot ${progress.source.slot}, ` +
        `${e.prayerBeads.collected}/${e.prayerBeads.totalInGame} contas, ` +
        `${e.gourdSeeds.held} semente(s), ${dead} chefe(s) com memória`
    );
  } else {
    console.log(`  [${stamp}] ${reason}: ${progress.message || progress.error}`);
  }
  const recentes = (progress.history || []).filter((h) => h.at === progress.generatedAt);
  for (const r of recentes) console.log(`  [novo] ${r.tipo}: ${r.label} - ${r.texto}`);
  if (progress.stale) {
    console.log(`  [aviso] save indisponivel (${progress.stale.error}); servindo a leitura de ${progress.stale.leituraDe}`);
  }
}

// -------------------------------------------------------------- the watcher
let watcher = null;
let debounceTimer = null;

function startWatching() {
  if (watcher) return;
  const file = sl2.findSavePath();
  if (!file) {
    console.log('  [watch] jogo aberto, mas não achei o save ainda');
    return;
  }
  const dir = path.dirname(file);
  const base = path.basename(file);
  try {
    // Watch the directory so replacing the save file is also detected.
    watcher = fs.watch(dir, { persistent: true }, (eventType, filename) => {
      if (filename && path.basename(filename) !== base) return;
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => syncNow('autosave'), DEBOUNCE_MS);
    });
    watcher.on('error', () => stopWatching());
    console.log(`  [watch] monitorando ${file}`);
  } catch (err) {
    console.log(`  [watch] não consegui monitorar: ${err.message}`);
    watcher = null;
  }
}

function stopWatching() {
  if (!watcher) return;
  try {
    watcher.close();
  } catch (e) {
    /* already gone */
  }
  watcher = null;
  clearTimeout(debounceTimer);
  debounceTimer = null;
  console.log('  [watch] parado (nenhum handle aberto no save)');
}

// ------------------------------------------------------------------ a rede
/*
 * O serviço pode subir antes de a rede ter IP. O endereço é vigiado e, quando
 * aparece ou muda, o mDNS reanuncia e o log registra.
 */
let ultimoIp = null;

/** `obterUrl` permite testar as transições; o padrão é serve.lanUrl. */
function vigiarRede(obterUrl, intervalo, aoMudar) {
  const fonte = obterUrl || (() => serve.lanUrl(PORT));
  const avisar = (ip) => { try { if (aoMudar) aoMudar(ip); } catch (e) { /* gancho não derruba o watcher */ } };
  const checar = () => {
    let url = null;
    try {
      url = fonte();
    } catch (e) {
      return;
    }
    const ip = url ? url.replace(/^http:\/\/([^:]+).*$/, '$1') : null;
    if (ip === ultimoIp) return;

    if (!ip) {
      console.log('  [rede] sem IP de rede local no momento - só localhost');
      ultimoIp = null;
      avisar(null);
      return;
    }
    const antes = ultimoIp;
    ultimoIp = ip;
    console.log(
      antes
        ? `  [rede] o IP mudou de ${antes} para ${ip}`
        : `  [rede] disponível na rede: ${url}`
    );
    avisar(ip);
  };
  checar();
  const t = setInterval(checar, intervalo || 15000);
  if (t.unref && intervalo) t.unref();
  return { checar, timer: t };
}

// ------------------------------------------------------------------ the loop
let gameWasRunning = null;

async function pollOnce() {
  let qual = null;
  try {
    qual = await jogoAberto();
  } catch (e) {
    qual = null;
  }
  const running = !!qual;

  if (running !== gameWasRunning) {
    gameWasRunning = running;
    if (running) {
      const g = jogos.porProcesso(qual);
      const nome = g ? g.nome : qual;
      if (g) jogos.marcarAberto(g.chave);
      console.log('\n  >> ' + nome + ' aberto - sincronização ativa');
      abrirBandeja(nome);
      startWatching();
      syncNow('jogo aberto');
    } else {
      console.log('\n  >> jogo fechado - só o poll leve continua rodando');
      stopWatching();
      // Última leitura da sessão; o ícone da bandeja continua aceso.
      syncNow('jogo fechado');
      // Atualização pendente roda na próxima volta.
      conferirLogo();
    }
  }
}

/* ------------------------------------------------------- atualização */

// Primeira verificação após a rede ter tempo de subir.
const ATUALIZAR_PRIMEIRA_MS = 20 * 1000;
// 12 consultas por hora cabem na cota anônima da API do GitHub.
const ATUALIZAR_MS = 5 * 60 * 1000;
const ATUALIZAR_ERRO_MS = 5 * 60 * 1000;
let proximaAtualizacao = Date.now() + ATUALIZAR_PRIMEIRA_MS;
// Acionada pelo menu da bandeja: roda na próxima volta, mesmo com jogo aberto.
let atualizacaoForcada = false;
// Mantém o ícone da bandeja com o anel de progresso até a atualização terminar.
let atualizandoPelaBandeja = false;
function pedirAtualizacao() { atualizacaoForcada = true; atualizandoPelaBandeja = true; proximaAtualizacao = 0; }
// Antecipa a verificação para a próxima volta (ainda espera o jogo fechar).
function conferirLogo() { proximaAtualizacao = Math.min(proximaAtualizacao, Date.now()); }

/**
 * Atualização silenciosa, executada dentro do ciclo, entre duas voltas.
 * Não roda com jogo aberto (salvo se acionada pela bandeja); saída só no log.
 */
async function passoDeAtualizacao() {
  if (gameWasRunning && !atualizacaoForcada) return;
  if (Date.now() < proximaAtualizacao) return;
  if (atualizacaoForcada) console.log('  [atualizacao] pedida pela bandeja');
  atualizacaoForcada = false;
  const r = await atualizar.verificar();
  if (r.atualizou) {
    console.log(`  [atualizacao] ${r.de || 'versão anterior'} -> ${r.para}; reiniciando em silêncio`);
    reiniciar();
    return;
  }
  atualizandoPelaBandeja = false;
  if (r.erro) console.log('  [atualizacao] não conferiu: ' + r.erro);
  else if (r.motivo) console.log('  [atualizacao] ' + r.motivo);
  proximaAtualizacao = Date.now() + (r.erro ? ATUALIZAR_ERRO_MS : ATUALIZAR_MS);
}

// Varredura de jogos (biblioteca.js): na partida e uma vez por dia, entre
// duas voltas e nunca com jogo aberto.
const VARRER_PRIMEIRA_MS = 45 * 1000;
const VARRER_MS = 24 * 60 * 60 * 1000;
let proximaVarredura = Date.now() + VARRER_PRIMEIRA_MS;
function pedirVarredura() { proximaVarredura = 0; }

// Vigia as pastas de instalação para antecipar a varredura; refeito a cada
// varredura, pois a lista de bibliotecas pode mudar.
let pararVigiasDeJogo = null;
function vigiarJogosNovos() {
  if (pararVigiasDeJogo) pararVigiasDeJogo();
  try {
    pararVigiasDeJogo = require('./biblioteca').vigiarInstalacoes(() => {
      proximaVarredura = Math.min(proximaVarredura, Date.now());
    });
  } catch (e) { pararVigiasDeJogo = null; }
}

async function passoDeVarredura() {
  if (gameWasRunning || Date.now() < proximaVarredura) return;
  proximaVarredura = Date.now() + VARRER_MS;
  try {
    const r = await require('./biblioteca').varrer();
    console.log(`  [jogos] ${r.jogos.length} jogo(s) encontrados${r.comSteam ? '' : ', sem Steam'}`);
  } catch (e) {
    console.log('  [jogos] a varredura falhou: ' + e.message);
  }
  vigiarJogosNovos();
}

/**
 * Reinicia o processo com o código atualizado. TRACKEROAO_REINICIO faz o novo
 * processo insistir na porta enquanto este a libera.
 */
function reiniciar() {
  // Repassa o estado do ícone da bandeja ao novo processo.
  const acesa = !!(bandeja && !bandeja.killed);
  fecharBandeja();
  const filho = require('child_process').spawn(process.execPath, process.argv.slice(1), {
    cwd: ROOT, detached: true, stdio: 'ignore', windowsHide: true,
    env: Object.assign({}, process.env, { TRACKEROAO_REINICIO: '1' }, acesa ? { TRACKEROAO_BANDEJA: '1' } : {}),
  });
  filho.unref();
  process.exit(0);
}

// Enquanto existir, o serviço não sobe sozinho; removido na abertura manual.
const FECHADO = path.join(__dirname, 'fechado.flag');

function encerrarDeVez() {
  try { fs.writeFileSync(FECHADO, new Date().toISOString()); } catch (e) { /* sai mesmo assim */ }
  // Descarta solicitação de abertura pendente.
  try { fs.unlinkSync(PEDIDO); } catch (e) { /* nao havia */ }
  console.log('  [fechar] fechado pela bandeja; só volta aberto à mão');
  process.exit(0);
}

/*
 * No logon o serviço só sobe se iniciar-com-windows.flag existir. A abertura
 * manual grava abrir.pedido (válido por 2 min) antes de disparar a tarefa.
 * Reinício de atualização sempre sobe; fechado.flag bloqueia até nova abertura.
 */
const PEDIDO = path.join(__dirname, 'abrir.pedido');
const COM_WINDOWS = path.join(__dirname, 'iniciar-com-windows.flag');

function podeSubir(reinicio) {
  // Fora do Windows, ou com `--manual` (npm start), sempre sobe.
  if (process.platform !== 'win32' || process.argv.includes('--manual')) return true;
  const idade = (f) => { try { return Date.now() - fs.statSync(f).mtimeMs; } catch (e) { return Infinity; } };
  // abrir.pedido recente e posterior ao último fechamento.
  if (idade(PEDIDO) < 2 * 60 * 1000 && idade(PEDIDO) < idade(FECHADO)) {
    try { fs.unlinkSync(PEDIDO); } catch (e) { /* ja foi */ }
    try { fs.unlinkSync(FECHADO); } catch (e) { /* nao havia */ }
    return true;
  }
  if (reinicio) return true;
  const ligado = require('os').uptime() * 1000;
  if (idade(FECHADO) < ligado) return false;
  return fs.existsSync(COM_WINDOWS);
}

async function run() {
  const reinicio = !!process.env.TRACKEROAO_REINICIO;
  if (!podeSubir(reinicio)) process.exit(0);
  const bandejaAcesa = !!process.env.TRACKEROAO_BANDEJA;
  delete process.env.TRACKEROAO_REINICIO;
  delete process.env.TRACKEROAO_BANDEJA;
  hookConsole();
  console.log('');
  console.log('  Sekiro - sincronização de progresso');
  console.log('  (somente leitura: este programa nunca escreve no save do jogo)');
  console.log('');

  // Exceções não tratadas são registradas sem derrubar o servidor.
  process.on('uncaughtException', (err) => {
    console.error('  [erro] exceção não tratada:', err && err.stack ? err.stack : err);
  });
  process.on('unhandledRejection', (err) => {
    console.error('  [erro] promessa rejeitada:', err && err.stack ? err.stack : err);
  });

  const saves = sl2.listSavePaths();
  if (saves.length) {
    for (const s of saves) console.log(`  save encontrado: ${s.file}`);
  } else {
    console.log('  Nenhum save encontrado ainda - vou procurar de novo a cada varredura.');
  }

  // One read at startup so the page has data even with the game closed.
  syncNow('leitura inicial');

  try {
    // Após reinício, tenta de novo enquanto o processo anterior libera a porta.
    for (let tentativa = 1; ; tentativa++) {
      try {
        await serve.start({
          root: ROOT, port: PORT, indexFile: 'trackeroao.html', quiet: true,
          aoAbrir: () => { abrirBandeja('atalho'); conferirLogo(); },
          aoVarrer: () => pedirVarredura(),
          aoAtualizar: () => pedirAtualizacao(),
          aoEncerrar: () => encerrarDeVez(),
        });
        break;
      } catch (e) {
        if (!reinicio || e.code !== 'EADDRINUSE' || tentativa >= 20) throw e;
        await new Promise((r) => setTimeout(r, 250));
      }
    }
  } catch (err) {
    if (err && err.code === 'EADDRINUSE') {
      console.error(`\n  A porta ${PORT} já está ocupada.`);
      console.error(`  Feche o outro processo, ou escolha outra porta:`);
      console.error(`      set PORT=8888 && npm start        (Windows)`);
      console.error(`      PORT=8888 npm start               (Linux)\n`);
    } else {
      console.error('\n  Não consegui subir o servidor:', err.message, '\n');
    }
    process.exit(1);
  }

  // Porta 80 opcional, para um endereço sem ":8777".
  const extra = await serve.listenExtra({ root: ROOT, port: 80, indexFile: 'trackeroao.html' });
  if (extra.ok) console.log('  [http] também na porta 80');
  else console.log(`  [http] porta 80 indisponível (${extra.error}); o endereço sai com :${PORT}`);

  // Nome na rede local via mDNS.
  const nomeador = mdns.responder({
    nomes: NOMES_REDE,
    obterIp: () => {
      const a = serve.localAddresses();
      return a.length ? a[0].address : null;
    },
    log: (m) => console.log('  ' + m),
  });

  if (nomeador.ativo()) {
    const porta = extra.ok ? '' : ':' + PORT;
    console.log('');
    console.log('  No celular, no mesmo Wi-Fi:');
    console.log(`      http://trackeroao.local${porta}`);
    console.log('');
  }

  // O ícone da bandeja fica aceso enquanto o serviço estiver no ar.
  abrirBandeja(bandejaAcesa ? 'depois da atualização' : 'início');

  vigiarRede(null, null, (novo) => nomeador.ipMudou(novo));
  vigiarInstalacao(hibernarAgora);
  vigiarJogosNovos();

  // Logotipos baixados por versões antigas para a bandeja, que hoje usa o ícone do jogo.
  try { fs.rmSync(path.join(__dirname, 'cache', 'logos'), { recursive: true, force: true }); } catch (e) { /* em uso */ }

  // Remove pastas legadas que ficaram vazias.
  const varridas = atualizar.varrerPastasVazias(null, atualizar.PASTAS_LEGADO);
  if (varridas.length) console.log('  [atualizar] pastas vazias removidas: ' + varridas.join(', '));

  // Reagenda ao fim de cada volta, para a atualização e a varredura caberem
  // entre duas voltas sem sobreposição.
  let timer = null;
  const ciclo = async () => {
    try {
      await pollOnce();
      await passoDeAtualizacao();
      await passoDeVarredura();
    } catch (e) {
      console.error('  [erro] no ciclo:', e && e.message ? e.message : e);
    }
    timer = setTimeout(ciclo, POLL_MS);
  };
  await ciclo();

  const shutdown = () => {
    clearTimeout(timer);
    stopWatching();
    console.log('\n  Encerrando.');
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) {
  run().catch((err) => {
    console.error('Erro fatal:', err);
    process.exit(1);
  });
}

module.exports = { isGameRunning, jogoAberto, alvos, learnActiveSlot, syncNow, vigiarRede, vigiarInstalacao };
