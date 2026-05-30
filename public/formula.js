/* formula.js — runtime formula + rollup evaluator (NOT stored in the log).
 *
 * The expression lives in the schema (DEF _schema.fields.<set>.formula);
 * the COMPUTED VALUE is derived on every render from the current fold state.
 * Nothing here writes to the log.
 *
 *   window.Formula.evaluate(expr, ctx)         -> { ok, value, error }
 *   window.Formula.evaluateRollup(cfg, ctx)    -> { ok, value, error }
 *
 *   ctx = {
 *     record:  <entity>,         // the row we're computing for (with _anchor)
 *     state:   <fold state>,     // for cross-row, link, and rollup lookups
 *     fieldType: (name) => type, // resolve a referenced field's declared type
 *   }
 *
 * Formula dialect — Airtable-flavoured:
 *   {Field}                        bracketed field reference
 *   + - * / % ()                   arithmetic
 *   == != < <= > >= && || !        comparison + logic
 *   "string" 'string' 123 0.5      literals
 *   a & b                          string concat (Airtable's &)
 *   SUM(...) IF(c,a,b) etc.        curated function library (case-insensitive)
 *
 * Rollups:
 *   { via: '<relation>', field: '<name>'?, fn: 'sum'|'count'|'avg'|'min'|'max'|'list'|'concat'|'and'|'or' }
 *   `via` follows CON edges (either direction) of that relation_type;
 *   the linked entities' field values get aggregated. `count`/`list` ignore `field`.
 */

