/**
 * Small spreadsheet formula engine. Cells starting with "=" are formulas.
 * References use column letters by position and 1-based row numbers (A1, B2:B20).
 */
export type FVal = number | string | boolean;

export class FormulaError {
  constructor(public code: '#ERR!' | '#REF!' | '#VALUE!' | '#DIV/0!' | '#CIRC!' | '#NAME?' | '#N/A') {}
  toString() {
    return this.code;
  }
}

type Result = FVal | FormulaError;
type Getter = (col: number, row: number) => string | undefined;

export function colLetter(i: number): string {
  let s = '';
  i += 1;
  while (i > 0) {
    const m = (i - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    i = Math.floor((i - 1) / 26);
  }
  return s;
}

function colIndex(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

// ---------- tokenizer ----------

type Tok =
  | { t: 'num'; v: number }
  | { t: 'str'; v: string }
  | { t: 'ref'; c: number; r: number }
  | { t: 'id'; v: string }
  | { t: 'op'; v: string };

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (/[0-9.]/.test(ch)) {
      const m = src.slice(i).match(/^\d*\.?\d+(?:[eE][+-]?\d+)?/);
      if (!m) throw new FormulaError('#ERR!');
      toks.push({ t: 'num', v: Number(m[0]) });
      i += m[0].length;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let s = '';
      while (j < src.length) {
        if (src[j] === '"' && src[j + 1] === '"') {
          s += '"';
          j += 2;
        } else if (src[j] === '"') break;
        else s += src[j++];
      }
      if (src[j] !== '"') throw new FormulaError('#ERR!');
      toks.push({ t: 'str', v: s });
      i = j + 1;
      continue;
    }
    const ref = src.slice(i).match(/^\$?([A-Za-z]{1,3})\$?(\d+)(?![A-Za-z0-9_(])/);
    if (ref) {
      toks.push({ t: 'ref', c: colIndex(ref[1]), r: Number(ref[2]) - 1 });
      i += ref[0].length;
      continue;
    }
    const id = src.slice(i).match(/^[A-Za-z_][A-Za-z0-9_.]*/);
    if (id) {
      toks.push({ t: 'id', v: id[0].toUpperCase() });
      i += id[0].length;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (['<=', '>=', '<>'].includes(two)) {
      toks.push({ t: 'op', v: two });
      i += 2;
      continue;
    }
    if ('+-*/^&=<>(),:%'.includes(ch)) {
      toks.push({ t: 'op', v: ch });
      i++;
      continue;
    }
    throw new FormulaError('#ERR!');
  }
  return toks;
}

// ---------- coercion ----------

const isErr = (v: unknown): v is FormulaError => v instanceof FormulaError;

function literal(raw: string): FVal {
  const s = raw.trim();
  if (s === '') return '';
  if (/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(s)) return Number(s);
  if (/^true$/i.test(s)) return true;
  if (/^false$/i.test(s)) return false;
  return raw;
}

function num(v: FVal): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v.trim() === '') return 0;
  const n = Number(v);
  if (Number.isNaN(n)) throw new FormulaError('#VALUE!');
  return n;
}

function text(v: FVal): string {
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'number') return formatNumber(v);
  return v;
}

function truth(v: FVal): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (/^true$/i.test(v)) return true;
  if (/^false$/i.test(v) || v === '') return false;
  throw new FormulaError('#VALUE!');
}

export function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return '#NUM!';
  if (Number.isInteger(n)) return String(n);
  return String(Number(n.toPrecision(10)));
}

function compare(a: FVal, b: FVal): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  const sa = text(a).toLowerCase();
  const sb = text(b).toLowerCase();
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

function matchesCriterion(v: FVal, crit: FVal): boolean {
  if (typeof crit !== 'string') return compare(v, crit) === 0;
  const m = crit.match(/^(<=|>=|<>|<|>|=)?(.*)$/s)!;
  const op = m[1] ?? '=';
  const target = literal(m[2]);
  const cv = typeof target === 'number' && typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v)) ? Number(v) : v;
  const c = compare(cv, target);
  switch (op) {
    case '<':
      return c < 0;
    case '>':
      return c > 0;
    case '<=':
      return c <= 0;
    case '>=':
      return c >= 0;
    case '<>':
      return c !== 0;
    default:
      return c === 0;
  }
}

