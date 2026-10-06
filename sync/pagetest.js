/**
 * Roda os renderizadores da página contra um progress.json, no DOM mínimo,
 * para detectar campos renomeados que deixam linhas sem marcação.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { install, stripTags } = require('./domshim.js');

const RAIZ = path.join(__dirname, '..');
const PAGINA = path.join(RAIZ, 'trackeroao.html');

const IDS = ['categories', 'topics', 'essentials', 'beads', 'seeds', 'bosses', 'minibosses', 'headless',
  'deaths', 'deathsCount', 'deathsNote', 'syncDot', 'syncText', 'anelFio', 'overallPct', 'overallCount', 'tempoNum', 'skillEmote', 'marcos', 'bossPanel', 'bossHead', 'bossNum', 'bossLista', 'bossNota', 'quadroTempo', 'tempoRot', 'therm', 'thermFill', 'thermPin',
  'idols', 'novidades', 'syncDot', 'syncText', 'overallCount', 'overallLabel', 'overallBar',
  'themeBtn',
  // As listas ficam dentro de janelas nativas.
  'bossJanela', 'headlessJanela', 'conqJanela', 'headlessPanel', 'headlessHead',
  'headlessNum', 'headlessLista', 'anelPanel', 'anelHead', 'conqLista'];

/** Carrega o <script> da página num contexto com o progress.json fornecido. */
async function carregar(progress, opts) {
  const html = fs.readFileSync(PAGINA, 'utf8');
  const blocos = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  if (blocos.length !== 1) throw new Error('esperava um único <script>, achei ' + blocos.length);

  const nodes = install(IDS, opts);
  // O progresso entra por fetch e pollProgress, como no navegador.
  let atual = progress;
  global.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve(atual) });

  // Contexto novo a cada carga: o script declara `const DATA` no topo.
  const ctx = vm.createContext({});
  Object.assign(ctx, {
    document: global.document,
    localStorage: global.localStorage,
    window: global.window,
    location: global.location,
    fetch: global.fetch,
    console,
    setInterval: global.setInterval,
    setTimeout: global.setTimeout,
    clearInterval: global.clearInterval,
    clearTimeout: global.clearTimeout,
  });
  new vm.Script(blocos[0][1], { filename: 'trackeroao.html' }).runInContext(ctx);
  await ctx.pollProgress();

  /**
   * Troca o progresso e redesenha, via fetch + pollProgress. O generatedAt
   * muda a cada troca (por contador), senão a página não redesenha.
   */
  let seq = 0;
  const trocar = async (mudancas) => {
    seq += 1;
    atual = Object.assign({}, progress, mudancas, {
      generatedAt: new Date(Date.now() + seq * 1000).toISOString(),
    });
    await ctx.pollProgress();
    return atual;
  };
  return { nodes, ctx, trocar, original: () => trocar({}) };
}

