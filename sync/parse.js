'use strict';
/*
 * parse.js - turns a Sekiro save into the progress.json read by the tracker.
 *
 * Data comes mainly from the item table and event flags. Anything that cannot
 * be read reliably is left out instead of guessed.
 */

const fs = require('fs');
const path = require('path');

const sl2 = require('./sl2');
const inventory = require('./inventory');
const flags = require('./flags');
const deaths = require('./deaths');
const deathsmem = require('./deathsmem');
const tempo = require('./tempo');
const bosskills = require('./bosskills');
const achievements = require('./achievements');
const conquistasave = require('./conquistasave');
const jogador = require('./jogador');
const jogosCat = require('./jogos');
const conquistas = require('./conquistas');
const efeitos = require('./efeitos');
const memoria = require('./memoria');

const CONFIG_PATH = path.join(__dirname, 'offsets.json');
const STATE_PATH = path.join(__dirname, '.state.json');

function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch (e) {
    return {};
  }
}

function saveState(state) {
  try {
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
  } catch (e) {
    /* state is only an optimisation; never fail the run over it */
  }
}

/**
 * Picks which of the ten character slots to read.
 *
 * "auto" prefers the slot last seen being written (recorded in .state.json);
 * otherwise falls back to the most-progressed non-empty slot.
 */
function chooseSlot(save, config, state) {
  const entries = sl2.slotEntries(save);
  const nonEmpty = sl2.nonEmptySlots(save);

  if (typeof config.slot === 'number') {
    return { entry: entries[config.slot], index: config.slot, how: 'configured' };
  }
  if (state.activeSlot !== undefined && state.activeSlot !== null) {
    const e = entries[state.activeSlot];
    if (e && !sl2.isSlotEmpty(save, e)) {
      return { entry: e, index: state.activeSlot, how: 'learned' };
    }
  }
  if (!nonEmpty.length) return { entry: null, index: null, how: 'none' };

  // Heuristic: the slot holding the most distinct items is the furthest along.
  let best = null;
  for (const entry of nonEmpty) {
    const payload = sl2.blockPayload(save.buf, entry);
    const { items } = inventory.readItemTable(payload, config.itemTable);
    if (!best || items.length > best.count) {
      best = { entry, count: items.length, index: entry.index };
    }
  }
  return { entry: best.entry, index: best.index, how: 'heuristic' };
}

function goodsQuantities(payload, config) {
  const { region, items, error } = inventory.readItemTable(payload, config.itemTable);
  // Prosthetic tools and combat arts are 'weapon' records; presence = unlocked.
  const weapons = new Set();
  for (const it of items) if (it.category === 'weapon') weapons.add(it.paramId);
  return {
    region,
    error,
    goods: inventory.quantityMap(items, 'goods'),
    weapons,
    itemCount: items.length,
  };
}

/**
 * Mini-bosses, read from event flags. The flag block is first validated (and
 * relocated if needed) against the boss Memories in the item table.
 */
function buildMiniBosses(payload, config, bosses, goods) {
  const cfg = config.eventFlags;
  if (!cfg || cfg.base === null || cfg.base === undefined) {
    return { list: [], calibration: { how: 'not-configured' } };
  }

  const expected = {};
  const byKey = new Map(bosses.map((b) => [b.key, b]));
  for (const bf of cfg.bossFlags.list) {
    const b = byKey.get(bf.key);
    // Referência: só chefes confirmados por Memory (os que dependem de flag
    // ainda são null aqui).
    if (b && typeof b.defeated === 'boolean') expected[bf.flag] = b.defeated;
  }

  const cal = flags.calibrate(payload, cfg, expected);
  if (cal.how === 'failed') {
    // Unverified block: report nothing.
    return { list: [], calibration: cal };
  }
  const effective = Object.assign({}, cfg, { base: cal.base });

  // Flag no bloco comum, item exclusivo (Shichimen do Abandoned Dungeon) ou
  // nenhum dos dois (`detected: false`, estado desconhecido).
  const list = cfg.miniBosses.map((m) => {
    const base = { key: m.key, label: m.label, area: m.area, drop: m.drop || null, entity: m.entity };
    if (m.flag) {
      return Object.assign(base, {
        via: 'flag', flag: m.flag, detected: true,
        defeated: flags.read(payload, effective, m.flag) === true,
      });
    }
    if (m.goodsAnyOf) {
      return Object.assign(base, {
        via: 'item', ids: m.goodsAnyOf, detected: true, confidence: m.confidence || null,
        defeated: m.goodsAnyOf.some((id) => goods.has(id)),
      });
    }
    return Object.assign(base, { via: 'none', detected: false, defeated: false });
  });
  return { list, calibration: cal };
}

