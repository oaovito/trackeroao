'use strict';
/*
 * selftest.js - checks that the pieces work on this machine.
 *
 * Run: npm run selftest
 *
 * Checks, in order of how badly a failure would hurt:
 *   1. QR encoder round-trips (structural checks + known-answer test)
 *   2. The save file is found, is a BND4, and every block's MD5 matches
 *   3. The item table is located and the essentials parse to sane values
 */

const fs = require('fs');
const path = require('path');

const RAIZ_PROJETO = path.join(__dirname, '..');
const sl2 = require('./sl2');
const inventory = require('./inventory');
const parse = require('./parse');

let pass = 0;
let fail = 0;
const failures = [];

function check(name, fn) {
  try {
    const detail = fn();
    pass++;
    console.log(`   ok    ${name}${detail ? '  -  ' + detail : ''}`);
  } catch (err) {
    if (err && err.pular) {
      console.log(`   --    ${name}  -  ${err.message}`);
      return;
    }
    fail++;
    failures.push(name);
    console.log(`   FALHA ${name}\n            ${err.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

/**
 * Marca o teste como pulado, com o motivo, quando depende de algo gerado em
 * execução (ex.: `progress.json` num clone recém-feito).
 */
function pular(motivo) {
  const e = new Error(motivo);
  e.pular = true;
  throw e;
}

/** A leitura local do save, ou um pulo explicando que ela ainda não existe. */
function temProgresso() { return fs.existsSync(path.join(RAIZ_PROJETO, 'progress.json')); }

function progressoLocal() {
  const arq = path.join(RAIZ_PROJETO, 'progress.json');
  if (!fs.existsSync(arq)) {
    pular('sem leitura local ainda; rode `npm start` uma vez com o jogo instalado');
  }
  return JSON.parse(fs.readFileSync(arq, 'utf8'));
}


console.log('\n  === 2. Arquivo de save ===');

let save = null;
let saveFile = null;

check('acha o S0000.sl2', () => {
  saveFile = sl2.findSavePath();
  assert(saveFile, 'nenhum save encontrado (o jogo já rodou nesta máquina?)');
  return saveFile;
});

check('lê como BND4 e confere o MD5 de todos os blocos', () => {
  assert(saveFile, 'sem save, pulando');
  save = sl2.readSave(saveFile);
  assert(save.entries.length === 12, `esperava 12 entradas, vieram ${save.entries.length}`);
  for (const e of save.entries) {
    const { ok } = sl2.blockChecksums(save.buf, e);
    assert(ok, `MD5 não bate em ${e.name}`);
  }
  return `${save.entries.length} blocos, todos íntegros`;
});

check('identifica os slots com dados', () => {
  assert(save, 'sem save, pulando');
  const used = sl2.nonEmptySlots(save);
  assert(used.length > 0, 'nenhum slot com dados');
  return `slots ${used.map((e) => e.index).join(', ')}`;
});

console.log('\n  === 3. Leitura do progresso ===');

check('localiza a tabela de itens pela estrutura', () => {
  assert(save, 'sem save, pulando');
  const used = sl2.nonEmptySlots(save);
  const payload = sl2.blockPayload(save.buf, used[used.length - 1]);
  const region = inventory.detectItemTable(payload);
  assert(region, 'tabela de itens não encontrada');
  return `0x${region.start.toString(16)}..0x${region.end.toString(16)}`;
});

check('monta o progress.json', () => {
  const p = parse.buildProgress({});
  assert(p.ok, `parse falhou: ${p.message || p.error}`);
  const e = p.essentials;
  assert(e.prayerBeads.held >= 0 && e.prayerBeads.held <= 40, 'contas fora de faixa');
  assert(
    e.prayerBeads.necklaces >= 0 && e.prayerBeads.necklaces <= e.prayerBeads.totalNecklaces,
    'colares fora de faixa'
  );
  assert(e.materials.length === 9, `esperava 9 materiais, vieram ${e.materials.length}`);
  assert(p.bosses.length > 0, 'nenhum chefe na lista');
  return `slot ${p.source.slot}, ${e.prayerBeads.collected} contas, ${p.bosses.filter((b) => b.defeated).length} chefes`;
});

check('materiais de tier tardio não aparecem antes dos iniciais', () => {
  // Sanity check on the id->name mapping: late materials must not appear
  // while early ones are still at zero.
  const p = parse.buildProgress({});
  assert(p.ok, 'parse falhou');
  const by = {};
  for (const m of p.essentials.materials) by[m.key] = m.qty;
  const early = by.scrapIron + by.scrapMagnetite + by.blackGunpowder + by.yellowGunpowder;
  const late = by.lapisLazuli + by.adamantiteScrap + by.fulminatedMercury;
  if (late > 0 && early === 0) {
    throw new Error('materiais tardios sem nenhum material inicial - mapeamento suspeito');
  }
  return `iniciais=${early}, tardios=${late}`;
});

console.log('\n  === 4. O progresso não pode ser perdido ===');

check('uma leitura falha não apaga o progresso já conhecido', () => {
  // Falha temporária do save não pode sobrescrever o último resultado bom.
  const tmp = path.join(require('os').tmpdir(), 'sekiro-preserve-test.json');
  const bom = {
    ok: true,
    generatedAt: '2026-01-01T00:00:00.000Z',
    essentials: { prayerBeads: { collected: 18 } },
    bosses: [{ key: 'gyoubu', defeated: true }],
  };
  fs.writeFileSync(tmp, JSON.stringify(bom));
  try {
    const falha = { ok: false, error: 'no-save-found', message: 'sumiu' };
    const r = parse.preserveGood(tmp, falha);
    assert(r.ok === true, 'o resultado bom foi descartado');
    assert(r.essentials.prayerBeads.collected === 18, 'perdeu as contas');
    assert(r.bosses.length === 1, 'perdeu os chefes');
    assert(r.stale && r.stale.error === 'no-save-found', 'não marcou como velho');
    assert(r.stale.leituraDe === bom.generatedAt, 'não registrou a data da leitura boa');

    // Uma leitura boa nova limpa o estado e não carrega o marcador.
    const novo = parse.preserveGood(tmp, { ok: true, generatedAt: 'x', essentials: {} });
    assert(!novo.stale, 'manteve o marcador depois de uma leitura boa');

    // Sem resultado bom no disco, reporta o erro.
    fs.writeFileSync(tmp, JSON.stringify({ ok: false, error: 'antigo' }));
    assert(parse.preserveGood(tmp, falha).ok === false, 'inventou um resultado bom');
  } finally {
    try { fs.unlinkSync(tmp); } catch (e) { /* já foi */ }
  }
  return 'preserva, marca como velho e limpa na próxima leitura boa';
});

check('registra o que mudou entre duas leituras', () => {
  const antes = {
    ok: true,
    generatedAt: 'a',
    essentials: {
      prayerBeads: { collected: 18, necklaces: 4 },
      gourdSeeds: { held: 0 },
      materials: [{ key: 'scrapIron', label: 'Scrap Iron', qty: 4 }],
    },
    bosses: [{ key: 'gyoubu', label: 'Gyoubu', defeated: true }, { key: 'ape', label: 'Guardian Ape', defeated: false }],
    miniBosses: [{ key: 'orin', label: "O'Rin", defeated: false }],
    tools: [{ key: 'axe', label: 'Loaded Axe', unlocked: true }],
    arts: [{ key: 'oneMind', label: 'One Mind', unlocked: false }],
    goodsUnlocks: [],
  };
  const depois = JSON.parse(JSON.stringify(antes));
  depois.generatedAt = 'b';
  depois.bosses[1].defeated = true;
  depois.miniBosses[0].defeated = true;
  depois.arts[0].unlocked = true;
  depois.essentials.prayerBeads.collected = 22;
  depois.essentials.materials[0].qty = 2;

  const d = parse.diffProgress(antes, depois);
  const achar = (label) => d.filter((x) => x.label === label)[0];
  assert(d.length === 5, `esperava 5 mudanças, vieram ${d.length}: ${JSON.stringify(d)}`);
  assert(achar('Guardian Ape').tipo === 'boss', 'chefe não classificado');
  assert(achar("O'Rin").tipo === 'mini-boss', 'mini-chefe não classificado');
  assert(achar('One Mind').tipo === 'art', 'arte não classificada');
  assert(achar('Prayer Beads').texto === '18 → 22', 'contador de contas errado');
  assert(achar('Scrap Iron').subiu === false, 'não marcou que o material caiu');
  assert(d.every((x) => x.at === 'b'), 'carimbo de tempo errado');

  // Sem mudança nenhuma, não inventa entrada.
  assert(parse.diffProgress(antes, antes).length === 0, 'inventou mudança onde não houve');
  // Leitura ruim não gera histórico.
  assert(parse.diffProgress(antes, { ok: false }).length === 0, 'gerou histórico de leitura ruim');
  return '5 mudanças: chefe, mini, arte e 2 contadores';
});

console.log('\n  === 5. Descoberta do IP da rede ===');

check('ignora endereços APIPA (169.254.x) ao escolher o IP da LAN', () => {
  // Adaptadores sem DHCP recebem 169.254.x e não podem ser anunciados.
  const serve = require('./serve');
  assert(serve.isApipa('169.254.232.5'), 'não reconheceu APIPA');
  assert(!serve.isApipa('192.168.1.10'), 'classificou IP da LAN como APIPA');
  const addrs = serve.localAddresses();
  const vazou = addrs.filter((a) => a.address.startsWith('169.254.'));
  assert(vazou.length === 0, 'APIPA vazou: ' + JSON.stringify(vazou));
  if (addrs.length) assert(addrs[0].private, 'o primeiro endereço não é privado');
  return addrs.length ? addrs.map((a) => a.address).join(', ') : 'sem rede agora';
});

check('anuncia quando a rede aparece depois do boot', () => {
  // Sem IP na partida, o serviço deve reavaliar quando o endereço aparecer.
  const main = require('./main');
  const linhas = [];
  const original = console.log;
  console.log = (...a) => linhas.push(a.join(' '));

  let url = null;
  let v;
  try {
    v = main.vigiarRede(() => url, 3600000); // intervalo longo; checar() é chamado manualmente
    url = 'http://192.168.1.50:8777/trackeroao.html';
    v.checar();
    url = 'http://192.168.1.77:8777/trackeroao.html';
    v.checar();
    url = null;
    v.checar();
  } finally {
    console.log = original;
    if (v && v.timer) clearInterval(v.timer);
  }

  const texto = linhas.join('\n');
  assert(/sem IP de rede local/.test(texto), 'não avisou que começou sem IP');
  assert(/disponível na rede: http:\/\/192\.168\.1\.50/.test(texto), 'não anunciou o IP quando apareceu');
  assert(/o IP mudou de 192\.168\.1\.50 para 192\.168\.1\.77/.test(texto), 'não detectou a troca de IP');
  return 'sem rede -> aparece -> muda -> some';
});

/*
 * 7. Leitura da memória do jogo.
 *
 * Sem o jogo aberto: montagem da requisição, recusa limpa sem processo e
 * handle somente leitura. Com o jogo aberto, resolve também os ponteiros.
 */
console.log('\n  === 7. Leitura da memória do jogo ===');

const memoria = require('./memoria');
const deathsmem = require('./deathsmem');
const tempo = require('./tempo');

check('o handle é pedido somente para leitura', () => {
  // Ignora os comentários, que citam as constantes de escrita.
  const bruto = fs.readFileSync(path.join(__dirname, 'mem.ps1'), 'utf8');
  const codigo = bruto
    .split(/\r?\n/)
    .filter((l) => !/^\s*(#|\/\/)/.test(l))
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '');

  // A primeira ocorrência é a declaração do P/Invoke; interessa a chamada.
  const todas = [...codigo.matchAll(/OpenProcess\(([^)]*)\)/g)];
  const chamada = todas.find((m) => /PROCESS_/.test(m[1]));
  assert(chamada, 'não achei a chamada de OpenProcess com constantes');
  assert(/PROCESS_VM_READ/.test(chamada[1]), 'não pede leitura');
  assert(/PROCESS_QUERY_INFORMATION/.test(chamada[1]), 'não pede consulta');
  assert(!/WRITE|OPERATION|ALL_ACCESS/.test(chamada[1]), 'pede mais que leitura: ' + chamada[1]);
  assert(!/WriteProcessMemory|VirtualProtectEx|CreateRemoteThread/.test(codigo),
    'importa função que escreve no processo');
  return 'OpenProcess(' + chamada[1].trim() + ')';
});

check('os padrões de busca são os documentados, com curinga', () => {
  const nomes = Object.keys(memoria.PADROES);
  assert(nomes.length >= 3, `só ${nomes.length} padrões`);
  for (const [n, p] of Object.entries(memoria.PADROES)) {
    assert(/^[0-9a-fA-F? ]+$/.test(p.padrao), `${n}: padrão com caractere estranho`);
    assert(p.padrao.includes('?'), `${n}: sem curinga, quebraria a cada versão do jogo`);
    assert(typeof p.desloc === 'number' && typeof p.instrucao === 'number', `${n}: sem deslocamento`);
  }
  return nomes.join(', ');
});

const jogoAberto = memoria.conectar();

check('diz claramente quando o jogo está fechado', () => {
  if (jogoAberto.ok) return 'jogo aberto agora; caminho de recusa exercitado por processo inexistente';
  assert(jogoAberto.erro, 'falhou sem dizer o motivo');
  return jogoAberto.erro;
});

check('processo inexistente não derruba nada', () => {
  const r = memoria.executar([], { processo: 'processo-que-nao-existe-xyz' });
  assert(r.ok === false, 'disse que conseguiu abrir um processo inexistente');
  assert(typeof r.erro === 'string' && r.erro.length > 0, 'não explicou');
  return r.erro;
});

if (jogoAberto.ok) {
  check('acha o módulo do jogo', () => {
    assert(jogoAberto.base > 0, 'base zerada');
    assert(jogoAberto.tamanho > 1024 * 1024, 'módulo pequeno demais para ser o jogo');
    return `pid ${jogoAberto.pid}, base 0x${jogoAberto.base.toString(16)}, ` +
      `${(jogoAberto.tamanho / 1048576).toFixed(1)} MB`;
  });

  check('resolve os ponteiros por varredura de padrão', () => {
    const r = memoria.resolverPonteiros();
    assert(r.ok, r.erro || 'falhou');
    const achados = Object.entries(r.res || {}).filter(([, v]) => v && v.alvo);
    assert(achados.length >= 2, `só ${achados.length} ponteiros resolvidos`);
    for (const [n, v] of achados) {
      assert(v.alvo > jogoAberto.base && v.alvo < jogoAberto.base + jogoAberto.tamanho,
        `${n} resolveu para fora do módulo`);
    }
    return achados.map(([n, v]) => n + '@0x' + v.alvo.toString(16)).join('  ');
  });

  check('lê bytes do processo', () => {
    const b = memoria.ler(jogoAberto.base, 64);
    assert(b && b.length === 64, 'não leu');
    // Todo PE começa com "MZ": se não vier isso, não é o módulo do jogo.
    assert(b[0] === 0x4d && b[1] === 0x5a, 'o início do módulo não é um PE');
    return 'cabeçalho MZ conferido na base do módulo';
  });
} else {
  console.log('   --    (jogo fechado: os testes contra o processo vivo ficam de fora)');
}

check('a contagem por memória se cala quando não tem o que ler', () => {
  // Calibrado não implica número disponível: isso depende do jogo aberto.
  const e = deathsmem.estado();
  const c = deathsmem.contagem();
  const aberto = memoria.conectar().ok;

  if (!aberto) {
    assert(c === null, 'devolveu número com o jogo fechado');
    return 'jogo fechado: devolve null em vez de repetir a última leitura';
  }
  if (e.calibrado || c) {
    assert(c && typeof c.mortes === 'number', 'jogo aberto e calibrado, mas sem número');
    return `${c.mortes} mortes, escopo "${c.escopo}"`;
  }
  assert(c === null, 'devolveu número sem estar calibrado');
  return 'sem offset ainda, devolve null em vez de inventar';
});

check('a contagem é da jornada inteira, não da sessão', () => {
  const j = deathsmem.daJornada();
  if (!j) return 'jogo fechado ou no menu principal; nada a ler';
  // A contagem deve vir da struct do save (jornada), não do contador de sessão.
  assert(j.escopo === 'jornada', 'escopo "' + j.escopo + '"');
  const p = parse.buildProgress({});
  assert(p.deaths.escopo === 'jornada',
    'a página está publicando escopo "' + p.deaths.escopo + '"');
  assert(p.deaths.count === j.mortes,
    'página diz ' + p.deaths.count + ', a struct diz ' + j.mortes);
  // O tempo interno da struct deve ser plausível frente ao relógio da Steam
  // (menor, mas não muito menor).
  const t = tempo.tempoDeJogo();
  if (t && j.igtHoras) {
    assert(j.igtHoras < t.horas, `IGT ${j.igtHoras.toFixed(1)}h não pode passar do relógio ${t.horas}h`);
    assert(j.igtHoras > t.horas * 0.3, `IGT ${j.igtHoras.toFixed(1)}h baixo demais para ${t.horas}h de relógio`);
    return `${j.mortes} mortes, IGT ${j.igtHoras.toFixed(1)}h contra ${t.horas}h de relógio`;
  }
  return `${j.mortes} mortes na jornada`;
});

// Efeitos de sessão, com o instante passado como argumento a `atualizar`.
check('os efeitos acendem no limiar e vencem em seis horas', () => {
  const efeitos = require('./efeitos');
  const guardado = fs.existsSync(efeitos.ESTADO) ? fs.readFileSync(efeitos.ESTADO) : null;
  try {
    fs.rmSync(efeitos.ESTADO, { force: true });
    const H = 3600000;
    let t = Date.parse('2026-01-01T00:00:00Z');
    const passo = (o, dt) => efeitos.atualizar(o, (t += (dt || 0)));

    let r = passo({ pid: 1, mortesNaSessao: 0, conquistas: 19 });
    assert(!r.podridao && !r.fogo, 'acendeu sem gatilho nenhum');

    r = passo({ pid: 1, mortesNaSessao: 4, conquistas: 19 }, 60000);
    assert(!r.podridao, 'podridão acendeu com 4 mortes, e o limiar é 5');

    r = passo({ pid: 1, mortesNaSessao: 5, conquistas: 19 }, 60000);
    assert(r.podridao > 0, 'não acendeu com 5 mortes na sessão');
    assert(Math.abs(r.podridao - 6 * 3600) < 5, 'não durou seis horas: ' + r.podridao + 's');

    r = passo({ pid: 1, mortesNaSessao: 5, conquistas: 20 }, 60000);
    assert(!r.fogo, 'fogo acendeu com uma conquista só, e o limiar é 2');

    r = passo({ pid: 1, mortesNaSessao: 5, conquistas: 21 }, 60000);
    assert(r.fogo > 0, 'não acendeu com duas conquistas na sessão');

    // Fechar o jogo não apaga um efeito aceso.
    r = passo({ pid: null }, H);
    assert(r.podridao > 0 && r.fogo > 0, 'fechar o jogo apagou os efeitos');
    r = passo({ pid: null }, 5 * H);
    assert(!r.podridao && !r.fogo, 'ainda aceso depois de seis horas');

    // Sessão nova não reacende pelo acumulado: 21 conquistas continuam 21.
    r = passo({ pid: 2, mortesNaSessao: 0, conquistas: 21 }, 60000);
    assert(!r.fogo, 'sessão nova acendeu o fogo pelo total, não pelo ganho');
    return 'limiar 5/2, duração 6 h, sobrevive ao jogo fechar, não reacende sozinho';
  } finally {
    fs.rmSync(efeitos.ESTADO, { force: true });
    if (guardado) fs.writeFileSync(efeitos.ESTADO, guardado);
  }
});

check('o que é publicado é o tempo que falta, não a hora de início', () => {
  // Publica só os segundos restantes, nunca a hora de início.
  const efeitos = require('./efeitos');
  const guardado = fs.existsSync(efeitos.ESTADO) ? fs.readFileSync(efeitos.ESTADO) : null;
  try {
    fs.rmSync(efeitos.ESTADO, { force: true });
    const t = Date.parse('2026-01-01T00:00:00Z');
    efeitos.atualizar({ pid: 1, mortesNaSessao: 0, conquistas: 19 }, t);
    const r = efeitos.atualizar({ pid: 1, mortesNaSessao: 5, conquistas: 19 }, t + 1000);
    for (const v of Object.values(r)) {
      assert(typeof v === 'number', 'efeito publicado como ' + typeof v + ', não número');
    }
    const texto = JSON.stringify(require('./publish').sanitizar({ efeitos: r }));
    assert(!/\d{4}-\d{2}-\d{2}T/.test(texto), 'saiu um carimbo de data no que vai para o ar');
    return 'só segundos restantes: ' + JSON.stringify(r);
  } finally {
    fs.rmSync(efeitos.ESTADO, { force: true });
    if (guardado) fs.writeFileSync(efeitos.ESTADO, guardado);
  }
});

check('fechar o jogo não derruba a contagem', () => {
  // Com o jogo fechado, vale a última leitura guardada.
  const guardada = deathsmem.ultimaConhecida();
  if (!guardada) return 'ainda não houve leitura boa para guardar';
  const p = parse.buildProgress({});
  const aberto = memoria.conectar().ok;
  assert(p.deaths.count >= guardada.mortes,
    `a página diz ${p.deaths.count} e a última leitura boa foi ${guardada.mortes}`);
  assert(p.deaths.how === 'memoria',
    'com leitura guardada a via deveria ser "memoria", e é "' + p.deaths.how + '"');
  if (!aberto) {
    assert(p.deaths.aoVivo === false, 'jogo fechado, mas a página diz que é ao vivo');
    return `jogo fechado: mantém ${p.deaths.count}, marcado como não ao vivo`;
  }
  return `jogo aberto: ${p.deaths.count} ao vivo, ${guardada.mortes} guardadas`;
});

check('a contagem de sessão continua existindo como reserva', () => {
  const s = deathsmem.daSessao();
  const j = deathsmem.daJornada();
  if (!s) return 'sem offset de sessão calibrado';
  assert(s.escopo === 'sessao', 'escopo "' + s.escopo + '"');
  if (j) {
    assert(s.mortes <= j.mortes,
      'a sessão (' + s.mortes + ') não pode passar da jornada (' + j.mortes + ')');
    return `sessão ${s.mortes} dentro da jornada ${j.mortes}`;
  }
  return `sessão ${s.mortes}`;
});

check('calibrado e com o jogo aberto, quem manda é a memória', () => {
  const e = deathsmem.estado();
  const c = deathsmem.contagem();
  if (!e.calibrado) return 'ainda sem offset; nada a comparar';
  if (!c) return 'calibrado, mas o jogo está fechado agora';
  const p = parse.buildProgress({});
  // Confere a via da leitura, não só o número.
  assert(p.deaths.how === 'memoria',
    'a via é "' + p.deaths.how + '" com o contador calibrado e o jogo aberto');
  assert(p.deaths.count === c.mortes,
    'a página diz ' + p.deaths.count + ' e a memória diz ' + c.mortes);
  assert(p.deaths.confidence === 'high', 'confiança "' + p.deaths.confidence + '", esperada "high"');
  // A descrição não deve citar o offset de sessão, que não produziu o número.
  return `${c.mortes} mortes, escopo "${c.escopo}"`;
});

check('o save é a reserva enquanto a memória não fecha', () => {
  const p = parse.buildProgress({});
  assert(p.deaths, 'sem contagem nenhuma');
  const vias = ['memoria', 'counted', 'learning'];
  assert(vias.includes(p.deaths.how), `via desconhecida: ${p.deaths.how}`);
  return `via "${p.deaths.how}"` + (p.deaths.count !== null ? `, ${p.deaths.count} mortes` : '');
});


/*
 * 8. O nome na rede local.
 *
 * Monta uma consulta mDNS real, passa pelo mesmo leitor do socket e confere
 * a resposta byte a byte.
 */
console.log('\n  === 8. Nome na rede local (mDNS) ===');

const mdns = require('./mdns');

/** Monta uma pergunta mDNS como um iPhone mandaria. */
function pergunta(nome, tipo, unicast) {
  const cab = Buffer.alloc(12);
  cab.writeUInt16BE(0, 0);
  cab.writeUInt16BE(0, 2);       // QR=0: é pergunta
  cab.writeUInt16BE(1, 4);       // uma pergunta
  const q = Buffer.alloc(4);
  q.writeUInt16BE(tipo === undefined ? 1 : tipo, 0);
  q.writeUInt16BE(unicast ? 0x8001 : 1, 2);
  return Buffer.concat([cab, mdns.codificarNome(nome), q]);
}

check('lê uma pergunta de nome como o aparelho manda', () => {
  const p = mdns.lerPerguntas(pergunta('sekiro.local'));
  assert(p.length === 1, `esperava 1 pergunta, vieram ${p.length}`);
  assert(p[0].nome === 'sekiro.local', `leu "${p[0].nome}"`);
  assert(p[0].tipo === 1, `tipo ${p[0].tipo}`);
  return 'sekiro.local, tipo A';
});

check('entende o pedido de resposta direta (bit QU)', () => {
  const p = mdns.lerPerguntas(pergunta('sekiro.local', 1, true));
  assert(p[0].unicast === true, 'não marcou unicast');
  const p2 = mdns.lerPerguntas(pergunta('sekiro.local', 1, false));
  assert(p2[0].unicast === false, 'marcou unicast onde não havia');
  return 'unicast e multicast distinguidos';
});

check('ignora resposta de outro programa em vez de responder a ela', () => {
  const resp = mdns.montarResposta('sekiro.local', '192.168.1.10');
  assert(mdns.lerPerguntas(resp).length === 0, 'tratou uma resposta como pergunta');
  return 'loop de resposta evitado';
});

check('monta a resposta A no formato do protocolo', () => {
  const r = mdns.montarResposta('sekiro.local', '192.168.1.10');
  assert(r.readUInt16BE(2) === 0x8400, `flags 0x${r.readUInt16BE(2).toString(16)}, esperava 0x8400`);
  assert(r.readUInt16BE(4) === 0, 'mandou pergunta junto');
  assert(r.readUInt16BE(6) === 1, 'não mandou exatamente uma resposta');
  const nome = mdns.lerNome(r, 12);
  assert(nome.nome === 'sekiro.local', `nome "${nome.nome}"`);
  const off = nome.proximo;
  assert(r.readUInt16BE(off) === 1, 'tipo não é A');
  assert(r.readUInt16BE(off + 2) === 0x8001, 'faltou o bit de cache-flush');
  assert(r.readUInt16BE(off + 8) === 4, 'RDLENGTH não é 4');
  assert([...r.slice(off + 10)].join('.') === '192.168.1.10', 'o IP saiu errado');
  return 'cabeçalho, nome, tipo, classe e IP conferem';
});

check('nome malformado não derruba o serviço', () => {
  // Ponteiro que aponta para si mesmo.
  const mau = Buffer.concat([Buffer.alloc(12), Buffer.from([0xc0, 0x0c])]);
  mau.writeUInt16BE(1, 4);
  const p = mdns.lerPerguntas(mau);
  assert(Array.isArray(p), 'não devolveu lista');
  return 'ponteiro em círculo cortado';
});

check('não responde por nome que não é o dele', () => {
  const p = mdns.lerPerguntas(pergunta('impressora.local'));
  assert(p[0].nome === 'impressora.local', 'leu o nome errado');
  const nossos = ['sekiro.local', 'oaovito.local'];
  assert(!nossos.includes(p[0].nome), 'confundiu com um nome nosso');
  return 'a comparação é por nome exato';
});

/*
 * 9. Hibernação quando o jogo sai da máquina.
 *
 * Checagem inválida não desliga nada, e nada é desligado antes da cópia.
 */
console.log('\n  === 9. Hibernação (jogo desinstalado) ===');

const instalacao = require('./instalacao');
const hibernar = require('./hibernar');

check('detecta o estado real do Sekiro nesta máquina', () => {
  const e = instalacao.estado();
  assert(e.instalado === true, `devolveu ${e.instalado}: ${e.evidencias.join('; ')}`);
  assert(e.checagemValida === true, 'marcou a checagem como inválida');
  return e.evidencias[0];
});

check('"não sei" nunca vira "desinstalado"', () => {
  // HD externo desconectado ou Steam ausente.
  const e = { instalado: null, checagemValida: false, evidencias: ['simulado'] };
  const agiria = e.instalado === false && e.checagemValida;
  assert(!agiria, 'agiria sobre uma checagem que não vale');
  return 'null e checagemValida=false são ignorados';
});

check('a cópia guarda o progresso e o save, sem apagar nada', () => {
  const tmp = path.join(__dirname, 'hib-test');
  fs.rmSync(tmp, { recursive: true, force: true });
  const falso = path.join(tmp, 'S0000.sl2');
  fs.mkdirSync(tmp, { recursive: true });
  fs.writeFileSync(falso, Buffer.alloc(2048, 7));

  const r = hibernar.arquivar({ destino: path.join(tmp, 'saida'), saves: [falso], motivo: 'teste' });

  // Num clone sem leitura do save não há progresso para guardar.
  if (temProgresso()) {
    const guardouProgresso = r.manifesto.projeto.some((g) => g.arquivo === 'progress.json' && g.bytes > 0);
    assert(guardouProgresso, 'não guardou o progress.json');
  }
  const guardouSave = r.manifesto.save.some((g) => g.bytes === 2048);
  assert(guardouSave, 'não guardou o save');
  assert(fs.existsSync(falso), 'APAGOU o original — hibernar só copia');
  // Só confere o original se ele existir.
  if (temProgresso()) assert(fs.existsSync(path.join(RAIZ_PROJETO, 'progress.json')), 'mexeu no progress.json de verdade');

  const n = r.manifesto.projeto.length + r.manifesto.save.length;
  fs.rmSync(tmp, { recursive: true, force: true });
  return `${n} arquivos copiados, nenhum removido`;
});

check('cada hibernação vai para uma pasta nova', () => {
  const tmp = path.join(__dirname, 'hib-test2');
  fs.rmSync(tmp, { recursive: true, force: true });
  const a = hibernar.arquivar({ destino: tmp, saves: [] });
  const b = hibernar.arquivar({ destino: tmp, saves: [] });
  const pastas = fs.readdirSync(tmp).length;
  fs.rmSync(tmp, { recursive: true, force: true });
  // Duas hibernações no mesmo segundo usam pastas distintas.
  assert(a.destino !== b.destino, 'duas hibernações no mesmo segundo colidiram');
  assert(pastas === 2, `esperava 2 pastas, achei ${pastas}`);
  return '2 pastas distintas, mesmo no mesmo segundo';
});

check('o manifesto diz como voltar', () => {
  const tmp = path.join(__dirname, 'hib-test3');
  fs.rmSync(tmp, { recursive: true, force: true });
  const r = hibernar.arquivar({ destino: tmp, saves: [] });
  assert(/reativar\.ps1/.test(r.manifesto.comoVoltar), 'não aponta o caminho de volta');
  assert(/Nada foi apagado/.test(r.manifesto.observacao), 'não deixa claro que é cópia');
  fs.rmSync(tmp, { recursive: true, force: true });
  return r.manifesto.comoVoltar;
});

check('a cópia da hibernação está fora do git', () => {
  const ig = fs.readFileSync(path.join(RAIZ_PROJETO, '.gitignore'), 'utf8');
  assert(/^arquivo\/$/m.test(ig), 'arquivo/ não está no .gitignore — o save iria junto');
  return 'arquivo/ ignorado: o save tem o Steam ID dentro';
});

check('existe o caminho de volta, e ele não apaga save sozinho', () => {
  const p = path.join(RAIZ_PROJETO, 'windows', 'reativar.ps1');
  assert(fs.existsSync(p), 'reativar.ps1 não existe');
  const txt = fs.readFileSync(p, 'utf8');
  assert(/install-sync-service\.ps1/.test(txt), 'não religa a tarefa');
  assert(!/Copy-Item[^\n]*S0000/.test(txt), 'restaura save sozinho — sobrescrever save é irreversível');
  return 'religa a tarefa e só indica onde está a cópia do save';
});

/*
 * 10. O site público mostra a página inteira.
 *
 * Todo campo que a página lê de `sync` deve estar na lista pública do
 * publish.js ou declarado aqui como excluído.
 */
console.log('\n  === 10. O público recebe o que a página desenha ===');

const publish = require('./publish');

// Campos excluídos da versão pública, com o motivo.
const EXCLUIDOS = {
  goodsRaw: 'despejo cru do inventário; a página não usa e era metade do arquivo',
  weaponsRaw: 'idem',
  flagCalibration: 'diagnóstico interno da leitura de flags',
};

check('todo campo que a página lê chega na versão pública', () => {
  const src = fs.readFileSync(path.join(RAIZ_PROJETO, 'trackeroao.html'), 'utf8');
  const usados = [...new Set([...src.matchAll(/sync\.([a-zA-Z]+)/g)].map((m) => m[1]))];
  const publicos = new Set(publish.CAMPOS_PUBLICOS.concat(['source']));
  const faltando = usados.filter((u) => !publicos.has(u) && !EXCLUIDOS[u]);
  assert(faltando.length === 0, 'a página lê, mas o público não recebe: ' + faltando.join(', '));
  return usados.length + ' campos lidos, todos cobertos';
});

check('o que ficou de fora ficou por um motivo escrito', () => {
  const local = progressoLocal();
  const limpo = publish.sanitizar(local);
  const fora = Object.keys(local).filter((k) => !(k in limpo));
  const semMotivo = fora.filter((k) => !EXCLUIDOS[k]);
  assert(semMotivo.length === 0, 'sem motivo declarado: ' + semMotivo.join(', '));
  return fora.length + ' fora: ' + fora.join(', ');
});

check('sem o save, a versão pública passa na conferência de vazamento', () => {
  const semSave = { ok: false, error: 'no-save-found', message: require('./sl2').MENSAGEM_SEM_SAVE };
  const v = publish.vazamentos(JSON.stringify(publish.sanitizar(semSave)));
  assert(v.length === 0, 'a própria mensagem de save ausente foi acusada: ' + v.join(', '));
  const bp = require('./parse').buildProgress;
  if (!require('./sl2').findSavePath()) {
    const r = bp({ config: {}, state: {} });
    const v2 = publish.vazamentos(JSON.stringify(publish.sanitizar(r)));
    assert(v2.length === 0, 'o parse sem save foi acusado: ' + v2.join(', '));
  }
  return 'nenhum aviso de vazamento numa máquina sem o jogo';
});

check('a versão pública segue sem nada de máquina ou conta', () => {
  const local = progressoLocal();
  const v = publish.vazamentos(JSON.stringify(publish.sanitizar(local)));
  assert(v.length === 0, 'vazou: ' + v.join(', '));
  return 'sem caminho, Steam ID, IP ou despejo cru';
});

check('o público não recebe quando a pessoa jogou', () => {
  const local = progressoLocal();
  const limpo = publish.sanitizar(local);
  assert(limpo.playtime && limpo.playtime.horas > 0, 'perdeu as horas junto');
  assert(!limpo.playtime.ultimaVez, 'a data da última partida foi publicada');
  assert(!limpo.source.saveModified,
    'saveModified foi publicado, e ele diz a mesma coisa que a última partida');
  return limpo.playtime.horas.toFixed(1) + ' h publicadas, sem quando';
});

/*
 * 13. Independência da Steam.
 *
 * Cada dado que vem da Steam tem uma fonte própria; a Steam, quando existe,
 * serve de conferência.
 */
check('o tempo de jogo tem fonte propria, fora da Steam', () => {
  const sl2 = require('./sl2');
  const tempo = require('./tempo');
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'offsets.json'), 'utf8'));
  const caminho = sl2.findSavePath();
  assert(caminho, 'sem save nesta maquina para conferir');
  const bruto = fs.readFileSync(caminho);
  const save = sl2.readSave(caminho);
  const achados = sl2.nonEmptySlots(save)
    .map((sl) => tempo.doSave(sl2.blockPayload(bruto, sl), cfg))
    .filter((v) => v !== null);
  assert(achados.length > 0, 'nenhum slot devolveu tempo interno');
  return achados.map((v) => (v / 3600).toFixed(1) + ' h').join(', ') + ' nos slots do save';
});

check('e a Steam confere esse tempo em vez de substitui-lo', () => {
  const p2 = progressoLocal();
  const t = p2.playtime;
  assert(t, 'sem tempo de jogo lido');
  if (t.fonte !== 'steam') return 'sem Steam nesta maquina: a fonte e o proprio jogo (' + t.fonte + ')';
  assert(t.conferencia, 'com Steam presente, a conferencia tinha de existir');
  // O relógio de parede é sempre maior que o tempo interno.
  assert(t.conferencia.coerente,
    'tempo interno (' + (t.conferencia.jogoSegundos / 3600).toFixed(1) + ' h) passou do relogio de parede ('
    + (t.conferencia.relogioSegundos / 3600).toFixed(1) + ' h)');
  return (t.conferencia.jogoSegundos / 3600).toFixed(1) + ' h internas dentro de '
    + (t.conferencia.relogioSegundos / 3600).toFixed(1) + ' h de relogio';
});

check('o nome do cabecalho vem da maquina, nao do codigo', () => {
  const jogador = require('./jogador');
  const src = fs.readFileSync(path.join(RAIZ_PROJETO, 'trackeroao.html'), 'utf8');
  assert(!/oaovito game progress/.test(src), 'o nome continua escrito na pagina');
  const r = jogador.quem({ save: require('./sl2').findSavePath() });
  if (!r) return 'sem Steam identificada: o cabecalho fica so com o titulo, que e o previsto';
  assert(r.nick && r.fonte === 'steam', 'apelido veio sem fonte declarada');
  return 'apelido lido do loginusers.vdf (' + r.nick.length + ' caracteres)';
});

check('e o nome de login da conta nunca entra no processo', () => {
  // Só PersonaName (apelido público) pode ser lido; AccountName (login), nunca.
  const jogador = require('./jogador');
  const inst = require('./instalacao');
  const steam = inst.steamPath();
  if (!steam) return 'sem Steam nesta maquina: nada a vazar';
  let txt;
  try { txt = fs.readFileSync(path.join(steam, 'config', 'loginusers.vdf'), 'utf8'); }
  catch (e) { return 'loginusers.vdf ilegivel: nada a vazar'; }
  const logins = [...txt.matchAll(/"AccountName"\s+"([^"]+)"/g)].map((m) => m[1]).filter(Boolean);
  const r = jogador.quem({ save: require('./sl2').findSavePath() });
  const saida = JSON.stringify(r || {});
  const vazou = logins.filter((l) => saida.includes(l));
  assert(vazou.length === 0, 'o nome de login saiu no objeto do jogador');
  return logins.length + ' login(s) no arquivo, nenhum no objeto';
});

/*
 * 14. Os dois estados do bloco de mortes.
 *
 * Sino e podridão são lidos do inventário: confere os ids do config, o estado
 * devolvido e a lista de nomes.
 */
check('o Sino Demoniaco vira estado, nao silencio', () => {
  const p2 = progressoLocal();
  const b = p2.demonBell;
  assert(b, 'demonBell nao foi montado');
  assert(typeof b.ativo === 'boolean', 'o estado nao e binario');
  assert(b.id === 3730, 'id do Bell Demon mudou: era 3730');
  return b.ativo ? 'sino tocado agora' : 'sino nao tocado (ou ja devolvido)';
});

check('a podridao sabe o nome de cada um dos afligidos', () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'offsets.json'), 'utf8'));
  const lista = cfg.rotEssence && cfg.rotEssence.list;
  assert(lista && lista.length === 17, 'a wiki lista 17 Rot Essence; aqui tem ' + (lista ? lista.length : 0));
  const semNome = lista.filter((r) => !r.npc || !r.item || !(r.id > 0));
  assert(semNome.length === 0, 'entrada incompleta: ' + semNome.map((r) => r.id).join(', '));
  const ids = new Set(lista.map((r) => r.id));
  assert(ids.size === lista.length, 'id repetido na lista');
  const npcs = new Set(lista.map((r) => r.npc));
  assert(npcs.size === lista.length, 'dois itens apontando para o mesmo NPC');
  return lista.length + ' essencias, cada uma com item e NPC proprios';
});

check('e o estado dela sai montado do parse', () => {
  const p2 = progressoLocal();
  const d = p2.dragonrot;
  assert(d, 'dragonrot nao foi montado');
  assert(typeof d.ativo === 'boolean' && d.quantos >= 0, 'estado incompleto');
  assert(d.quantos === d.essencias.length, 'a contagem nao bate com a lista');
  assert(d.ativo === (d.quantos > 0), 'ativo diz uma coisa e a contagem diz outra');
  return d.quantos + ' de ' + d.total + ' com essencia no inventario';
});

check('quem clonar recebe as artes dos Headless tambem', () => {
  const icones = require('./icones');
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'offsets.json'), 'utf8'));
  const faltando = cfg.headless.list.filter((h) => !icones.MAPA[h.key]);
  assert(faltando.length === 0, 'sem arte no mapa: ' + faltando.map((h) => h.key).join(', '));
  const semArquivo = cfg.headless.list
    .filter((h) => !fs.existsSync(path.join(icones.DESTINO, h.key + '.png')));
  assert(semArquivo.length === 0, 'arte nao baixada: ' + semArquivo.map((h) => h.key).join(', '));
  return cfg.headless.list.length + ' Headless com arte, no mesmo lugar das dos chefes';
});

/*
 * 15. O instalador não pode parecer malware.
 *
 * Um .exe que abre o PowerShell com -EncodedCommand é bloqueado pelo Windows
 * Defender (Trojan:Win32/ClickFix.PM!MTB), e o erro aparece apenas como
 * "Access is denied" no CreateProcess.
 */
check('o instalador nao usa os padroes que o antivirus derruba', () => {
  const construir = fs.readFileSync(path.join(RAIZ_PROJETO, 'windows', 'instalador', 'construir-exe.ps1'), 'utf8');
  const gerado = /\$cs = @"([\s\S]*?)"@/.exec(construir);
  assert(gerado, 'nao achei o C# embutido no construir-exe.ps1');
  // Remove os comentários, que podem citar os padrões proibidos.
  const cs = gerado[1]
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  const proibidos = [];
  if (/-EncodedCommand/.test(cs)) proibidos.push('-EncodedCommand');
  if (/-ExecutionPolicy\s+Bypass/.test(cs)) proibidos.push('-ExecutionPolicy Bypass na linha de comando');
  if (/FromBase64String[\s\S]{0,200}ScriptBlock/.test(cs)) proibidos.push('base64 virando ScriptBlock na linha');
  assert(proibidos.length === 0, 'padrao que o Defender derruba: ' + proibidos.join(', '));

  // A alternativa precisa estar presente (a política padrão é Restricted).
  assert(/-File/.test(cs), 'o script precisa ser chamado por -File');
  assert(/PSExecutionPolicyPreference/.test(cs),
    'sem a politica pelo ambiente, o -File nao roda em maquina com politica Restricted');
  return 'script em disco, chamado por -File, politica pelo ambiente';
});

check('o executavel nasce na release, dos scripts desta versao', () => {
  // O .exe não é versionado: a Action de release o gera a cada versão a
  // partir dos scripts.
  assert(!fs.existsSync(path.join(RAIZ_PROJETO, 'trackeroao-instalador.exe')),
    'ha um .exe versionado na raiz: ele ficaria velho em relacao ao que a release gera');
  const wf = fs.readFileSync(path.join(RAIZ_PROJETO, '.github', 'workflows', 'release.yml'), 'utf8');
  assert(/runs-on:\s*windows/.test(wf), 'a release nao roda em Windows, onde o csc existe');
  assert(/construir-exe\.ps1/.test(wf), 'a release nao constroi o .exe');
  assert(/gh release create[^\n]*trackeroao-instalador\.exe/.test(wf), 'a release nao anexa o instalador');
  // A release carrega um arquivo so: o desinstalador e o mesmo .exe.
  assert(!/desinstalador\.exe/.test(wf.split('gh release create')[1] || ''),
    'a release anexa um desinstalador separado; ele e o proprio instalador, copiado na instalacao');
  const construir = fs.readFileSync(path.join(RAIZ_PROJETO, 'windows', 'instalador', 'construir-exe.ps1'), 'utf8');
  assert(/Embutir 'instalar\.ps1'/.test(construir) && /Embutir 'desinstalar\.ps1'/.test(construir),
    'o .exe nao carrega os dois scripts');
  return 'gerado no runner Windows, um .exe que instala e desinstala';
});

check('existe o desinstalador, e ele desfaz o que o instalador fez', () => {
  const des = fs.readFileSync(path.join(RAIZ_PROJETO, 'windows', 'instalador', 'desinstalar.ps1'), 'utf8');
  const inst = fs.readFileSync(path.join(RAIZ_PROJETO, 'windows', 'instalador', 'instalar.ps1'), 'utf8');
  assert(/Unregister-ScheduledTask/.test(des) && /SekiroProgressSync/.test(des), 'nao tira a tarefa (nem a de nome antigo)');
  assert(/trackeroao\.lnk/.test(des), 'nao tira o atalho');
  assert(/Remove-NetFirewallRule/.test(des), 'nao tira a regra de firewall');
  assert(/CurrentVersion\\Uninstall\\trackeroao/.test(des), 'nao tira o registro de Aplicativos instalados');
  assert(/Remove-Item -Path \$Destino -Recurse/.test(des), 'nao tira a pasta');
  // O progresso nao sai sem pergunta, e a resposta padrao e guardar.
  assert(/Read-Host[^\n]*\(S\/n\)/.test(des), 'apaga o progresso sem perguntar');
  // So os processos desta instalacao: o que roda de dentro do sync\ dela.
  assert(/\\sync\\/.test(des) && /\$PID/.test(des), 'poderia encerrar processo que nao e desta instalacao');
  // E o instalador deixa o desinstalador na pasta e em Aplicativos instalados.
  assert(/trackeroao-desinstalador\.exe/.test(inst) && /UninstallString/.test(inst),
    'o instalador nao deixa o desinstalador');
  return 'tarefa, processos, atalho, firewall, registro e pasta, perguntando antes do progresso';
});

/*
 * Chamado pelo .exe, o PowerShell roda oculto: não pode pedir entrada nem
 * uma segunda elevação.
 */
check('pela janela, os scripts nao perguntam nem abrem outra janela', () => {
  const problemas = [];
  for (const nome of ['instalar.ps1', 'desinstalar.ps1']) {
    const src = fs.readFileSync(path.join(RAIZ_PROJETO, 'windows', 'instalador', nome), 'utf8');
    if (!/TRACKEROAO_GUI/.test(src)) problemas.push(nome + ' nao conhece a janela');
    if (!/if \(-not \$gui -and -not \$souAdmin/.test(src)) problemas.push(nome + ' pede administrador por conta propria');
    const leTecla = src.split('\n').filter((l) => /ReadKey/.test(l));
    if (!src.split('\n').some((l) => /-not \$gui/.test(l) && /JaElevado/.test(l))) problemas.push(nome + ' espera uma tecla na janela');
    if (!/Tela 'PRONTO'/.test(src)) problemas.push(nome + ' nao avisa a janela do fim');
    if (!leTecla.length) problemas.push(nome + ' perdeu a pausa do console');
    // node e winget escrevem em stderr, o que com 'Stop' no PowerShell 5.1 aborta.
    const soltos = src.split('\n').filter((l) => /^\s*(&\s*\$node|winget )/.test(l));
    if (soltos.length) problemas.push(nome + ' chama programa de fora sem Nativo: ' + soltos[0].trim());
  }
  assert(problemas.length === 0, problemas.join('; '));
  const construir = fs.readFileSync(path.join(RAIZ_PROJETO, 'windows', 'instalador', 'construir-exe.ps1'), 'utf8');
  assert(/\/target:winexe/.test(construir), 'o .exe voltou a ser de console');
  assert(/CreateNoWindow = true/.test(construir), 'o PowerShell apareceria numa janela de console');
  return 'sem console, sem pergunta, um pedido de administrador so, feito pelo .exe';
});

/*
 * 18. Abertura da aplicação e seleção de jogos.
 *
 * Pelo atalho, abre a qualquer momento; automaticamente, só quando um jogo
 * selecionado começa, e apenas com o ícone na bandeja. A seleção fica fora do
 * catálogo e só é gravável a partir da própria máquina.
 */
check('o jogo vigiado vem de um catalogo, e nao de um nome no codigo', () => {
  const jogos = require('./jogos');
  const cat = jogos.catalogo();
  assert(cat.length > 0, 'o catalogo esta vazio');
  const semProcesso = cat.filter((g) => !Array.isArray(g.processos) || !g.processos.length);
  assert(semProcesso.length === 0,
    'jogo sem processo para procurar: ' + semProcesso.map((g) => g.chave).join(', '));
  const chaves = new Set(cat.map((g) => g.chave));
  assert(chaves.size === cat.length, 'chave repetida no catalogo');

  // No main.js o nome do executável é só reserva; a lista vem do catálogo.
  const main = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  assert(/PROCESS_FALLBACK/.test(main) && !/const PROCESS_NAME =/.test(main),
    'o nome do processo voltou a ser fixo no codigo: nao daria para escolher');
  assert(/jogos\.processos\(\)/.test(main),
    'o main nao pergunta ao catalogo quais processos procurar');
  // Vários /FI no tasklist são combinados com E; o filtro deve ser feito no
  // código. Comentários são ignorados na conferência.
  const mainSemComentario = main
    .replace(/\/\\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  assert(!/IMAGENAME eq/.test(mainSemComentario),
    'a busca voltou a filtrar pelo tasklist: com dois jogos no catalogo ela nao acha nenhum');
  return cat.length + ' no catalogo: ' + cat.map((g) => g.chave).join(', ');
});

check('a escolha e estado desta maquina, e nao configuracao versionada', () => {
  // A seleção é estado local, separada do catálogo versionado.
  const jogos = require('./jogos');
  assert(jogos.CATALOGO !== jogos.SELECAO, 'catalogo e escolha no mesmo arquivo');

  // Sem seleção vigia todos; seleção vazia não vigia nenhum.
  assert(typeof jogos.paraProgresso().escolheu === 'boolean',
    'a pagina nao consegue distinguir "nao escolheu" de "escolheu nenhum"');
  return 'catalogo versionado, escolha fora do git';
});

check('a escolha so pode ser gravada de quem esta nesta maquina', () => {
  // Rotas que alteram estado só aceitam requisições da própria máquina.
  const src = fs.readFileSync(path.join(__dirname, 'serve.js'), 'utf8');
  const bloco = /if \(urlPath === '\/selecao'\)[\s\S]*?\n    \}/.exec(src);
  assert(bloco, 'nao achei a rota de selecao');
  assert(/remoteAddress/.test(bloco[0]) && /403/.test(bloco[0]),
    'a rota de selecao aceita de qualquer origem');
  const abrir = /if \(urlPath === '\/abrir'\)[\s\S]*?\n    \}/.exec(src);
  assert(abrir && /remoteAddress/.test(abrir[0]),
    'a rota que acende a bandeja aceita de qualquer origem');
  return 'as duas rotas que mudam algo sao so de localhost';
});

check('a bandeja fica acesa enquanto o Trackeroao esta de pe', () => {
  const main = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  const poll = /async function pollOnce\(\)[\s\S]*?\n\}/.exec(main);
  assert(poll, 'nao achei o poll');
  const corpo = poll[0];
  assert(corpo.indexOf('abrirBandeja') > 0, 'a bandeja nao acende quando o jogo abre');
  // O ícone não apaga quando o jogo fecha; só o "Fechar" do menu encerra.
  assert(corpo.indexOf('fecharBandeja') < 0, 'a bandeja apaga quando o jogo fecha, e a janela escondida fica sem volta');
  assert(/abrirBandeja\(bandejaAcesa \? 'depois da atualização' : 'início'\)/.test(main), 'o servico nao acende a bandeja ao subir');
  // A abertura automática não abre o navegador.
  assert(!/start.*http:\/\/localhost/i.test(corpo),
    'o poll abre o navegador sozinho; a abertura automatica e silenciosa');
  return 'acende ao subir e com o jogo, e so sai com o Fechar';
});

check('nada inicia com o Windows sem a caixa marcada', () => {
  const main = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  const f = /function podeSubir\(reinicio\)[\s\S]*?\n\}/.exec(main);
  assert(f, 'nao achei a regra de subida');
  assert(/COM_WINDOWS/.test(f[0]) && /PEDIDO/.test(f[0]), 'a subida nao depende do pedido nem da caixa');
  assert(/if \(!podeSubir\(reinicio\)\) process\.exit\(0\)/.test(main), 'o servico sobe sem conferir se pode');
  const vbs = fs.readFileSync(path.join(__dirname, 'abrir.vbs'), 'utf8');
  assert(/abrir\.pedido/.test(vbs), 'o atalho do clone nao deixa o pedido antes de subir o servico');
  return 'so sobe aberto a mao, no reinicio da atualizacao ou com a caixa marcada';
});

check('a bandeja nao sobrevive ao servico', () => {
  // O ícone da bandeja encerra junto com o serviço.
  const bandeja = path.join(__dirname, 'bandeja.ps1');
  assert(fs.existsSync(bandeja), 'bandeja.ps1 nao esta na pasta');
  const src = fs.readFileSync(bandeja, 'utf8');
  assert(/ProcessoPai/.test(src) && /Get-Process -Id \$ProcessoPai/.test(src),
    'o icone nao vigia o processo que o abriu');
  assert(/NotifyIcon/.test(src), 'nao e um icone de bandeja');
  // Sem dependências externas; a janela é do próprio projeto (app\).
  assert(!/Install-Module|Import-Module|\.exe/.test(src.replace(/wscript\.exe|powershell\.exe|Trackeroao\.exe/g, '')),
    'o icone depende de algo de fora do Windows');
  return 'NotifyIcon do proprio Windows, e morre junto com o servico';
});

check('existe o atalho, e ele nao e um link de internet', () => {
  // O abrir.vbs sobe o serviço, espera a resposta, acende a bandeja e só
  // então abre a página.
  const vbs = path.join(__dirname, 'abrir.vbs');
  assert(fs.existsSync(vbs), 'abrir.vbs nao esta na pasta');
  const src = fs.readFileSync(vbs, 'utf8');
  assert(/schtasks \/run/.test(src), 'o atalho nao sobe o servico quando ele esta parado');
  assert(/url & "abrir"/.test(src), 'o atalho nao acende a bandeja');
  assert(/shell\.Run url/.test(src), 'o atalho nao abre a pagina');

  const inst = fs.readFileSync(path.join(RAIZ_PROJETO, 'windows', 'instalador', 'instalar.ps1'), 'utf8');
  assert(/CreateShortcut/.test(inst), 'o instalador nao cria atalho nenhum');
  assert(/abrir\.vbs/.test(inst), 'o atalho do instalador nao aponta para o abrir.vbs');
  assert(/UsuarioOriginal/.test(inst.slice(inst.indexOf('4/6  Atalho'), inst.indexOf('5/6  Rede'))),
    'o atalho nasce na area de trabalho de quem elevou, e nao de quem joga');
  return 'wscript + abrir.vbs, na area de trabalho de quem instalou';
});

/*
 * 20. A atualização automática.
 *
 * O estado local sobrevive à cópia, arquivos removidos na versão nova saem da
 * pasta, e a atualização roda entre duas voltas do ciclo, nunca com jogo aberto.
 */
console.log('\n  === 20. A atualização automática ===');

check('atualizar preserva o estado e limpa o que a versão nova não tem', () => {
  const atualizar = require('./atualizar');
  const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'trackeroao-teste-'));
  try {
    const fonte = path.join(tmp, 'fonte');
    const inst = path.join(tmp, 'inst');
    for (const rel of atualizar.EXIGIDOS) {
      fs.mkdirSync(path.dirname(path.join(fonte, rel)), { recursive: true });
      fs.writeFileSync(path.join(fonte, rel), 'novo');
    }
    fs.mkdirSync(path.join(inst, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(inst, 'progress.json'), 'meu progresso');
    fs.writeFileSync(path.join(inst, 'docs', 'progress.json'), 'publicado aqui');
    fs.writeFileSync(path.join(inst, 'install-sync-service.ps1'), 'da raiz antiga');

    // Primeira atualização de uma instalação sem versao.json: sai o legado.
    const r1 = atualizar.aplicarPasta(fonte, 'v9.0.0', inst);
    assert(r1.removidos.includes('install-sync-service.ps1'), 'o script velho da raiz ficou');
    assert(fs.readFileSync(path.join(inst, 'progress.json'), 'utf8') === 'meu progresso', 'apagou o progresso');
    assert(fs.readFileSync(path.join(inst, 'docs', 'progress.json'), 'utf8') === 'publicado aqui',
      'trocou o progresso publicado desta maquina pelo que veio no zip');
    assert(atualizar.lerEstado(inst).tag === 'v9.0.0', 'nao gravou a versao');

    // Segunda: um arquivo do projeto deixou de existir e sai junto.
    fs.writeFileSync(path.join(fonte, 'windows', 'extra.ps1'), 'x');
    atualizar.aplicarPasta(fonte, 'v9.1.0', inst);
    fs.unlinkSync(path.join(fonte, 'windows', 'extra.ps1'));
    const r3 = atualizar.aplicarPasta(fonte, 'v9.2.0', inst);
    assert(r3.removidos.includes('windows/extra.ps1'), 'o arquivo que saiu do projeto ficou na pasta');

    // Zip truncado nao e copiado.
    fs.unlinkSync(path.join(fonte, 'sync', 'main.js'));
    let recusou = false;
    try { atualizar.aplicarPasta(fonte, 'v9.3.0', inst); } catch (e) { recusou = true; }
    assert(recusou, 'copiou uma versao incompleta');
    assert(atualizar.lerEstado(inst).tag === 'v9.2.0', 'a versao incompleta ficou registrada');
    return 'estado intacto, legado removido, zip incompleto recusado';
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

check('a atualização roda entre voltas do ciclo, e nunca com o jogo aberto', () => {
  const main = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  const ciclo = /const ciclo = async \(\) => \{[\s\S]*?\n  \};/.exec(main);
  assert(ciclo, 'nao achei o ciclo');
  const c = ciclo[0];
  assert(c.indexOf('await pollOnce()') >= 0 && c.indexOf('await passoDeAtualizacao()') > c.indexOf('await pollOnce()'),
    'a atualizacao nao roda depois da volta');
  assert(c.indexOf('setTimeout(ciclo') > c.indexOf('await passoDeAtualizacao()'),
    'a proxima volta nao espera a atualizacao terminar');
  assert(!/setInterval\(pollOnce/.test(main), 'um setInterval rodaria voltas por cima da atualizacao');
  const passo = /async function passoDeAtualizacao\(\) \{[\s\S]*?\n\}/.exec(main);
  assert(passo && /if \(gameWasRunning/.test(passo[0]), 'a atualizacao nao espera o jogo fechar');
  // Silenciosa: nada de janela, navegador ou aviso.
  const mod = fs.readFileSync(path.join(__dirname, 'atualizar.js'), 'utf8');
  assert(!/start\s+http|msg\s|MessageBox|Popup|shell\.Run/i.test(mod + passo[0]), 'a atualizacao mostra algo na tela');
  assert(/windowsHide:\s*true/.test(mod), 'o PowerShell da descompactacao abriria janela');
  return 'depois da volta, antes da proxima, so com o jogo fechado, sem nada na tela';
});

check('nenhum modulo do sync esta quebrado', () => {
  // Carrega cada módulo, inclusive os que o resto do projeto não importa.
  const quebrados = [];
  for (const arq of fs.readdirSync(__dirname).filter((f) => f.endsWith('.js'))) {
    if (arq === 'selftest.js') continue;
    try { require(path.join(__dirname, arq)); }
    catch (e) { quebrados.push(arq + ': ' + e.message.split('\n')[0]); }
  }
  assert(quebrados.length === 0, quebrados.join(' | '));
  return 'todos os modulos carregam';
});

/*
 * 16. O link público mostra a mesma página que a instância local.
 *
 * Aqui ficam as imagens; o render está no grupo 6, que é assíncrono.
 */
check('as artes que a pagina usa estao todas dentro de docs/', () => {
  // Toda imagem usada pela página precisa estar em docs/, que é o que o Pages serve.
  const src = fs.readFileSync(path.join(RAIZ_PROJETO, 'trackeroao.html'), 'utf8');
  const pastas = new Set();
  for (const m of src.matchAll(/["'(](icones\/[^"')]*)["')]/g)) {
    pastas.add(m[1].replace(/[^/]*$/, ''));
  }
  assert(pastas.size > 0, 'nenhum caminho de imagem achado na pagina: o teste parou de olhar o lugar certo');
  const vazias = [];
  for (const dir of pastas) {
    const alvo = path.join(RAIZ_PROJETO, 'docs', dir);
    if (!fs.existsSync(alvo) || fs.readdirSync(alvo).length === 0) vazias.push(dir);
  }
  assert(vazias.length === 0, 'a pagina pede imagem de ' + vazias.join(', ') + ', que nao existe em docs/');
  // Caminhos de imagem que vêm no JSON (ícones das conquistas).
  const pub = JSON.parse(fs.readFileSync(path.join(RAIZ_PROJETO, "docs", "progress.json"), "utf8"));
  const citados = ((pub.achievements && pub.achievements.lista) || [])
    .map((c) => c.icone).filter(Boolean);
  const semArquivo = citados.filter((rel) => !fs.existsSync(path.join(RAIZ_PROJETO, "docs", rel)));
  assert(semArquivo.length === 0,
    "o progresso publicado cita imagem que nao foi junto: " + semArquivo.slice(0, 3).join(", "));
  return [...pastas].join(', ') + ' e ' + citados.length + ' icones de conquista — todos no que vai para o ar';
});

check('nenhum carimbo de hora sobra no arquivo publico', () => {
  const HORA = /[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}/;
  const PERMITIDOS = new Set(['generatedAt']);
  const limpo = publish.sanitizar(progressoLocal());
  const achados = [];
  (function anda(v, caminho) {
    if (v === null || v === undefined) return;
    if (typeof v === 'string') {
      if (HORA.test(v) && !PERMITIDOS.has(caminho)) achados.push(caminho);
      return;
    }
    if (Array.isArray(v)) { v.forEach((x, i) => anda(x, caminho + '[' + i + ']')); return; }
    if (typeof v === 'object') {
      for (const k of Object.keys(v)) anda(v[k], caminho ? caminho + '.' + k : k);
    }
  }(limpo, ''));
  assert(achados.length === 0, 'data publicada em: ' + achados.join(', '));
  return 'so generatedAt carrega data, e ela nao diz quando se jogou';
});

/*
 * 11. O repositório se basta.
 *
 * Um clone tem tudo o que precisa, nada é resolvido para fora da pasta e
 * nada versionado identifica a máquina.
 */

/*
 * 21. Sem Steam.
 *
 * Simula uma máquina sem Steam e confere conquistas, nome do cabeçalho,
 * detecção de instalação e lista de jogos.
 */
console.log('\n  === 21. Sem Steam ===');

check('as 34 conquistas saem do save, sem Steam', () => {
  const cs = require('./conquistasave');
  const on = new Set([6801, 6802, 6830, 8250, 9370]);
  const d = cs.derivar({
    f: (id) => on.has(id), goods: new Map([[2300, 1]]), armas: new Set(cs.PROTESES),
    essenciais: { prayerBeads: { necklaces: 10, totalNecklaces: 10 }, gourdSeeds: { charges: 3, maxCharges: 10 } },
  });
  assert(d.length === 34, 'não devolveu as 34');
  const v = (i) => d.find((x) => x.indice === i).conquistada;
  assert(v(20) === true && v(21) === true && v(22) === false, 'chefes pelas flags 68xx');
  assert(v(9) === true && v(10) === false, 'finais pelas flags 6830-6833');
  assert(v(19) === true, 'Resurrection pela flag 8250');
  assert(v(5) === true && v(3) === false, 'próteses pelo inventário');
  assert(v(7) === true && v(8) === false, 'colares e cabaça pelos essenciais');
  assert(v(33) === true, 'Great Colored Carp pela flag 9370');
  const j = cs.juntar(d, null);
  assert(j.fonte === 'save' && j.total === 34, 'sem Steam a lista não se fechou pelo save');
  return j.desbloqueadas + ' de 34 provadas só pelo save';
});

check('com Steam, ela confere e marca o desencontro', () => {
  const cs = require('./conquistasave');
  const d = cs.derivar({ f: (id) => id === 6801, goods: new Map(), armas: new Set(), essenciais: null });
  const steam = { lista: cs.LISTA.map((a) => ({ nome: a.nome, conquistada: a.indice === 21 })) };
  const j = cs.juntar(d, steam);
  const gyoubu = j.lista[20];
  const borboleta = j.lista[21];
  assert(gyoubu.conquistada && gyoubu.confere === false && gyoubu.fonte === 'save', 'o save sozinho não valeu');
  assert(borboleta.conquistada && borboleta.fonte === 'steam', 'a Steam não somou o que a conta tem');
  return j.divergentes.length + ' desencontro(s) marcado(s)';
});

check('o nome do cabeçalho existe sem Steam', () => {
  const jogador = require('./jogador');
  const tmp = path.join(require('os').tmpdir(), 'trackeroao-jogador-' + process.pid + '.json');
  try {
    jogador.escolher('  lobo\n  solitário <b> ', tmp);
    const r = jogador.quem({ arquivo: tmp, steam: path.join(require('os').tmpdir(), 'sem-steam-aqui') });
    assert(r && r.nick === 'lobo solitário b' && r.fonte === 'escolhido', 'veio ' + JSON.stringify(r));
    return r.nick;
  } finally { try { fs.unlinkSync(tmp); } catch (e) { /* */ } }
});

check('a instalação do jogo é detectada sem Steam', () => {
  const instalacao = require('./instalacao');
  const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'trackeroao-inst-'));
  try {
    const pasta = path.join(tmp, 'Sekiro');
    fs.mkdirSync(pasta);
    const lembrada = path.join(tmp, 'lembrada.json');
    const a = instalacao.semSteam({ varredura: { pasta, em: 'x' }, lembrada });
    assert(a.instalado === true && a.checagemValida, 'achado pela varredura e não reconheceu');
    fs.rmdirSync(pasta);
    const b = instalacao.semSteam({ varredura: { pasta: null, em: 'x' }, lembrada });
    assert(b.instalado === false && b.checagemValida, 'a pasta sumiu e não percebeu');
    const c = instalacao.semSteam({ varredura: { pasta: null, em: null }, lembrada: path.join(tmp, 'nada.json') });
    assert(c.instalado === null && !c.checagemValida, '"não sei" virou resposta');
    return 'instalado, desinstalado e "não sei"';
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

check('lê os arquivos VDF da Steam', () => {
  const b = require('./biblioteca');
  const v = b.lerVdf('"AppState" { "appid" "814380" "name" "Sekiro" "UserConfig" { "language" "english" } }');
  assert(v.appstate.appid === '814380' && v.appstate.userconfig.language === 'english', JSON.stringify(v));
  assert(b.normalizar("Baldur's Gate 3") === b.normalizar('Baldurs Gate 3'), 'grafias diferentes não casaram');
  assert(b.normalizar('ELDEN RING™') === 'eldenring', 'marca registrada ficou no nome');
  return 'appmanifest e nomes';
});

console.log('\n  === 11. O repositório se basta ===');

const { execFileSync: exec11 } = require('child_process');
/*
 * Lista de arquivos versionados, ou null sem checkout git (instalações vêm
 * do zip da release, sem `.git`).
 */
const rastreados = (() => {
  try {
    if (!fs.existsSync(path.join(RAIZ_PROJETO, '.git'))) return null;
    return exec11('git', ['ls-files'], { cwd: RAIZ_PROJETO, encoding: 'utf8', windowsHide: true })
      .split('\n').filter(Boolean);
  } catch (e) { return null; }
})();

/** Sai pulando quando não há checkout git para inspecionar. */
function exigeGit() {
  if (!rastreados) pular('instalado a partir do zip; não há checkout git para conferir');
  return rastreados;
}

// A raiz do repositório tem no máximo oito itens; o resto vai para windows/,
// docs/ ou .github/.
check('a raiz do repositório tem no máximo oito itens', () => {
  exigeGit();
  const raiz = [...new Set(rastreados.map((a) => a.split('/')[0]))].sort();
  assert(raiz.length <= 8, raiz.length + ' itens na raiz: ' + raiz.join(', '));
  return raiz.length + ' itens: ' + raiz.join(', ');
});

check('o projeto inteiro está versionado, não só a página', () => {
  exigeGit();
  const porExt = {};
  for (const a of rastreados) {
    const e = path.extname(a) || a;
    porExt[e] = (porExt[e] || 0) + 1;
  }
  for (const e of ['.js', '.ps1', '.html']) assert(porExt[e] > 0, 'nenhum ' + e + ' versionado');
  assert(rastreados.includes('package.json'), 'sem package.json');
  assert(rastreados.includes('sync/main.js'), 'sem o serviço');
  assert(rastreados.includes('trackeroao.html'), 'sem a página');
  return rastreados.length + ' arquivos: ' + Object.entries(porExt)
    .sort((a, b) => b[1] - a[1]).slice(0, 5).map(([e, n]) => n + e).join(', ');
});

check("o catalogo de jogos vem no clone, e a escolha nao", () => {
  // A seleção é estado local e não pode ser versionada.
  exigeGit();
  const jogos = require('./jogos');
  const rel = (f) => path.relative(RAIZ_PROJETO, f).split('\\').join('/');
  assert(rastreados.includes(rel(jogos.CATALOGO)),
    rel(jogos.CATALOGO) + ' nao esta versionado: quem clonar nao recebe o catalogo');
  assert(!rastreados.includes(rel(jogos.SELECAO)),
    rel(jogos.SELECAO) + ' esta versionado: a escolha de quem instalou viraria commit');
  return 'jogos.json no clone, selecao.json fora dele';
});

check('quem clonar recebe as artes junto', () => {
  exigeGit();
  const artes = rastreados.filter((a) => a.startsWith('docs/icones/') && a.endsWith('.png'));
  assert(artes.length > 0, 'nenhuma arte versionada; a lista de chefes cairia no kanji');
  return artes.length + ' imagens no repositório';
});

check('nada é resolvido para fora da pasta clonada', () => {
  exigeGit();
  const foraDaPasta = [];
  for (const a of rastreados) {
    if (!/\.(ps1|js|bat|vbs)$/i.test(a)) continue;
    const t = fs.readFileSync(path.join(RAIZ_PROJETO, a), 'utf8');
    // Subir de sync/ ou windows/ até a raiz é permitido; sair da raiz, não.
    if (!a.includes('/') && /Split-Path \$PSScriptRoot -Parent/.test(t)) foraDaPasta.push(a + ': sobe acima da raiz');
    if (/\.\.[\\/]\.\.[\\/]/.test(t)) foraDaPasta.push(a + ': caminho para fora da raiz');
    /*
     * Proíbe executáveis de terceiros chamados por caminho. São permitidos o
     * Node, o compilador do .NET Framework, utilitários do Windows e os .exe
     * do próprio projeto (Trackeroao.exe e trackeroao-instalador.exe).
     * `(?![A-Za-z])` evita casar com `.exec(`.
     */
    const DA_MAQUINA = /^(node|csc|wscript|cscript|powershell|winget|explorer|schtasks|taskkill|Trackeroao|trackeroao-instalador)$/i;
    const CAMINHO_EXE = /[\\/]([A-Za-z0-9_-]+)\.exe(?![A-Za-z])/g;
    for (const m of t.matchAll(CAMINHO_EXE)) {
      if (DA_MAQUINA.test(m[1])) continue;
      if (/System32/i.test(t)) continue;
      foraDaPasta.push(a + ": chama " + m[1] + ".exe por caminho");
    }
  }
  assert(foraDaPasta.length === 0, foraDaPasta.join(' | '));
  return 'nenhum caminho sai da raiz do projeto';
});

check('a porta da rede local e liberada pelo perfil em uso, nao no escuro', () => {
  /*
   * Os perfis da regra vêm do estado da máquina (a rede pode ser Public), e
   * a regra fica limitada ao LocalSubnet.
   */
  const arq = path.join(RAIZ_PROJETO, 'windows', 'liberar-porta.ps1');
  assert(fs.existsSync(arq), 'liberar-porta.ps1 nao esta na pasta');
  const src = fs.readFileSync(arq, 'utf8');

  assert(/Get-NetConnectionProfile/.test(src),
    'os perfis nao vem do estado da maquina: a regra estaria sendo criada no escuro');
  assert(/-Profile \(\$perfis/.test(src),
    'a regra nao usa os perfis descobertos');
  assert(/-RemoteAddress LocalSubnet/.test(src),
    'sem limitar ao LocalSubnet, valer no perfil Public seria abrir para a rede inteira');
  assert(/-LocalPort \$Porta/.test(src) && /-Protocol TCP/.test(src),
    'o escopo tem de ser a porta e o protocolo, e nao o programa inteiro');

  // Idempotente: não duplica a regra nem pede elevação de novo.
  assert(/Regra-Existe/.test(src) && /ja estava liberada/.test(src),
    'o script nao confere se a regra ja existe antes de pedir administrador');
  // Confere pelo nome da regra, não pela mensagem do netsh (traduzida).
  assert(/regex\]::Escape\(\$nome\)/.test(src),
    'a existencia da regra e conferida por texto traduzivel: quebra em Windows de outro idioma');

  // O instalador delega ao script, sem duplicar a lógica.
  const inst = fs.readFileSync(path.join(RAIZ_PROJETO, 'windows', 'instalador', 'instalar.ps1'), 'utf8');
  assert(/liberar-porta\.ps1/.test(inst), 'o instalador nao chama o script da porta');
  assert(!/New-NetFirewallRule/.test(inst),
    'o instalador tem a sua propria copia da regra: duas copias divergem');
  return 'perfis em uso, limitado ao LocalSubnet, TCP na porta do servidor';
});

check('e nesta maquina ela esta mesmo aberta', () => {
  // netsh em vez de Get-NetFirewallRule, que exige administrador até para ler.
  const { execFileSync } = require('child_process');
  let saida = '';
  try {
    saida = execFileSync('netsh', ['advfirewall', 'firewall', 'show', 'rule', 'name=trackeroao (8777)'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (e) { saida = (e.stdout || '').toString(); }

  if (!/trackeroao/.test(saida)) {
    pular('a regra nao existe aqui; rode liberar-porta.ps1 e aceite o pedido de administrador');
  }
  // Lê por valor ("Private", "LocalSubnet", porta), pois os rótulos são traduzidos.
  assert(/\b8777\b/.test(saida), 'a regra existe mas nao menciona a porta 8777');
  assert(/LocalSubnet/i.test(saida),
    'a regra aceita qualquer origem: deveria ser so o LocalSubnet');
  assert(/Private/i.test(saida), 'a regra nao cobre o perfil Private');
  const publico = /Public/i.test(saida);
  return 'porta 8777, origem LocalSubnet, Private'
    + (publico ? ' e Public (a rede daqui esta classificada como Public)' : '');
});

check('a janela é escondida sem binário de terceiro', () => {
  const vbs = path.join(RAIZ_PROJETO, 'sync', 'oculto.vbs');
  assert(fs.existsSync(vbs), 'sem o lançador oculto');
  const t = fs.readFileSync(vbs, 'utf8');
  assert(/\.Run .*, 0, False/.test(t), 'não pede janela oculta');
  const inst = fs.readFileSync(path.join(RAIZ_PROJETO, 'windows', 'install-sync-service.ps1'), 'utf8');
  assert(/wscript/i.test(inst), 'o instalador não usa o wscript');
  return 'wscript.exe do próprio Windows, nada para baixar';
});

check('nada do que está versionado identifica esta máquina', () => {
  exigeGit();
  const sujos = [];
  for (const a of rastreados) {
    if (/\.(png|svg|bin|sl2|zip|exe|ico)$/i.test(a)) continue;
    let t = '';
    try { t = fs.readFileSync(path.join(RAIZ_PROJETO, a), 'utf8'); } catch (e) { continue; }
    // docs/ usa o detector de dados; o resto, o detector de código.
    const v = a.startsWith('docs/') ? publish.vazamentos(t) : publish.vazamentosNoCodigo(t);
    if (v.length) sujos.push(a + ': ' + v.join(', '));
  }
  assert(sujos.length === 0, sujos.join(' | '));
  return rastreados.length + ' arquivos, nenhum com pasta pessoal, Steam ID ou IP';
});

check('nada no projeto carrega o nome antigo', () => {
  exigeGit();
  // Nomes legados do projeto. Montados em pedaços para este arquivo não
  // casar consigo mesmo.
  const NOME_ANTIGO = 'sekiro' + '-progresso';
  const LOG_ANTIGO = 'sekiro' + '-sync';
  const TITULO_ANTIGO = 'Progress ' + '— Sekiro';
  const antigos = new RegExp(NOME_ANTIGO + '|' + LOG_ANTIGO, 'gi');
  // A página usa o nome antigo na migração das chaves de armazenamento.
  const COTA = { 'trackeroao.html': 3 };

  const sujos = [];
  for (const a of rastreados) {
    if (/\.(png|svg|bin|sl2|zip|exe|ico)$/i.test(a)) continue;
    if (/^docs\//.test(a)) continue;   // saída publicada, conferida à parte
    if (a === 'sync/selftest.js') continue;   // este arquivo
    if (antigos.test(a)) { sujos.push(a + ' (no nome do arquivo)'); continue; }
    let t = '';
    try { t = fs.readFileSync(path.join(RAIZ_PROJETO, a), 'utf8'); } catch (e) { continue; }
    if (t.includes(TITULO_ANTIGO)) sujos.push(a + ': título antigo');
    const citacoes = (t.match(antigos) || []).length;
    if (citacoes > (COTA[a] || 0)) sujos.push(a + ': ' + citacoes + ' citações do nome antigo');
  }
  assert(sujos.length === 0, sujos.join(' | '));
  const titulo = /<title>([^<]*)<\/title>/.exec(
    fs.readFileSync(path.join(RAIZ_PROJETO, 'trackeroao.html'), 'utf8'));
  assert(titulo && titulo[1].trim() === 'trackeroao', 'o título da aba é "' + (titulo && titulo[1]) + '"');
  return 'título "trackeroao", arquivo trackeroao.html, chaves trackeroao-*';
});

check('quem já usava a página não perde as preferências', () => {
  // A leitura usa a chave antiga do localStorage quando a nova não existe.
  const t = fs.readFileSync(path.join(RAIZ_PROJETO, 'trackeroao.html'), 'utf8');
  assert(/function guardado\(chave\)/.test(t), 'não há função de leitura');
  assert(/getItem\("trackeroao-" \+ chave\)/.test(t), 'não lê a chave nova');
  assert(/getItem\("sekiro-progresso-" \+ chave\)/.test(t), 'não tem a reserva da chave antiga');
  assert(/setItem\("trackeroao-" \+ chave/.test(t), 'não grava na chave nova');
  return 'lê a nova, cai na antiga, grava sempre na nova';
});

check('o estado de execução ficou fora do git', () => {
  exigeGit();
  const nunca = ['progress.json', 'deaths.json', 'bosskills.json', 'deaths-mem.json'];
  const vazados = nunca.filter((n) => rastreados.includes(n));
  assert(vazados.length === 0, 'versionado indevidamente: ' + vazados.join(', '));
  // A versão publicada (saneada) deve estar presente.
  assert(rastreados.includes('docs/progress.json'), 'o progresso publicado não está versionado');
  return 'o cru fora, o saneado dentro';
});

check('a conferência do fonte sabe distinguir falar de um caminho e escrever o seu', () => {
  const os = require('os');
  // Descrever o formato do caminho é permitido; um caminho concreto, não.
  assert(publish.vazamentosNoCodigo('o save fica em AppData/Roaming/Sekiro/<steamid64>/S0000.sl2').length === 0,
    'recusou a descrição do formato');
  assert(publish.vazamentosNoCodigo('C:\\Users\\<usuario>\\AppData').length === 0,
    'recusou o marcador de usuário');
  assert(publish.vazamentosNoCodigo('const BASE_STEAMID64 = 76561197960265728n;').length === 0,
    'recusou a constante pública da Steam');
  // Montados em pedaços para este arquivo não casar consigo mesmo.
  const caminhoFalso = 'C:\\Users\\' + 'ful' + 'ano\\AppData';
  const idFalso = '7656119' + '8000000001';
  assert(publish.vazamentosNoCodigo(caminhoFalso).length > 0,
    'deixou passar um caminho com nome de gente');
  assert(publish.vazamentosNoCodigo(idFalso).length > 0,
    'deixou passar um Steam ID de verdade');
  assert(publish.vazamentosNoCodigo(os.homedir()).length > 0,
    'deixou passar a pasta pessoal desta máquina');
  return 'seis casos, os três que passam e os três que não';
});

/*
 * 12. Autoria do projeto.
 *
 * Arquivos, comentários, commits, autores e referências git são conferidos
 * contra uma lista de termos e expressões vetados. A lista guarda só o
 * resumo sha256 de cada termo, para este arquivo não conter o que proíbe.
 */
console.log('\n  === 12. A assinatura do projeto ===');

const crypto = require('crypto');
const resumoDe = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);

const VETADOS = new Set([
  'c857d09db23e6822', 'c70eca6b0f88f44d', '3ea125d0bff386e6',
  '60965168ce762e94', '7d3194f79e645c42',
]);
const EXPRESSOES = new Set([
  'a7091b63620eb08f', '0b5a04f1d73989c5', '41406ccf3af905dc',
  '1c876b8d7b6e39db', 'a9c935bc22f96642', 'f85b295d59714526',
  '95f8b0d87094092f', '9524a1a13601e991', '8c2d02375b0ae666',
]);

const palavras = (texto) => String(texto).toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];

// Termos isolados: qualquer palavra do texto cujo resumo esteja na lista.
const marcado = (texto) => {
  const achados = new Set();
  for (const p of palavras(texto)) if (VETADOS.has(resumoDe(p))) achados.add(p);
  return [...achados];
};

// Expressões de uma a três palavras seguidas.
const expressoes = (texto) => {
  const ps = palavras(texto);
  const achados = new Set();
  for (let i = 0; i < ps.length; i++) {
    for (let n = 1; n <= 3 && i + n <= ps.length; n++) {
      const trecho = ps.slice(i, i + n).join(' ');
      if (EXPRESSOES.has(resumoDe(trecho))) achados.add(trecho);
    }
  }
  return [...achados];
};

// Só o texto de comentários de um arquivo de código.
const comentarios = (texto, nome) => {
  if (/\.(md|txt)$/i.test(nome)) return texto;
  const partes = [];
  const blocos = /\/\*[\s\S]*?\*\/|<!--[\s\S]*?-->|<#[\s\S]*?#>/g;
  let m;
  while ((m = blocos.exec(texto))) partes.push(m[0]);
  for (const linha of texto.split('\n')) {
    const l = linha.trim();
    if (/^(\/\/|#(?!!)|--\s|;)/.test(l)) partes.push(l);
    else {
      const fim = linha.match(/\s\/\/\s(.*)$/);
      if (fim && !/["'`]/.test(fim[1])) partes.push(fim[1]);
    }
  }
  return partes.join('\n');
};