(function () {
'use strict';

// ─────────────────────────────────────────────────────────────────────────
// Function library
// ─────────────────────────────────────────────────────────────────────────

const FUNCS = {
  // numeric
  SUM:    (...a) => flatten(a).reduce((x, y) => num(x) + num(y), 0),
  AVG:    (...a) => {
    const arr = flatten(a).map(num);
    return arr.length ? arr.reduce((x, y) => x + y, 0) / arr.length : 0;
  },
  AVERAGE: (...a) => FUNCS.AVG(...a),
  MIN:    (...a) => Math.min(...flatten(a).map(num)),
  MAX:    (...a) => Math.max(...flatten(a).map(num)),
  COUNT:  (...a) => flatten(a).filter(v => v !== undefined && v !== null && v !== '' && !isNaN(parseFloat(v))).length,
  COUNTA: (...a) => flatten(a).filter(v => v !== undefined && v !== null && v !== '').length,
  COUNTALL: (...a) => flatten(a).length,
  ROUND:  (n, d = 0) => {
    const p = Math.pow(10, num(d));
    return Math.round(num(n) * p) / p;
  },
  ROUNDUP:   (n, d = 0) => { const p = Math.pow(10, num(d)); return Math.ceil(num(n) * p) / p; },
  ROUNDDOWN: (n, d = 0) => { const p = Math.pow(10, num(d)); return Math.trunc(num(n) * p) / p; },
  ABS:    n => Math.abs(num(n)),
  FLOOR:  n => Math.floor(num(n)),
  CEIL:   n => Math.ceil(num(n)),
  CEILING:n => Math.ceil(num(n)),
  INT:    n => Math.trunc(num(n)),
  EVEN:   n => { const x = num(n); return x % 2 === 0 ? x : x + (x >= 0 ? 1 : -1); },
  ODD:    n => { const x = num(n); return Math.abs(x) % 2 === 1 ? x : x + (x >= 0 ? 1 : -1); },
  POW:    (a, b) => Math.pow(num(a), num(b)),
  POWER:  (a, b) => Math.pow(num(a), num(b)),
  SQRT:   n => Math.sqrt(num(n)),
  EXP:    n => Math.exp(num(n)),
  LOG:    (n, base) => base === undefined ? Math.log10(num(n)) : Math.log(num(n)) / Math.log(num(base)),
  MOD:    (a, b) => num(a) % num(b),
  VALUE:  v => {
    if (typeof v === 'number') return v;
    const m = stringify(v).match(/-?\d+(?:\.\d+)?/);
    return m ? parseFloat(m[0]) : 0;
  },

  // logic
  IF:     (c, a, b) => truthy(c) ? a : b,
  AND:    (...a) => a.every(truthy),
  OR:     (...a) => a.some(truthy),
  XOR:    (...a) => a.reduce((x, y) => x !== truthy(y), false),
  NOT:    a => !truthy(a),
  BLANK:  v => v === undefined || v === null || v === '',
  ERROR:  (msg = 'error') => { throw new Error(stringify(msg)); },
  ISERROR:(v) => v && typeof v === 'object' && v.__isErr === true,
  IFERROR:(v, fb) => (v && typeof v === 'object' && v.__isErr) || (typeof v === 'number' && !isFinite(v)) ? fb : v,
  // SWITCH(expr, key1, val1, key2, val2, ..., default?) — match by ===
  SWITCH: (expr, ...rest) => {
    for (let i = 0; i + 1 < rest.length; i += 2) {
      if (rest[i] === expr) return rest[i + 1];
    }
    return rest.length % 2 === 1 ? rest[rest.length - 1] : null;
  },

  // string
  CONCAT:      (...a) => a.map(stringify).join(''),
  CONCATENATE: (...a) => a.map(stringify).join(''),
  LEN:    s => stringify(s).length,
  LOWER:  s => stringify(s).toLowerCase(),
  UPPER:  s => stringify(s).toUpperCase(),
  TRIM:   s => stringify(s).trim(),
  LEFT:   (s, n) => stringify(s).slice(0, num(n)),
  RIGHT:  (s, n) => { const str = stringify(s); return str.slice(str.length - num(n)); },
  MID:    (s, start, len) => stringify(s).slice(num(start) - 1, num(start) - 1 + num(len)),
  FIND:   (needle, hay, start = 0) => {
    const i = stringify(hay).indexOf(stringify(needle), num(start));
    return i + 1; // FIND is 1-indexed; returns 0 if not found
  },
  SEARCH: (needle, hay, start = 0) => {
    const i = stringify(hay).toLowerCase().indexOf(stringify(needle).toLowerCase(), num(start));
    return i === -1 ? '' : i + 1;
  },
  SUBSTITUTE: (s, find, rep, index) => {
    const str = stringify(s), f = stringify(find), r = stringify(rep);
    if (index === undefined) return str.split(f).join(r);
    const idx = num(index);
    let count = 0, i = 0, out = '';
    while (i < str.length) {
      const next = str.indexOf(f, i);
      if (next === -1) { out += str.slice(i); break; }
      count++;
      out += str.slice(i, next) + (count === idx ? r : f);
      i = next + f.length;
    }
    return out;
  },
  REPLACE: (s, find, rep) => stringify(s).split(stringify(find)).join(stringify(rep)),
  REPT:   (s, n) => stringify(s).repeat(Math.max(0, num(n))),
  T:      v => typeof v === 'string' ? v : '',
  ENCODE_URL_COMPONENT: v => encodeURIComponent(stringify(v)),

  // regex
  REGEX_MATCH:   (s, pattern) => { try { return new RegExp(stringify(pattern)).test(stringify(s)); } catch (e) { return false; } },
  REGEX_EXTRACT: (s, pattern) => { try { const m = stringify(s).match(new RegExp(stringify(pattern))); return m ? m[0] : ''; } catch (e) { return ''; } },
  REGEX_REPLACE: (s, pattern, rep) => { try { return stringify(s).replace(new RegExp(stringify(pattern), 'g'), stringify(rep)); } catch (e) { return stringify(s); } },

  // arrays
  ARRAYCOMPACT: (...a) => flatten(a).filter(v => v !== undefined && v !== null && v !== ''),
  ARRAYFLATTEN: (...a) => flatten(a),
  ARRAYUNIQUE:  (...a) => Array.from(new Set(flatten(a))),

  // dates — return Date objects so chained fns work; stringify at the edge
  TODAY:  () => new Date().toISOString().slice(0, 10),
  NOW:    () => new Date().toISOString(),
  YEAR:   d => new Date(d).getFullYear(),
  MONTH:  d => new Date(d).getMonth() + 1,
  DAY:    d => new Date(d).getDate(),
  HOUR:   d => new Date(d).getHours(),
  MINUTE: d => new Date(d).getMinutes(),
  SECOND: d => new Date(d).getSeconds(),
  WEEKDAY: (d) => new Date(d).getDay(), // 0=Sunday
  DATEADD: (d, amount, unit = 'days') => {
    const date = new Date(d);
    const n = num(amount);
    switch (String(unit).toLowerCase()) {
      case 'seconds': date.setSeconds(date.getSeconds() + n); break;
      case 'minutes': date.setMinutes(date.getMinutes() + n); break;
      case 'hours':   date.setHours(date.getHours() + n); break;
      case 'days':    date.setDate(date.getDate() + n); break;
      case 'weeks':   date.setDate(date.getDate() + n * 7); break;
      case 'months':  date.setMonth(date.getMonth() + n); break;
      case 'years':   date.setFullYear(date.getFullYear() + n); break;
      default:        date.setDate(date.getDate() + n);
    }
    return date.toISOString();
  },
  DATESTR: d => d ? new Date(d).toISOString().slice(0, 10) : '',
  TIMESTR: d => d ? new Date(d).toISOString().slice(11, 19) : '',
  DATETIME_FORMAT: (d, fmt = 'YYYY-MM-DD') => formatDate(new Date(d), stringify(fmt)),
  DATETIME_PARSE:  (s) => { const t = Date.parse(stringify(s)); return isNaN(t) ? null : new Date(t).toISOString(); },
  DATETIME_DIFF:   (a, b, unit = 'days') => {
    const diff = new Date(a).getTime() - new Date(b).getTime();
    switch (String(unit).toLowerCase()) {
      case 'milliseconds': return diff;
      case 'seconds': return diff / 1000;
      case 'minutes': return diff / 60000;
      case 'hours':   return diff / 3600000;
      case 'days':    return diff / 86400000;
      case 'weeks':   return diff / (7 * 86400000);
      default:        return diff / 86400000;
    }
  },
  IS_BEFORE: (a, b) => new Date(a).getTime() < new Date(b).getTime(),
  IS_AFTER:  (a, b) => new Date(a).getTime() > new Date(b).getTime(),
  IS_SAME:   (a, b, unit = 'milliseconds') => {
    const aa = new Date(a), bb = new Date(b);
    switch (String(unit).toLowerCase()) {
      case 'year':  return aa.getFullYear() === bb.getFullYear();
      case 'month': return aa.getFullYear() === bb.getFullYear() && aa.getMonth() === bb.getMonth();
      case 'day':   return aa.toDateString() === bb.toDateString();
      default:      return aa.getTime() === bb.getTime();
    }
  },
  FROMNOW: d => relTime(new Date(d), new Date(), false),
  TONOW:   d => relTime(new Date(d), new Date(), false),
};

// Constants exposed alongside functions
const CONSTS = { TRUE: true, FALSE: false, VOID: null, PI: Math.PI, E: Math.E };

const FUNC_NAMES = Object.keys(FUNCS);
const FUNC_RE = new RegExp('\\b(' + FUNC_NAMES.join('|') + '|TRUE|FALSE|VOID|PI|E)\\b', 'gi');

// ─────────────────────────────────────────────────────────────────────────
// Evaluator (per-row)
// ─────────────────────────────────────────────────────────────────────────

function evaluate(expr, ctx) {
  if (!expr || !String(expr).trim()) return { ok: false, value: null, error: 'empty formula' };
  const record = ctx?.record || {};
  let transformed;
  try {
    // 1. {field} → __f("field")
    transformed = String(expr).replace(/\{([^}]+)\}/g, (_, name) => '__f(' + JSON.stringify(name.trim()) + ')');
    // 2. Normalize known identifiers (functions + constants) to uppercase.
    transformed = transformed.replace(FUNC_RE, (m) => m.toUpperCase());
    // (Airtable "&" concat is handled natively by the evaluator below.)
  } catch (e) {
    return { ok: false, value: null, error: 'parse: ' + (e?.message || String(e)) };
  }

  const env = Object.assign({}, FUNCS, CONSTS, {
    __f: (name) => record[name],
    RECORD_ID: () => record._anchor,
    CREATED_TIME: () => record._created,
    LAST_MODIFIED_TIME: () => record._updated || record._created,
  });

  try {
    // Parse to an AST and interpret against the curated env. We deliberately
    // do NOT use new Function/eval: the formula string is remote, attacker-
    // controllable data (DEF _schema.fields.<set>.formula set by any room
    // member), so executing it as JS would be client-side RCE in every
    // viewer's browser. The interpreter below supports only literals,
    // arithmetic/comparison/logic operators, parenthesised grouping, and
    // calls to allowlisted FUNCS/CONSTS — no property access, no globals,
    // no assignment, no arbitrary identifiers.
    const ast = parseFormula(transformed);
    const value = evalNode(ast, env);
    if (value && typeof value === 'object' && value.__isErr) {
      return { ok: false, value: null, error: value.message };
    }
    if (typeof value === 'number' && !isFinite(value)) {
      return { ok: false, value: null, error: 'non-finite result' };
    }
    return { ok: true, value, error: null };
  } catch (e) {
    return { ok: false, value: null, error: 'eval: ' + (e?.message || String(e)) };
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Safe expression evaluator (tokenizer + Pratt parser + tree-walk interpreter)
//
// Grammar (precedence low→high):
//   || , && , (== != < <= > >=) , (+ - &) , (* / %) , unary(! - +) , call/atom
// Atoms: number, string, identifier (resolved ONLY against env), (group),
//        FUNC(args...). No member access, no assignment, no `this`/globals.
// ─────────────────────────────────────────────────────────────────────────

function tokenize(src) {
  const toks = [];
  let i = 0;
  const n = src.length;
  const isIdStart = (c) => /[A-Za-z_$]/.test(c);
  const isIdPart  = (c) => /[A-Za-z0-9_$]/.test(c);
  while (i < n) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
    // string literal (single or double); supports \\ and \" / \' escapes
    if (c === '"' || c === "'") {
      const quote = c; let j = i + 1; let out = '';
      while (j < n && src[j] !== quote) {
        if (src[j] === '\\' && j + 1 < n) { out += src[j + 1]; j += 2; }
        else { out += src[j]; j++; }
      }
      if (j >= n) throw new Error('unterminated string');
      toks.push({ t: 'str', v: out }); i = j + 1; continue;
    }
    // number (integer or decimal)
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] || ''))) {
      let j = i; while (j < n && /[0-9.]/.test(src[j])) j++;
      const raw = src.slice(i, j);
      if ((raw.match(/\./g) || []).length > 1) throw new Error('bad number: ' + raw);
      toks.push({ t: 'num', v: parseFloat(raw) }); i = j; continue;
    }
    // identifier
    if (isIdStart(c)) {
      let j = i; while (j < n && isIdPart(src[j])) j++;
      toks.push({ t: 'id', v: src.slice(i, j) }); i = j; continue;
    }
    // multi-char operators
    const two = src.slice(i, i + 2);
    if (two === '==' || two === '!=' || two === '<=' || two === '>=' || two === '&&' || two === '||') {
      toks.push({ t: 'op', v: two }); i += 2; continue;
    }
    // single-char operators / punctuation
    if ('+-*/%<>!&(),'.includes(c)) { toks.push({ t: 'op', v: c }); i++; continue; }
    throw new Error('unexpected character: ' + JSON.stringify(c));
  }
  toks.push({ t: 'eof' });
  return toks;
}