async function rodar(log) {
  // Sem leitura local do save, usa a versão publicada (tem os campos que a
  // página desenha).
  const cru = path.join(RAIZ, 'progress.json');
  const publicado = path.join(RAIZ, 'docs', 'progress.json');
  const de = fs.existsSync(cru) ? cru : publicado;
  const progress = JSON.parse(fs.readFileSync(de, 'utf8'));
  const { nodes, ctx, trocar, original } = await carregar(progress);
  // `sync` não é visível daqui; confere que a página desenhou algo.
  const desenhou = nodes.bosses.outerHTML.length > 100;
  log(desenhou, 'a página consome o progress.json que o servidor devolve',
    desenhou ? 'fetch -> pollProgress -> render' : 'nada foi desenhado');

  const secoes = [
    ['bosses', 'bosses', 'Bosses'],
    ['minibosses', 'miniBosses', 'Mini-bosses'],
    ['headless', 'headless', 'Headless'],
  ];

  for (const [id, campo, titulo] of secoes) {
    const html = nodes[id].outerHTML;
    const lista = progress[campo] || [];
    const rastreaveis = lista.filter((x) => x.detected !== false);
    const feitos = rastreaveis.filter((x) => x.defeated === true).length;

    log(html.includes(titulo), 'seção ' + titulo + ' é montada',
      html.includes(titulo) ? 'título presente' : 'título ausente');

    const caixas = (html.match(/<input type="checkbox"/g) || []).length;
    log(caixas === lista.length, titulo + ': uma linha por inimigo',
      caixas + ' caixas para ' + lista.length + ' inimigos');

    const marcadas = (html.match(/<input type="checkbox" checked/g) || []).length;
    log(marcadas === feitos, titulo + ': marcadas batem com o save',
      marcadas + ' marcadas, save diz ' + feitos);

    const contador = titulo === 'Bosses' || titulo === 'Mini-bosses' || titulo === 'Headless';
    const esperado = feitos + '/' + rastreaveis.length;
    log(contador && html.includes(esperado), titulo + ': contador do cabeçalho',
      'esperava ' + esperado);

    // Rótulo vazio ou "undefined" indica campo renomeado na config.
    const texto = stripTags(html);
    log(!/undefined|\[object/.test(texto), titulo + ': nenhum rótulo quebrado',
      /undefined/.test(texto) ? 'achei "undefined" no texto' : 'todos com nome');

    // Todo inimigo da config tem de aparecer pelo nome.
    const faltando = lista.filter((x) => !texto.includes(x.label)).map((x) => x.label);
    log(faltando.length === 0, titulo + ': todos os nomes aparecem',
      faltando.length ? 'faltou: ' + faltando.join(', ') : lista.length + ' nomes');
  }

  // Checklists de item: uma linha por unidade, contador igual às flags.
  for (const [id, campo, titulo] of [['beads', 'prayerBeadList', 'Prayer Beads'],
    ['seeds', 'gourdSeedList', 'Gourd Seeds']]) {
    const html = nodes[id].outerHTML;
    const lista = progress[campo] || [];
    const feitos = lista.filter((x) => x.collected).length;
    const caixas = (html.match(/<input type="checkbox"/g) || []).length;
    const marcadas = (html.match(/<input type="checkbox" checked/g) || []).length;
    log(caixas === lista.length, titulo + ': uma linha por unidade',
      caixas + ' linhas para ' + lista.length + ' no jogo');
    log(marcadas === feitos, titulo + ': marcadas batem com as flags',
      marcadas + ' marcadas, flags dizem ' + feitos);
    log(html.includes(feitos + '/' + lista.length), titulo + ': contador do cabeçalho',
      'esperava ' + feitos + '/' + lista.length);
    const faltando = lista.filter((x) => !stripTags(html).includes(x.label));
    log(faltando.length === 0, titulo + ': todos os nomes aparecem',
      faltando.length ? 'faltou: ' + faltando.map((x) => x.label).join(', ') : lista.length + ' nomes');
  }

  // Sem offset, o contador de mortes mostra um traço, não zero.
  const d = progress.deaths || {};
  const mostrado = nodes.deathsCount.textContent;
  log(d.known ? mostrado === String(d.count) : mostrado === '—',
    'contador de mortes no cabeçalho', d.known
      ? 'offset calibrado, mostra ' + mostrado
      : 'sem offset, mostra "' + mostrado + '" em vez de 0');
  log(!/hunting log/i.test(nodes.deaths.outerHTML), 'o texto antigo do cabeçalho saiu',
    'subtítulo removido');

  // O rótulo "deaths" ao lado do número é marcação estática; confere no arquivo.
  const marcacao = fs.readFileSync(PAGINA, 'utf8');
  const linhaMortes = /<div class="deaths-head"[\s\S]*?<\/div>/.exec(marcacao);
  const dentro = linhaMortes ? linhaMortes[0] : '';
  log(/deaths-rot">deaths</.test(dentro), 'o rótulo "deaths" está ao lado do número',
    dentro ? stripTags(dentro).replace(/\s+/g, ' ').trim() : 'não achei o cabeçalho');
  const rotuloDepois = dentro.indexOf('deathsCount') < dentro.indexOf('deaths-rot');
  log(rotuloDepois, 'e vem depois do número, não antes', '死 <número> deaths');

  // Termômetro: pino e preenchimento seguem a contagem; escala até 1000.
  for (const caso of [
    { count: 0, pct: '0%' }, { count: 250, pct: '25%' }, { count: 1000, pct: '100%' },
    { count: 2500, pct: '100%', over: true },
  ]) {
    await trocar({ deaths: { known: true, count: caso.count, how: 'discovered', confidence: 'likely' } });
    const bate = nodes.thermFill.style.width === caso.pct && nodes.thermPin.style.left === caso.pct;
    log(bate, 'termômetro em ' + caso.count + ' mortes',
      'barra ' + nodes.thermFill.style.width + ', pino ' + nodes.thermPin.style.left +
      ' (esperado ' + caso.pct + ')');
    if (caso.over) {
      log(/\bover\b/.test(nodes.deaths.className) && nodes.deathsCount.textContent === '2500',
        'acima de 1000 o pino encosta mas o número real continua',
        'classe "' + nodes.deaths.className + '", mostra ' + nodes.deathsCount.textContent);
    }
  }
  // Durante a busca, o painel não mostra texto explicativo.
  await trocar({ deaths: { known: false, count: null, how: 'learning', progresso: { fase: 'baseline', gravacoes: 0, mortes: 0 } } });
  const limpo = nodes.deathsNote.textContent.trim() === '';
  log(limpo, 'painel sem texto enquanto a busca corre',
    limpo ? 'nota vazia' : 'sobrou: "' + nodes.deathsNote.textContent.slice(0, 60) + '"');

  // --- menu de tópicos ---
  await original();

  // Estado inicial: só o menu, sem seção aberta nem botão marcado.
  const secInicial = (id) => nodes[id].children[0];
  const limpoNoInicio =
    ['essentials', 'beads', 'seeds', 'bosses', 'minibosses', 'headless', 'idols']
      .every((id) => !secInicial(id) || secInicial(id).hidden === true) &&
    !/topic on/.test(nodes.topics.outerHTML);
  log(limpoNoInicio, 'estado inicial não mostra seção nenhuma',
    limpoNoInicio ? 'só o menu' : 'alguma seção apareceu sem ninguém escolher');

  const menu = nodes.topics.outerHTML;
  const esperados = ['Bosses', 'Mini-bosses', 'Items'];
  const ausentes = esperados.filter((t) => !menu.includes(t));
  log(ausentes.length === 0, 'menu tem os três tópicos',
    ausentes.length ? 'faltou: ' + ausentes.join(', ') : esperados.join(', '));
  log(!/>All</.test(menu), 'o tópico "All" saiu do menu',
    /All</.test(menu) ? 'All ainda está lá' : 'nenhum atalho de ver tudo');

  // Três tópicos e a gaveta, nessa ordem.
  const naBarra = nodes.topics.children;
  const topicosFixos = naBarra.filter((c) => c.tagName === 'BUTTON');
  log(topicosFixos.length === 3, 'menu tem exatamente três tópicos fixos',
    topicosFixos.length + ' botões soltos na barra');
  const gaveta = naBarra.find((c) => /(^| )gaveta( |$)/.test(c.className));
  log(!!gaveta, 'a gaveta de três risquinhos existe', gaveta ? 'presente' : 'ausente');
  const risquinhos = gaveta && gaveta.children[0] ? gaveta.children[0].children.length : 0;
  log(risquinhos === 3, 'a gaveta é desenhada com três risquinhos', risquinhos + ' traços');

  // Prosthetic Tools mora na gaveta, não na barra.
  const naGaveta = gaveta && gaveta.children[1] ? stripTags(gaveta.children[1].outerHTML) : '';
  log(naGaveta.includes('Prosthetic Tools'), '"Prosthetic Tools" está dentro da gaveta',
    naGaveta.trim() ? 'gaveta: ' + naGaveta.replace(/\s+/g, ' ').trim() : 'gaveta vazia');
  const barraTexto = topicosFixos.map((b) => stripTags(b.outerHTML)).join(' | ');
  for (const fora of ['Prayer Beads', 'Gourd Seeds', 'Headless', 'Prosthetic Tools']) {
    log(!barraTexto.includes(fora), 'a barra não lista "' + fora + '"', 'fora da barra do menu');
  }

  // Escolher uma aba mostra ela e esconde as outras.
  const secao = (id) => nodes[id].children[0];
  ctx.selecionarAba('Bosses');
  const soBosses = secao('bosses').hidden === false && secao('beads').hidden === true;
  log(soBosses, 'escolher um tópico isola a seção',
    'bosses hidden=' + secao('bosses').hidden + ', beads hidden=' + secao('beads').hidden);
  log(/class="topic on"|topic on/.test(nodes.topics.outerHTML), 'o tópico escolhido fica marcado',
    'classe "on" aplicada');

  // Fechar a seção fecha a aba: volta ao menu e à página limpa.
  ctx.setOpen(secao('bosses'), 'bosses');
  const fechou = secao('bosses').hidden && secao('essentials').hidden &&
    !/topic on/.test(nodes.topics.outerHTML);
  log(fechou, 'fechar a seção volta ao estado limpo',
    fechou ? 'nada mostrado, nenhum botão marcado' : 'a seção ou o botão continuaram');

  // Clicar de novo no tópico marcado também fecha. Busca por `outerHTML`
  // porque o botão é montado com appendChild.
  const clicar = (el) => el.listeners.click[0]({ stopPropagation() {} });
  const nomeDe = (b) => stripTags(b.outerHTML).replace(/\d+\/\d+$/, '').trim();
  const botao = (nome) => nodes.topics.children.find((b) => nomeDe(b) === nome);

  clicar(botao('Mini-bosses'));
  const abriu = !secao('minibosses').hidden;
  clicar(botao('Mini-bosses'));
  const fechouPeloMenu = secao('minibosses').hidden &&
    !/topic on/.test(nodes.topics.outerHTML);
  log(abriu && fechouPeloMenu, 'clicar no tópico marcado fecha a aba',
    'abriu=' + abriu + ', fechou=' + fechouPeloMenu);

  // --- alfinete ---
  const alfinete = (id) => secao(id).children[0].children.find((c) => /(^| )pin( |$)/.test(c.className));
  log(!!alfinete('beads'), 'cada seção tem alfinete no cabeçalho',
    alfinete('beads') ? 'presente' : 'ausente');
  log(alfinete('bosses').className.includes('on') && !alfinete('beads').className.includes('on'),
    'as três do menu começam alfinetadas e as outras não',
    'bosses="' + alfinete('bosses').className + '", beads="' + alfinete('beads').className + '"');

  clicar(alfinete('beads'));
  const entrou = nodes.topics.outerHTML.includes('Prayer Beads');
  log(entrou, 'alfinetar põe a seção no menu',
    entrou ? 'Prayer Beads entrou' : 'não entrou');
  const naBarraDepois = nodes.topics.children.filter((c) => c.tagName === 'BUTTON').length;
  log(naBarraDepois === 4, 'a barra cresce de um', naBarraDepois + ' tópicos na barra');

  clicar(alfinete('beads'));
  log(!nodes.topics.outerHTML.includes('Prayer Beads'), 'desalfinetar tira do menu', 'saiu');

  // Desalfinetar a seção aberta não pode deixar ela na tela sem botão que a feche.
  clicar(alfinete('beads'));
  clicar(botao('Prayer Beads'));
  const aberta = !secao('beads').hidden;
  clicar(alfinete('beads'));
  const semBeco = secao('beads').hidden && !/topic on/.test(nodes.topics.outerHTML);
  log(aberta && semBeco, 'desalfinetar a aba aberta volta ao estado limpo',
    'abriu=' + aberta + ', fechou=' + semBeco);

  // "Items" reúne seis seções, com as de item primeiro.
  ctx.selecionarAba('Items');
  const grupo = !secao('beads').hidden && !secao('seeds').hidden && !secao('essentials').hidden;
  log(grupo, 'o tópico "Items" abre todas as seções de item',
    grupo ? 'contas, sementes e essenciais juntas' : 'faltou alguma');
  log(!secao('bosses').hidden === false, '"Items" não arrasta os chefes junto',
    'bosses hidden=' + secao('bosses').hidden);
  const ordemCerta = Number(secao('beads').style.order) < Number(secao('essentials').style.order);
  log(ordemCerta, 'dentro do grupo as contas vêm antes dos essenciais',
    'beads order=' + secao('beads').style.order + ', essentials order=' + secao('essentials').style.order);

  // Recolher uma seção do grupo só fecha a aba quando é a última.
  ctx.setOpen(secao('beads'), 'beads');
  const grupoIntacto = !secao('essentials').hidden && !secao('seeds').hidden;
  log(grupoIntacto, 'fechar uma seção do grupo não fecha as irmãs',
    grupoIntacto ? 'as demais seguem visíveis' : 'a aba caiu inteira');
  ctx.selecionarAba(null);

  // Aba salva inexistente volta ao estado inicial.
  ctx.selecionarAba('Uma Aba Que Sumiu');
  await original();
  const voltou = secao('essentials').hidden && secao('bosses').hidden &&
    !/topic on/.test(nodes.topics.outerHTML);
  log(voltou, 'aba salva que não existe mais volta ao estado inicial',
    voltou ? 'nada mostrado, nenhum botão marcado' : 'sobrou seção visível ou botão marcado');
  ctx.selecionarAba('*');

  // --- ritmo do poll conforme onde a página está servida ---
  // Rede local: poll rápido; GitHub Pages: poll mais espaçado.
  for (const caso of [
    { hostname: 'localhost', esperado: 5000, onde: 'nesta máquina' },
    { hostname: '192.168.1.10', esperado: 5000, onde: 'na rede local' },
    { hostname: 'sekiro.local', esperado: 5000, onde: 'pelo nome na rede local' },
    { hostname: 'oaovito.github.io', esperado: 60000, onde: 'no GitHub Pages' },
  ]) {
    await carregar(progress, { hostname: caso.hostname, protocol: 'https:' });
    const pedido = global.intervalosPedidos[global.intervalosPedidos.length - 1];
    log(pedido === caso.esperado, 'poll ' + caso.onde + ': ' + caso.esperado / 1000 + 's',
      'pediu ' + (pedido / 1000) + 's para ' + caso.hostname);
  }

  // --- tema e assinatura ---
  // O tema padrão é o escuro, independentemente do sistema.
  await carregar(progress, { hostname: 'localhost' });
  const temaInicial = global.document.documentElement.getAttribute('data-theme');
  log(temaInicial === 'dark', 'sem escolha salva, o site abre escuro',
    'data-theme="' + temaInicial + '"');

  const fonte = fs.readFileSync(PAGINA, 'utf8');
  log(!/@media \(prefers-color-scheme/.test(fonte),
    'nenhuma regra de CSS segue o tema do sistema',
    'o escuro vale mesmo se o script não rodar');

  // O nome do cabeçalho vem dos dados; nenhum nome fixo no HTML.
  log(!/oaovito game progress/.test(fonte), 'nenhum nome de pessoa escrito no cabeçalho',
    'a assinatura vem do apelido do Steam da máquina');
  log(/id="assinatura"[^>]*hidden/.test(fonte), 'e ela nasce escondida',
    'sem Steam identificado a linha some e o cabeçalho fecha');
  log(/game progress"/.test(fonte) || /\+ " game progress"/.test(fonte),
    'o sufixo continua sendo "game progress"', 'só o nome é que varia');
  // Inclui o ponto de sync e os botões de voltar, avançar e início.
  log(/class="topbar"[\s\S]{0,2000}themeToggle/.test(fonte),
    'o botão de tema fica na faixa do topo', 'fora do cabeçalho, à direita');

  // --- estado do sync escondido dentro do ponto ---
  await carregar(progress, { hostname: 'localhost' });
  const ponto = nodes.syncDot;
  const texto = nodes.syncText;

  // O DOM mínimo não lê a marcação; o estado inicial é conferido no arquivo.
  log(/id="syncText" hidden/.test(fs.readFileSync(PAGINA, 'utf8')),
    'o texto do sync começa escondido na marcação', 'atributo hidden presente');
  texto.hidden = true;
  log(/slot/.test(texto.textContent), 'mas o texto está lá, pronto para aparecer',
    JSON.stringify(texto.textContent.slice(0, 46)));
  log(/Sync status/.test(ponto.getAttribute('aria-label') || ''),
    'o ponto anuncia o estado para leitor de tela',
    ponto.getAttribute('aria-label') ? 'aria-label preenchido' : 'sem rótulo');

  ponto.listeners.click[0]({});
  log(texto.hidden === false && ponto.getAttribute('aria-expanded') === 'true',
    'clicar no ponto revela o texto',
    'hidden=' + texto.hidden + ', aria-expanded=' + ponto.getAttribute('aria-expanded'));

  // Uma nova leitura não altera o estado aberto/fechado.
  await trocar({});
  log(texto.hidden === false, 'a leitura seguinte não fecha o que foi aberto',
    'continua visível');

  ponto.listeners.click[0]({});
  log(texto.hidden === true, 'clicar de novo esconde', 'voltou a esconder');

  // --- blocos 2 e 3: tempo de jogo e mortes de chefe ---
  await carregar(progress, { hostname: 'localhost' });
  const src = fs.readFileSync(PAGINA, 'utf8');

  // Ordem: contagens de combate, mortes, conquistas e tempo de jogo.
  const iMenu = src.indexOf('class="topics"');
  const iCombate = src.indexOf('id="bossPanel"');
  const iCabeca = src.indexOf('id="headlessPanel"');
  const iMortes = src.indexOf('class="deaths-panel"');
  const iAnel = src.indexOf('class="quadro quadro-anel"');
  const iTempo = src.indexOf('id="quadroTempo"');
  const ordem = [iMenu, iCombate, iCabeca, iMortes, iAnel, iTempo];
  log(ordem.every((p, i) => p > 0 && (i === 0 || p > ordem[i - 1])),
    'ordem dos blocos: chefes e Headless, mortes, conquistas e tempo',
    ordem.join(' < '));
  // Os quadrados de combate e os de medida são duas fileiras, não uma grade só.
  const fileiras = (src.match(/class="dois-quadrados"/g) || []).length;
  log(fileiras === 2, 'são duas fileiras de quadrados', fileiras + ' fileiras');
  // A lista fica entre as duas fileiras.
  const iLista = src.indexOf('id="bossLista"');
  log(iLista > iCabeca && iLista < iMortes,
    'a lista dos chefes fica entre as contagens e o resto',
    'lista em ' + iLista + ', entre ' + iCabeca + ' e ' + iMortes);

  const t = progress.playtime;
  log(!!t && t.horas > 0, 'o tempo de jogo chega do Steam',
    t ? t.horas.toFixed(1) + ' h (' + t.minutos + ' min)' : 'ausente');
  const horasNaTela = nodes.tempoNum.textContent;
  log(horasNaTela !== '—' && horasNaTela !== '', 'o quadrado mostra as horas', horasNaTela);
  const marcos = (nodes.marcos.outerHTML.match(/<i/g) || []).length;
  log(marcos === 8, 'oito marcos de 25 h até 200 h', marcos + ' marcos');
  log(!/skillEmote/.test(src), 'o emote saiu do quadrado de tempo',
    'nenhum resto de skillEmote');

  // Escala de metais: sobe com as horas, sem repetir, com três cores por degrau.
  const degraus = [...src.matchAll(/\[(\d+),\s+"([^"]+)",\s+\["([^"]+)", "([^"]+)", "([^"]+)"\]\]/g)]
    .map((m) => ({ h: Number(m[1]), metal: m[2], cores: [m[3], m[4], m[5]] }));
  const emOrdem = degraus.every((d, i) => i === 0 || d.h > degraus[i - 1].h);
  const semRepetir = new Set(degraus.map((d) => d.metal)).size === degraus.length;
  const comCores = degraus.every((d) => d.cores.every((c) => /^#[0-9a-f]{6}$/i.test(c)));
  log(degraus.length === 9 && emOrdem && semRepetir && comCores,
    'a escada de metal vai de 0 a 200 h sem repetir material',
    degraus.length + ' degraus: ' + degraus.map((d) => d.metal).join(', '));

  // O metal atual é aplicado ao quadrado como variável de cor.
  const m1 = nodes.quadroTempo.style['--m1'];
  log(!!m1 && /^#/.test(m1), 'o metal do momento chega ao número',
    m1 ? 'a ' + (progress.playtime ? progress.playtime.horas.toFixed(0) : '?') + ' h: ' + m1 : 'sem --m1');

  const kills = progress.bossKills || [];
  const somaKills = kills.reduce((a, b) => a + (b.vezes || 0), 0);
  log(nodes.bossNum.textContent === String(somaKills),
    'o contador de chefes soma as mortes',
    nodes.bossNum.textContent + ' para ' + somaKills);
  // Fecha a aspa para não casar "boss-card-n", "-nome" e "-area".
  const cartoes = (nodes.bossLista.outerHTML.match(/class="boss-card[ "]/g) || []).length;
  log(cartoes === kills.length, 'um bloco por chefe na lista',
    cartoes + ' blocos para ' + kills.length + ' chefes');
  log(/boss-card-n/.test(nodes.bossLista.outerHTML), 'cada bloco traz a contagem no topo',
    'contagem por chefe presente');

  // A lista abre em janela, fora do fluxo da página.
  log(nodes.bossJanela && nodes.bossJanela.open === false,
    'a janela dos chefes começa fechada',
    'open=' + (nodes.bossJanela && nodes.bossJanela.open));
  nodes.bossHead.listeners.click[0]({});
  log(nodes.bossJanela.open === true
      && nodes.bossHead.getAttribute('aria-expanded') === 'true',
    'clicar no contador abre a janela',
    'open=' + nodes.bossJanela.open);
  log(/com-janela/.test(ctx.document.body.className),
    'e a página de trás trava a rolagem enquanto ela está aberta',
    'classe no body: "' + ctx.document.body.className + '"');

  nodes.bossJanela.close();
  log(nodes.bossJanela.open === false
      && nodes.bossHead.getAttribute('aria-expanded') === 'false'
      && !/com-janela/.test(ctx.document.body.className),
    'fechar devolve tudo ao lugar',
    'open=' + nodes.bossJanela.open + ', body="' + ctx.document.body.className + '"');
  // A lista não pode estar no fluxo do documento.
  log(/<dialog class="janela" id="bossJanela"/.test(src),
    'a lista mora dentro de um dialog', 'backdrop, foco preso e Esc sem script');

  // Emblema por chefe, e o convite a abrir legível sem hover.
  const comEmblema = kills.filter((b) => b.emblema).length;
  log(comEmblema === kills.length, "cada chefe tem emblema",
    comEmblema + "/" + kills.length + " — ex.: " + (kills[0] && kills[0].emblema));
  const emblemasUnicos = new Set(kills.map((b) => b.emblema)).size;
  log(emblemasUnicos >= kills.length - 2, "os emblemas distinguem os chefes",
    emblemasUnicos + " distintos para " + kills.length + " chefes");
  // A arte é servida pelo próprio site (sem hotlink).
  log(!/fextralifeimages\.com/i.test(src), 'a página não faz hotlink de imagem',
    'as artes são arquivos locais em icones/');
  const dirIcones = path.join(RAIZ, 'docs', 'icones');
  const arquivos = fs.existsSync(dirIcones) ? fs.readdirSync(dirIcones).filter((f) => f.endsWith('.png')) : [];
  const semArte = kills.filter((b) => !arquivos.includes(b.key + '.png'));
  log(arquivos.length > 0, 'há arte baixada para os chefes',
    arquivos.length + ' arquivos; sem arte: ' + (semArte.map((b) => b.key).join(', ') || 'nenhum'));
  log(semArte.every((b) => b.emblema), 'quem não tem arte cai no emblema',
    semArte.length ? semArte.map((b) => b.emblema + ' ' + b.key).join(', ') : 'todos têm arte');

  // Anel de progresso: progresso maior = offset menor.
  const VOLTA = 263.89;
  const off = Number(nodes.anelFio.style.strokeDashoffset);
  const alvo = VOLTA - VOLTA * (Number(nodes.overallPct.textContent.replace("%", "")) / 100);
  log(Math.abs(off - alvo) < 1, "o anel de progresso acompanha a porcentagem",
    "offset " + off.toFixed(1) + " para " + nodes.overallPct.textContent);
  log(off > 0 && off < VOLTA, "o anel não está nem vazio nem fechado",
    "entre 0 e " + VOLTA);
  log(!/id="overallBar"/.test(src), "a barra fina saiu do quadrado",
    "substituída pelo anel");

  // O cabeçalho inteiro abre a seção.
  log(!/see each boss|boss-abre/.test(src), "o botão de abrir saiu do bloco de chefes",
    "só a seta, e o cabeçalho inteiro é o alvo");
  log(!/.boss-icone {[^}]*border-radius/.test(src), "o anel em volta de cada chefe saiu",
    "sem borda circular no ícone");

  // Cabeçalho: título centralizado e em destaque.
  log(/.top-centro {[^}]*align-items: center/.test(src), "o cabeçalho é uma coluna centrada",
    "título, sync e assinatura empilhados");
  // Confere a presença do título pela largura ocupada, não pelo corpo da fonte.
  const tam = /h1 \{[^}]*font-size: ([\d.]+)rem/.exec(src);
  const entre = /h1 \{[^}]*letter-spacing: ([\d.]+)em/.exec(src);
  log(tam && Number(tam[1]) >= 2.5, "o título tem porte de cabeçalho",
    tam ? tam[1] + "rem" : "não achei");

  // Tipografia do logo: Libre Baskerville (alternativa livre à Athelas), em
  // caixa alta e com entreletra larga.
  log(/h1 \{[^}]*font-family: "Libre Baskerville"/.test(src),
    "o título usa a serifada do logo do jogo", "Libre Baskerville");
  log(/h1 \{[^}]*text-transform: uppercase/.test(src) && entre && Number(entre[1]) >= 0.1,
    "em caixa alta e com entreletra larga, como o logo",
    entre ? "letter-spacing " + entre[1] + "em" : "sem entreletra");
  // O kanji fica fora da Baskerville e do espaçamento largo.
  log(/h1 span \{[^}]*font-family: var\(--font-display\)/.test(src),
    "e o 進捗 continua na Mincho", "caixa alta e entreletra não valem para ele");

  // Menu: sem régua embaixo, e o traço no lugar da caixa.
  const cssDe = (sel) => {
    const alvo = src.indexOf(String.fromCharCode(10) + "  " + sel + " {");
    if (alvo < 0) return "";
    return src.slice(alvo, src.indexOf("}", alvo) + 1);
  };
  log(!/border-bottom/.test(cssDe(".topics")), "o menu perdeu a linha embaixo",
    "o espaçamento faz o trabalho dela");
  // Menu sem borda nem fundo cheio no item ativo: só o traço.
  const cssTopic = cssDe(".topic");
  log(/border: 0/.test(cssTopic) && /background: none/.test(cssTopic),
    "o tópico não tem caixa: nem borda, nem fundo",
    "a interface do jogo é traço sobre papel");
  // Pincelada: paradas de opacidade desiguais.
  const paradas = cssDe(".topic::after");
  const stops = (paradas.match(/rgba\(214, 210, 200,/g) || []).length;
  log(stops >= 4, "o traço afina nas pontas, como pincelada",
    stops + " paradas de opacidade — linha de espessura constante é régua");
  log(/#d6402a/.test(cssDe(".topic.on::after")),
    "e o escolhido é marcado em vermelhão de selo",
    "a cor do carimbo, que é como o jogo marca o que vale");

  // O nome manda no bloco do chefe.
  log(/\.boss-card-nome \{[^}]*font-family: var\(--font-display\)/.test(src),
    "o título do bloco de chefe ganhou destaque", "fonte de display, maior");
  // Fechado, o bloco mostra só kanji, número e rótulo; a ressalva fica no title.
  const dentroDoQuadro = stripTags(nodes.bossPanel.outerHTML).replace(/\s+/g, ' ').trim();
  log(dentroDoQuadro.length < 40, 'o bloco de chefes fechado é só a contagem',
    '"' + dentroDoQuadro + '"');
  log(!/no readable flag|goes from undone/.test(src.slice(src.indexOf('id="bossPanel"'), src.indexOf('id="bossLista"'))),
    'nenhum parágrafo de explicação na marcação do bloco', 'só kanji, número e rótulo');

  // `hidden` deve recolher o bloco mesmo com display declarado na classe.
  log(/\.boss-lista\[hidden\] \{[^}]*display: none/.test(src),
    'o hidden da lista vence o display da classe',
    'regra explícita para .boss-lista[hidden]');

  // Fechado, o bloco só informa a contagem: nada de rodapé com explicação.
  log(nodes.bossNota.textContent.trim() === '', 'o rodapé do bloco de chefes está vazio',
    nodes.bossNota.textContent.trim() ? 'sobrou texto' : 'sem parágrafo');
  log(/per-boss kill count/.test(nodes.bossHead.title || ''),
    'a ressalva dos chefes foi para o hover',
    nodes.bossHead.title ? 'title com ' + nodes.bossHead.title.length + ' caracteres' : 'title vazio');

  // O número de chefes é o maior da página.
  const numMortes = /\.deaths-count \{[^}]*font-size: ([\d.]+)rem/.exec(src);
  const numChefes = /\.quadro-botao \.quadro-num \{[^}]*font-size: clamp\([\d.]+rem, [\d.]+vw, ([\d.]+)rem\)/.exec(src);
  log(numMortes && numChefes && Number(numChefes[1]) > Number(numMortes[1]),
    'o número de chefes é maior que o de mortes',
    (numMortes && numMortes[1]) + 'rem vs até ' + (numChefes && numChefes[1]) + 'rem');
  log(/\.quadro-abre \{[^}]*justify-content: center/.test(src),
    'o número fica centralizado no bloco', 'conteúdo do quadrado centrado');
  log(/\.quadro-botao::after \{[^}]*position: absolute/.test(src),
    "a seta sai do fluxo para não desequilibrar o centro", "posicionada no canto");
  // Moldura animada: vermelha em chefes, roxa em Headless.
  log(/\.boss-quadro::before \{[^}]*animation: sangue-borda/.test(src),
    "a moldura do bloco de chefes sangra", "border-image animado");
  log(/\.headless-quadro::before \{[^}]*animation: medo-borda/.test(src),
    "a moldura do bloco de Headless é roxa e pulsa", "border-image animado em roxo");

  // Tremor do bloco de Headless: mais forte, com a mesma cadência (início da
  // janela do tremor dentro do ciclo).
  const tremorCss = /@keyframes tremor \{([\s\S]*?)\n  \}/.exec(src);
  const saltos = tremorCss
    ? [...tremorCss[1].matchAll(/translate\((-?[\d.]+)px, (-?[\d.]+)px\)/g)]
      .map((m) => Math.max(Math.abs(Number(m[1])), Math.abs(Number(m[2]))))
    : [];
  const pico = saltos.length ? Math.max(...saltos) : 0;
  log(pico >= 5, 'o tremor do Headless é violento', 'pico de ' + pico + 'px');

  // Todos os deslocamentos apontam para baixo (sudoeste/sudeste) e a escala
  // só diminui.
  const vetores = tremorCss
    ? [...tremorCss[1].matchAll(/translate\((-?[\d.]+)px, (-?[\d.]+)px\)/g)]
      .map((m) => ({ x: Number(m[1]), y: Number(m[2]) }))
      .filter((v) => v.x !== 0 || v.y !== 0)
    : [];
  const todosAoSul = vetores.length > 0 && vetores.every((v) => v.y > 0);
  log(todosAoSul, 'todo vetor do susto aponta para o sul',
    vetores.map((v) => v.y).join(', '));
  const alterna = vetores.every((v, i) => (i % 2 === 0 ? v.x < 0 : v.x > 0));
  log(alterna, 'e alterna entre sudoeste e sudeste',
    vetores.map((v) => (v.x < 0 ? 'SO' : 'SE')).join(' '));
  const escalas = tremorCss
    ? [...tremorCss[1].matchAll(/scale\(([\d.]+)\)/g)].map((m) => Number(m[1]))
    : [];
  log(escalas.every((s) => s <= 1), 'e o bloco só encolhe, nunca incha',
    'maior escala: ' + Math.max(...escalas));
  const janela = tremorCss ? /0%, (\d+)%, 100%/.exec(tremorCss[1]) : null;
  log(janela && Number(janela[1]) === 88,
    'e a janela do susto não mudou: o intervalo entre um e outro é o mesmo',
    janela ? 'começa em ' + janela[1] + '% do ciclo' : 'não achei a janela');
  const ciclo = /\.headless-quadro \{[^}]*animation: tremor ([\d.]+)s/.exec(src);
  log(ciclo && Number(ciclo[1]) === 6.1, 'e o ciclo continua de 6,1s',
    ciclo ? ciclo[1] + 's' : 'não achei o ciclo');
  log(saltos.length >= 8, 'o susto tem mais solavancos dentro da mesma janela',
    saltos.length + ' solavancos');

  // Número do Headless com contraste sobre o fundo roxo: topo claro, base roxa.
  const gradHeadless = /\.headless-num \{[^}]*background-image: linear-gradient\(180deg,\s*(#[0-9a-f]{6})/i.exec(src);
  const claro = gradHeadless ? gradHeadless[1] : '';
  const brilho = claro
    ? (parseInt(claro.slice(1, 3), 16) + parseInt(claro.slice(3, 5), 16) + parseInt(claro.slice(5, 7), 16)) / 3
    : 0;
  log(brilho > 200, 'o número do Headless contrasta com o fundo do bloco',
    claro + ' (brilho médio ' + brilho.toFixed(0) + ')');
  const azulado = claro && parseInt(claro.slice(5, 7), 16) >= parseInt(claro.slice(1, 3), 16);
  log(azulado, 'e o tom é frio, não mais o roxo do fundo', 'topo do gradiente puxa para o azul');
  log(/\.headless-num \{[^}]*#2a1550/.test(src), 'a raiz do gradiente continua roxa',
    'o número resolve na cor do bloco, então segue no tema');

  /*
   * --- o luto sem listras ---
   *
   * Sem padrão listrado repetido no bloco; o luto é representado pelo 白菊
   * (crisântemo branco).
   */
  const painelMortes = /\.deaths-panel\b[\s\S]*?\.deaths-head \{/.exec(src);
  const cssPainel = painelMortes ? painelMortes[0] : '';
  log(!/repeating-linear-gradient/.test(cssPainel),
    'o bloco de mortes não tem padrão repetido em faixa',
    'é o desenho que lia como travessia de rua, em qualquer dose');
  const fio = /\.deaths-panel::before \{[\s\S]*?\n  \}/.exec(src);
  const cssFio = fio ? fio[0] : '';
  const alturaFio = /height: (\d+)px/.exec(cssFio);
  log(alturaFio && Number(alturaFio[1]) <= 2,
    'no alto ficou só um fio de luz', alturaFio ? alturaFio[1] + 'px' : 'não achei');
  log(/<div class="kiku"/.test(src) && /viewBox="0 0 100 100"/.test(src),
    'e o luto vem do 白菊, desenhado', 'o crisântemo branco dos funerais japoneses');
  const opKiku = /\.deaths-panel \.kiku \{[\s\S]*?opacity: ([\d.]+)/.exec(src);
  log(opKiku && Number(opKiku[1]) <= 0.12,
    'quase apagado, como marca d\'água de lápide',
    opKiku ? 'opacidade ' + opKiku[1] : 'sem opacidade');
  // Dezesseis pétalas em duas coroas.
  const petalas = (src.match(/<use href="#kikuCoroa"/g) || []).length * 2 + 2;
  log(petalas >= 16, 'com pétalas bastantes para ler como crisântemo',
    petalas + ' pétalas em duas coroas');

  /*
   * A chama do Ídolo do Escultor, à esquerda do número, em turquesa.
   */
  log(!/class=\"alma/.test(src), 'os fantasmas saíram do bloco',
    'o bloco ficou com o 白菊, a névoa e a chama');
  const chama = /<span class=\"deaths-chama\"[\s\S]*?<\/span>/.exec(src);
  const svgChama = chama ? chama[0] : '';
  log(!!svgChama && !/死/.test(svgChama), 'e o 死 deu lugar a uma chama desenhada',
    'emoji traria a paleta de outra pessoa, e o tom aqui é o ponto');
  // Turquesa do 鬼仏: verde e azul acima do vermelho.
  const tonsChama = (svgChama.match(/#[0-9a-f]{6}/gi) || []);
  const quentes = tonsChama.filter((h) => {
    const r = parseInt(h.slice(1, 3), 16);
    const b = parseInt(h.slice(5, 7), 16);
    // Branco puro (r === b) é permitido; tons quentes, não.
    return r > b;
  });
  log(tonsChama.length > 0 && quentes.length === 0,
    'e o tom e o turquesa dos checkpoints do jogo',
    tonsChama.length + ' paradas, nenhuma puxando para o quente' +
      (quentes.length ? ': ' + quentes.join(', ') : ''));
  const cssChama = cssDe('.deaths-chama');
  log(/animation: vela/.test(cssChama), 'a chama oscila como a do Ídolo',
    'quase apaga e volta, em vez de pulsar num ritmo regular');
  log(/<animate /.test(svgChama), 'e a língua de fogo lambe por conta própria',
    'o d alterna entre desenhos de mesmo número de segmentos, então interpola');
  const fagulhas = (svgChama.match(/class=\"fagulha/g) || []).length;
  log(fagulhas >= 3, 'com fagulhas que sobem soltas e apagam',
    fagulhas + ' delas, em períodos que não são múltiplos entre si');

  /*
   * `hidden` deve prevalecer sobre `display` de classe. Exige a regra global
   * e lista as classes usadas com `hidden` que declaram display próprio.
   */
  log(/\[hidden\]\s*{\s*display:\s*none\s*!important/.test(src),
    'o atributo hidden vence o display de qualquer classe',
    'sem isso o elemento fica escondido no JavaScript e visível na tela');

  const nascemEscondidos = new Set();
  for (const tag of src.match(/<[a-z]+[^>]*\bhidden\b[^>]*>/g) || []) {
    const cls = /class="([^"]+)"/.exec(tag);
    if (cls) for (const c of cls[1].split(/\s+/)) nascemEscondidos.add(c);
  }
  const semGuarda = [];
  for (const c of nascemEscondidos) {
    const re = new RegExp('(?:^|[\\s,])\\.' + c.replace(/-/g, '\\-') + '(?:[\\s,{])[^{]*{([^}]*)}', 'g');
    let r;
    while ((r = re.exec(src))) {
      const d = /display:\s*([^;]+)/.exec(r[1]);
      if (d && d[1].trim() !== 'none') { semGuarda.push(c); break; }
    }
  }
  // Com a regra global elas são inofensivas; a contagem é informativa.
  log(true, 'e há ' + semGuarda.length + ' classes que dependem disso',
    semGuarda.length ? semGuarda.slice(0, 6).join(', ') + (semGuarda.length > 6 ? '…' : '')
      : 'nenhuma declara display próprio');

  // No DOM: abaixo de 100%, o selo não fica visível.
  const seloEl = document.getElementById('selo');
  log(!!seloEl && seloEl.hidden, 'e o selo de 100% não aparece antes dos 100%',
    'com 20 de 34, ele fica fora — foi assim que o defeito apareceu');

  /*
   * Estados do bloco de mortes: sino e podridão. O sino é menor; a podridão
   * é maior, tem contagem e abre a lista. Ligado e desligado são figuras
   * diferentes, não só cores diferentes.
   */
  const cssSinoSvg = cssDe('.estado-sino svg');
  const cssRotN = cssDe('.rot-n');
  const cssRotulo = cssDe('.estado-rot');
  const medida = (css, prop) =>
    parseFloat((new RegExp(prop + ': *([0-9.]+)rem').exec(css) || [])[1] || 0);
  const tamSino = medida(cssSinoSvg, 'width');
  const tamRot = medida(cssRotN, 'font-size');
  const tamRotulo = medida(cssRotulo, 'font-size');
  log(tamSino > 0 && tamRot > 0, 'os dois ícones têm medida declarada',
    'sino ' + tamSino + 'rem, número da podridão ' + tamRot + 'rem');

  // O número de atingidos faz parte do ícone e é bem maior que o rótulo.
  log(tamRot > tamRotulo * 1.8, 'a contagem de atingidos é o que se lê primeiro',
    tamRot + 'rem contra ' + tamRotulo + 'rem do nome — o número manda no ícone');
  log(/id=\"rotN\"/.test(src), 'e ela tem elemento próprio',
    'separada do rótulo, para poder ter corpo e cor diferentes');
  log(/>dragon rot</.test(src), 'e o nome dragon rot aparece no ícone',
    'em duas palavras');

  // O estado aceso acrescenta elementos: badalo e ondas no sino, número e
  // mancha na podridão.
  log(/\.estado-sino\.on \.sino-badalo/.test(src)
      && /\.estado-sino\.on \.sino-ondas/.test(src),
    'o sino aceso ganha badalo e ondas, que o apagado não tem',
    'sino em repouso tem o badalo no centro; o desalinho é o que diz que ele bateu');
  log(/\.estado-rot-bt\.off \.rot-n *{ *display: none/.test(src),
    'e a podridão limpa não mostra número nenhum',
    'zero não é uma mancha pequena, é a ausência dela');
  log(/\.estado-rot-bt\.on \.rot-mancha/.test(src),
    'enquanto a suja ganha a mancha atrás do kanji',
    'ela cresce com a contagem, via --rot');

  // Nome do estado do sino conforme o jogo: SINISTER BURDEN.
  log(/sinister burden/i.test(src), 'o sino aceso diz sinister burden',
    'é o nome que a interface do jogo dá ao estado de quem tocou o sino');
  // Confere o rótulo renderizado, não o fonte.
  const trechoRotulo = /rotulo.textContent = b.ativo[^;]*;/.exec(src);
  log(!!trechoRotulo && !/bell rung/i.test(trechoRotulo[0]),
    'e o rótulo antigo saiu',
    'descrevia o gesto, não o estado');

  log(/id=\"estadoRot\"[^>]*type=\"button\"/.test(src)
      && /aria-haspopup=\"dialog\"/.test(src),
    'os atingidos aparecem ao interagir com o ícone',
    'o sino é liga-desliga: não há o que abrir nele');
  log(/Rot Essence/.test(src) || /rot-item/.test(src),
    'e a janela traz Rot Essence: <NPC>', 'item em cima, nome de quem embaixo');
  // O ícone leva só kanji, número e nome; o resto fica na janela e no hover.
  const marcaRot = /<button class=\"estado estado-rot-bt\"[\s\S]*?<\/button>/.exec(src);
  const textoDoIcone = stripTags(marcaRot ? marcaRot[0] : '').replace(/\s+/g, ' ').trim();
  log(textoDoIcone.length <= 16, 'o ícone da podridão não vira parágrafo',
    '"' + textoDoIcone + '"');

  // 皆伝: selo de 100% nas conquistas, fora do fluxo (não desloca o layout).
  const cssSelo = cssDe('.selo');
  log(/position: absolute/.test(cssSelo),
    'o selo não ocupa lugar no fluxo', 'aos 100% ele aparece sem mover nada na página');
  log(/皆伝/.test(src), 'o selo é 皆伝, a licença de transmissão completa',
    'nas escolas japonesas é a mais alta que existe: o mestre ensinou tudo que sabia');
  const cssKaiden = cssDe('.quadro-anel.kaiden');
  log(/box-shadow/.test(cssKaiden) && /translateY/.test(cssKaiden),
    'e o bloco vira o destaque da página a partir dali',
    'sobe e ganha halo — as duas por fora do fluxo, então nada se reorganiza');
  log(/renderKaiden\(ok && todas > 0 && feitas >= todas\)/.test(src),
    'o selo exige contagem real antes de carimbar',
    'sem o "todas > 0", zero de zero seria 100% e a página se parabenizaria sozinha');
  log(/id="kaidenCena"/.test(src) && /pointer-events: none/.test(cssDe('.kaiden-cena')),
    'a cena do selo é a página inteira, e não engole o clique',
    'a cena é para contemplar; uma cena que trava a página vira espera');
  log(/selo\.addEventListener\("click", tocarKaiden\)/.test(src),
    'e ela responde à interação com o selo', 'clicar recomeça a cena');

  // Cada `@keyframes` deve ter acima uma linha `no jogo: ...` com a referência
  // da animação no jogo.
  const linhas = src.split(String.fromCharCode(10));
  const semOrigem = [];
  const nomes = [];
  for (let i = 0; i < linhas.length; i++) {
    const m = /@keyframes ([a-z-]+)/.exec(linhas[i]);
    if (!m) continue;
    nomes.push(m[1]);
    if (!/no jogo:/.test(linhas[i - 1] || '')) semOrigem.push(m[1]);
  }
  log(nomes.length > 0 && semOrigem.length === 0,
    'toda animação declara de onde no jogo ela vem',
    semOrigem.length ? 'sem origem: ' + semOrigem.join(', ')
      : nomes.length + ' animações, cada uma com o referente escrito acima dela');
  // A referência precisa ter um tamanho mínimo.
  const origens = (src.match(/no jogo: ([^*]+)\*\//g) || [])
    .map((t) => t.replace(/^no jogo: /, '').replace(/\s*\*\/$/, '').trim());
  const curtas = origens.filter((t) => t.length < 25);
  log(curtas.length === 0, 'e a origem é descrita, não só nomeada',
    curtas.length ? 'curta demais: ' + curtas.join(' | ')
      : 'a mais curta tem ' + Math.min.apply(null, origens.map((t) => t.length)) + ' caracteres');

  // Sem linha embaixo do cabeçalho (a pincelada do menu já separa).
  log(!/border-bottom/.test(cssDe("header.top")),
    'não há linha entre o título e o corpo',
    'o espaço e a diferença de corpo já separam os dois');

  // O tempo de jogo: "h" no número, e nenhum nome de metal na tela.
  log(/\+ "h";/.test(src), 'o número de horas traz o "h"', 'colado no número');
  log(!/getElementById\("tempoRot"\)\.textContent = d\[1\]/.test(src),
    'o nome do metal saiu da tela', 'a cor continua evoluindo, a palavra não aparece');
  const rot = /<span class="quadro-rot" id="tempoRot">([^<]*)</.exec(src);
  log(rot && !/bronze|iron|steel|silver|gold|lazulite|magnetite|adamantite/i.test(rot[1]),
    'e o rótulo do bloco não é um material', '"' + (rot ? rot[1] : '?') + '"');

  // O hover mostra o valor exato, na precisão de cada fonte (Steam em minutos,
  // tempo interno com segundos).
  const t2 = nodes.quadroTempo.title || '';
  log(/\d+h \d{2}m on the Steam clock/.test(t2), 'o hover dá o relógio em hora e minuto',
    (t2.split('\n')[0] || '').slice(0, 60));
  const temInterno = typeof progress.playtime.internoSegundos === 'number';
  if (temInterno) {
    log(/\d+h \d{2}m \d{2}s of in-game time/.test(t2), 'e o tempo interno com segundos',
      (t2.split('\n')[1] || '').slice(0, 60));
    log(!/\d+h \d{2}m 00s on the Steam clock/.test(t2),
      'sem segundo inventado no relógio da Steam', 'a fonte só grava minutos');
  } else {
    log(!/in-game time/.test(t2), 'sem tempo interno, o hover não o menciona',
      'nada de linha vazia');
  }
  // O title é atribuído uma única vez.
  log((src.match(/quadro\.title =/g) || []).length === 2,
    'o título do bloco de tempo é escrito num lugar só',
    (src.match(/quadro\.title =/g) || []).length + ' atribuições (a outra é o caso sem dado)');

  // --- estilo do bloco de mortes (luto), distinto do de chefes (sangue) ---
  log(!/repeating-linear-gradient/.test(cssPainel),
    'o bloco de mortes guarda luto sem imitar pavimentação',
    'a cortina listrada saiu; o 白菊 ficou no lugar dela');

  // Número em tom de osso, sem gradiente vermelho.
  const numMorte = /\.deaths-count \{[\s\S]*?background-image: linear-gradient\(\s*180deg,\s*(#[0-9a-f]{6})/i.exec(src);
  const topoMorte = numMorte ? numMorte[1] : '';
  const r = topoMorte ? parseInt(topoMorte.slice(1, 3), 16) : 0;
  const b = topoMorte ? parseInt(topoMorte.slice(5, 7), 16) : 0;
  log(topoMorte && r - b < 30, 'o número de mortes não é mais vermelho',
    topoMorte + ' (osso: vermelho e azul quase iguais)');
  log(!/\.deaths-count \{[^}]*animation: escorrer\b/.test(src),
    'e não escorre como o de chefes', 'a animação de sangue saiu daqui');
  log(/\.deaths-count \{[^}]*animation: luto/.test(src),
    'o número respira em vez de pulsar', 'animação "luto", lenta');
  log(!/\.deaths-count::after \{/.test(src) && !/@keyframes incenso/.test(src),
    'nada sobe do número', 'a fumaça que parecia fantasma saiu');
  log(/\.deaths-chama \{[^}]*animation: vela/.test(src),
    'e a chama do Ídolo oscila como vela', 'animação "vela"');
  // A escala esfria com mais mortes.
  const fim = /\.therm-fill \{[\s\S]*?linear-gradient\(90deg,[^)]*?(#[0-9a-f]{6})\);/i.exec(src);
  const fimCor = fim ? fim[1] : '';
  const fr = fimCor ? parseInt(fimCor.slice(1, 3), 16) : 0;
  const fb = fimCor ? parseInt(fimCor.slice(5, 7), 16) : 0;
  log(fimCor && fr - fb < 30, 'o fim da escala é cinza, não sangue',
    fimCor + ' no extremo de 1000');

  // --- moldura anima no hover; conteúdo (número, kanji) anima sempre ---
  const temGatilho = (re) => re.test(src);
  log(/\.boss-quadro, \.headless-quadro \{ --anim: paused; \}/.test(src),
    'os dois blocos nascem com a moldura parada', '--anim: paused');
  log(/\.boss-quadro:hover, \.boss-quadro\.animando/.test(src) &&
      /\.headless-quadro:hover, \.headless-quadro\.animando \{ --anim: running; \}/.test(src),
    'e ligam no hover ou por toque', ':hover para mouse, .animando para celular');

  const gatilhada = (nome) => {
    // O play-state deve estar na mesma regra (o atalho `animation` redefine
    // os longhands).
    const i = src.indexOf('animation: ' + nome);
    if (i < 0) return null;
    const fim = src.indexOf('}', i);
    return /animation-play-state: var\(--anim/.test(src.slice(i, fim));
  };
  for (const doBloco of ['sangue-borda', 'medo-borda', 'tremor', 'gotejar']) {
    const g = gatilhada(doBloco);
    log(g === true, 'a animação "' + doBloco + '" é do bloco e espera o gatilho',
      g === null ? 'não achei a animação' : 'play-state ligado a --anim');
  }
  for (const doConteudo of ['vela', 'luto', 'polir', 'escorrer-forte']) {
    const g = gatilhada(doConteudo);
    log(g === false, 'a animação "' + doConteudo + '" é conteúdo e corre sempre',
      g === null ? 'não achei a animação' : 'sem gatilho, como deve ser');
  }
  log(/const BLOCOS_ANIMADOS = "\.boss-quadro, \.headless-quadro"/.test(src),
    'o toque alcança os mesmos dois blocos', 'e nenhum outro');

  // O bloco de prefers-reduced-motion vem depois das animações que desliga.
  const iReduz = src.indexOf('@media (prefers-reduced-motion: reduce)');
  const iUltima = Math.max(
    src.indexOf('animation: tremor'), src.indexOf('animation: medo-borda'),
    src.indexOf('animation: sangue-borda'), src.indexOf('animation: gotejar'));
  log(iReduz > iUltima && iReduz > 0,
    'menos movimento vence as animações que desliga',
    'declarado em ' + iReduz + ', depois da última animação em ' + iUltima);

  // --- a lista de conquistas ---
  const conqs = (progress.achievements && progress.achievements.lista) || [];
  log(/\.conq-lista \{[^}]*flex-direction: column/.test(src),
    'as conquistas ficam em lista de uma coluna, não em grade',
    'nome e descrição têm comprimentos muito diferentes; em grade sobram buracos');
  log(/\.quadro-anel::after \{[\s\S]*?content: "▾"/.test(src),
    'o bloco mostra que pode ser aberto', 'a mesma seta dos blocos de chefe');

  const semDesc = conqs.filter((c) => !c.descricao);
  log(semDesc.length === 0, 'toda conquista tem descrição',
    semDesc.length ? semDesc.length + ' sem texto: ' + semDesc.slice(0, 3).map((c) => c.nome).join(', ')
      : conqs.length + ' de ' + conqs.length);
  const daReserva = conqs.filter((c) => c.descricaoOculta).length;
  log(daReserva > 0, 'e as ocultas vêm marcadas como texto de reserva',
    daReserva + ' das ' + conqs.length + ' o jogo esconde até desbloquear');

  const semIcone = conqs.filter((c) => !c.icone);
  log(semIcone.length === 0, 'toda conquista tem ícone',
    semIcone.length ? semIcone.length + ' sem arte' : conqs.length + ' baixados');
  const faixas = new Set(conqs.map((c) => c.dificuldade).filter(Boolean));
  log(faixas.size === 3, 'separadas em três faixas de dificuldade',
    [...faixas].join(', '));

  // A dificuldade deriva da raridade da Steam: cada faixa respeita seus limites.
  const dentroDaFaixa = conqs.every((c) => {
    if (typeof c.raridade !== 'number') return true;
    if (c.dificuldade === 'facil') return c.raridade >= 50;
    if (c.dificuldade === 'media') return c.raridade >= 20 && c.raridade < 50;
    return c.raridade < 20;
  });
  log(dentroDaFaixa, 'e a faixa concorda com a porcentagem de jogadores',
    'fácil ≥50%, média 20–50%, difícil <20%');

  // Uma única marca de shinobi, na mais rara.
  const comTag = conqs.filter((c) => c.shinobi);
  const maisRara = conqs.slice().sort((a, b) => (a.raridade || 100) - (b.raridade || 100))[0];
  log(comTag.length === 1, 'existe uma marca de shinobi, e uma só',
    comTag.length + ' marcadas');
  log(comTag.length === 1 && maisRara && comTag[0].nome === maisRara.nome,
    'e ela está na conquista mais rara de todas',
    comTag[0] ? comTag[0].nome + ' (' + comTag[0].raridade + '%)' : 'nenhuma');
  log(/antes === "1" \|\| antes === null/.test(src),
    'as cenas só correm na transição, não a cada leitura',
    'a página relê de 5 em 5s; sem isso o site piscaria para sempre');
  log(/\.golpe \{[^}]*pointer-events: none/.test(src),
    'e a cena não rouba o clique de nada', 'pointer-events: none');

  /*
   * Os três marcos de tela inteira. Kanji: 忍殺 (golpe mortal), 怖 (Terror,
   * como no jogo) e 討 (o mesmo do bloco de chefes).
   */
  const blocoMarcos = /const MARCOS_CENA = \[[\s\S]*?\n\];/.exec(src);
  const cenas = blocoMarcos ? blocoMarcos[0] : '';
  log(/kanji: "忍殺"/.test(cenas) && /kanji: "討"/.test(cenas) && /kanji: "怖"/.test(cenas),
    'há três marcos de tela inteira, com os kanji certos',
    '忍殺 para a conquista, 討 para os chefes, 怖 para os Headless');
  log(/s\.bosses\.every\(\(b\) => b\.defeated\)/.test(cenas),
    'o dos chefes espera todos derrotados', 'every, não some');
  log(/s\.headless\.every\(\(h\) => h\.defeated\)/.test(cenas),
    'e o dos Headless também', 'every, não some');
  // Lista vazia não dispara as cenas (`every` de lista vazia é true).
  log(/\.length > 0\s*\n?\s*&& s\.bosses\.every/.test(cenas) || /s\.bosses\.length > 0/.test(cenas),
    'lista vazia não conta como tudo derrotado',
    'every de lista vazia é true, e isso dispararia a cena sem save');
  // Cada cena fala a língua do bloco dela.
  log(/\.golpe-chefes \.golpe-kanji \{[^}]*color: #e0301c/.test(src),
    'a cena dos chefes é de sangue', 'vermelho, e os fios escorrem pela tela');
  log(/\.golpe-headless \.golpe-kanji \{[^}]*color: #c98cf5/.test(src)
      && /animation:[^;]*pavor/.test(src),
    'a dos Headless é roxa e treme', 'os mesmos vetores de medo do bloco');
  log(/@keyframes pavor \{[\s\S]*?25%\s*\{ margin: 3px 0 -3px -4px; \}/.test(src),
    'e o tremor aponta para o sul, como no bloco',
    'medo encolhe e recua para baixo, não pula');

  // O menu cabe na largura do celular, sem rolagem horizontal.
  const menuCel = /@media \(max-width: 460px\) \{[\s\S]*?\n  \}/.exec(src);
  const menuCelCss = menuCel ? menuCel[0] : '';
  log(!/\.topics \{[^}]*overflow-x: auto/.test(menuCelCss), 'o menu não rola de lado no celular',
    'sem overflow-x na barra');
  log(/\.topics \{[^}]*flex-wrap: wrap/.test(menuCelCss), 'ele quebra em duas colunas',
    'flex-wrap: wrap na largura de celular');
  log(/\.topics > \.topic \{[^}]*flex: 1 1 calc\(50% - 6px\)/.test(menuCelCss),
    'cada tópico ocupa meia largura', 'dois por fileira, nada cortado na borda');

  // Ponto de sync na faixa do topo, à esquerda; botão de tema à direita.
  const iFaixa = src.indexOf('class="topbar"');
  const iPonto = src.indexOf('syncDot');
  const iTema = src.indexOf('themeToggle');
  const iCab = src.indexOf('<header class="top">');
  log(iFaixa < iPonto && iPonto < iTema && iTema < iCab,
    'o ponto de sync fica à esquerda da faixa do topo',
    'faixa ' + iFaixa + ' < ponto ' + iPonto + ' < tema ' + iTema + ' < cabeçalho ' + iCab);
  log(/\.topbar \{[^}]*justify-content: space-between/.test(src),
    'a faixa separa as duas pontas', 'space-between');
  log(!/<header class="top">[\s\S]{0,400}syncDot/.test(src),
    'e saiu do cabeçalho', 'cabeçalho ficou com título e assinatura');

  // A assinatura se destaca por peso e espaçamento, não por tamanho.
  const assin = /\.assinatura \{[^}]*font-size: ([\d.]+)rem/.exec(src);
  const blocoAssin = /\.assinatura \{[\s\S]*?\n  \}/.exec(src);
  const cssAssin = blocoAssin ? blocoAssin[0] : '';
  log(assin && Number(assin[1]) <= 0.85,
    'a assinatura encolheu, para o corpo da página caber',
    assin ? assin[1] + 'rem' : 'não achei');
  const pesoAssin = /font-weight: (\d+)/.exec(cssAssin);
  const entreAssin = /letter-spacing: ([\d.]+)em/.exec(cssAssin);
  log(pesoAssin && Number(pesoAssin[1]) >= 700 && entreAssin && Number(entreAssin[1]) >= 0.3,
    'e destaca por peso e entreletra em vez de corpo',
    (pesoAssin ? pesoAssin[1] : '?') + ' / ' + (entreAssin ? entreAssin[1] + 'em' : '?'));
  log(/\.assinatura::before,/.test(src) && /\.assinatura::after \{/.test(src),
    'com um fio de cada lado isolando a linha', 'lê como legenda de placa');
  // O título mantém o tamanho.
  const alturaCab = /header\.top \{[\s\S]*?padding-bottom: (\d+)px[\s\S]*?margin-bottom: (\d+)px/.exec(src);
  log(alturaCab && Number(alturaCab[1]) + Number(alturaCab[2]) <= 32,
    'e o cabeçalho ficou mais baixo sem mexer no título',
    alturaCab ? alturaCab[1] + 'px + ' + alturaCab[2] + 'px' : 'não achei');
  log(/\.assinatura \{[^}]*color: var\(--gold\)/.test(src),
    'e ganhou cor própria', 'dourado, não cinza apagado');

  // Os dois quadrados do meio não têm moldura nem fundo.
  log(/\.quadro \{[^}]*border: 0/.test(src), 'os quadrados não têm borda', 'border: 0');
  log(/\.quadro \{[^}]*background: none/.test(src), 'e são transparentes', 'sem fundo');

  // Proporção 1:1 garantida por aspect-ratio junto com min-height.
  log(/\.quadro \{[^}]*aspect-ratio: 1 \/ 1/.test(src),
    'os quadrados declaram 1:1', 'aspect-ratio presente');
  log(/\.quadro \{[^}]*min-height: 0/.test(src),
    'e o conteúdo não pode esticá-los', 'min-height: 0 no quadro');
  log(/\.anel \{[^}]*height: 100%/.test(src) && !/\.anel \{[^}]*max-width/.test(src),
    'o anel dimensiona pela altura, não pela largura',
    'sem max-width fixo empurrando a caixa');

  // Emma tem arte com enquadramento próprio.
  const emma = kills.find((b) => b.key === "emma");
  log(!!(emma && emma.enquadre), "a arte da Emma tem enquadramento próprio",
    emma && emma.enquadre ? JSON.stringify(emma.enquadre) : "sem enquadre");
  log(fs.existsSync(path.join(RAIZ, "docs", "icones", "emma.png")),
    "a arte da Emma foi baixada", "icones/emma.png");

  // O painel de mortes não tem parágrafo; a ressalva fica no hover.
  await carregar(progress, { hostname: "localhost" });
  const notaMortes = nodes.deathsNote.textContent.trim();
  log(notaMortes === "", "o painel de mortes não mostra texto explicativo",
    notaMortes ? "sobrou: \"" + notaMortes.slice(0, 50) + "\"" : "sem parágrafo");
  const hover = nodes.deaths.title || "";
  log(/counted|save/i.test(hover), "mas a ressalva continua no hover",
    hover ? "title com " + hover.length + " caracteres" : "title vazio");

  // O contador de mortes mostra um número.
  log(progress.deaths && progress.deaths.known === true,
    'o contador de mortes está funcionando',
    progress.deaths ? progress.deaths.count + ' (' + progress.deaths.how + ')' : 'ausente');

  // Alvo de toque: o alfinete é um desenho (não emoji) com área ampla.
  log(/\.cat-header \.pin \{[^}]*width: 34px/.test(src), 'o alfinete tem alvo de 34px',
    'alvo maior que o desenho');
  log(!/b\.textContent = "📌"/.test(src) && /pin svg/.test(src),
    'o alfinete é desenhado e segue o tema', 'sem emoji, herda currentColor');

  // O rodapé existe.
  const rodape = /made by (<span>)?oaovito/i.test(fs.readFileSync(PAGINA, 'utf8'));
  log(rodape, 'rodapé de autoria presente', rodape ? 'made by oaovito' : 'ausente');

  await original();

  // Contas: flags e aritmética dos colares devem coincidir.
  const pb = progress.essentials.prayerBeads;
  const porFlag = (progress.prayerBeadList || []).filter((x) => x.collected).length;
  log(porFlag === pb.collected, 'as duas contagens de Prayer Bead concordam',
    'flags: ' + porFlag + ', colares×4+bolsa: ' + pb.collected);

  // Idem para as sementes: flags contra cargas da cabaça.
  const gs = progress.essentials.gourdSeeds;
  log(gs.charges === gs.startingCharges + gs.collected,
    'sementes por flag batem com as cargas da cabaça',
    gs.collected + ' sementes + ' + gs.startingCharges + ' inicial = ' + gs.charges + ' cargas');

  // O total geral inclui as três seções.
  const total = nodes.overallCount.textContent;
  const m = /(\d+)\s*\/\s*(\d+)/.exec(total);
  // O anel mede as conquistas da Steam.
  const conq = progress.achievements;
  log(!!m && !!conq && Number(m[1]) === conq.desbloqueadas && Number(m[2]) === conq.total,
    'o bloco de progresso mostra as conquistas do Steam',
    total + (conq ? ' para ' + conq.desbloqueadas + '/' + conq.total : ' (sem conquistas no progresso)'));
  const soma = secoes.reduce((a, [, campo]) =>
    a + (progress[campo] || []).filter((x) => x.detected !== false).length, 0);
  log(soma > 0, 'as listas seguem contando por trás',
    'total mostra ' + total + ', só as três seções já somam ' + soma);

  // Nenhuma linha de chefe/mini-chefe no DATA com chave inexistente.
  const cats = nodes.categories.outerHTML;
  log(!/flag:chainedOgre|flag:genichiro1|flag:shichimen\b/.test(cats),
    'nenhuma chave antiga sobrou no DATA', 'renome aplicado');
}

/**
 * Desenha a página com um progresso e devolve o texto da tela. Usado para
 * comparar a versão local com a publicada.
 */
async function desenhar(progress) {
  const { nodes } = await carregar(progress, { hostname: 'localhost' });
  const pedacos = [];
  for (const id of Object.keys(nodes)) {
    const n = nodes[id];
    if (!n || typeof n.outerHTML !== 'string') continue;
    pedacos.push(id + '::' + n.outerHTML.replace(/\s+/g, ' ').trim());
  }
  return pedacos.join(String.fromCharCode(10));
}

module.exports = { rodar, carregar, desenhar };