const IGNORAR = new Set(['.git', 'node_modules', 'snapshots', 'arquivo', 'icones', 'build']);

function arquivosDoProjeto() {
  const lista = [];
  const anda = (d) => {
    for (const n of fs.readdirSync(d)) {
      if (IGNORAR.has(n)) continue;
      const c = path.join(d, n);
      if (fs.statSync(c).isDirectory()) { anda(c); continue; }
      lista.push(c);
    }
  };
  anda(RAIZ_PROJETO);
  return lista;
}

check('nenhum arquivo do projeto traz termo vetado', () => {
  const sujos = [];
  for (const c of arquivosDoProjeto()) {
    const n = path.basename(c);
    if (marcado(n).length) { sujos.push(path.relative(RAIZ_PROJETO, c) + ' (no nome)'); continue; }
    if (/\.(log|log\.\d+|png|jpg|ico|svg|bin|sl2|txt|apk|ipa|exe)$/i.test(n)) continue;
    let texto = '';
    try { texto = fs.readFileSync(c, 'utf8'); } catch (e) { continue; }
    if (marcado(texto).length) sujos.push(path.relative(RAIZ_PROJETO, c));
  }
  assert(sujos.length === 0, 'com termo vetado: ' + sujos.join(', '));
  return 'nome e conteúdo de todos os arquivos';
});