function parseFormula(src) {
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];
  const next = () => toks[p++];
  const expect = (v) => {
    const tk = next();
    if (tk.t === 'op' && tk.v === v) return tk;
    throw new Error('expected "' + v + '"');
  };

  // operator-precedence climbing
  const BIN = [
    ['||'],
    ['&&'],
    ['==', '!=', '<', '<=', '>', '>='],
    ['+', '-', '&'],
    ['*', '/', '%'],
  ];

  function parseExpr(level) {
    if (level >= BIN.length) return parseUnary();
    let left = parseExpr(level + 1);
    for (;;) {
      const tk = peek();
      if (tk.t === 'op' && BIN[level].includes(tk.v)) {
        next();
        const right = parseExpr(level + 1);
        left = { k: 'bin', op: tk.v, left, right };
      } else break;
    }
    return left;
  }

  function parseUnary() {
    const tk = peek();
    if (tk.t === 'op' && (tk.v === '!' || tk.v === '-' || tk.v === '+')) {
      next();
      return { k: 'un', op: tk.v, arg: parseUnary() };
    }
    return parseAtom();
  }

  function parseAtom() {
    const tk = next();
    if (tk.t === 'num') return { k: 'num', v: tk.v };
    if (tk.t === 'str') return { k: 'str', v: tk.v };
    if (tk.t === 'op' && tk.v === '(') {
      const e = parseExpr(0);
      expect(')');
      return e;
    }
    if (tk.t === 'id') {
      // function call?
      if (peek().t === 'op' && peek().v === '(') {
        next(); // consume '('
        const args = [];
        if (!(peek().t === 'op' && peek().v === ')')) {
          args.push(parseExpr(0));
          while (peek().t === 'op' && peek().v === ',') { next(); args.push(parseExpr(0)); }
        }
        expect(')');
        return { k: 'call', name: tk.v, args };
      }
      return { k: 'id', name: tk.v };
    }
    throw new Error('unexpected token: ' + (tk.t === 'eof' ? 'end of formula' : JSON.stringify(tk.v)));
  }

  const ast = parseExpr(0);
  if (peek().t !== 'eof') throw new Error('trailing input after expression');
  return ast;
}

