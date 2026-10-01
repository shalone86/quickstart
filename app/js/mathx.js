// Note math: pull numbers out of text, summarise them, and evaluate "12*4 + 3 =" lines.
// Pure functions (unit-tested in tests/).

const NUM_RE = /(?<![\w.])[-−]?\$?(?:\d{1,3}(?:,\d{3})+|\d+)?(?:\.\d+)?(?:[eE][-+]?\d+)?%?(?![\w])/g;

/** Extracts numeric values from free text such as "$1,200.50", "-3", "4.5". Dates and times are skipped. */
export function extractNumbers(text) {
  const out = [];
  const lines = String(text || '').split('\n');
  for (let line of lines) {
    // drop list markers like "1." / "2)" at the start of a line, and dates/times
    line = line.replace(/^\s*\d+[.)]\s+/, ' ')
      .replace(/\b\d{1,4}[-/]\d{1,2}[-/]\d{1,4}\b/g, ' ')
      .replace(/\b\d{1,2}:\d{2}(:\d{2})?\s*(am|pm)?\b/gi, ' ');
    for (const m of line.matchAll(NUM_RE)) {
      const raw = m[0];
      if (!/\d/.test(raw) || raw.endsWith('%')) continue;
      const v = parseFloat(raw.replace(/[−]/g, '-').replace(/[$,]/g, ''));
      if (Number.isFinite(v)) out.push(v);
    }
  }
  return out;
}

export function summarize(nums) {
  if (!nums.length) return null;
  const sum = nums.reduce((a, b) => a + b, 0);
  const product = nums.reduce((a, b) => a * b, 1);
  const difference = nums.slice(1).reduce((a, b) => a - b, nums[0]);
  const quotient = nums.slice(1).every((b) => b !== 0) ? nums.slice(1).reduce((a, b) => a / b, nums[0]) : NaN;
  return {
    count: nums.length,
    sum,
    average: sum / nums.length,
    min: Math.min(...nums),
    max: Math.max(...nums),
    difference,
    product,
    quotient,
  };
}

export function formatNumber(v) {
  if (!Number.isFinite(v)) return '—';
  const r = Math.round(v * 1e10) / 1e10;
  const abs = Math.abs(r);
  if (abs !== 0 && (abs >= 1e15 || abs < 1e-6)) return r.toExponential(6).replace(/\.?0+e/, 'e');
  return r.toLocaleString(undefined, { maximumFractionDigits: 6, useGrouping: abs >= 10000 });
}

/* ---- expression evaluator (no eval) ----
   Supports + - * / ^ % (modulo), parentheses, ×, ÷, unary minus, commas in numbers,
   $ signs, and functions sqrt/abs/round/floor/ceil/min/max/sum/avg. */

function lex(src) {
  const s = src.replace(/×/g, '*').replace(/÷/g, '/').replace(/−/g, '-').replace(/\$/g, '');
  const toks = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }
    if (/[\d.]/.test(c)) {
      const m = s.slice(i).match(/^(\d{1,3}(,\d{3})+|\d*)(\.\d+)?([eE][-+]?\d+)?/);
      if (!m || m[0] === '' || m[0] === '.') throw new Error('bad number');
      toks.push({ t: 'n', v: parseFloat(m[0].replace(/,/g, '')) });
      i += m[0].length;
      continue;
    }
    if (/[a-z]/i.test(c)) {
      const m = s.slice(i).match(/^[a-z]+/i);
      toks.push({ t: 'f', v: m[0].toLowerCase() });
      i += m[0].length;
      continue;
    }
    if ('+-*/^%(),'.includes(c)) { toks.push({ t: c }); i++; continue; }
    throw new Error(`unexpected ${c}`);
  }
  return toks;
}

const FNS = {
  sqrt: (a) => Math.sqrt(a[0]), abs: (a) => Math.abs(a[0]), round: (a) => (a.length > 1 ? Math.round(a[0] * 10 ** a[1]) / 10 ** a[1] : Math.round(a[0])),
  floor: (a) => Math.floor(a[0]), ceil: (a) => Math.ceil(a[0]), min: (a) => Math.min(...a), max: (a) => Math.max(...a),
  sum: (a) => a.reduce((x, y) => x + y, 0), avg: (a) => a.reduce((x, y) => x + y, 0) / a.length,
  pi: () => Math.PI,
};

export function evaluate(expr) {
  const toks = lex(expr);
  let p = 0;
  const peek = () => toks[p];
  const take = (t) => { if (toks[p]?.t !== t) throw new Error(`expected ${t}`); return toks[p++]; };
  const primary = () => {
    const tk = toks[p++];
    if (!tk) throw new Error('unexpected end');
    if (tk.t === 'n') return tk.v;
    if (tk.t === '-') return -power();
    if (tk.t === '+') return power();
    if (tk.t === '(') { const v = add(); take(')'); return v; }
    if (tk.t === 'f') {
      const fn = FNS[tk.v];
      if (!fn) throw new Error(`unknown ${tk.v}`);
      if (tk.v === 'pi') return Math.PI;
      take('(');
      const args = [add()];
      while (peek()?.t === ',') { p++; args.push(add()); }
      take(')');
      return fn(args);
    }
    throw new Error('syntax');
  };
  const power = () => {
    const b = primary();
    if (peek()?.t === '^') { p++; return b ** unary(); }
    return b;
  };
  const unary = () => {
    if (peek()?.t === '-') { p++; return -unary(); }
    if (peek()?.t === '+') { p++; return unary(); }
    return power();
  };
  const mul = () => {
    let v = unary();
    while (peek() && '*/%'.includes(peek().t) && peek().t.length === 1) {
      const op = toks[p++].t;
      const r = unary();
      v = op === '*' ? v * r : op === '/' ? v / r : v % r;
    }
    return v;
  };
  const add = () => {
    let v = mul();
    while (peek() && (peek().t === '+' || peek().t === '-')) {
      const op = toks[p++].t;
      const r = mul();
      v = op === '+' ? v + r : v - r;
    }
    return v;
  };
  const v = add();
  if (p !== toks.length) throw new Error('trailing input');
  return v;
}

/**
 * If `line` ends with "=" after an arithmetic expression, returns { expr, value, text }.
 * Only triggers when the expression contains an operator or function so prose like "x =" is ignored.
 */
export function inlineCalc(line) {
  const m = String(line).match(/([\d$(][\d\s.,$()+\-−*/×÷^%a-z]*?)\s*=\s*$/i);
  if (!m) return null;
  let expr = m[1].trim();
  // take the longest tail that parses
  const startIdx = line.length - m[0].length;
  const candidates = [];
  const head = line.slice(0, startIdx + m[0].length).replace(/\s*=\s*$/, '');
  for (let i = 0; i < head.length; i++) {
    if (i === 0 || /[\s:(]/.test(head[i - 1])) candidates.push(head.slice(i).trim());
  }
  for (const c of candidates) {
    if (!/\d/.test(c) || !/[+\-−*/×÷^%(]|\b(sqrt|abs|round|floor|ceil|min|max|sum|avg)\b/i.test(c.replace(/^-/, ''))) continue;
    if (/[a-z]{2,}/i.test(c.replace(/\b(sqrt|abs|round|floor|ceil|min|max|sum|avg|pi)\b/gi, ''))) continue;
    try {
      const value = evaluate(c);
      if (Number.isFinite(value)) { expr = c; return { expr, value, text: formatNumber(value) }; }
    } catch { /* try a shorter tail */ }
  }
  return null;
}
