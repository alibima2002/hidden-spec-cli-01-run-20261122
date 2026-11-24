// main.ts is mend, the CLI SPEC.md specifies. Node 22, the standard library alone;
// run it as `node main.ts [options] [PATCH]`.
//
// It does all of SPEC.md: the command line, the output and exit codes, safe paths,
// format detection, the three matching tiers (section 5), unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7), V4A patches (section 8), JSON edits (section 9)
// and the all-or-nothing write (section 10).
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then
// this file hands over to runner.ts (the last lines below): keep that hand-over and
// runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

/** Index of the first non-blank line, or -1 when every line is blank. */
function firstNonBlank(lines: string[]): number {
  return lines.findIndex((l) => !blank(l));
}

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: [string, string][] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = firstNonBlank(lines);
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/* ---------- lines, tiers and files (SPEC.md sections 3 and 5) ---------- */

function trimEndWS(s: string): string {
  return s.replace(/[ \t]+$/, '');
}
function trimWS(s: string): string {
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}
function leadingWS(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}
function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEndWS(a) === trimEndWS(b);
  return trimWS(a) === trimWS(b);
}
/** Every position at which `pat` occurs in `lines` at `tier`, from `from` on. */
function occurrences(lines: string[], pat: string[], tier: number, from = 0): number[] {
  const out: number[] = [];
  if (pat.length === 0) return out;
  for (let i = from; i + pat.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < pat.length; j++) {
      if (!lineEq(lines[i + j]!, pat[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}
/** The first tier (0, then 1, then 2; only 0 when strict) at which `pat` occurs. */
function findTier(lines: string[], pat: string[], strict: boolean, from = 0): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(lines, pat, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}
/** Tier 2 re-indent of one new line: P (old first line's indent) becomes F (file's). */
function reindent(line: string, p: string, f: string): string {
  if (line === '' || line.trim() === '') return line;
  if (line.startsWith(p)) return f + line.slice(p.length);
  return line;
}

interface Split {
  lines: string[];
  br: string;
  finalBreak: boolean;
}
function splitFile(text: string): Split {
  if (text === '') return { lines: [], br: '\n', finalBreak: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const finalBreak = text.endsWith(br);
  if (finalBreak) parts.pop();
  return { lines: parts, br, finalBreak };
}
function joinFile(lines: string[], br: string, finalBreak: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (finalBreak ? br : '');
}

/** O and N of a hunk or chunk body. An N line that is context carries its O index. */
interface NLine {
  text: string;
  ctx: number | null;
}
function buildON(body: string[]): { o: string[]; n: NLine[] } {
  const o: string[] = [];
  const n: NLine[] = [];
  for (const b of body) {
    if (b === '') {
      o.push('');
      n.push({ text: '', ctx: o.length - 1 });
    } else if (b[0] === ' ') {
      const t = b.slice(1);
      o.push(t);
      n.push({ text: t, ctx: o.length - 1 });
    } else if (b[0] === '-') {
      o.push(b.slice(1));
    } else if (b[0] === '+') {
      n.push({ text: b.slice(1), ctx: null });
    }
  }
  return { o, n };
}
/** The N lines as written: context lines are the file's own matched lines, the rest
 *  are re-indented at tier 2. */
function renderN(n: NLine[], fileLines: string[], pos: number, tier: number, o: string[]): string[] {
  if (o.length === 0) return n.map((x) => x.text);
  const p = leadingWS(o[0]!);
  const f = leadingWS(fileLines[pos]!);
  return n.map((x) => {
    if (x.ctx !== null) return fileLines[pos + x.ctx]!;
    return tier === 2 ? reindent(x.text, p, f) : x.text;
  });
}
/** Whether a `\` line follows the body's last context or `+` line. */
function backslashAfterLast(body: string[]): boolean {
  let last = -1;
  for (let j = 0; j < body.length; j++) {
    const b = body[j]!;
    if (b === '' || b[0] === ' ' || b[0] === '+') last = j;
  }
  if (last < 0) return false;
  const nx = body[last + 1];
  return nx !== undefined && nx[0] === '\\';
}

/* ---------- JSON edits (SPEC.md section 9) ---------- */

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = firstNonBlank(lines);
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* ---------- unified diffs (SPEC.md section 6) ---------- */

interface Hunk {
  a: number;
  body: string[];
}
interface Section {
  diffOld: string | undefined;
  diffNew: string | undefined;
  oldPath: string | null | undefined;
  newPath: string | null | undefined;
  renameFrom: string | undefined;
  renameTo: string | undefined;
  newFile: boolean;
  deletedFile: boolean;
  pairSeen: boolean;
  hunks: Hunk[];
}

/** The path a `--- ` or `+++ ` line names, or null for /dev/null. */
function parseDiffPath(line: string): string | null {
  const rest = line.slice(4).split('\t')[0]!.trim();
  if (rest === '/dev/null') return null;
  if (rest.startsWith('a/') || rest.startsWith('b/')) return rest.slice(2);
  return rest;
}

/** One hunk applied to a file's lines. `d` is the length delta of the section's
 *  hunks applied so far. */
function applyHunk(
  lines: string[],
  finalBreak: boolean,
  h: Hunk,
  d: number,
  strict: boolean,
  path: string,
): { lines: string[]; finalBreak: boolean; delta: number } {
  const { o, n } = buildON(h.body);
  const delta = n.length - o.length;
  if (o.length === 0) {
    let pos = h.a + d;
    if (pos < 0) pos = 0;
    if (pos > lines.length) pos = lines.length;
    const atEnd = pos === lines.length;
    const inserted = renderN(n, lines, pos, 0, o);
    return {
      lines: [...lines.slice(0, pos), ...inserted, ...lines.slice(pos)],
      finalBreak: atEnd ? !backslashAfterLast(h.body) : finalBreak,
      delta,
    };
  }
  const found = findTier(lines, o, strict);
  if (found === null) throw new Fail('no-match', path);
  const target = h.a - 1 + d;
  let best = found.occ[0]!;
  let bestDist = Math.abs(best - target);
  for (const p of found.occ) {
    const dist = Math.abs(p - target);
    if (dist < bestDist) {
      best = p;
      bestDist = dist;
    }
  }
  const pos = best;
  const toEnd = pos + o.length === lines.length;
  const nPrime = renderN(n, lines, pos, found.tier, o);
  return {
    lines: [...lines.slice(0, pos), ...nPrime, ...lines.slice(pos + o.length)],
    finalBreak: toEnd ? !backslashAfterLast(h.body) : finalBreak,
    delta,
  };
}

/** Whether a created file ends without a line break: a `\` line follows its last `+` line. */
function creationNoBreak(hunks: Hunk[]): boolean {
  for (let hi = hunks.length - 1; hi >= 0; hi--) {
    const body = hunks[hi]!.body;
    for (let j = body.length - 1; j >= 0; j--) {
      if (body[j]!.startsWith('+')) {
        const nx = body[j + 1];
        return nx !== undefined && nx[0] === '\\';
      }
    }
  }
  return false;
}

function sectionEdit(s: Section, strict: boolean): Edit {
  const oldP: string | null = s.oldPath !== undefined ? s.oldPath : s.renameFrom !== undefined ? s.renameFrom : (s.diffOld ?? '');
  const newP: string | null = s.newPath !== undefined ? s.newPath : s.renameTo !== undefined ? s.renameTo : (s.diffNew ?? '');
  if (oldP === null && newP === null) return () => {};
  if (oldP === null || s.newFile) {
    const p = newP as string;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const outLines: string[] = [];
      for (const h of s.hunks) for (const b of h.body) if (b.startsWith('+')) outLines.push(b.slice(1));
      tree.now.set(p, outLines.length === 0 ? '' : outLines.join('\n') + (creationNoBreak(s.hunks) ? '' : '\n'));
    };
  }
  if (newP === null || s.deletedFile) {
    const p = oldP as string;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
    };
  }
  if (oldP !== newP) {
    const op = oldP as string;
    const np = newP as string;
    return (tree) => {
      if (!safe(op)) throw new Fail('unsafe', op);
      if (!safe(np)) throw new Fail('unsafe', np);
      const before = tree.get(op);
      if (before === null) throw new Fail('missing', op);
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const f = splitFile(before);
      let lines = f.lines;
      let finalBreak = f.finalBreak;
      let d = 0;
      for (const h of s.hunks) {
        const r = applyHunk(lines, finalBreak, h, d, strict, op);
        lines = r.lines;
        finalBreak = r.finalBreak;
        d += r.delta;
      }
      tree.now.set(op, null);
      tree.now.set(np, joinFile(lines, f.br, finalBreak));
      tree.moves.push([op, np]);
    };
  }
  const p = oldP as string;
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    const f = splitFile(before);
    let lines = f.lines;
    let finalBreak = f.finalBreak;
    let d = 0;
    for (const h of s.hunks) {
      const r = applyHunk(lines, finalBreak, h, d, strict, p);
      lines = r.lines;
      finalBreak = r.finalBreak;
      d += r.delta;
    }
    tree.now.set(p, joinFile(lines, f.br, finalBreak));
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  const fresh = (): Section => ({
    diffOld: undefined,
    diffNew: undefined,
    oldPath: undefined,
    newPath: undefined,
    renameFrom: undefined,
    renameTo: undefined,
    newFile: false,
    deletedFile: false,
    pairSeen: false,
    hunks: [],
  });
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      if (cur !== null) sections.push(cur);
      cur = fresh();
      cur.diffOld = m[1]!;
      cur.diffNew = m[2]!;
      i++;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const op = parseDiffPath(line);
      const np = parseDiffPath(lines[i + 1]!);
      if (cur !== null && cur.hunks.length === 0 && !cur.pairSeen) {
        cur.oldPath = op;
        cur.newPath = np;
        cur.pairSeen = true;
      } else {
        if (cur !== null) sections.push(cur);
        cur = fresh();
        cur.oldPath = op;
        cur.newPath = np;
        cur.pairSeen = true;
      }
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      const hm = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (hm === null || cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const hunk: Hunk = { a: Number(hm[1]), body: [] };
      i++;
      while (i < lines.length) {
        const b = lines[i]!;
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (b === '' || b[0] === ' ' || b[0] === '-' || b[0] === '+' || b[0] === '\\') {
          hunk.body.push(b);
          i++;
        } else break;
      }
      while (hunk.body.length > 0 && hunk.body[hunk.body.length - 1] === '') hunk.body.pop();
      cur.hunks.push(hunk);
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice(12);
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice(10);
      else if (/^new file mode($| )/.test(line)) cur.newFile = true;
      else if (/^deleted file mode($| )/.test(line)) cur.deletedFile = true;
      i++;
      continue;
    }
    i++;
  }
  if (cur !== null) sections.push(cur);
  return sections.map((s) => sectionEdit(s, strict));
}

/* ---------- SEARCH/REPLACE blocks (SPEC.md section 7) ---------- */

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  if (oldLines.length === 0) {
    return (tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
    };
  }
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const f = splitFile(before);
    const found = findTier(f.lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const pos = found.occ[0]!;
    const nPrime = renderN(
      newLines.map((t) => ({ text: t, ctx: null })),
      f.lines,
      pos,
      found.tier,
      oldLines,
    );
    const out = [...f.lines.slice(0, pos), ...nPrime, ...f.lines.slice(pos + oldLines.length)];
    tree.now.set(path, joinFile(out, f.br, f.finalBreak));
  };
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const sIdx = i;
    let eq = -1;
    for (let j = sIdx + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq < 0) throw new Exit2(`error: parse ${sIdx + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${sIdx + 1}`);
    let path: string | null = null;
    for (let j = sIdx - 1; j > prevEnd; j--) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${sIdx + 1}`);
      path = prevPath;
    }
    prevPath = path;
    prevEnd = rep;
    edits.push(srEdit(path, lines.slice(sIdx + 1, eq), lines.slice(eq + 1, rep), strict));
    i = rep + 1;
  }
  return edits;
}

/* ---------- V4A patches (SPEC.md section 8) ---------- */

interface VChunk {
  anchor: string | null;
  eof: boolean;
  body: string[];
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: VChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const f = splitFile(before);
    let lines = f.lines;
    let cursor = 0;
    const tiers = strict ? [0] : [0, 1, 2];
    for (const ch of chunks) {
      if (ch.anchor !== null && ch.anchor !== '') {
        let foundIdx = -1;
        for (const t of tiers) {
          for (let k = cursor; k < lines.length; k++) {
            if (lineEq(lines[k]!, ch.anchor, t)) {
              foundIdx = k;
              break;
            }
          }
          if (foundIdx >= 0) break;
        }
        if (foundIdx < 0) throw new Fail('no-match', path);
        cursor = foundIdx + 1;
      }
      const { o, n } = buildON(ch.body);
      if (o.length === 0) {
        const pos = ch.eof ? lines.length : cursor;
        const inserted = n.map((x) => x.text);
        lines = [...lines.slice(0, pos), ...inserted, ...lines.slice(pos)];
        cursor = pos + inserted.length;
      } else {
        let found: { tier: number; occ: number[] } | null = null;
        for (const t of tiers) {
          const occ = occurrences(lines, o, t, cursor);
          if (occ.length > 0) {
            found = { tier: t, occ };
            break;
          }
        }
        if (found === null) throw new Fail('no-match', path);
        let pos: number;
        if (ch.eof) {
          const end = found.occ.find((p) => p + o.length === lines.length);
          if (end === undefined) throw new Fail('no-match', path);
          pos = end;
        } else {
          pos = found.occ[0]!;
        }
        const nPrime = renderN(n, lines, pos, found.tier, o);
        lines = [...lines.slice(0, pos), ...nPrime, ...lines.slice(pos + o.length)];
        cursor = pos + nPrime.length;
      }
    }
    const text = joinFile(lines, f.br, f.finalBreak);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, text);
      tree.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, text);
    }
  };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = firstNonBlank(lines);
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    let m = /^\*\*\* Add File: (.*)$/.exec(line);
    if (m !== null) {
      const path = m[1]!.trim();
      i++;
      const raw: { text: string; idx: number }[] = [];
      while (i < last && !isSectionStart(lines[i]!)) {
        raw.push({ text: lines[i]!, idx: i });
        i++;
      }
      while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
      const fileLines: string[] = [];
      for (const r of raw) {
        if (r.text === '') fileLines.push('');
        else if (r.text.startsWith('+')) fileLines.push(r.text.slice(1));
        else throw new Exit2(`error: parse ${r.idx + 1}`);
      }
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
      });
      continue;
    }
    m = /^\*\*\* Delete File: (.*)$/.exec(line);
    if (m !== null) {
      const path = m[1]!.trim();
      i++;
      const raw: { text: string; idx: number }[] = [];
      while (i < last && !isSectionStart(lines[i]!)) {
        raw.push({ text: lines[i]!, idx: i });
        i++;
      }
      while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
      if (raw.length > 0) throw new Exit2(`error: parse ${raw[0]!.idx + 1}`);
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      });
      continue;
    }
    m = /^\*\*\* Update File: (.*)$/.exec(line);
    if (m !== null) {
      const path = m[1]!.trim();
      const updIdx = i;
      i++;
      const raw: { text: string; idx: number }[] = [];
      while (i < last && !isSectionStart(lines[i]!)) {
        raw.push({ text: lines[i]!, idx: i });
        i++;
      }
      while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
      let moveTo: string | null = null;
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      for (const r of raw) {
        const l = r.text;
        if (l === '*** End of File') {
          if (cur !== null) {
            cur.eof = true;
            chunks.push(cur);
            cur = null;
          }
          continue;
        }
        if (l.startsWith('*** Move to: ') && moveTo === null && cur === null && chunks.length === 0) {
          moveTo = l.slice(13).trim();
          continue;
        }
        if (l.startsWith('@@')) {
          if (cur !== null) chunks.push(cur);
          cur = { anchor: l.slice(2).trim(), eof: false, body: [] };
          continue;
        }
        if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
          if (cur === null) cur = { anchor: null, eof: false, body: [] };
          cur.body.push(l);
          continue;
        }
        throw new Exit2(`error: parse ${r.idx + 1}`);
      }
      if (cur !== null) chunks.push(cur);
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updIdx + 1}`);
      edits.push(v4aUpdateEdit(path, moveTo, chunks, strict));
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

/* ---------- the command line (SPEC.md sections 1, 2 and 10) ---------- */

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  }
  interface Action {
    key: string;
    text: string;
    kind: 'A' | 'D' | 'M' | 'R';
    path: string;
    newPath?: string;
  }
  const actions: Action[] = [];
  const covered = new Set<string>();
  for (const [old, nw] of tree.moves) {
    if (tree.original(old) !== null && tree.get(old) === null && tree.original(nw) === null && tree.get(nw) !== null) {
      actions.push({ key: nw, text: `R ${old} -> ${nw}`, kind: 'R', path: old, newPath: nw });
      covered.add(old);
      covered.add(nw);
    }
  }
  for (const p of [...tree.now.keys()]) {
    if (covered.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    const kind = was === null ? 'A' : now === null ? 'D' : 'M';
    actions.push({ key: p, text: `${kind} ${p}`, kind, path: p });
  }
  actions.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const rows = actions.map((a) => a.text);
  if (!check) {
    for (const a of actions) {
      if (a.kind === 'R') {
        rmSync(a.path, { force: true });
        mkdirSync(dirname(a.newPath!), { recursive: true });
        writeFileSync(a.newPath!, tree.now.get(a.newPath!)!);
      } else if (a.kind === 'D') {
        rmSync(a.path, { force: true });
      } else {
        mkdirSync(dirname(a.path), { recursive: true });
        writeFileSync(a.path, tree.now.get(a.path)!);
      }
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