function evalNode(node, env) {
  switch (node.k) {
    case 'num': return node.v;
    case 'str': return node.v;
    case 'id': {
      // Identifiers resolve ONLY against the curated env (own properties).
      if (Object.prototype.hasOwnProperty.call(env, node.name)) {
        const v = env[node.name];
        return typeof v === 'function' ? v() : v; // zero-arg callables (RECORD_ID, etc.)
      }
      throw new Error('unknown identifier: ' + node.name);
    }
    case 'un': {
      const a = evalNode(node.arg, env);
      if (node.op === '!') return !truthy(a);
      if (node.op === '-') return -num(a);
      return +num(a);
    }
    case 'bin': {
      const op = node.op;
      if (op === '&&') { const l = evalNode(node.left, env); return truthy(l) ? evalNode(node.right, env) : l; }
      if (op === '||') { const l = evalNode(node.left, env); return truthy(l) ? l : evalNode(node.right, env); }
      const l = evalNode(node.left, env);
      const r = evalNode(node.right, env);
      switch (op) {
        case '+': return (typeof l === 'string' || typeof r === 'string') ? stringify(l) + stringify(r) : num(l) + num(r);
        case '&': return stringify(l) + stringify(r);
        case '-': return num(l) - num(r);
        case '*': return num(l) * num(r);
        case '/': return num(l) / num(r);
        case '%': return num(l) % num(r);
        case '==': return l === r;
        case '!=': return l !== r;
        case '<':  return num(l) <  num(r);
        case '<=': return num(l) <= num(r);
        case '>':  return num(l) >  num(r);
        case '>=': return num(l) >= num(r);
      }
      throw new Error('bad operator: ' + op);
    }
    case 'call': {
      const fn = Object.prototype.hasOwnProperty.call(env, node.name) ? env[node.name] : undefined;
      if (typeof fn !== 'function') throw new Error('unknown function: ' + node.name);
      // IF needs lazy branches so the untaken side can't error; the rest are eager.
      if (node.name === 'IF') {
        const c = node.args.length > 0 ? evalNode(node.args[0], env) : undefined;
        return truthy(c)
          ? (node.args[1] !== undefined ? evalNode(node.args[1], env) : null)
          : (node.args[2] !== undefined ? evalNode(node.args[2], env) : null);
      }
      const args = node.args.map(a => evalNode(a, env));
      return fn(...args);
    }
  }
  throw new Error('bad node');
}

