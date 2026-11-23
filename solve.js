// Fast drop-in for makefun-site 1.0.0 (site-generator-speed-01-run-20261122).
//
// run(input) returns exactly what makefun-site 1.0.0's build(input) returns:
// the output tree of one site as a JSON object of path -> text. Written from
// the makefun-site README and its code as the reference for every rule, but
// structured for speed: the Markdown inline renderer scans for its special
// characters instead of escaping one character at a time, blocks render
// straight to string chunks instead of through token objects, front matter
// is scanned by hand, slugs and long dates are memoised, and templates are
// rendered into one output array with loop scopes mutated in place.
//
// No dependencies. No clock, no environment, no randomness, no I/O: the
// answer is a function of the input alone, as the reference's is.

/** The report file every build writes. */
export const REPORT_FILE = 'build-report.txt';

/** The top-level directories the generator writes itself. */
const RESERVED = ['posts', 'tags', 'page'];

/** The most characters a slug keeps before a collision suffix. */
const SLUG_MAX = 64;

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ---------------------------------------------------------------- text

/** `text` with & < > " and ' escaped. Returns `text` itself when it holds none of them. */
const NEEDS_ESCAPE = /[&<>"']/;
function escapeHtml(text) {
  if (!NEEDS_ESCAPE.test(text)) return text;
  let out = '';
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    let rep;
    if (c === '&') rep = '&amp;';
    else if (c === '<') rep = '&lt;';
    else if (c === '>') rep = '&gt;';
    else if (c === '"') rep = '&quot;';
    else if (c === "'") rep = '&#39;';
    else continue;
    out += text.slice(start, i) + rep;
    start = i + 1;
  }
  return out + text.slice(start);
}

/** The HTML escape table, in this order: & < > " ' . */
let slugCache = new Map();

/**
 * The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every run
 * of characters other than a-z and 0-9 one "-", none at either end, at most
 * 64 characters (a "-" left at the cut dropped), and "untitled" when nothing
 * is left. Results are memoised: titles, headings and tag names repeat.
 */
