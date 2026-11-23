// Fast drop-in replacement for makefun-site 1.0.0: run(input) returns exactly the output tree
// makefun-site's build returns for the same input, byte for byte, but computed with fused single-pass
// scanners instead of token objects, per-character escape calls and repeated slug/date work.
// Dependency-free ES module. The semantics implemented here are makefun-site's own dialect:
// front matter, permalinks, its Markdown subset, collections, tags, layouts and the build report.

const byCU = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ---------------------------------------------------------------- text helpers

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/g;

/** HTML-escape a string in one scan; with nothing to escape the string is returned as it is. */
function esc(s) {
  return s.replace(ESC_RE, (c) => ESC_MAP[c]);
}

const SLUG_MAX = 64;
const slugCache = new Map();

function slugAscii(text) {
  let out = '';
  let gap = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    let keep = -1;
    if (c >= 65 && c <= 90) keep = c + 32;
    else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
    if (keep === -1) {
      if (out.length > 0) gap = true;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += String.fromCharCode(keep);
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

function slugFull(text) {
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
  return out === '' ? 'untitled' : out;
}

/** The slug of `text` (makefun-site's rule), memoised: titles, tags and headings repeat a lot. */
function slugify(text) {
  let hit = slugCache.get(text);
  if (hit !== undefined) return hit;
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) { ascii = false; break; }
  }
  const out = ascii ? slugAscii(text) : slugFull(text);
  if (slugCache.size > 30000) slugCache.clear();
  slugCache.set(text, out);
  return out;
}

/** `slug` made unique against the `taken` set, which it joins: slug, slug-2, slug-3 ... */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const dateCache = new Map();