/**
 * Headless: sem flag legível; cada um larga um Spiritfall exclusivo e
 * permanente, verificado no inventário.
 */
function buildHeadless(config, goods) {
  const cfg = config.headless;
  if (!cfg || !cfg.list) return [];
  return cfg.list.map((h) => ({
    key: h.key,
    label: h.label,
    area: h.area,
    drop: h.drop || null,
    entity: h.entity,
    ids: h.goodsAnyOf,
    via: 'item',
    detected: true,
    defeated: h.goodsAnyOf.some((id) => goods.has(id)),
    confidence: h.confidence,
    enquadre: h.enquadre || null,
  }));
}

/**
 * Sino Demoníaco: ativo enquanto o item "Bell Demon" estiver no inventário.
 */
function buildDemonBell(config, goods) {
  const cfg = config.goods && config.goods.bellDemon;
  if (!cfg) return null;
  return {
    ativo: goods.has(cfg.id),
    id: cfg.id,
    label: cfg.label,
    confidence: cfg.confidence || 'unknown',
  };
}

/**
 * Dragonrot: cada NPC adoecido larga uma Rot Essence exclusiva. Reporta as
 * Rot Essence presentes no inventário e de quem são.
 */
function buildDragonrot(config, goods) {
  const cfg = config.rotEssence;
  if (!cfg || !cfg.list) return null;
  const tocados = cfg.list.filter((r) => goods.has(r.id));
  return {
    ativo: tocados.length > 0,
    quantos: tocados.length,
    total: cfg.list.length,
    essencias: tocados.map((r) => ({ item: r.item, npc: r.npc })),
    confidence: cfg.confidence || 'unknown',
  };
}

/**
 * Sculptor's Idols. As flags ficam em blocos por área, de base ainda
 * desconhecida; sem base, devolve `detected: false`.
 */
function buildIdols(payload, config) {
  const cfg = config.idols;
  if (!cfg || !cfg.list) return { list: [], blocosCalibrados: 0, blocosTotal: 0 };

  const bases = cfg.blockBases || {};
  const blocos = Object.keys(bases);
  const calibrados = blocos.filter((b) => typeof bases[b] === 'number');

  const list = cfg.list.map((i) => {
    const base = bases[i.block];
    if (typeof base !== 'number') {
      return { key: i.key, label: i.label, area: i.area, flag: i.flag, detected: false, unlocked: false };
    }
    const efetivo = { base, zoneStride: cfg.zoneStride || 128 };
    return {
      key: i.key,
      label: i.label,
      area: i.area,
      flag: i.flag,
      detected: true,
      unlocked: flags.read(payload, efetivo, i.flag) === true,
    };
  });

  return { list, blocosCalibrados: calibrados.length, blocosTotal: blocos.length };
}

/** Owning the weapon record for an id means the tool/art is unlocked. */
function buildUnlocks(list, weapons) {
  return list.map((e) => ({
    key: e.key,
    label: e.label,
    id: e.id,
    unlocked: weapons.has(e.id),
    confidence: e.confidence,
  }));
}

/** Things proven by simply holding one of a set of goods. */
function buildGoodsUnlocks(config, goods) {
  const cfg = config.goodsUnlocks;
  if (!cfg || !cfg.list) return [];
  return cfg.list.map((e) => ({
    key: e.key,
    label: e.label,
    ids: e.anyOf,
    drop: e.drop || null,
    unlocked: e.anyOf.some((id) => goods.has(id)),
    confidence: e.confidence,
  }));
}