function slugify(text) {
  const hit = slugCache.get(text);
  if (hit !== undefined) return hit;
  const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (const ch of plain) {
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  const slug = out === '' ? 'untitled' : out;
  slugCache.set(text, slug);
  return slug;
}

/** `slug` made unique against `taken` (and added to it): slug, slug-2, slug-3 ... */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

let longCache = new Map();

// The memoisation caches are per case: build() replaces both before a
// case runs, so nothing is ever carried from one case to the next (the
// competition answers each case alone).

/** A YYYY-MM-DD date in words, from the string alone: "2026-11-09" is "9 November 2026". */
function longDate(date) {
  const hit = longCache.get(date);
  if (hit !== undefined) return hit;
  const [y, m, d] = date.split('-');
  const out = `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
  longCache.set(date, out);
  return out;
}

/** The words of a body: its runs of characters other than whitespace. Counted by hand: the reference's /\S+/g match builds an array of every word. */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    let ws;
    if (c <= 32) ws = c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13;
    else if (c < 160) ws = false;
    else ws = c === 160 || c === 5760 || (c >= 8192 && c <= 8202) || c === 8232 || c === 8233 || c === 8239 || c === 8287 || c === 12288 || c === 65279;
    if (ws) inWord = false;
    else if (!inWord) {
      inWord = true;
      n++;
    }
  }
  return n;
}

/** `rel` (a link's path, "/"-separated) from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

// ---------------------------------------------------------------- front matter

const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const KEY_SET = new Set(KEYS);

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare, the rest of the line (never opening on " or [). */
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

function isNameChar(c) {
  return (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c === '-';
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      let ok = raw.length === 10 && raw.charCodeAt(4) === 45 && raw.charCodeAt(7) === 45;
      if (ok) {
        for (let i = 0; i < 10; i++) {
          if (i === 4 || i === 7) continue;
          const c = raw.charCodeAt(i);
          if (c < 48 || c > 57) { ok = false; break; }
        }
      }
      const y = ok ? Number(raw.slice(0, 4)) : 0;
      const mo = ok ? Number(raw.slice(5, 7)) : 0;
      const d = ok ? Number(raw.slice(8, 10)) : 0;
      if (!ok || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      for (const t of tags) {
        if (t === '' || t.includes('"') || t.includes('[') || t.includes(']')) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout': {
      let ok = raw.length > 0;
      for (let i = 0; ok && i < raw.length; i++) ok = isNameChar(raw[i]);
      return ok ? { value: raw } : { error: 'key "layout": not a template name' };
    }
    case 'slug': {
      let ok = raw.length > 0 && raw.length <= 64;
      let prevDash = true;
      for (let i = 0; ok && i < raw.length; i++) {
        const c = raw[i];
        const alnum = (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9');
        if (alnum) prevDash = false;
        else if (c === '-' && !prevDash) prevDash = true;
        else ok = false;
      }
      if (prevDash) ok = false;
      return ok ? { value: raw } : { error: 'key "slug": not a slug' };
    }
    default:
      return { error: `unknown key "${key}"` };
  }
}

/** Whether `line` is blank (spaces and tabs only). */
function isBlank(line) {
  for (let k = 0; k < line.length; k++) {
    const c = line.charCodeAt(k);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/**
 * A source's front matter and body: { data, body }, or { error } with the
 * first reason it is refused. `text` has "\n" line ends. The close line is
 * found first, then the lines between are validated in order, as the
 * reference does; the body is the text after the close line, unsplit.
 */
function parseFrontMatter(text) {
  if (text !== '---' && !text.startsWith('---\n')) return { error: 'no front matter' };
  // Find the close line and remember every line between.
  const fmLines = [];
  let pos = text === '---' ? 3 : 4;
  let closeAt = -1;
  let bodyAt = text.length;
  while (pos <= text.length) {
    const nl = text.indexOf('\n', pos);
    const end = nl === -1 ? text.length : nl;
    const line = text.slice(pos, end);
    if (line === '---') {
      closeAt = fmLines.length + 1;
      bodyAt = nl === -1 ? text.length : nl + 1;
      break;
    }
    fmLines.push(line);
    if (nl === -1) break;
    pos = nl + 1;
  }
  if (closeAt === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let i = 0; i < fmLines.length; i++) {
    const line = fmLines[i];
    const lineNo = i + 2;
    if (isBlank(line) || line.charCodeAt(0) === 35) continue;
    let j = 0;
    while (j < line.length) {
      const c = line[j];
      if ((c >= 'a' && c <= 'z') || c === '_') j++;
      else break;
    }
    if (j === 0 || line[j] !== ':') return { error: `line ${lineNo} is not "key: value"` };
    const key = line.slice(0, j);
    j++;
    let raw;
    if (j === line.length) raw = '';
    else if (line[j] === ' ') raw = line.slice(j + 1);
    else return { error: `line ${lineNo} is not "key: value"` };
    let e = raw.length;
    while (e > 0 && (raw.charCodeAt(e - 1) === 32 || raw.charCodeAt(e - 1) === 9)) e--;
    raw = raw.slice(0, e);
    if (!KEY_SET.has(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(bodyAt) };
}

// ---------------------------------------------------------------- markdown

/** `line` with spaces and tabs at either end dropped. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return line.slice(a, b);
}

/** A fence's language, or null when `line` does not open one. */
function fenceOpen(line) {
  if (!line.startsWith('```')) return null;
  let j = 3;
  while (j < line.length) {
    const c = line[j];
    if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c === '_' || c === '+' || c === '-') j++;
    else break;
  }
  for (let k = j; k < line.length; k++) {
    const c = line.charCodeAt(k);
    if (c !== 32 && c !== 9) return null;
  }
  return line.slice(3, j);
}

