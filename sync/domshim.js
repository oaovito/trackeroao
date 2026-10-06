/**
 * DOM mínimo para rodar os renderizadores da página fora do navegador nos
 * testes. Não resolve seletores, não faz layout e não aplica CSS.
 */
'use strict';

class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.attrs = {};
    this._class = '';
    this._text = '';
    this._html = '';
    this.dataset = {};
    this.pai = null;
    this.open = false;
    // setProperty, usado pela página para variáveis CSS.
    this.style = {
      setProperty(k, v) { this[k] = v; },
      removeProperty(k) { delete this[k]; },
      getPropertyValue(k) { return this[k]; },
    };
    this.listeners = {};
    // hidden começa false; a marcação não é lida, o teste ajusta se precisar.
    this.hidden = false;
  }

  get className() { return this._class; }
  set className(v) { this._class = String(v); }

  get classList() {
    const self = this;
    return {
      add: (...c) => { self._class = [...new Set(self._class.split(/\s+/).concat(c))].filter(Boolean).join(' '); },
      remove: (...c) => { self._class = self._class.split(/\s+/).filter((x) => x && !c.includes(x)).join(' '); },
      contains: (c) => self._class.split(/\s+/).includes(c),
      // Respeita o segundo argumento (forçar estado).
      toggle: (c, forcar) => {
        const quer = forcar === undefined ? !self.classList.contains(c) : !!forcar;
        if (quer) self.classList.add(c);
        else self.classList.remove(c);
        return quer;
      },
    };
  }

  get textContent() { return this._text || stripTags(this._html) || this.children.map((c) => c.textContent).join(''); }
  set textContent(v) { this._text = String(v); this._html = ''; this.children = []; }

  get innerHTML() { return this._html; }
  set innerHTML(v) { this._html = String(v); this._text = ''; this.children = []; }

  appendChild(c) {
    // Remove do pai anterior antes de anexar.
    if (c.pai && c.pai !== this) {
      const i = c.pai.children.indexOf(c);
      if (i >= 0) c.pai.children.splice(i, 1);
    }
    c.pai = this;
    this.children.push(c);
    return c;
  }

  get parentNode() { return this.pai; }
  addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }
  removeAttribute(k) { delete this.attrs[k]; }
  querySelectorAll() { return []; }

  // `dialog` mínimo: estado aberto e evento de fechar (sem foco nem backdrop).
  showModal() {
    this.open = true;
    this.setAttribute('open', '');
  }

  close() {
    if (!this.open) return;
    this.open = false;
    this.removeAttribute('open');
    for (const fn of (this.listeners.close || []).slice()) {
      try { fn({ type: 'close', target: this }); } catch (e) { /* ouvinte não derruba */ }
    }
    // Ouvintes tratados como `{ once: true }`.
    this.listeners.close = [];
  }

  /** O ancestral mais próximo cujo nome de tag bate. Só o que a página usa. */
  closest(seletor) {
    const alvo = String(seletor).toLowerCase();
    let no = this;
    while (no) {
      if (no.tagName && no.tagName.toLowerCase() === alvo) return no;
      no = no.pai || null;
    }
    return null;
  }

  /** O primeiro descendente com a classe pedida. Só aceita ".classe". */
  querySelector(seletor) {
    const s = String(seletor);
    if (s[0] !== '.') return null;
    const classe = s.slice(1);
    const procurar = (no) => {
      for (const f of no.children) {
        if (f.classList && f.classList.contains(classe)) return f;
        const achado = procurar(f);
        if (achado) return achado;
      }
      return null;
    };
    return procurar(this);
  }

  /** Todo o HTML da subárvore, o que basta para procurar texto e contar linhas. */
  get outerHTML() {
    if (this.tagName === '#TEXT') return this._text;
    const dentro = this._html + this._text + this.children.map((c) => c.outerHTML).join('');
    const cls = this._class ? ' class="' + this._class + '"' : '';
    return '<' + this.tagName.toLowerCase() + cls + '>' + dentro + '</' + this.tagName.toLowerCase() + '>';
  }
}

function stripTags(h) { return String(h || '').replace(/<[^>]*>/g, ''); }

/** Cria o global `document` com os ids pedidos, e devolve o mapa deles. */
function install(ids, opts) {
  const o = opts || {};
  const nodes = {};
  for (const id of ids) nodes[id] = new El('div');
  global.document = {
    createElement: (t) => new El(t),
    // Nó de texto.
    createTextNode: (t) => { const n = new El('#text'); n.textContent = String(t); return n; },
    // Cria elementos sob demanda para ids não declarados.
    getElementById: (id) => (nodes[id] = nodes[id] || new El('div')),
    addEventListener: () => {},
    querySelectorAll: () => [],
    querySelector: () => null,
    documentElement: new El('html'),
    body: new El('body'),
  };
  const guardado = new Map();
  global.localStorage = {
    getItem: (k) => (guardado.has(k) ? guardado.get(k) : null),
    setItem: (k, v) => guardado.set(k, String(v)),
    removeItem: (k) => guardado.delete(k),
  };
  global.window = { matchMedia: () => ({ matches: false, addEventListener: () => {} }) };
  // A página usa `location` para decidir o ritmo do poll.
  global.location = {
    protocol: o.protocol || "http:",
    hostname: o.hostname || "localhost",
    href: (o.protocol || "http:") + "//" + (o.hostname || "localhost") + "/",
  };
  // Timers não são agendados (o teste terminaria nunca); ficam registrados
  // para o teste conferir o intervalo.
  global.intervalosPedidos = [];
  global.setInterval = (fn, ms) => { global.intervalosPedidos.push(ms); return 0; };
  global.setTimeout = () => 0;
  global.clearInterval = () => {};
  global.clearTimeout = () => {};
  return nodes;
}

module.exports = { El, install, stripTags };