// ─────────────────────────────────────────────────────────────────────────
// Rollup — aggregate over linked records
// ─────────────────────────────────────────────────────────────────────────

function evaluateRollup(cfg, ctx) {
  const state = ctx?.state;
  const record = ctx?.record;
  if (!state || !record) return { ok: false, value: null, error: 'rollup needs ctx.state + ctx.record' };
  const via = cfg?.via;
  const fn  = (cfg?.fn || 'count').toLowerCase();
  if (!via) return { ok: false, value: null, error: 'rollup needs `via` (relation name)' };

  const anchor = record._anchor;
  const linked = [];
  for (const c of state.connections) {
    if (c.type !== via) continue;
    const otherAnchor = c.source === anchor ? c.target
                      : c.target === anchor ? c.source
                      : null;
    if (!otherAnchor) continue;
    const e = state.entities[otherAnchor];
    if (e && !e._removed) linked.push(e);
  }

  if (fn === 'count') return { ok: true, value: linked.length, error: null };
  if (fn === 'list')  return { ok: true, value: linked.map(labelOf).join(', '), error: null };

  const field = cfg.field;
  if (!field) return { ok: false, value: null, error: 'rollup needs `field` for fn=' + fn };
  const raw = linked.map(e => e[field]).filter(v => v !== undefined && v !== null && v !== '');

  if (fn === 'concat') return { ok: true, value: raw.map(stringify).join(', '), error: null };
  if (fn === 'and')    return { ok: true, value: raw.every(truthy), error: null };
  if (fn === 'or')     return { ok: true, value: raw.some(truthy),  error: null };

  const nums = raw.map(num).filter(n => !isNaN(n));
  if (fn === 'sum')  return { ok: true, value: nums.reduce((a, b) => a + b, 0), error: null };
  if (fn === 'avg')  return { ok: true, value: nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0, error: null };
  if (fn === 'min')  return { ok: nums.length > 0, value: nums.length ? Math.min(...nums) : null, error: nums.length ? null : 'no values' };
  if (fn === 'max')  return { ok: nums.length > 0, value: nums.length ? Math.max(...nums) : null, error: nums.length ? null : 'no values' };
  return { ok: false, value: null, error: 'unknown fn: ' + fn };
}