/** Whether `line` closes a fence. */
function fenceClose(line) {
  if (!line.startsWith('```')) return false;
  for (let k = 3; k < line.length; k++) {
    const c = line.charCodeAt(k);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  if (line.charCodeAt(0) !== 35) return null;
  let count = 0;
  while (count < line.length && line.charCodeAt(count) === 35) count++;
  if (count === 0 || count > 6) return null;
  if (count >= line.length) return null;
  const sep = line.charCodeAt(count);
  if (sep !== 32 && sep !== 9) return null;
  let j = count;
  while (j < line.length && (line.charCodeAt(j) === 32 || line.charCodeAt(j) === 9)) j++;
  let end = line.length;
  while (end > j && (line.charCodeAt(end - 1) === 32 || line.charCodeAt(end - 1) === 9)) end--;
  if (end === j) return null;
  return { depth: count, text: line.slice(j, end) };
}

/** Whether `line` is a thematic break. */
function isHr(line) {
  let end = line.length;
  while (end > 0 && (line.charCodeAt(end - 1) === 32 || line.charCodeAt(end - 1) === 9)) end--;
  const t = line.slice(0, end);
  return t === '---' || t === '***';
}

/** A bullet item's text, or null; an ordered item's text and start, or null. */
function bulletOf(line) {
  if (line.length < 2) return null;
  const c0 = line.charCodeAt(0);
  if ((c0 === 45 || c0 === 42) && line.charCodeAt(1) === 32) return { ordered: false, start: 1, text: line.slice(2) };
  return null;
}

function orderedOf(line) {
  let j = 0;
  while (j < line.length && j < 9 && line.charCodeAt(j) >= 48 && line.charCodeAt(j) <= 57) j++;
  if (j === 0) return null;
  if (line.charCodeAt(j) !== 46 || line.charCodeAt(j + 1) !== 32) return null;
  return { ordered: true, start: Number(line.slice(0, j)), text: line.slice(j + 2) };
}

/** Whether `line` continues a list item: two or more spaces, then a non-space. */
function isContinued(line) {
  if (line.length < 3 || line.charCodeAt(0) !== 32 || line.charCodeAt(1) !== 32) return false;
  let j = 0;
  while (j < line.length && line.charCodeAt(j) === 32) j++;
  if (j < 2 || j >= line.length) return false;
  return !/\s/.test(line[j]);
}

/** The characters a backslash escapes. */
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. Found with indexOf (C++): a hit is escaped exactly when the run of backslashes right before it, counted from `from`, is odd. */
function findUnescaped(s, what, from) {
  let j = s.indexOf(what, from);
  while (j !== -1) {
    let k = j - 1;
    let bs = 0;
    while (k >= from && s[k] === '\\') {
      bs++;
      k--;
    }
    if (bs % 2 === 0) return j;
    j = s.indexOf(what, j + 1);
  }
  return -1;
}

/** The first single * from `from` (the last star of an odd-length run), outside an escape, or -1. A run of stars contributes a single star only when its length is odd; even runs are strong markers and are skipped whole. */
function findSingleStar(s, from) {
  let j = s.indexOf('*', from);
  while (j !== -1) {
    let k = j - 1;
    let bs = 0;
    while (k >= from && s[k] === '\\') {
      bs++;
      k--;
    }
    if (bs % 2 === 1) {
      j = s.indexOf('*', j + 1);
      continue;
    }
    let e = j;
    while (s[e + 1] === '*') e++;
    if ((e - j + 1) % 2 === 1) return e;
    j = s.indexOf('*', e + 1);
  }
  return -1;
}

/** `str` escaped, pushed as one chunk. */
function pushEscaped(out, str) {
  out.push(escapeHtml(str));
}

/**
 * `s` rendered inline into `out` (an array of chunks); `env.link(target)` is
 * a link's href. The scanner jumps from one special character to the next,
 * so runs of plain text are pushed whole and never escaped one character at
 * a time; only the characters that need it are handled. Every construct
 * matches the reference's inline renderer exactly: backslash escapes, code
 * spans, strong, emphasis, and links with their unescaped closers.
 */
function inlineInto(s, env, out) {
  const re = /[\\`*\[&<>"']/g;
  let plain = 0;
  let m;
  while ((m = re.exec(s)) !== null) {
    const i = m.index;
    const c = m[0];
    if (i > plain) out.push(s.slice(plain, i));
    if (c === '&') { out.push('&amp;'); plain = i + 1; }
    else if (c === '<') { out.push('&lt;'); plain = i + 1; }
    else if (c === '>') { out.push('&gt;'); plain = i + 1; }
    else if (c === '"') { out.push('&quot;'); plain = i + 1; }
    else if (c === "'") { out.push('&#39;'); plain = i + 1; }
    else if (c === '\\') {
      const n = s[i + 1];
      if (i + 1 < s.length && ESCAPABLE.has(n)) {
        out.push(n === '>' ? '&gt;' : n);
        re.lastIndex = i + 2;
        plain = i + 2;
      } else {
        out.push('\\');
        plain = i + 1;
      }
    } else if (c === '`') {
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) {
        out.push('<code>');
        pushEscaped(out, s.slice(i + 1, j));
        out.push('</code>');
        re.lastIndex = j + 1;
        plain = j + 1;
      } else {
        out.push('`');
        plain = i + 1;
      }
    } else if (c === '*') {
      if (s[i + 1] === '*') {
        const j = findUnescaped(s, '**', i + 2);
        if (j > i + 2) {
          out.push('<strong>');
          inlineInto(s.slice(i + 2, j), env, out);
          out.push('</strong>');
          re.lastIndex = j + 2;
          plain = j + 2;
        } else {
          out.push('**');
          re.lastIndex = i + 2;
          plain = i + 2;
        }
      } else {
        const j = findSingleStar(s, i + 1);
        if (j > i + 1) {
          out.push('<em>');
          inlineInto(s.slice(i + 1, j), env, out);
          out.push('</em>');
          re.lastIndex = j + 1;
          plain = j + 1;
        } else {
          out.push('*');
          plain = i + 1;
        }
      }
    } else {
      const k = findUnescaped(s, ']', i + 1);
      const m2 = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
      const target = m2 === -1 ? '' : s.slice(k + 2, m2);
      if (target !== '' && !/\s/.test(target)) {
        out.push('<a href="');
        out.push(escapeHtml(env.link(target)));
        out.push('">');
        inlineInto(s.slice(i + 1, k), env, out);
        out.push('</a>');
        re.lastIndex = m2 + 1;
        plain = m2 + 1;
      } else {
        out.push('[');
        plain = i + 1;
      }
    }
  }
  if (plain < s.length) out.push(s.slice(plain));
}