function buildEssentials(goods, config) {
  const prog = config.progression;
  const beadId = config.goods.prayerBead.id;
  const seedId = config.goods.gourdSeed.id;

  const held = goods.get(beadId) || 0;
  let necklaces = 0;
  for (const id of config.goods.prayerNecklaces.ids) {
    if (goods.has(id)) necklaces++;
  }

  const materials = config.materials.map((m) => ({
    key: m.key,
    label: m.label,
    id: m.id,
    qty: goods.get(m.id) || 0,
    confidence: m.confidence,
  }));

  return {
    prayerBeads: {
      held,
      necklaces,
      beadsPerNecklace: prog.beadsPerNecklace,
      // Collected = held + beads already converted into necklaces.
      collected: necklaces * prog.beadsPerNecklace + held,
      totalInGame: prog.totalPrayerBeads,
      totalNecklaces: prog.totalNecklaces,
      confidence: config.goods.prayerBead.confidence,
    },
    gourdSeeds: {
      // Seeds are consumed when handed to Emma; `collected` is filled in by
      // buildProgress from the pickup flags.
      held: goods.get(seedId) || 0,
      charges: goods.get(config.goods.healingGourd.id) || 0,
      startingCharges: prog.startingGourdCharges,
      collected: null,
      totalInGame: prog.maxGourdSeeds,
      maxCharges: prog.maxGourdCharges,
      confidence: config.goods.gourdSeed.confidence,
    },
    materials,
  };
}

function buildBosses(goods, config) {
  const { unusedBase, usedBase, list, confidence } = config.bossMemories;
  return list.map((b) => {
    // Sem Memory (prólogo, Emma): resolvidos por flag em resolveFlagOnlyBosses.
    if (b.flagOnly) {
      return {
        key: b.key, label: b.label, area: b.area || null, drop: null,
        emblema: b.emblema || null, emblemaPorque: b.emblemaPorque || null, enquadre: b.enquadre || null,
      enquadre: b.enquadre || null,
        defeated: null, memory: null, via: 'flag', flag: b.flag,
        note: b.note || null, confidence: 'high',
      };
    }
    const hasUnused = goods.has(unusedBase + b.n);
    const hasUsed = goods.has(usedBase + b.n);
    return {
      key: b.key,
      label: b.label,
      area: b.area || null,
      drop: b.drop || null,
      emblema: b.emblema || null,
      emblemaPorque: b.emblemaPorque || null,
      enquadre: b.enquadre || null,
      defeated: hasUnused || hasUsed,
      memory: hasUsed ? 'used' : hasUnused ? 'held' : null,
      via: 'memory',
      confidence,
    };
  });
}

/**
 * Itens com flag de obtenção no bloco comum: as 40 Prayer Beads e as 9 Gourd
 * Seeds. A flag permanece depois que o item é usado.
 */
function buildFlagItems(payload, cfg, calibration, itens) {
  if (!itens || !itens.list || !calibration || calibration.how === 'failed' ||
      typeof calibration.base !== 'number') {
    return null;
  }
  const effective = Object.assign({}, cfg, { base: calibration.base });
  return itens.list.map((x) => ({
    key: x.key,
    label: x.label,
    area: x.area,
    from: x.from,
    where: x.where || null,
    flag: x.flag,
    collected: flags.read(payload, effective, x.flag) === true,
  }));
}

/**
 * Contagem de mortes. O offset no save é deduzido por deaths.js a partir das
 * gravações observadas; `observar` roda antes de `paraProgresso` para que a
 * gravação atual já conte.
 */
function buildDeaths(payload, config, goods, weapons, slot, opts) {
  let estado = deaths.load();
  // Só o processo residente observa: a busca compara com a leitura anterior
  // do mesmo processo.
  if (opts && opts.observe === true) {
    try {
      estado = deaths.observar({
        payload, goods, weapons, slot,
        senOffset: config.deathCount && config.deathCount.senOffset,
      });
    } catch (e) {
      // Falha na busca não afeta o resto do progresso.
      estado = deaths.load();
    }
  }
  // A memória do jogo tem prioridade quando calibrada e com o jogo aberto; o
  // save é reserva. O try cobre só a leitura da memória.
  let m = null;
  try {
    m = deathsmem.contagem();
    // Com o jogo fechado, usa a última leitura da memória.
    if (!m) m = deathsmem.ultimaConhecida();
  } catch (e) { /* jogo fechado, ou ainda sem calibração */ }
  if (m) {
    // `escopo`: "jornada" conta desde o início do save; "sessao" só desde que
    // o jogo abriu.
    return {
      known: true,
      count: m.mortes,
      confidence: m.escopo === 'jornada' ? 'high' : 'likely',
      how: 'memoria',
      escopo: m.escopo || 'jornada',
      // `false`: última leitura, com o jogo fechado.
      aoVivo: m.aoVivo !== false,
      em: m.em,
    };
  }
  return deaths.paraProgresso(estado);
}