/** A YYYY-MM-DD date in words, memoised (dates repeat across posts). */
function longDate(date) {
  let hit = dateCache.get(date);
  if (hit !== undefined) return hit;
  const out = `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
  if (dateCache.size > 10000) dateCache.clear();
  dateCache.set(date, out);
  return out;
}

/** Count of a body's words: runs of characters other than whitespace (JS \s), one scan, no match array. */
function wordsOf(text) {
  let count = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    let ws;
    if (c === 32 || (c >= 9 && c <= 13)) ws = true;
    else if (c < 160) ws = false;
    else ws = c === 160 || c === 5760 || (c >= 8192 && c <= 8202) || c === 8232 || c === 8233 || c === 8239 || c === 8287 || c === 12288 || c === 65279;
    if (ws) inWord = false;
    else if (!inWord) { inWord = true; count++; }
  }
  return count;
}

// ---------------------------------------------------------------- front matter

const FM_KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) { // '"'
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    const inner = raw.slice(1, -1);
    if (inner.indexOf('\\') === -1 && inner.indexOf('"') === -1) return { value: inner };
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
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' }; // '['
  return { value: raw };
}

function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      let ok = raw.length === 10 && raw[4] === '-' && raw[7] === '-';
      let y = 0, mo = 0, d = 0;
      if (ok) {
        for (let i = 0; i < 10; i++) {
          if (i === 4 || i === 7) continue;
          const c = raw.charCodeAt(i);
          if (c < 48 || c > 57) { ok = false; break; }
        }
      }
      if (ok) {
        y = Number(raw.slice(0, 4)); mo = Number(raw.slice(5, 7)); d = Number(raw.slice(8, 10));
        ok = y >= 1970 && y <= 2099 && mo >= 1 && mo <= 12 && d >= 1 && d <= daysIn(y, mo);
      }
      return ok ? { value: raw } : { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
    }
    case 'tags': {
      if (raw[0] !== '[' || raw[raw.length - 1] !== ']') return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      for (const t of tags) {
        if (t === '' || t.indexOf('"') !== -1 || t.indexOf('[') !== -1 || t.indexOf(']') !== -1) {
          return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        }
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout': {
      if (raw.length === 0) return { error: 'key "layout": not a template name' };
      for (let i = 0; i < raw.length; i++) {
        const c = raw[i];
        if (!((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c === '-')) return { error: 'key "layout": not a template name' };
      }
      return { value: raw };
    }
    case 'slug': {
      // [a-z0-9]+(-[a-z0-9]+)* and at most 64 characters
      let ok = raw.length >= 1 && raw.length <= 64;
      let seg = 0;
      if (ok) {
        for (let i = 0; i < raw.length; i++) {
          const c = raw[i];
          if ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')) seg++;
          else if (c === '-' && seg > 0) seg = 0;
          else { ok = false; break; }
        }
        if (seg === 0) ok = false;
      }
      return ok ? { value: raw } : { error: 'key "slug": not a slug' };
    }
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body, or { error } with the first reason it is refused.
 * Works on line ranges of the original text; the body is one slice, never split and rejoined.
 */
function parseFrontMatter(text) {
  if (text !== '---' && !text.startsWith('---\n')) return { error: 'no front matter' };
  // Find the closing line (the first later line that is exactly "---"), collecting line ranges.
  const ranges = [];
  let closeStart = -1;
  let closeEnd = -1;
  let pos = 4; // just past the opening "---\n" (text === '---' has no second line)
  if (text === '---') pos = 3;
  while (pos <= text.length) {
    let nl = text.indexOf('\n', pos);
    if (nl === -1) nl = text.length;
    if (nl - pos === 3 && text.startsWith('---', pos)) { closeStart = pos; closeEnd = nl; break; }
    ranges.push([pos, nl]);
    if (nl === text.length) break;
    pos = nl + 1;
    if (pos === text.length) { ranges.push([pos, pos]); break; } // trailing empty line
  }
  if (closeStart === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let r = 0; r < ranges.length; r++) {
    const line = text.slice(ranges[r][0], ranges[r][1]);
    const ln = r + 2; // line number from 1 at the opening ---
    let blank = true;
    for (let i = 0; i < line.length; i++) {
      if (line[i] !== ' ' && line[i] !== '\t') { blank = false; break; }
    }
    if (blank || line[0] === '#') continue;
    // ^([a-z_]+):(?: (.*))?$
    let k = 0;
    while (k < line.length) {
      const c = line[k];
      if ((c >= 'a' && c <= 'z') || c === '_') k++;
      else break;
    }
    if (k === 0 || line[k] !== ':') return { error: `line ${ln} is not "key: value"` };
    let raw0;
    if (k + 1 === line.length) raw0 = '';
    else if (line[k + 1] === ' ') raw0 = line.slice(k + 2);
    else return { error: `line ${ln} is not "key: value"` };
    const key = line.slice(0, k);
    let e = raw0.length;
    while (e > 0 && (raw0[e - 1] === ' ' || raw0[e - 1] === '\t')) e--;
    const raw = e === raw0.length ? raw0 : raw0.slice(0, e);
    if (!FM_KEYS.has(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  const body = closeEnd < text.length ? text.slice(closeEnd + 1) : '';
  return { data, body };
}

// ---------------------------------------------------------------- Markdown

const isSpTab = (c) => c === ' ' || c === '\t';

function isBlank(l) {
  for (let i = 0; i < l.length; i++) if (!isSpTab(l[i])) return false;
  return true;
}

/** A fence opening line's language, or null: three backticks, language chars, spaces/tabs only. */
function fenceLang(l) {
  if (l.charCodeAt(0) !== 96 || l.charCodeAt(1) !== 96 || l.charCodeAt(2) !== 96) return null;
  let i = 3;
  while (i < l.length) {
    const c = l[i];
    if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c === '_' || c === '+' || c === '-') i++;
    else break;
  }
  const langEnd = i;
  while (i < l.length) {
    if (!isSpTab(l[i])) return null;
    i++;
  }
  return l.slice(3, langEnd);
}

function isFenceClose(l) {
  if (l.charCodeAt(0) !== 96 || l.charCodeAt(1) !== 96 || l.charCodeAt(2) !== 96) return false;
  for (let i = 3; i < l.length; i++) if (!isSpTab(l[i])) return false;
  return true;
}

/** A heading line's { depth, text }, or null. */
function headingOf(l) {
  let h = 0;
  while (h < l.length && l[h] === '#') h++;
  if (h < 1 || h > 6 || h >= l.length) return null;
  if (!isSpTab(l[h])) return null;
  let j = h;
  while (j < l.length && isSpTab(l[j])) j++;
  let e = l.length;
  while (e > j && isSpTab(l[e - 1])) e--;
  if (e <= j) return null;
  return { depth: h, text: l.slice(j, e) };
}

function isHR(l) {
  if (!(l.startsWith('---') || l.startsWith('***'))) return false;
  for (let i = 3; i < l.length; i++) if (!isSpTab(l[i])) return false;
  return true;
}

function trimLine(l) {
  let a = 0;
  let b = l.length;
  while (a < b && isSpTab(l[a])) a++;
  while (b > a && isSpTab(l[b - 1])) b--;
  return a === 0 && b === l.length ? l : l.slice(a, b);
}

function endsParagraph(l) {
  return isBlank(l) || fenceLang(l) !== null || headingOf(l) !== null || isHR(l);
}

/** Bullet marker content offset, or -1; ordered marker { num, off } or null. */
function bulletOff(l) {
  return (l[0] === '-' || l[0] === '*') && l[1] === ' ' ? 2 : -1;
}
function orderedOff(l) {
  let i = 0;
  while (i < l.length && l[i] >= '0' && l[i] <= '9') i++;
  if (i < 1 || i > 9) return null;
  if (l[i] !== '.' || l[i + 1] !== ' ') return null;
  return { num: Number(l.slice(0, i)), off: i + 2 };
}
function isContinued(l) {
  let i = 0;
  while (i < l.length && l[i] === ' ') i++;
  return i >= 2 && i < l.length && !isSpTab(l[i]);
}

const ESCAPABLE = '\\`*_[]()#+-.!>';
const SPEC_RE = /[\\`*\[&<>"']/g;
const WS_TEST = /\s/;

function findUnescaped(s, what, from) {
  const wlen = what.length;
  for (let j = from; j <= s.length - wlen; j++) {
    if (s[j] === '\\' && j + 1 < s.length && ESCAPABLE.indexOf(s[j + 1]) !== -1) { j++; continue; }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

function findSingleStar(s, from) {
  let j = from;
  while (j < s.length) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && ESCAPABLE.indexOf(s[j + 1]) !== -1) { j += 2; continue; }
    if (c !== '*') { j++; continue; }
    if (s[j + 1] === '*') { j += 2; continue; }
    return j;
  }
  return -1;
}

function escChar(c) {
  const e = ESC_MAP[c];
  return e === undefined ? c : e;
}

/** `s` rendered inline; `link(target)` resolves a link's href. Plain runs are sliced, never per-char. */
function inline(s, link) {
  const parts = [];
  let i = 0;
  const n = s.length;
  while (i < n) {
    SPEC_RE.lastIndex = i;
    const m = SPEC_RE.exec(s);
    if (m === null) { parts.push(s.slice(i)); break; }
    const j = m.index;
    if (j > i) parts.push(s.slice(i, j));
    const c = s[j];
    i = j;
    if (c === '&' || c === '<' || c === '>' || c === '"' || c === "'") {
      parts.push(ESC_MAP[c]);
      i++;
    } else if (c === '\\') {
      if (i + 1 < n && ESCAPABLE.indexOf(s[i + 1]) !== -1) {
        parts.push(escChar(s[i + 1]));
        i += 2;
      } else {
        parts.push('\\');
        i++;
      }
    } else if (c === '`') {
      const k = s.indexOf('`', i + 1);
      if (k > i + 1) {
        parts.push(`<code>${esc(s.slice(i + 1, k))}</code>`);
        i = k + 1;
      } else {
        parts.push('`');
        i++;
      }
    } else if (c === '*') {
      if (s[i + 1] === '*') {
        const k = findUnescaped(s, '**', i + 2);
        if (k > i + 2) {
          parts.push(`<strong>${inline(s.slice(i + 2, k), link)}</strong>`);
          i = k + 2;
        } else {
          parts.push('**');
          i += 2;
        }
      } else {
        const k = findSingleStar(s, i + 1);
        if (k > i + 1) {
          parts.push(`<em>${inline(s.slice(i + 1, k), link)}</em>`);
          i = k + 1;
        } else {
          parts.push('*');
          i++;
        }
      }
    } else { // '['
      const k = findUnescaped(s, ']', i + 1);
      const mm = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
      const target = mm === -1 ? '' : s.slice(k + 2, mm);
      if (target !== '' && !WS_TEST.test(target)) {
        parts.push(`<a href="${esc(link(target))}">${inline(s.slice(i + 1, k), link)}</a>`);
        i = mm + 1;
      } else {
        parts.push('[');
        i++;
      }
    }
  }
  return parts.join('');
}

