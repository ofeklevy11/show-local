// Add or update one entry in .claude/launch.json (Claude desktop app's preview config)
// without disturbing anything else in the file: every byte outside the entry we touch
// stays exactly as it was. A file that is not strict JSON is never rewritten.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** Minimal strict-JSON scanner that records where every value starts and ends. */
export function scanJson(text) {
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const fail = (msg) => { throw new SyntaxError(`${msg} at offset ${i}`); };
  const ws = () => { while (i < text.length && ' \t\n\r'.includes(text[i])) i++; };

  function str() {
    const start = i++;
    while (i < text.length) {
      const ch = text[i];
      if (ch === '\\') { i += 2; continue; }
      if (ch === '"') { i++; return { type: 'string', start, end: i, value: JSON.parse(text.slice(start, i)) }; }
      if (ch < ' ') fail('control character in string');
      i++;
    }
    return fail('unterminated string');
  }

  function value() {
    ws();
    const start = i;
    const c = text[i];
    if (c === '{') {
      i++;
      const members = [];
      ws();
      if (text[i] === '}') { i++; return { type: 'object', start, end: i, members }; }
      for (;;) {
        ws();
        if (text[i] !== '"') fail('expected a key');
        const key = str();
        ws();
        if (text[i] !== ':') fail('expected ":"');
        i++;
        members.push({ key: key.value, keyStart: key.start, node: value() });
        ws();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === '}') { i++; break; }
        fail('expected "," or "}"');
      }
      return { type: 'object', start, end: i, members };
    }
    if (c === '[') {
      i++;
      const elements = [];
      ws();
      if (text[i] === ']') { i++; return { type: 'array', start, end: i, elements }; }
      for (;;) {
        elements.push(value());
        ws();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === ']') { i++; break; }
        fail('expected "," or "]"');
      }
      return { type: 'array', start, end: i, elements };
    }
    if (c === '"') return str();
    const m = text.slice(i).match(/^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/);
    if (!m) fail('unexpected token');
    i += m[0].length;
    return { type: 'literal', start, end: i };
  }

  const root = value();
  ws();
  if (i !== text.length) fail('unexpected trailing content');
  return root;
}

const canonical = (v) => JSON.stringify(v, (k, val) => (val && typeof val === 'object' && !Array.isArray(val)
  ? Object.fromEntries(Object.keys(val).sort().map((key) => [key, val[key]]))
  : val));

function lineIndent(text, offset) {
  const nl = text.lastIndexOf('\n', offset - 1);
  const lead = text.slice(nl + 1, offset);
  return /^[ \t]*$/.test(lead) ? lead : null;
}

function detectUnit(text) {
  const m = text.match(/\n([ \t]+)\S/);
  return m ? m[1] : '  ';
}

function format(entry, indent, unit, eol) {
  return JSON.stringify(entry, null, unit).split('\n').map((l, k) => (k === 0 ? l : indent + l)).join(eol);
}

/**
 * @param {string|null} text  current file content, or null when the file does not exist
 * @param {object} entry      launch configuration with a unique "name"
 * @returns {{ok:true, text:string, action:'created'|'added'|'updated'|'unchanged'} | {ok:false, error:string, detail:string}}
 */