/** Preenche os chefes sem Memory, após a base de flags ser confirmada. */
function resolveFlagOnlyBosses(bosses, payload, config, calibration) {
  if (!calibration || calibration.how === 'failed' || typeof calibration.base !== 'number') {
    return;
  }
  const effective = Object.assign({}, config.eventFlags, { base: calibration.base });
  for (const b of bosses) {
    if (b.defeated !== null || !b.flag) continue;
    b.defeated = flags.read(payload, effective, b.flag) === true;
    b.detected = true;
  }
}

/** Read the save and produce the progress object. Throws on unreadable saves. */
function buildProgress(options) {
  const opts = options || {};
  const config = opts.config || loadConfig();
  const state = opts.state || loadState();
  const file = opts.file || sl2.findSavePath();

  if (!file) {
    return {
      generatedAt: new Date().toISOString(),
      ok: false,
      error: 'no-save-found',
      message: sl2.MENSAGEM_SEM_SAVE,
    };
  }

  // Reuse the save already read and validated by the watcher.
  const save = opts.save || sl2.readSave(file);
  const chosen = chooseSlot(save, config, state);
  if (!chosen.entry) {
    return {
      generatedAt: new Date().toISOString(),
      ok: false,
      error: 'no-character',
      message: 'The save exists but no character slot has data.',
      source: { file },
    };
  }

  const payload = sl2.blockPayload(save.buf, chosen.entry);
  const { goods, weapons, region, error, itemCount } = goodsQuantities(payload, config);

  const goodsRaw = {};
  for (const [id, qty] of goods) goodsRaw[id] = qty;

  const bosses = buildBosses(goods, config);
  const mini = buildMiniBosses(payload, config, bosses, goods);
  resolveFlagOnlyBosses(bosses, payload, config, mini.calibration);
  const idols = buildIdols(payload, config);
  const beadList = buildFlagItems(payload, config.eventFlags, mini.calibration, config.prayerBeadFlags);
  const seedList = buildFlagItems(payload, config.eventFlags, mini.calibration, config.gourdSeedFlags);

  const essentials = buildEssentials(goods, config);
  // Sementes entregues à Emma são contadas pelas flags.
  if (seedList) essentials.gourdSeeds.collected = seedList.filter((s) => s.collected).length;

  // Calculado antes do objeto porque os efeitos também usam a contagem.
  const conq = (() => {
    /*
     * Conquistas deduzidas do save (conquistasave.js). Quando a Steam existe,
     * acrescenta as de outros saves e marca divergências.
     */
    let daSteam = null;
    try { daSteam = achievements.conquistas({ conta: tempo.contaDoSave(file) }); } catch (e) { daSteam = null; }
    let c = null;
    try {
      const cal = mini.calibration;
      const efetivo = cal && cal.how !== 'failed' && typeof cal.base === 'number'
        ? Object.assign({}, config.eventFlags, { base: cal.base }) : null;
      const doSave = conquistasave.derivar({
        f: efetivo ? (id) => flags.read(payload, efetivo, id) : null,
        goods, armas: weapons, essenciais: essentials,
      });
      c = conquistasave.juntar(doSave, daSteam);
    } catch (e) {
      c = daSteam;
    }
    if (!c || !Array.isArray(c.lista)) return c;
    /*
     * Ícone e dificuldade são associados por nome, não por posição. A tabela
     * vem das estatísticas públicas da Steam (`npm run conquistas`).
     */
    let tabela = null;
    try { tabela = conquistas.carregar(); } catch (e) { tabela = null; }
    if (!tabela) return c;
    const lista = c.lista.map((a) => {
      const t = tabela[conquistas.slug(a.nome)];
      const extra = t
        ? { icone: t.icone, dificuldade: t.dificuldade, raridade: t.percent }
        : {};
      /*
       * Conquistas ocultas usam a descrição do troféu equivalente do
       * PlayStation; `descricaoOculta` marca essa origem.
       */
      if (!a.descricao) {
        const r = conquistas.descricaoDeReserva(a.nome);
        if (r) { extra.descricao = r; extra.descricaoOculta = true; }
      }
      return Object.assign({}, a, extra);
    });

    /*
     * A conquista de menor porcentagem global recebe a marca de shinobi.
     * Em caso de empate, vale a primeira.
     */
    let maisRara = null;
    for (const a of lista) {
      if (typeof a.raridade !== 'number') continue;
      if (!maisRara || a.raridade < maisRara.raridade) maisRara = a;
    }
    if (maisRara) maisRara.shinobi = true;

    return Object.assign({}, c, { lista });
  })();

  let saveModified = null;
  try {
    saveModified = fs.statSync(file).mtime.toISOString();
  } catch (e) {
    /* not important */
  }

  return {
    generatedAt: new Date().toISOString(),
    ok: !error,
    source: {
      file,
      slot: chosen.index,
      slotSelection: chosen.how,
      nonEmptySlots: sl2.nonEmptySlots(save).map((e) => e.index),
      saveModified,
      itemTable: region ? { start: region.start, end: region.end, how: region.confidence } : null,
      itemsRead: itemCount,
    },
    essentials,
    deaths: buildDeaths(payload, config, goods, weapons, chosen.index, opts),
    /*
     * Tempo de jogo em duas medidas: o relógio (Steam, em minutos, inclui
     * menus e carregamentos) e o tempo interno do jogo, em milissegundos.
     */
    playtime: (() => {
      /*
       * Tempo interno: memória ou save, o que for maior (o tempo de jogo
       * só aumenta, então o maior é o mais recente).
       */
      let interno = null;
      try {
        const m = deathsmem.contagem() || deathsmem.ultimaConhecida();
        if (m && typeof m.igtHoras === 'number') interno = Math.round(m.igtHoras * 3600);
      } catch (e) { /* jogo fechado e nada guardado ainda */ }
      try {
        const doSave = tempo.doSave(payload, config);
        if (doSave && (interno === null || doSave > interno)) interno = doSave;
      } catch (e) { /* sem offset no config, fica só o da memória */ }

      let t = null;
      try { t = tempo.tempoDeJogo({ save: file, internoSegundos: interno }); } catch (e) { return null; }
      return t;
    })(),
    // Jogos que acendem a aplicação ao abrir; a escolha é feita na página.
    jogosVigiados: (() => {
      try { return jogosCat.paraProgresso(); } catch (e) { return null; }
    })(),
    // Nome do jogador; null sem Steam (ver jogador.js).
    jogador: (() => {
      try { return jogador.quem({ save: file }); } catch (e) { return null; }
    })(),
    // Conquistas do Steam, lidas do cache local (sem chave de API).
    achievements: conq,
    /*
     * Efeitos temporários da sessão (identificada pelo pid do jogo). Só o
     * processo residente aciona. Publica o tempo restante, não o horário.
     */
    efeitos: (() => {
      try {
        if (!(opts && opts.observe === true)) return efeitos.ativos();
        const c = memoria.conectar();
        const s = (() => { try { return deathsmem.daSessao(); } catch (e) { return null; } })();
        return efeitos.atualizar({
          pid: c.ok ? c.pid : null,
          mortesNaSessao: s ? s.mortes : null,
          conquistas: conq ? conq.desbloqueadas : null,
        });
      } catch (e) { return {}; }
    })(),
    bossKills: (() => {
      try {
        // Só o processo residente acumula, para não contar a mesma transição duas vezes.
        const st = (opts && opts.observe === true) ? bosskills.atualizar(bosses) : bosskills.carregar();
        return bosskills.paraProgresso(bosses, st);
      } catch (e) { return null; }
    })(),
    prayerBeadList: beadList,
    gourdSeedList: seedList,
    bosses,
    tools: buildUnlocks(config.prostheticTools.list, weapons),
    arts: buildUnlocks(config.combatArts.list, weapons),
    miniBosses: mini.list,
    headless: buildHeadless(config, goods),
    demonBell: buildDemonBell(config, goods),
    dragonrot: buildDragonrot(config, goods),
    idols: idols.list,
    idolCalibration: { blocos: idols.blocosCalibrados, total: idols.blocosTotal },
    goodsUnlocks: buildGoodsUnlocks(config, goods),
    flagCalibration: mini.calibration,
    goodsRaw,
    weaponsRaw: [...weapons].sort((a, b) => a - b),
    notes: error ? [error] : [],
  };
}