/** `s` rendered inline, as one string. */
function inlineStr(s, env) {
  const out = [];
  inlineInto(s, env, out);
  return out.join('');
}

/**
 * `src` rendered: its HTML (each block on its own lines, a "\n" after the
 * last), its table of contents (every level 2 and 3 heading: level, id and
 * its inline HTML) and its excerpt (the first paragraph's inline HTML, or
 * ""). Blocks render straight into the output chunks; no token objects.
 */
function renderMarkdown(src, env) {
  const lines = src.split('\n');
  const out = [];
  const toc = [];
  const ids = new Set();
  let excerpt = null;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    if (line === '') {
      i++;
      continue;
    }
    const c0 = line.charCodeAt(0);
    // Each block kind is fixed by its first character, so the checks below
    // only run when the line could possibly be that kind: a letter-start
    // line reaches the paragraph branch with no classification call at all.
    if ((c0 === 32 || c0 === 9) && isBlank(line)) {
      i++;
      continue;
    }
    if (c0 === 96) {
      const fence = fenceOpen(line);
      if (fence !== null) {
        const body = [];
        i++;
        while (i < n && !fenceClose(lines[i])) body.push(lines[i++]);
        i++;
        const cls = fence === '' ? '' : ` class="language-${escapeHtml(fence)}"`;
        out.push(`<pre><code${cls}>`);
        for (const l of body) out.push(escapeHtml(l), '\n');
        out.push('</code></pre>\n');
        continue;
      }
    }
    if (c0 === 35) {
      const heading = headingOf(line);
      if (heading !== null) {
        const id = uniqueSlug(slugify(heading.text), ids);
        const html = inlineStr(heading.text, env);
        out.push(`<h${heading.depth} id="${id}">`, html, `</h${heading.depth}>\n`);
        if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
        i++;
        continue;
      }
    }
    if ((c0 === 45 || c0 === 42) && isHr(line)) {
      out.push('<hr>\n');
      i++;
      continue;
    }
    if (c0 === 62) {
      const body = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        const l = lines[i++];
        body.push(trimLine(l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1)));
      }
      const kept = body.filter((l) => l !== '');
      if (kept.length === 0) {
        out.push('<blockquote>\n</blockquote>\n');
      } else {
        out.push('<blockquote>\n<p>');
        inlineInto(kept.join('\n'), env, out);
        out.push('</p>\n</blockquote>\n');
      }
      continue;
    }
    const first = (c0 === 45 || c0 === 42) ? bulletOf(line) : (c0 >= 48 && c0 <= 57) ? orderedOf(line) : null;
    if (first !== null) {
      const isOrdered = first.ordered;
      const items = [];
      while (i < n) {
        const m = isOrdered ? orderedOf(lines[i]) : bulletOf(lines[i]);
        if (m !== null) {
          items.push([trimLine(m.text)]);
          i++;
        } else if (items.length > 0 && isContinued(lines[i])) {
          items[items.length - 1].push(trimLine(lines[i]));
          i++;
        } else break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && first.start !== 1 ? `<ol start="${first.start}">` : `<${tag}>`;
      out.push(open, '\n');
      for (const parts of items) {
        out.push('<li>');
        inlineInto(parts.join('\n'), env, out);
        out.push('</li>\n');
      }
      out.push(`</${tag}>\n`);
      continue;
    }
    const body = [trimLine(line)];
    i++;
    // A paragraph runs until a line that ends it; the first character
    // decides which ending test can possibly match (a blank line is the
    // empty string, a space/tab start can only be blank, '#' a heading,
    // '`' a fence, '-'/'*' a rule, anything else never ends it).
    while (i < n) {
      const l = lines[i];
      if (l === '') break;
      const d0 = l.charCodeAt(0);
      if (d0 === 32 || d0 === 9) {
        if (isBlank(l)) break;
      } else if (d0 === 35) {
        if (headingOf(l) !== null) break;
      } else if (d0 === 96) {
        if (fenceOpen(l) !== null) break;
      } else if (d0 === 45 || d0 === 42) {
        if (isHr(l)) break;
      }
      body.push(trimLine(l));
      i++;
    }
    const joined = body.join('\n');
    if (excerpt === null) {
      const html = inlineStr(joined, env);
      excerpt = html;
      out.push('<p>', html, '</p>\n');
    } else {
      out.push('<p>');
      inlineInto(joined, env, out);
      out.push('</p>\n');
    }
  }
  return { html: out.join(''), toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** The value at `path` in the scope chain: its first name from the nearest scope holding it, then own properties. */
function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/**
 * `nodes` rendered in `scope` ({ vars, parent }) into `out` (an array of
 * chunks). `ctx` holds the parsed templates, the HTML escape and the include
 * depth. A for loop reuses one scope object per loop, mutating the element
 * and the loop record each turn (rendering is synchronous, so no scope is
 * ever read after its turn); `loop` always wins over an element bound to
 * the same name, as the reference's object literal does.
 */
function renderNodes(nodes, scope, ctx, depth, out) {
  for (const n of nodes) {
    switch (n.kind) {
      case 'text':
        out.push(n.text);
        break;
      case 'var':
        out.push(ctx.escape(textOf(lookup(scope, n.path))));
        break;
      case 'raw':
        out.push(textOf(lookup(scope, n.path)));
        break;
      case 'if': {
        const v = truthy(lookup(scope, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) renderNodes(branch, scope, ctx, depth, out);
        break;
      }
      case 'for': {
        const xs = lookup(scope, n.path);
        if (!Array.isArray(xs)) break;
        const vars = {};
        const loop = { index: 0, first: false, last: false, length: xs.length };
        const child = { vars, parent: scope };
        for (let k = 0; k < xs.length; k++) {
          vars[n.name] = xs[k];
          vars.loop = loop;
          loop.index = k + 1;
          loop.first = k === 0;
          loop.last = k === xs.length - 1;
          renderNodes(n.body, child, ctx, depth, out);
        }
        break;
      }
      case 'include': {
        const t = ctx.templates.get(n.name);
        if (t !== undefined && depth < INCLUDE_DEPTH) renderNodes(t, scope, ctx, depth + 1, out);
        break;
      }
    }
  }
}

/**
 * `obj`'s own property `key`, or undefined (a value that is null, not an
 * object, or lacks the key reads as undefined, as the reference's lookup does).
 */
function getProp(obj, key) {
  return obj !== null && typeof obj === 'object' && Object.hasOwn(obj, key) ? obj[key] : undefined;
}

// ---------------------------------------------------------------- template compiler

/**
 * A parsed template compiled to a fast render function. The tree walk above
 * is correct and stays as the fallback; this compiles each layout (with its
 * includes inlined, so every loop is lexical) to straight-line code with
 * real for loops and ifs, which is what makes the layouts fast. The
 * generated function takes (R, out, esc, textOf, truthy, get): R is the
 * case's root values, out the chunk array. An include inlines the included
 * template at one depth deeper, and an include at depth 8 renders nothing,
 * exactly as the reference's depth rule does; a template that does not
 * parse is absent, so an include of it renders nothing too.
 *
 * A for loop binds its element and its loop record to fresh locals, and a
 * reference to `loop` always reads the innermost loop's record (a loop
 * whose element is itself named `loop` still leaves `loop` the record, as
 * the reference's object literal does). Anything else reads from R, so a
 * name no loop binds is the root value or undefined.
 */
function genPath(path, stack) {
  const first = path[0];
  let expr;
  if (first === 'loop') {
    if (stack.length === 0) return 'undefined';
    expr = stack[stack.length - 1].loopVar;
  } else {
    let bound = null;
    for (let i = stack.length - 1; i >= 0; i--) {
      if (stack[i].elemName === first) {
        bound = stack[i].elemVar;
        break;
      }
    }
    expr = bound !== null ? bound : `get(R, ${JSON.stringify(first)})`;
  }
  for (let k = 1; k < path.length; k++) expr = `get(${expr}, ${JSON.stringify(path[k])})`;
  return expr;
}

function genNodes(nodes, depth, stack, S) {
  let code = '';
  for (const n of nodes) {
    if (n.kind === 'text') code += `out.push(${JSON.stringify(n.text)});\n`;
    else if (n.kind === 'var') code += `out.push(esc(textOf(${genPath(n.path, stack)})));\n`;
    else if (n.kind === 'raw') code += `out.push(textOf(${genPath(n.path, stack)}));\n`;
    else if (n.kind === 'if') {
      const cond = `truthy(${genPath(n.path, stack)})`;
      code += `if (${cond} !== ${n.not ? 'true' : 'false'}) {\n${genNodes(n.then, depth, stack, S)}`;
      if (n.else !== null) code += `} else {\n${genNodes(n.else, depth, stack, S)}`;
      code += '}\n';
    } else if (n.kind === 'for') {
      const arrVar = `_a${S.uid++}`;
      const elemVar = `_v${S.uid++}`;
      const loopVar = `_l${S.uid++}`;
      const idxVar = `_k${S.uid++}`;
      code += `{\nconst ${arrVar} = ${genPath(n.path, stack)};\n`;
      code += `if (Array.isArray(${arrVar})) {\n`;
      code += `const ${loopVar} = { index: 0, first: false, last: false, length: ${arrVar}.length };\n`;
      code += `for (let ${idxVar} = 0; ${idxVar} < ${arrVar}.length; ${idxVar}++) {\n`;
      code += `const ${elemVar} = ${arrVar}[${idxVar}];\n`;
      code += `${loopVar}.index = ${idxVar} + 1; ${loopVar}.first = ${idxVar} === 0; ${loopVar}.last = ${idxVar} === ${arrVar}.length - 1;\n`;
      stack.push({ elemName: n.name, elemVar, loopVar });
      code += genNodes(n.body, depth, stack, S);
      stack.pop();
      code += '}\n}\n}\n';
    } else if (n.kind === 'include') {
      if (depth < INCLUDE_DEPTH) {
        const target = S.templates.get(n.name);
        if (target !== undefined) code += genNodes(target, depth + 1, stack, S);
      }
    }
  }
  return code;
}

/** The compiled render function for `name`'s template, or null when there is none. */
function compileTemplate(name, templates) {
  const nodes = templates.get(name);
  if (nodes === undefined) return null;
  const S = { uid: 0, templates };
  const body = genNodes(nodes, 0, [], S);
  return new Function('R', 'out', 'esc', 'textOf', 'truthy', 'get', body);
}

// ---------------------------------------------------------------- the build

const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/** A page's link record as templates read it. */
function linkOf(s) {
  return s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) };
}