/**
 * `src` rendered in one fused pass: { html, toc, excerpt } exactly as makefun-site's lexer+parser produce.
 */
function renderMarkdown(src, link) {
  const lines = src.split('\n');
  const n = lines.length;
  const ids = new Set();
  const toc = [];
  const parts = [];
  let excerpt = null;
  let i = 0;
  while (i < n) {
    const line = lines[i];
    if (isBlank(line)) { i++; continue; }
    const lang = fenceLang(line);
    if (lang !== null) {
      i++;
      const body = [];
      while (i < n && !isFenceClose(lines[i])) { body.push(esc(lines[i]), '\n'); i++; }
      i++;
      parts.push(lang === '' ? `<pre><code>${body.join('')}</code></pre>\n` : `<pre><code class="language-${esc(lang)}">${body.join('')}</code></pre>\n`);
      continue;
    }
    const heading = headingOf(line);
    if (heading !== null) {
      const id = uniqueSlug(slugify(heading.text), ids);
      const html = inline(heading.text, link);
      parts.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>\n`);
      if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
      i++;
      continue;
    }
    if (isHR(line)) { parts.push('<hr>\n'); i++; continue; }
    if (line[0] === '>') {
      const kept = [];
      while (i < n && lines[i][0] === '>') {
        const raw = lines[i];
        const stripped = raw[1] === ' ' ? raw.slice(2) : raw.slice(1);
        const t = trimLine(stripped);
        if (t !== '') kept.push(t);
        i++;
      }
      parts.push(kept.length === 0 ? '<blockquote>\n</blockquote>\n' : `<blockquote>\n<p>${inline(kept.join('\n'), link)}</p>\n</blockquote>\n`);
      continue;
    }
    const bOff = bulletOff(line);
    const oOff = bOff === -1 ? orderedOff(line) : null;
    if (bOff !== -1 || oOff !== null) {
      const isOrdered = oOff !== null;
      const items = [];
      while (i < n) {
        const l = lines[i];
        let content = null;
        if (isOrdered) {
          const o = orderedOff(l);
          if (o !== null) content = l.slice(o.off);
        } else if (bulletOff(l) !== -1) content = l.slice(2);
        if (content !== null) {
          items.push([trimLine(content)]);
          i++;
        } else if (isContinued(l)) {
          items[items.length - 1].push(trimLine(l));
          i++;
        } else break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && oOff.num !== 1 ? `<ol start="${oOff.num}">` : `<${tag}>`;
      const block = [`${open}\n`];
      for (const pit of items) block.push(`<li>${inline(pit.join('\n'), link)}</li>\n`);
      block.push(`</${tag}>\n`);
      parts.push(block.join(''));
      continue;
    }
    let text = trimLine(line);
    i++;
    while (i < n && !endsParagraph(lines[i])) { text += `\n${trimLine(lines[i])}`; i++; }
    const html = inline(text, link);
    if (excerpt === null) excerpt = html;
    parts.push(`<p>${html}</p>\n`);
  }
  return { html: parts.join(''), toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

const INCLUDE_DEPTH = 8;
const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

class TemplateError extends Error {}

function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

// Node kinds: 0 text, 1 var (escaped), 2 raw, 3 if, 4 for, 5 include.
function parseTemplate(name, src) {
  const root = { kind: 'root', kindName: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  const pushText = (text) => { if (text !== '') body.push({ k: 0, text }); };
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) { text += src.slice(i); break; }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') { text += src.slice(i, open + 1); i = open + 1; continue; }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      pushText(text); text = '';
      body.push({ k: raw ? 2 : 1, path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    let standalone = true;
    for (let q = lineStart; q < open; q++) if (!isSpTab(src[q])) { standalone = false; break; }
    if (standalone) for (let q = end; q < lineEnd; q++) if (!isSpTab(src[q])) { standalone = false; break; }
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    pushText(text); text = '';
    const tag = src.slice(open + 2, close).trim();
    const top = stack[stack.length - 1];
    let m;
    if ((m = FOR_RE.exec(tag)) !== null) {
      const node = { k: 4, kind: 'for', kindName: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
      body.push(node); stack.push(node); body = node.body;
    } else if ((m = IF_RE.exec(tag)) !== null) {
      const node = { k: 3, kind: 'if', kindName: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
      body.push(node); stack.push(node); body = node.then;
    } else if (tag === 'else') {
      if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
      top.else = []; body = top.else;
    } else if (tag === 'endfor' || tag === 'endif') {
      if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
      stack.pop();
      const parent = stack[stack.length - 1];
      body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
    } else if ((m = INCLUDE_RE.exec(tag)) !== null) {
      body.push({ k: 5, name: m[1] });
    } else {
      throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  pushText(text);
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kindName} is not closed`);
  return root.body;
}

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

function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

let G_TEMPLATES = null;

function renderNodes(nodes, scope, depth, parts) {
  for (let idx = 0; idx < nodes.length; idx++) {
    const nd = nodes[idx];
    switch (nd.k) {
      case 0:
        parts.push(nd.text);
        break;
      case 1: {
        const v = lookup(scope, nd.path);
        parts.push(typeof v === 'string' ? esc(v) : esc(textOf(v)));
        break;
      }
      case 2: {
        const v = lookup(scope, nd.path);
        parts.push(typeof v === 'string' ? v : textOf(v));
        break;
      }
      case 3: {
        const branch = truthy(lookup(scope, nd.path)) !== nd.not ? nd.then : nd.else;
        if (branch !== null) renderNodes(branch, scope, depth, parts);
        break;
      }
      case 4: {
        const xs = lookup(scope, nd.path);
        if (!Array.isArray(xs)) break;
        const len = xs.length;
        for (let k = 0; k < len; k++) {
          const vars = { [nd.name]: xs[k], loop: { index: k + 1, first: k === 0, last: k === len - 1, length: len } };
          renderNodes(nd.body, { vars, parent: scope }, depth, parts);
        }
        break;
      }
      case 5: {
        const t = G_TEMPLATES.get(nd.name);
        if (t !== undefined && depth < INCLUDE_DEPTH) renderNodes(t, scope, depth + 1, parts);
        break;
      }
    }
  }
}

// ---------------------------------------------------------------- the build

const RESERVED = ['posts', 'tags', 'page'];
const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;

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

function getCard(s) {
  if (s.card !== undefined) return s.card;
  const card = {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  };
  s.card = card;
  return card;
}

const linkOf = (s) => (s === null ? null : {
  title: s.data.title,
  url: s.url,
  date: s.data.date ?? '',
  date_long: s.data.date === undefined ? '' : longDate(s.data.date),
});

/** One site's output tree: path -> text, exactly makefun-site 1.0.0's build of the same input. */
export function run(input) {
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCU)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const base = input.site.base_url.replace(/\/+$/, '');
  const output = {};
  const broken = new Set();

  // 1. Sources in code-unit order of path; .md is a source (line ends made \n), anything else static.
  const files = [...input.files].sort((x, y) => byCU(x.path, y.path));
  let sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.includes('\r') ? f.content.replace(/\r\n?/g, '\n') : f.content });
    else statics.push({ path: f.path, content: f.content });
  }

  // 2. Front matter and the refusal/draft checks, in their order.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) { report.push(`refused ${s.path}: ${fm.error}`); continue; }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let own;
    if (s.path.startsWith('tags/')) own = 'tags';
    else if (s.path.startsWith('page/')) own = 'page';
    if (own !== undefined) { report.push(`refused ${s.path}: ${own}/ is the generator's own`); continue; }
    if (s.post && !Object.hasOwn(s.data, 'date')) { report.push(`refused ${s.path}: a post needs a date`); continue; }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) { report.push(`refused ${s.path}: layout "${layout}" is no template that parses`); continue; }
    s.layout = layout;
    if (s.data.draft === true) { report.push(`draft ${s.path}`); continue; }
    kept.push(s);
  }
  sources = kept;

  // 3. Permalinks: slug unique in its directory, in source order.
  const taken = new Map();
  const bySource = new Map();
  for (const s of sources) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) { set = new Set(dir === '' ? RESERVED : []); taken.set(dir, set); }
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. Markdown, links resolved against pages and static files.
  const staticPaths = new Set(statics.map((f) => f.path));
  for (const s of sources) {
    const dir = dirOf(s.path);
    const srcPath = s.path;
    const link = (target) => {
      if (SCHEME_RE.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolvePath(dir, rel);
      if (path !== null) {
        const page = bySource.get(path);
        if (page !== undefined) return `${page.url}${frag}`;
        if (staticPaths.has(path)) return `${base}/${path}${frag}`;
      }
      broken.add(`broken-link ${srcPath} -> ${target}`);
      return target;
    };
    const md = renderMarkdown(s.body, link);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. Collections: posts newest first, equal dates by slug.
  const posts = sources.filter((s) => s.post);
  posts.sort((x, y) => byCU(y.data.date, x.data.date) || byCU(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. Tags, grouped by slug, named as first met in collection order, ordered by count then slug.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name);
      if (!seen.has(slug)) { seen.add(slug); out.push(name); }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) { tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] }; bySlug.set(slug, tag); }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of sources) {
    if (!s.post) {
      s.tagRefs = ownTags(s).map((name) => {
        const slug = slugify(name);
        return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
      });
    }
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCU(x.slug, y.slug));

  // 7. Layouts: every page, the index pages, the tag pages, then statics.
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => getCard(p));
  G_TEMPLATES = templates;
  const baseScope = { vars: { site, tags: allTags, recent }, parent: null };
  const render = (name, vars) => {
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    const parts = [];
    renderNodes(nodes, { vars, parent: baseScope }, 0, parts);
    return parts.join('');
  };
  for (const s of sources) {
    const page = {
      ...getCard(s),
      slug: s.slug,
      content: s.html,
      toc: s.toc,
      newer: linkOf(s.newer ?? null),
      older: linkOf(s.older ?? null),
      is_post: s.post,
    };
    output[`${s.outDir}/index.html`] = render(s.layout, { page });
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => getCard(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => getCard(p)) } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report.
  const lines = [...report, ...broken].sort(byCU);
  const pageCount = sources.reduce((acc, s) => acc + (s.post ? 0 : 1), 0);
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