/**
 * Se a leitura falha e já existe um resultado bom no disco, mantém o resultado
 * bom e o marca como desatualizado (falhas do save costumam ser temporárias).
 */
function preserveGood(outFile, progress) {
  if (progress.ok) return progress;

  let anterior = null;
  try {
    anterior = JSON.parse(fs.readFileSync(outFile, 'utf8'));
  } catch (e) {
    anterior = null;
  }
  if (!anterior || !anterior.ok) return progress;

  return Object.assign({}, anterior, {
    stale: {
      desde: new Date().toISOString(),
      error: progress.error,
      message: progress.message,
      // O que está sendo mostrado é a última leitura boa, desta data:
      leituraDe: anterior.generatedAt,
    },
  });
}

// ------------------------------------------------------------------ histórico
const HISTORY_MAX = 80;

/** Listas de booleanos (chefes, mini-chefes, próteses, artes, itens). */
const LISTAS = [
  { campo: 'bosses', marca: 'defeated', tipo: 'boss', verbo: 'defeated' },
  { campo: 'miniBosses', marca: 'defeated', tipo: 'mini-boss', verbo: 'defeated' },
  { campo: 'headless', marca: 'defeated', tipo: 'headless', verbo: 'defeated' },
  { campo: 'prayerBeadList', marca: 'collected', tipo: 'prayer-bead', verbo: 'collected' },
  { campo: 'gourdSeedList', marca: 'collected', tipo: 'gourd-seed', verbo: 'collected' },
  { campo: 'tools', marca: 'unlocked', tipo: 'prosthetic', verbo: 'unlocked' },
  { campo: 'arts', marca: 'unlocked', tipo: 'art', verbo: 'learned' },
  { campo: 'goodsUnlocks', marca: 'unlocked', tipo: 'item', verbo: 'obtained' },
];