/** A post's card, as lists show it. */
function cardOf(s) {
  if (s.readingMinutes === undefined) s.readingMinutes = Math.max(1, Math.ceil(wordsOf(s.body) / 200));
  return {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: s.readingMinutes,
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  };
}

/** One site's output tree: path -> text. */
export function build(input) {
  // Fresh memoisation caches for this case alone.
  slugCache = new Map();
  longCache = new Map();
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const b = {
    input,
    base: input.site.base_url.replace(/\/+$/, ''),
    templates,
    sources: [],
    statics: [],
    bySource: new Map(),
    broken: new Set(),
    report,
    posts: [],
    tags: [],
    cards: new Map(),
    output: {},
  };

  // 1. The sources, in code-unit order of their paths, line ends made "\n".
  const files = [...b.input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      const text = f.content.includes('\r') ? f.content.replace(/\r\n?/g, '\n') : f.content;
      b.sources.push({ path: f.path, text });
    } else b.statics.push({ path: f.path, content: f.content });
  }

  // 2. Each source's front matter: a refused source is reported and dropped, and so is a draft.
  {
    const kept = [];
    for (const s of b.sources) {
      const fm = parseFrontMatter(s.text);
      if ('error' in fm) {
        b.report.push(`refused ${s.path}: ${fm.error}`);
        continue;
      }
      s.data = fm.data;
      s.body = fm.body;
      s.post = s.path.startsWith('posts/');
      let own;
      for (const d of RESERVED) {
        if (d !== 'posts' && s.path.startsWith(`${d}/`)) { own = d; break; }
      }
      if (own !== undefined) {
        b.report.push(`refused ${s.path}: ${own}/ is the generator's own`);
        continue;
      }
      if (s.post && !Object.hasOwn(s.data, 'date')) {
        b.report.push(`refused ${s.path}: a post needs a date`);
        continue;
      }
      const layout = s.data.layout ?? (s.post ? 'post' : 'page');
      if (!b.templates.has(layout)) {
        b.report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
        continue;
      }
      s.layout = layout;
      if (s.data.draft === true) {
        b.report.push(`draft ${s.path}`);
        continue;
      }
      kept.push(s);
    }
    b.sources = kept;
  }

  // 3. Each page's output directory and url: its slug made unique in its directory, in source order.
  {
    const taken = new Map();
    const takenIn = (dir) => {
      if (!taken.has(dir)) taken.set(dir, new Set(dir === '' ? RESERVED : []));
      return taken.get(dir);
    };
    for (const s of b.sources) {
      const dir = s.post ? 'posts' : dirOf(s.path);
      const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), takenIn(dir));
      s.slug = slug;
      s.outDir = dir === '' ? slug : `${dir}/${slug}`;
      s.url = `${b.base}/${s.outDir}/`;
      b.bySource.set(s.path, s);
    }
  }

  // 4. Each body's Markdown, its links resolved to the pages and static files they name.
  {
    const staticPaths = new Set(b.statics.map((f) => f.path));
    // Link targets repeat across bodies; the resolved href depends only on
    // the source directory and the target, so it is memoised per case.
    // A broken link memoises as null, and the broken entry is still
    // recorded for every source that links to it.
    const linkCache = new Map();
    for (const s of b.sources) {
      const dir = dirOf(s.path);
      const env = {
        link: (target) => {
          if (SCHEME_RE.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
          const key = `${dir}\n${target}`;
          const hit = linkCache.get(key);
          if (hit !== undefined) {
            if (hit === null) b.broken.add(`broken-link ${s.path} -> ${target}`);
            return hit === null ? target : hit;
          }
          const hash = target.indexOf('#');
          const rel = hash === -1 ? target : target.slice(0, hash);
          const frag = hash === -1 ? '' : target.slice(hash);
          const path = rel === '' ? null : resolvePath(dir, rel);
          let href = null;
          if (path !== null && b.bySource.has(path)) href = `${b.bySource.get(path).url}${frag}`;
          else if (path !== null && staticPaths.has(path)) href = `${b.base}/${path}${frag}`;
          linkCache.set(key, href);
          if (href === null) b.broken.add(`broken-link ${s.path} -> ${target}`);
          return href === null ? target : href;
        },
      };
      const md = renderMarkdown(s.body, env);
      s.html = md.html;
      s.toc = md.toc;
      s.excerpt = md.excerpt;
    }
  }

  // 5. The posts, newest first and then by slug; each post's newer and older neighbours.
  {
    const posts = b.sources.filter((s) => s.post);
    posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
    b.posts = posts;
    posts.forEach((p, k) => {
      p.newer = k === 0 ? null : posts[k - 1];
      p.older = k === posts.length - 1 ? null : posts[k + 1];
    });
  }

  // 6. The tags: grouped by their slug, each named as first met in the posts' order, ordered by count and then slug.
  {
    const bySlug = new Map();
    const ownTags = (s) => {
      const seen = new Set();
      return (s.data.tags ?? []).filter((name) => !seen.has(slugify(name)) && seen.add(slugify(name)));
    };
    for (const p of b.posts) {
      p.tagRefs = [];
      for (const name of ownTags(p)) {
        const slug = slugify(name);
        if (!bySlug.has(slug)) bySlug.set(slug, { name, slug, url: `${b.base}/tags/${slug}/`, posts: [] });
        const tag = bySlug.get(slug);
        tag.posts.push(p);
        p.tagRefs.push(tag);
      }
    }
    for (const s of b.sources) {
      if (!s.post) {
        s.tagRefs = ownTags(s).map((name) => {
          const slug = slugify(name);
          return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
        });
      }
    }
    b.tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));
  }

  // 7. Every page through its layout, the index pages and the tag pages through theirs.
  {
    b.cards = new Map(b.posts.map((p) => [p, cardOf(p)]));
    const site = { title: b.input.site.title, base_url: b.base };
    const allTags = b.tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
    const recent = b.posts.slice(0, b.input.site.recent).map((p) => b.cards.get(p));
    const ctx = { templates: b.templates, escape: escapeHtml };
    // One scope for every render of this case: the per-render values are
    // written into it and the ones a render does not give are left
    // undefined, which lookup reads exactly as a missing key (undefined is
    // falsy, writes as "", and is not an array), so this is the same scope
    // the reference builds fresh per render, without the spread or the
    // allocation. Rendering is synchronous, so nothing outlives its turn.
    const baseVars = { site, tags: allTags, recent, page: undefined, posts: undefined, pager: undefined, tag: undefined };
    const baseScope = { vars: baseVars, parent: null };
    const compiledCache = new Map();
    const render = (name, vars) => {
      const nodes = b.templates.get(name);
      if (nodes === undefined) return null;
      baseVars.page = vars.page;
      baseVars.posts = vars.posts;
      baseVars.pager = vars.pager;
      baseVars.tag = vars.tag;
      let fn = compiledCache.get(name);
      if (fn === undefined) {
        try {
          fn = compileTemplate(name, b.templates);
        } catch {
          fn = null;
        }
        compiledCache.set(name, fn);
      }
      if (fn !== null) {
        const out = [];
        fn(baseVars, out, escapeHtml, textOf, truthy, getProp);
        return out.join('');
      }
      const out = [];
      renderNodes(nodes, baseScope, ctx, 0, out);
      return out.join('');
    };
    for (const s of b.sources) {
      const base = s.post ? b.cards.get(s) : cardOf(s);
      const page = {
        ...base,
        slug: s.slug,
        content: s.html,
        toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
        newer: linkOf(s.newer ?? null),
        older: linkOf(s.older ?? null),
        is_post: s.post,
      };
      b.output[`${s.outDir}/index.html`] = render(s.layout, { page });
    }
    const per = b.input.site.per_page;
    const pages = Math.max(1, Math.ceil(b.posts.length / per));
    const indexUrl = (k) => (k === 1 ? `${b.base}/` : `${b.base}/page/${k}/`);
    for (let k = 1; k <= pages; k++) {
      const html = render('index', {
        posts: b.posts.slice((k - 1) * per, k * per).map((p) => b.cards.get(p)),
        pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
      });
      if (html !== null) b.output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
    }
    for (const t of b.tags) {
      const tag = { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => b.cards.get(p)) };
      const html = render('tag', { tag });
      if (html !== null) b.output[`tags/${t.slug}/index.html`] = html;
    }
    const tagsHtml = render('tags', {});
    if (tagsHtml !== null) b.output['tags/index.html'] = tagsHtml;
    for (const f of b.statics) {
      if (Object.hasOwn(b.output, f.path)) b.report.push(`shadowed ${f.path}: a built page has its path`);
      else b.output[f.path] = f.content;
    }
  }

  // 8. The report: every refusal, draft, broken link and template that did not parse, sorted, then the counts.
  {
    const lines = [...b.report, ...b.broken].sort(byCodeUnits);
    const pages = b.sources.filter((s) => !s.post).length;
    lines.push(`built ${pages} pages, ${b.posts.length} posts, ${b.tags.length} tags and ${b.statics.length} static files`);
    b.output[REPORT_FILE] = `${lines.join('\n')}\n`;
  }

  return b.output;
}

/** makefun-site 1.0.0's answer for one case's input. */
export function run(input) {
  return build(input);
}