export function mergeLaunchEntry(text, entry) {
  if (!entry || typeof entry.name !== 'string' || !entry.name) {
    return { ok: false, error: 'bad-entry', detail: 'A launch entry needs a "name".' };
  }
  if (text == null || text.trim() === '') {
    return { ok: true, action: 'created', text: `${JSON.stringify({ version: '0.0.1', configurations: [entry] }, null, 2)}\n` };
  }
  let root;
  let parsed;
  try {
    root = scanJson(text);
    parsed = JSON.parse(text.replace(/^﻿/, ''));
  } catch (e) {
    return { ok: false, error: 'invalid-json', detail: `launch.json is not strict JSON (${e.message}); left untouched.` };
  }
  if (root.type !== 'object') return { ok: false, error: 'invalid-json', detail: 'launch.json root is not an object; left untouched.' };
  // Duplicate keys are legal JSON but ambiguous (JSON.parse keeps the last one); never guess.
  const keys = root.members.map((m) => m.key);
  const dup = keys.find((k, i) => keys.indexOf(k) !== i);
  if (dup !== undefined) return { ok: false, error: 'invalid-json', detail: `launch.json has the key "${dup}" twice; left untouched.` };

  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const unit = detectUnit(text);
  const splice = (start, end, insert) => text.slice(0, start) + insert + text.slice(end);
  const member = root.members.find((m) => m.key === 'configurations');

  if (!member) {
    const ind = unit;
    const block = `"configurations": [${eol}${ind}${unit}${format(entry, ind + unit, unit, eol)}${eol}${ind}]`;
    if (root.members.length) {
      const last = root.members[root.members.length - 1].node;
      return { ok: true, action: 'added', text: splice(last.end, last.end, `,${eol}${ind}${block}`) };
    }
    return { ok: true, action: 'added', text: splice(root.start + 1, root.end - 1, `${eol}${ind}${block}${eol}`) };
  }

  const arr = member.node;
  if (arr.type !== 'array') return { ok: false, error: 'invalid-json', detail: '"configurations" is not an array; left untouched.' };
  const keyIndent = lineIndent(text, member.keyStart) ?? unit;
  const values = parsed.configurations;

  const at = values.findIndex((v) => v && v.name === entry.name);
  if (at !== -1) {
    if (canonical(values[at]) === canonical(entry)) return { ok: true, action: 'unchanged', text };
    const el = arr.elements[at];
    const ind = lineIndent(text, el.start);
    // An entry that shares its line with other content was written inline: keep it inline.
    const body = ind == null ? JSON.stringify(entry) : format(entry, ind, unit, eol);
    return { ok: true, action: 'updated', text: splice(el.start, el.end, body) };
  }

  if (!arr.elements.length) {
    const ind = keyIndent + unit;
    return { ok: true, action: 'added', text: splice(arr.start + 1, arr.end - 1, `${eol}${ind}${format(entry, ind, unit, eol)}${eol}${keyIndent}`) };
  }
  const last = arr.elements[arr.elements.length - 1];
  const ind = lineIndent(text, last.start);
  if (ind == null) {
    // Elements written inline on one line: stay inline.
    return { ok: true, action: 'added', text: splice(last.end, last.end, `, ${JSON.stringify(entry)}`) };
  }
  return { ok: true, action: 'added', text: splice(last.end, last.end, `,${eol}${ind}${format(entry, ind, unit, eol)}`) };
}

export function launchJsonPath(cwd) {
  return path.join(cwd, '.claude', 'launch.json');
}

/**
 * The configurations in <cwd>/.claude/launch.json that are objects, in file order, or [] (no
 * file, not JSON, no "configurations" array). Read only; never throws.
 */
export function readLaunchConfigs(cwd) {
  let text;
  try { text = readFileSync(launchJsonPath(cwd), 'utf8'); } catch { return []; }
  let parsed;
  try { parsed = JSON.parse(text.replace(/^﻿/, '')); } catch { return []; }
  const list = parsed && typeof parsed === 'object' ? parsed.configurations : null;
  if (!Array.isArray(list)) return [];
  return list.filter((c) => c && typeof c === 'object' && !Array.isArray(c));
}

/**
 * The configuration named `name` in <cwd>/.claude/launch.json, or null: no file, not JSON,
 * no such entry. Read only; never throws. The first entry with that name wins, as in
 * mergeLaunchEntry.
 */
export function readLaunchEntry(cwd, name) {
  return readLaunchConfigs(cwd).find((c) => c.name === name) || null;
}

/** Merge `entry` into <cwd>/.claude/launch.json on disk. Writes only when something changed. */
export function writeLaunchEntry(cwd, entry) {
  const file = launchJsonPath(cwd);
  const before = existsSync(file) ? readFileSync(file, 'utf8') : null;
  const r = mergeLaunchEntry(before, entry);
  if (!r.ok) return { ...r, file };
  if (r.action !== 'unchanged') {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, r.text);
  }
  return { ok: true, file, action: r.action };
}