function contadores(p) {
  const e = (p && p.essentials) || {};
  const out = {};
  if (e.prayerBeads) {
    out['Prayer Beads'] = e.prayerBeads.collected;
    out['Prayer Necklaces'] = e.prayerBeads.necklaces;
  }
  if (e.gourdSeeds) out['Gourd Seeds'] = e.gourdSeeds.held;
  for (const m of e.materials || []) out[m.label] = m.qty;
  return out;
}

/** Diferenças entre duas leituras boas, para destacar novidades na página. */
function diffProgress(antes, depois) {
  if (!antes || !antes.ok || !depois || !depois.ok) return [];
  const quando = depois.generatedAt;
  const mudancas = [];

  for (const l of LISTAS) {
    const mapaAntes = new Map(((antes[l.campo] || [])).map((x) => [x.key, x]));
    for (const item of depois[l.campo] || []) {
      const velho = mapaAntes.get(item.key);
      if (!velho) continue; // entrada nova na config, não é progresso do jogo
      if (!velho[l.marca] && item[l.marca]) {
        mudancas.push({ at: quando, tipo: l.tipo, chave: item.key, label: item.label, texto: l.verbo });
      } else if (velho[l.marca] && !item[l.marca]) {
        // Pode acontecer se o save for restaurado para um ponto anterior.
        mudancas.push({ at: quando, tipo: l.tipo, chave: item.key, label: item.label, texto: 'back to pending' });
      }
    }
  }

  const cAntes = contadores(antes);
  const cDepois = contadores(depois);
  for (const nome of Object.keys(cDepois)) {
    const a = cAntes[nome];
    const b = cDepois[nome];
    if (typeof a !== 'number' || typeof b !== 'number' || a === b) continue;
    mudancas.push({
      at: quando,
      tipo: 'counter',
      chave: nome,
      label: nome,
      texto: `${a} → ${b}`,
      subiu: b > a,
    });
  }
  return mudancas;
}