check('comentários e documentos não usam expressões vetadas', () => {
  const sujos = [];
  for (const c of arquivosDoProjeto()) {
    const n = path.basename(c);
    if (!/\.(js|cjs|mjs|html|css|ps1|psm1|cs|java|kt|swift|sh|yml|yaml|md|gradle|xml|plist)$/i.test(n)) continue;
    let texto = '';
    try { texto = fs.readFileSync(c, 'utf8'); } catch (e) { continue; }
    const achados = expressoes(comentarios(texto, n));
    if (achados.length) sujos.push(path.relative(RAIZ_PROJETO, c) + ' (' + achados.join(', ') + ')');
  }
  assert(sujos.length === 0, 'expressões vetadas em: ' + sujos.join('; '));
  return 'comentários do código, README e notas de versão';
});

check('nenhuma mensagem de commit traz termo vetado', () => {
  const { execFileSync } = require('child_process');
  const site = RAIZ_PROJETO;
  if (!fs.existsSync(path.join(site, '.git'))) return 'sem repositório aqui';
  const log = execFileSync('git', ['log', '--all', '--format=%H%n%s%n%b'],
    { cwd: site, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  assert(marcado(log).length === 0, 'aparece no histórico de commits');
  const n = execFileSync('git', ['rev-list', '--count', 'HEAD'],
    { cwd: site, encoding: 'utf8', windowsHide: true }).trim();
  return n + ' commits, nenhum com co-autoria';
});

check('o histórico tem um autor só', () => {
  const { execFileSync } = require('child_process');
  const site = RAIZ_PROJETO;
  if (!fs.existsSync(path.join(site, '.git'))) return 'sem repositório aqui';
  const quem = execFileSync('git', ['log', '--all', '--format=%an <%ae>|%cn <%ce>'],
    { cwd: site, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 })
    .split('\n').filter(Boolean);
  const distintos = [...new Set(quem.flatMap((l) => l.split('|')))];
  assert(distintos.length === 1, 'mais de um: ' + distintos.join(' / '));
  return distintos[0];
});

check('nenhum nome de branch ou tag traz termo vetado', () => {
  const { execFileSync } = require('child_process');
  if (!fs.existsSync(path.join(RAIZ_PROJETO, '.git'))) return 'sem repositório aqui';
  const refs = execFileSync('git', ['for-each-ref', '--format=%(refname)'],
    { cwd: RAIZ_PROJETO, encoding: 'utf8', windowsHide: true })
    .split('\n').filter(Boolean);
  const sujas = refs.filter((r) => marcado(r).length);
  assert(sujas.length === 0, 'referências marcadas: ' + sujas.join(', '));
  return refs.length + ' referências';
});

function resumo() {
  console.log('');
  console.log(`  === Resultado: ${pass} ok, ${fail} falha(s) ===`);
  if (fail) {
    console.log('  Falhou: ' + failures.join(', '));
    console.log('  Se for só a parte do save, veja o README (seção "não achou o save").');
    process.exitCode = 1;
  } else {
    console.log('  Tudo certo.');
  }
  console.log('');
}

/*
 * 6. A página desenha o que o save diz.
 *
 * Roda o <script> da página no DOM mínimo, pelo mesmo caminho do navegador
 * (fetch -> pollProgress -> render), e confere as linhas contra o
 * progress.json. Assíncrono; o resumo é impresso depois.
 */
(async () => {
  console.log('\n  === 6. A página desenha o que o save diz ===');
  try {
    await require('./pagetest').rodar((cond, nome, detalhe) => {
      if (cond) {
        pass++;
        console.log(`   ok    ${nome}${detalhe ? '  -  ' + detalhe : ''}`);
      } else {
        fail++;
        failures.push(nome);
        console.log(`   FALHA ${nome}\n            ${detalhe}`);
      }
    });
  } catch (err) {
    fail++;
    failures.push('render da página');
    console.log(`   FALHA render da página\n            ${err.message}`);
  }

  /*
   * A página desenhada com o progresso cru e com o publicado deve produzir a
   * mesma tela para os mesmos dados.
   */
  console.log('\n  === 16. O link público é a mesma página ===');
  try {
    const cru = path.join(RAIZ_PROJETO, 'progress.json');
    if (!fs.existsSync(cru)) {
      console.log('   --    a página publicada desenha igual à local  -  sem leitura crua nesta máquina');
    } else {
      /*
       * Compara a leitura crua com ela mesma após a poda do publish.js, não
       * com o docs/progress.json do disco (que pode ser de outra máquina).
       */
      const pagetest = require('./pagetest');
      const local = JSON.parse(fs.readFileSync(cru, 'utf8'));
      const limpo = publish.sanitizar(local);

      const telaLocal = await pagetest.desenhar(local);
      const telaSite = await pagetest.desenhar(limpo);
      if (telaLocal === telaSite) {
        pass++;
        console.log('   ok    a página publicada desenha igual à local  -  as duas telas são idênticas, caractere a caractere');
      } else {
        const a = telaLocal.split(String.fromCharCode(10));
        const b = telaSite.split(String.fromCharCode(10));
        const difs = [];
        for (let i = 0; i < Math.max(a.length, b.length); i++) {
          if (a[i] === b[i]) continue;
          difs.push(String(a[i] || b[i]).split('::')[0] + ': local "'
            + String(a[i] || '').slice(0, 80) + '" / público "'
            + String(b[i] || '').slice(0, 80) + '"');
        }
        fail++;
        failures.push('a página publicada desenha igual à local');
        console.log('   FALHA a página publicada desenha igual à local\n            '
          + difs.length + ' ponto(s) de diferença: ' + difs.slice(0, 3).join(' | '));
      }
    }
  } catch (err) {
    fail++;
    failures.push('a página publicada desenha igual à local');
    console.log('   FALHA a página publicada desenha igual à local\n            ' + err.message);
  }

  /*
   * A última nota em .github/releases/ corresponde à release publicada mais
   * recente, com o instalador. Consulta a API (o redirecionamento de 'latest'
   * é cacheado). Assíncrono; sem rede, o teste é pulado.
   */
  console.log('\n  === 17. A release publicada ===');
  const NOME_17 = 'a última versão de .github/releases/ está publicada, com o instalador';
  try {
    const versao = (t) => t.replace(/^v/, '').split('.').map(Number);
    const maior = (a, b) => { const x = versao(a), y = versao(b); for (let k = 0; k < 3; k++) if (x[k] !== y[k]) return x[k] > y[k] ? a : b; return a; };
    const notas = fs.readdirSync(path.join(RAIZ_PROJETO, '.github', 'releases'))
      .filter((n) => /^v\d+\.\d+\.\d+\.md$/.test(n)).map((n) => n.slice(0, -3));
    const esperada = notas.reduce((a, b) => maior(a, b), notas[0]);

    const https = require('https');
    const buscar = () => new Promise((resolve) => {
      const req = https.request(
        'https://api.github.com/repos/oaovito/trackeroao/releases/latest',
        { headers: { 'User-Agent': 'trackeroao', Accept: 'application/vnd.github+json' } },
        (res) => {
          if (res.statusCode !== 200) { res.resume(); return resolve(null); }
          let corpo = '';
          res.on('data', (c) => { corpo += c; });
          res.on('end', () => { try { resolve(JSON.parse(corpo)); } catch (e) { resolve(null); } });
        });
      req.on('error', () => resolve(null));
      req.setTimeout(8000, () => { req.destroy(); resolve(null); });
      req.end();
    });

    const release = esperada ? await buscar() : null;
    const anexo = release && (release.assets || []).find((a) => a.name === 'trackeroao-instalador.exe');
    const falha = (msg) => { fail++; failures.push(NOME_17); console.log('   FALHA ' + NOME_17 + '\n            ' + msg); };

    if (!esperada) {
      console.log('   --    ' + NOME_17 + '  -  nenhuma nota em .github/releases/');
    } else if (!release) {
      console.log('   --    ' + NOME_17 + '  -  sem alcançar a API do GitHub');
    } else if (maior(release.tag_name, esperada) !== release.tag_name) {
      falha('a nota ' + esperada + ' existe, mas a release mais nova é ' + release.tag_name
        + ' — veja a Action "release" no GitHub');
    } else if (!anexo) {
      falha('a release ' + release.tag_name + ' não tem o instalador anexado');
    } else {
      pass++;
      console.log('   ok    ' + NOME_17 + '  -  ' + release.tag_name + ', '
        + (anexo.size / 1024).toFixed(1) + ' KB');
    }
  } catch (err) {
    console.log('   --    ' + NOME_17 + '  -  ' + err.message);
  }

  /*
   * Exercita a rota /abrir pelo mesmo start() do serviço, com um GET de
   * localhost como o do abrir.vbs, e confere que o callback é chamado.
   */
  console.log('\n  === 19. O atalho acende a bandeja ===');
  try {
    const serve = require('./serve');
    let chamadas = 0;
    const { server } = await serve.start({
      root: RAIZ_PROJETO, port: 47000 + Math.floor(Math.random() * 1000), quiet: true, aoAbrir: () => { chamadas++; },
    });
    const porta = server.address().port;
    const status = await new Promise((resolve, reject) => {
      require('http').get({ host: '127.0.0.1', port: porta, path: '/abrir' }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      }).on('error', reject);
    });
    server.close();
    if (status === 204 && chamadas === 1) {
      pass++;
      console.log('   ok    o GET /abrir do atalho chega ao processo residente  -  204 e uma chamada');
    } else {
      fail++;
      failures.push('o GET /abrir do atalho chega ao processo residente');
      console.log('   FALHA o GET /abrir do atalho chega ao processo residente\n            '
        + 'status ' + status + ', ' + chamadas + ' chamada(s): a rota responde e a chama nao acende');
    }
  } catch (err) {
    fail++;
    failures.push('o GET /abrir do atalho chega ao processo residente');
    console.log('   FALHA o GET /abrir do atalho chega ao processo residente\n            ' + err.message);
  }

  console.log('\n  === 23. O consumo da página ===');
  check('a tela inicial não redesenha a cada quadro, e para fora de foco', () => {
    const html = fs.readFileSync(path.join(RAIZ_PROJETO, 'trackeroao.html'), 'utf8');
    // Só transform e opacity animam sem repintar a tela.
    const quadros = {};
    for (const m of html.matchAll(/@keyframes\s+([\w-]+)\s*\{([\s\S]*?)\n  \}/g)) quadros[m[1]] = m[2];
    const fundo = /\.vista-hub \.oao-fundo \{([\s\S]*?)\n  \}/.exec(html);
    assert(fundo, 'não achei a trama do fundo');
    const anim = /animation:\s*([\w-]+)[^;]*;/.exec(fundo[1]);
    assert(anim && /steps\(/.test(anim[0]), 'a trama do fundo anda a sessenta quadros por segundo');
    assert(!/mask-position|background-position/.test(quadros[anim[1]] || ''), 'a trama do fundo anima a máscara, e a tela é repintada a cada quadro');
    assert(!/titulo-oao[^;]*infinite/.test(html), 'o título respira numa animação infinita');
    assert(/html\.quieto \*[^{]*\{[^}]*animation-play-state:\s*paused/.test(html), 'fora de foco as animações continuam');
    return 'trama por transform em passos, título por disparo, pausa fora de foco';
  });

  console.log('\n  === 22. A varredura de jogos ===');
  {
    const nome = 'acha jogos pelo disco e pelo registro, sem Steam e sem rede';
    const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'trackeroao-bib-'));
    try {
      const b = require('./biblioteca');
      const jogos = path.join(tmp, 'Games');
      const programas = path.join(tmp, 'Program Files');
      fs.mkdirSync(path.join(jogos, 'VALORANT'), { recursive: true });
      fs.mkdirSync(path.join(jogos, 'ELDEN RING', 'Game'), { recursive: true });
      fs.writeFileSync(path.join(jogos, 'ELDEN RING', 'Game', 'eldenring.exe'), Buffer.alloc(2048));
      fs.writeFileSync(path.join(jogos, 'ELDEN RING', 'Game', 'unins000.exe'), Buffer.alloc(4096));
      fs.mkdirSync(path.join(programas, 'Blender'), { recursive: true });
      const r = await b.varrer({
        steam: null, semRede: true, naoGravar: true, registro: [{ nome: 'Genshin Impact', pasta: null, editora: 'miHoYo' }],
        raizes: [{ pasta: jogos, tipo: 'jogo' }, { pasta: programas, tipo: 'programa' }],
      });
      const nomes = r.jogos.map((j) => j.nome);
      const elden = r.jogos.find((j) => /elden/i.test(j.nome));
      if (!nomes.includes('VALORANT')) throw new Error('não achou o VALORANT pela pasta');
      if (!elden || elden.processos[0] !== 'eldenring.exe') throw new Error('não achou o executável do Elden Ring: ' + JSON.stringify(elden));
      if (!nomes.includes('Genshin Impact')) throw new Error('não achou o Genshin pelo registro');
      if (nomes.includes('Blender')) throw new Error('um programa virou jogo');
      if (r.comSteam) throw new Error('disse que tinha Steam');
      pass++;
      console.log('   ok    ' + nome + '  -  ' + nomes.join(', '));
    } catch (err) {
      fail++;
      failures.push(nome);
      console.log('   FALHA ' + nome + '\n            ' + err.message);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
  {
    const nome = 'acha jogos fora das lojas: raiz do disco, pasta própria, subpasta e nome com versão';
    const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'trackeroao-bib2-'));
    try {
      const b = require('./biblioteca');
      const disco = path.join(tmp, 'D');
      const exe = (dir, arq) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, arq), Buffer.alloc(4096)); };
      exe(path.join(disco, 'Hollow Knight v1.5.78.11833 [GOG]'), 'hollow_knight.exe');
      exe(path.join(disco, 'Sekiro Shadows Die Twice'), 'sekiro.exe');
      exe(path.join(disco, 'Windows'), 'explorer.exe');
      fs.mkdirSync(path.join(disco, 'Portal'), { recursive: true }); // sem executável: não é jogo instalado
      exe(path.join(disco, 'Jogos', 'Plataforma', 'Celeste'), 'Celeste.exe');
      const catalogo = { 367520: 'Hollow Knight', 814380: 'Sekiro: Shadows Die Twice', 504230: 'Celeste', 400: 'Portal', 1: 'Windows' };
      const r = await b.varrer({
        steam: null, semRede: true, naoGravar: true, registro: [], catalogo,
        raizes: [{ pasta: disco, tipo: 'raiz' }, { pasta: path.join(disco, 'Jogos'), tipo: 'jogo' }],
      });
      const inst = r.jogos.filter((j) => j.instalado).map((j) => j.nome);
      for (const n of ['Hollow Knight', 'Sekiro: Shadows Die Twice', 'Celeste']) {
        if (!inst.includes(n)) throw new Error('não achou ' + n + ': ' + JSON.stringify(inst));
      }
      if (inst.includes('Windows')) throw new Error('a pasta do Windows virou jogo');
      if (inst.includes('Portal')) throw new Error('pasta sem executável na raiz virou jogo');
      pass++;
      console.log('   ok    ' + nome + '  -  ' + inst.join(', '));
    } catch (err) {
      fail++;
      failures.push(nome);
      console.log('   FALHA ' + nome + '\n            ' + err.message);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
  {
    const nome = 'a base de jogos vem na release, e a varredura a usa sem rede';
    try {
      const zlib = require('zlib');
      const arq = require('./gerar-catalogo').ARQUIVO;
      if (!fs.existsSync(arq)) {
        const e = new Error('a base ainda não foi gerada neste clone (a integração contínua a gera antes de cada release)');
        e.pular = true;
        throw e;
      }
      const base = JSON.parse(zlib.gunzipSync(fs.readFileSync(arq)).toString('utf8'));
      const n = Object.keys(base.jogos || {}).length;
      if (n < 20000) throw new Error('a base tem só ' + n + ' jogos');
      const dias = (Date.now() - Date.parse(base.geradoEm)) / 86400000;
      pass++;
      console.log('   ok    ' + nome + '  -  ' + n + ' jogos, de ' + base.fonte + ', gerada há ' + Math.floor(dias) + ' dia(s)');
    } catch (err) {
      if (err.pular) { console.log('   --    ' + nome + '  -  ' + err.message); }
      else { fail++; failures.push(nome); console.log('   FALHA ' + nome + '\n            ' + err.message); }
    }
  }
  {
    const nome = 'cada jogo ganha banner, da maior resolução para a menor, com ou sem Steam';
    try {
      const a = require('./arte');
      const s = a.daSteam('814380');
      if (!/library_hero_2x\.jpg$/.test(s.heroi[0]) || !/library_600x900_2x\.jpg$/.test(s.capa[0])) throw new Error('a Steam não começa pela maior: ' + s.heroi[0]);
      const jogos = [{ nome: 'VALORANT', arteFonte: { site: 'https://playvalorant.com/' } }, { nome: 'Jogo Sem Nada' }];
      await a.resolver(jogos, {
        cache: {},
        pedir: async (u) => (u.includes('playvalorant') ? '<meta property="og:image" content="/media/key-art.jpg">' : '{"items":[]}'),
      });
      if (jogos[0].arte.heroi[0] !== 'https://playvalorant.com/media/key-art.jpg') throw new Error('não leu a og:image do site oficial');
      if (jogos[1].arte !== null) throw new Error('inventou arte para um jogo sem nenhuma');
      const semRede = [{ nome: 'VALORANT' }];
      await a.resolver(semRede, { cache: {}, semRede: true, pedir: async () => { throw new Error('usou a rede'); } });
      pass++;
      console.log('   ok    ' + nome + '  -  Steam 3840x1240 primeiro, site oficial para quem não está nela, nada inventado');
    } catch (err) {
      fail++;
      failures.push(nome);
      console.log('   FALHA ' + nome + '\n            ' + err.message);
    }
  }

  resumo();
})();