// ─────────────────────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────────────────────

function flatten(arr) {
  const out = [];
  const walk = (x) => {
    if (Array.isArray(x)) x.forEach(walk);
    else out.push(x);
  };
  walk(arr);
  return out;
}
function labelOf(e) {
  return e.Name || e.title || e.body || e.claim || e.what || e._anchor;
}
function num(v) {
  if (typeof v === 'number') return v;
  if (v === undefined || v === null || v === '' || v === false) return 0;
  if (v === true) return 1;
  const n = parseFloat(v);
  return isNaN(n) ? 0 : n;
}
function truthy(v) {
  if (v === undefined || v === null) return false;
  if (typeof v === 'number') return v !== 0 && !isNaN(v);
  if (typeof v === 'string') return v.length > 0;
  if (Array.isArray(v)) return v.length > 0;
  return !!v;
}
function stringify(v) {
  if (v === undefined || v === null) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

// Minimal DATETIME_FORMAT — supports common tokens; not full moment grammar.
function formatDate(d, fmt) {
  if (isNaN(d.getTime())) return '';
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const map = {
    YYYY: d.getFullYear(),
    YY:   pad(d.getFullYear() % 100),
    MM:   pad(d.getMonth() + 1),
    M:    d.getMonth() + 1,
    DD:   pad(d.getDate()),
    D:    d.getDate(),
    HH:   pad(d.getHours()),
    H:    d.getHours(),
    mm:   pad(d.getMinutes()),
    m:    d.getMinutes(),
    ss:   pad(d.getSeconds()),
    s:    d.getSeconds(),
  };
  return fmt.replace(/YYYY|YY|MM|M|DD|D|HH|H|mm|m|ss|s/g, (t) => String(map[t]));
}

function relTime(from, to) {
  const diff = to.getTime() - from.getTime();
  const abs = Math.abs(diff);
  const past = diff > 0;
  const units = [
    [31536000000, 'year'],
    [2592000000,  'month'],
    [604800000,   'week'],
    [86400000,    'day'],
    [3600000,     'hour'],
    [60000,       'minute'],
    [1000,        'second'],
  ];
  for (const [ms, name] of units) {
    if (abs >= ms) {
      const n = Math.floor(abs / ms);
      const plural = n === 1 ? '' : 's';
      return past ? `${n} ${name}${plural} ago` : `in ${n} ${name}${plural}`;
    }
  }
  return 'just now';
}

window.Formula = {
  evaluate,
  evaluateRollup,
  FUNCTIONS: FUNC_NAMES,
  ROLLUP_FNS: ['sum', 'count', 'avg', 'min', 'max', 'list', 'concat', 'and', 'or'],
};

})();