/**
 * Produz o objeto final que vai para o disco: preserva a última leitura boa se
 * esta falhou, e carrega o histórico de mudanças adiante.
 */
function finalizeProgress(outFile, progress) {
  let anterior = null;
  try {
    anterior = JSON.parse(fs.readFileSync(outFile, 'utf8'));
  } catch (e) {
    anterior = null;
  }

  const final = preserveGood(outFile, progress);
  const historico = (anterior && anterior.history) || [];

  // Só compara leituras boas; resultado preservado não gera histórico.
  const novas = final.stale ? [] : diffProgress(anterior, final);
  final.history = historico.concat(novas).slice(-HISTORY_MAX);
  return final;
}

function writeProgress(outFile, progress) {
  const tmp = outFile + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(progress, null, 2));
  fs.renameSync(tmp, outFile); // atomic-ish: the page never sees a half file
  return outFile;
}

// ------------------------------------------------------------------- summary
function formatSummary(p) {
  if (!p.ok && p.error) return `  ! ${p.message}`;
  const e = p.essentials;
  const lines = [];
  lines.push(`  save   : ${p.source.file}`);
  lines.push(`  slot   : ${p.source.slot} (${p.source.slotSelection})  itens lidos: ${p.source.itemsRead}`);
  lines.push(
    `  contas : ${e.prayerBeads.collected}/${e.prayerBeads.totalInGame} coletadas ` +
      `(${e.prayerBeads.held} na bolsa, ${e.prayerBeads.necklaces}/${e.prayerBeads.totalNecklaces} colares)`
  );
  lines.push(`  cabaça : ${e.gourdSeeds.held} semente(s) na bolsa (de ${e.gourdSeeds.totalInGame} no jogo)`);
  const mats = e.materials.filter((m) => m.qty > 0).map((m) => `${m.key}=${m.qty}`);
  lines.push(`  mater. : ${mats.length ? mats.join('  ') : '(nenhum)'}`);
  const dead = p.bosses.filter((b) => b.defeated);
  lines.push(`  chefes : ${dead.length}/${p.bosses.length} com memória`);
  for (const b of dead) lines.push(`             - ${b.label}`);
  const tools = p.tools.filter((t) => t.unlocked);
  lines.push(`  prótese: ${tools.length}/${p.tools.length}  ${tools.map((t) => t.label).join(', ') || '(nenhuma)'}`);
  const arts = p.arts.filter((a) => a.unlocked);
  lines.push(`  artes  : ${arts.length}/${p.arts.length}  ${arts.map((a) => a.label).join(', ') || '(nenhuma)'}`);
  const idl = p.idols || [];
  const calIdol = p.idolCalibration || {};
  if (idl.length) {
    const det = idl.filter(function (i) { return i.detected; });
    const on = det.filter(function (i) { return i.unlocked; }).length;
    const sufixo = calIdol.blocos === calIdol.total
      ? ' (todos os blocos calibrados)'
      : ' - ' + calIdol.blocos + '/' + calIdol.total + ' blocos calibrados; rode "npm run discover idol"';
    lines.push('  ídolos : ' + on + '/' + idl.length + sufixo);
  }
  const all = p.miniBosses || [];
  const mb = all.filter((m) => m.defeated);
  const cal = p.flagCalibration || {};
  lines.push(`  mini   : ${mb.length}/${all.length} por event flag (base ${cal.how}, ${cal.checked || 0} conferências)`);
  for (const m of mb) lines.push(`             - ${m.label} [${m.area}]`);
  return lines.join('\n');
}

module.exports = {
  CONFIG_PATH,
  STATE_PATH,
  loadConfig,
  loadState,
  saveState,
  chooseSlot,
  buildIdols,
  buildProgress,
  preserveGood,
  diffProgress,
  finalizeProgress,
  writeProgress,
  formatSummary,
};

// ----------------------------------------------------------------------- CLI
if (require.main === module) {
  const out = path.join(__dirname, '..', 'progress.json');
  try {
    const progress = finalizeProgress(out, buildProgress({}));
    writeProgress(out, progress);
    console.log('Progresso lido:');
    console.log(formatSummary(progress));
    console.log(`\n  -> escrito em ${out}`);
  } catch (err) {
    console.error('Falha ao ler o save:', err.message);
    process.exitCode = 1;
  }
}