// ---------- evaluator ----------

type Arg = FVal | FVal[];

export function createEvaluator(get: Getter, cols: number, rows: number) {
  const cache = new Map<string, Result>();
  const visiting = new Set<string>();

  function cell(c: number, r: number): Result {
    if (c < 0 || r < 0 || c >= cols || r >= rows) return new FormulaError('#REF!');
    const key = `${c}:${r}`;
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    if (visiting.has(key)) return new FormulaError('#CIRC!');
    const raw = get(c, r) ?? '';
    let v: Result;
    if (raw.startsWith('=')) {
      visiting.add(key);
      try {
        v = evaluate(raw.slice(1));
      } catch (e) {
        v = isErr(e) ? e : new FormulaError('#ERR!');
      }
      visiting.delete(key);
    } else v = literal(raw);
    cache.set(key, v);
    return v;
  }

  function evaluate(src: string): FVal {
    const toks = tokenize(src);
    let p = 0;
    const peek = () => toks[p];
    const isOp = (v: string) => peek()?.t === 'op' && (peek() as { v: string }).v === v;
    const expectOp = (v: string) => {
      if (!isOp(v)) throw new FormulaError('#ERR!');
      p++;
    };

    const scalar = (a: Arg): FVal => {
      if (Array.isArray(a)) {
        if (a.length === 1) return a[0];
        throw new FormulaError('#VALUE!');
      }
      return a;
    };

    const unwrap = (v: Result): FVal => {
      if (isErr(v)) throw v;
      return v;
    };

    function comparison(): Arg {
      let left = concat();
      while (peek()?.t === 'op' && ['=', '<>', '<', '>', '<=', '>='].includes((peek() as { v: string }).v)) {
        const op = (toks[p++] as { v: string }).v;
        const a = scalar(left);
        const b = scalar(concat());
        const c = compare(a, b);
        left = op === '=' ? c === 0 : op === '<>' ? c !== 0 : op === '<' ? c < 0 : op === '>' ? c > 0 : op === '<=' ? c <= 0 : c >= 0;
      }
      return left;
    }
    function concat(): Arg {
      let left = additive();
      while (isOp('&')) {
        p++;
        left = text(scalar(left)) + text(scalar(additive()));
      }
      return left;
    }
    function additive(): Arg {
      let left = term();
      while (isOp('+') || isOp('-')) {
        const op = (toks[p++] as { v: string }).v;
        const a = num(scalar(left));
        const b = num(scalar(term()));
        left = op === '+' ? a + b : a - b;
      }
      return left;
    }
    function term(): Arg {
      let left = power();
      while (isOp('*') || isOp('/')) {
        const op = (toks[p++] as { v: string }).v;
        const a = num(scalar(left));
        const b = num(scalar(power()));
        if (op === '/' && b === 0) throw new FormulaError('#DIV/0!');
        left = op === '*' ? a * b : a / b;
      }
      return left;
    }
    function power(): Arg {
      let left = unary();
      while (isOp('^')) {
        p++;
        left = Math.pow(num(scalar(left)), num(scalar(unary())));
      }
      return left;
    }
    function unary(): Arg {
      if (isOp('-')) {
        p++;
        return -num(scalar(unary()));
      }
      if (isOp('+')) {
        p++;
        return num(scalar(unary()));
      }
      const v = primary();
      if (isOp('%')) {
        p++;
        return num(scalar(v)) / 100;
      }
      return v;
    }
    function primary(): Arg {
      const tk = toks[p++];
      if (!tk) throw new FormulaError('#ERR!');
      if (tk.t === 'num' || tk.t === 'str') return tk.v;
      if (tk.t === 'ref') {
        if (isOp(':')) {
          p++;
          const end = toks[p++];
          if (end?.t !== 'ref') throw new FormulaError('#REF!');
          const out: FVal[] = [];
          const [c1, c2] = [Math.min(tk.c, end.c), Math.max(tk.c, end.c)];
          const [r1, r2] = [Math.min(tk.r, end.r), Math.max(tk.r, Math.min(end.r, rows - 1))];
          for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) out.push(unwrap(cell(c, r)));
          return out;
        }
        return unwrap(cell(tk.c, tk.r));
      }
      if (tk.t === 'id') {
        if (tk.v === 'TRUE') return true;
        if (tk.v === 'FALSE') return false;
        expectOp('(');
        const args: Arg[] = [];
        if (!isOp(')')) {
          args.push(comparison());
          while (isOp(',')) {
            p++;
            args.push(comparison());
          }
        }
        expectOp(')');
        return call(tk.v, args);
      }
      if (tk.t === 'op' && tk.v === '(') {
        const v = comparison();
        expectOp(')');
        return v;
      }
      throw new FormulaError('#ERR!');
    }

    const result = comparison();
    if (p < toks.length) throw new FormulaError('#ERR!');
    return scalar(result);
  }

  function call(name: string, args: Arg[]): FVal {
    const flat = () => args.flatMap((a) => (Array.isArray(a) ? a : [a]));
    const nums = () => flat().filter((v) => typeof v === 'number') as number[];
    const one = (i: number) => {
      const a = args[i];
      if (a === undefined) throw new FormulaError('#VALUE!');
      if (Array.isArray(a)) {
        if (a.length !== 1) throw new FormulaError('#VALUE!');
        return a[0];
      }
      return a;
    };
    switch (name) {
      case 'SUM':
        return nums().reduce((a, b) => a + b, 0);
      case 'AVERAGE':
      case 'AVG': {
        const n = nums();
        if (!n.length) throw new FormulaError('#DIV/0!');
        return n.reduce((a, b) => a + b, 0) / n.length;
      }
      case 'MIN':
        return nums().length ? Math.min(...nums()) : 0;
      case 'MAX':
        return nums().length ? Math.max(...nums()) : 0;
      case 'COUNT':
        return nums().length;
      case 'COUNTA':
        return flat().filter((v) => v !== '').length;
      case 'COUNTBLANK':
        return flat().filter((v) => v === '').length;
      case 'COUNTIF': {
        const range = Array.isArray(args[0]) ? args[0] : [one(0)];
        const crit = one(1);
        return range.filter((v) => matchesCriterion(v, crit)).length;
      }
      case 'SUMIF': {
        const range = Array.isArray(args[0]) ? args[0] : [one(0)];
        const crit = one(1);
        const sumRange = args[2] === undefined ? range : Array.isArray(args[2]) ? args[2] : [one(2)];
        let total = 0;
        range.forEach((v, i) => {
          if (matchesCriterion(v, crit)) {
            const s = sumRange[i];
            if (typeof s === 'number') total += s;
          }
        });
        return total;
      }
      case 'IF':
        return truth(one(0)) ? (args[1] === undefined ? true : one(1)) : args[2] === undefined ? false : one(2);
      case 'AND':
        return flat().every(truth);
      case 'OR':
        return flat().some(truth);
      case 'NOT':
        return !truth(one(0));
      case 'CONCAT':
      case 'CONCATENATE':
        return flat().map(text).join('');
      case 'LEN':
        return text(one(0)).length;
      case 'UPPER':
        return text(one(0)).toUpperCase();
      case 'LOWER':
        return text(one(0)).toLowerCase();
      case 'TRIM':
        return text(one(0)).trim();
      case 'ROUND': {
        const f = Math.pow(10, args[1] === undefined ? 0 : num(one(1)));
        return Math.round(num(one(0)) * f) / f;
      }
      case 'ABS':
        return Math.abs(num(one(0)));
      case 'ISBLANK':
        return one(0) === '';
      case 'NOW':
        return new Date().toISOString().slice(0, 16).replace('T', ' ');
      case 'TODAY':
        return new Date().toISOString().slice(0, 10);
      default:
        throw new FormulaError('#NAME?');
    }
  }

  return {
    value: cell,
    display(c: number, r: number): { text: string; error: boolean; numeric: boolean } {
      const v = cell(c, r);
      if (isErr(v)) return { text: v.code, error: true, numeric: false };
      return { text: text(v), error: false, numeric: typeof v === 'number' };
    },
  };
}
