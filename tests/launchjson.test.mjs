// lib/launchjson.mjs: the strict-JSON scanner and the byte-preserving merge of one entry into
// .claude/launch.json. The contract under test: adding or updating one entry leaves every
// byte outside the touched entry exactly as it was, and a file that is not strict JSON is
// never rewritten.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { lib, tempDir } from './helpers.mjs';

const { scanJson, mergeLaunchEntry, writeLaunchEntry, launchJsonPath } = await import(lib('launchjson.mjs'));

// ---------------------------------------------------------------------------------------
// Fixtures and helpers
// ---------------------------------------------------------------------------------------

const BOM = '\uFEFF';
const deepFreeze = (o) => {
  if (o && typeof o === 'object') {
    for (const v of Object.values(o)) deepFreeze(v);
    Object.freeze(o);
  }
  return o;
};

const WEB = deepFreeze({ name: 'web', runtimeExecutable: 'npm', runtimeArgs: ['run', 'dev'], port: 3000 });
const API = deepFreeze({ name: 'api', runtimeExecutable: 'node', runtimeArgs: ['server.js'], port: 8080 });
const DB = deepFreeze({ name: 'db', runtimeExecutable: 'docker', runtimeArgs: ['compose', 'up'], port: 5432 });
// What show-local writes (see open.mjs planServer): name, runtimeExecutable, runtimeArgs, port.
const ENTRY = deepFreeze({ name: 'show-site', runtimeExecutable: 'node', runtimeArgs: ['serve', '--port', '4401'], port: 4401 });
// Same shape with a Windows path, so escaped backslashes flow through the formatter too.
const WIN_ENTRY = deepFreeze({
  name: 'show-win',
  runtimeExecutable: 'node',
  runtimeArgs: ['C:\\Users\\me\\show-local\\scripts\\show.mjs', 'serve', 'C:\\site dir\\', '--port', '4402'],
  port: 4402,
});
const BASE = deepFreeze({ version: '0.0.1', configurations: [WEB, API] });

/** A file as JSON.stringify would lay it out, with a chosen indent unit, EOL and BOM. */
const pretty = (obj, unit = '  ', eol = '\n', bom = false) =>
  (bom ? BOM : '') + JSON.stringify(obj, null, unit).split('\n').join(eol) + eol;
/** One value formatted with `unit`, its continuation lines prefixed with `indent`. */
const block = (obj, unit, indent, eol = '\n') => JSON.stringify(obj, null, unit).split('\n').join(eol + indent);
const stripBom = (s) => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);
const parse = (s) => JSON.parse(stripBom(s));
const noBareLf = (s) => !/(^|[^\r])\n/.test(s);
const reEscape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Longest common prefix / suffix of a and b (non-overlapping); what changed lies between. */
function diffSpan(a, b) {
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  return { start: p, endA: a.length - s, endB: b.length - s };
}

/** Assert `result` is `original` with only [start, end) replaced; return the replacement. */
function assertOnlyRangeChanged(original, result, start, end) {
  const before = original.slice(0, start);
  const after = original.slice(end);
  assert.ok(result.length >= before.length + after.length, 'result is shorter than the untouched bytes');
  assert.equal(result.slice(0, start), before, 'bytes before the touched range changed');
  assert.equal(result.slice(result.length - after.length), after, 'bytes after the touched range changed');
  return result.slice(start, result.length - after.length);
}

/** Assert `result` is `original` with something inserted at exactly one point; return it. */
function assertPureInsertion(original, result, at) {
  const inserted = assertOnlyRangeChanged(original, result, at, at);
  assert.ok(inserted.length > 0, 'nothing was inserted');
  return inserted;
}

/**
 * Every continuation line of `text` must be indented with whole `unit`s only. The last piece may
 * be indentation alone (it sits before an original "]" or "}" that follows the insertion).
 */
function assertIndentUnit(text, unit, eol) {
  const lines = text.split(eol).slice(1);
  const re = new RegExp(`^(?:${reEscape(unit)})*(?:\\S|$)`);
  for (const line of lines) assert.match(line, re, `line not indented in whole ${JSON.stringify(unit)} units: ${JSON.stringify(line)}`);
}

/** Byte span of an element inside `text`, located by its exact source text (must be unique). */
function spanOf(text, source) {
  const start = text.indexOf(source);
  assert.ok(start >= 0, `fixture does not contain ${JSON.stringify(source)}`);
  assert.equal(text.indexOf(source, start + 1), -1, 'fixture span is not unique');
  return { start, end: start + source.length };
}

const PAST = new Date('2020-01-01T00:00:00Z');

// ---------------------------------------------------------------------------------------
// scanJson
// ---------------------------------------------------------------------------------------

test('scanJson: records start/end offsets that slice back to every value', () => {
  const text = '{\n  "a": [1, -2.5e+3, "x", true, false, null],\n  "b": {"c": {}, "d": []},\n  "e": "s"\n}';
  const root = scanJson(text);
  assert.equal(root.type, 'object');
  assert.equal(root.start, 0);
  assert.equal(root.end, text.length);
  assert.deepEqual(root.members.map((m) => m.key), ['a', 'b', 'e']);

  const [a, b, e] = root.members;
  assert.equal(a.node.type, 'array');
  assert.equal(text.slice(a.node.start, a.node.end), '[1, -2.5e+3, "x", true, false, null]');
  assert.deepEqual(
    a.node.elements.map((el) => text.slice(el.start, el.end)),
    ['1', '-2.5e+3', '"x"', 'true', 'false', 'null'],
  );
  assert.deepEqual(a.node.elements.map((el) => el.type), ['literal', 'literal', 'string', 'literal', 'literal', 'literal']);

  assert.equal(b.node.type, 'object');
  assert.equal(text.slice(b.node.start, b.node.end), '{"c": {}, "d": []}');
  const [c, d] = b.node.members;
  assert.equal(c.node.type, 'object');
  assert.deepEqual(c.node.members, []);
  assert.equal(text.slice(c.node.start, c.node.end), '{}');
  assert.equal(d.node.type, 'array');
  assert.deepEqual(d.node.elements, []);
  assert.equal(text.slice(d.node.start, d.node.end), '[]');

  assert.equal(e.node.type, 'string');
  assert.equal(e.node.value, 's');
  assert.equal(text.slice(e.node.start, e.node.end), '"s"');
});

test('scanJson: keyStart points at the opening quote of each key', () => {
  const text = '{ "alpha" : 1,\t"beta":{"gamma" :2} }';
  const root = scanJson(text);
  const [alpha, beta] = root.members;
  assert.equal(alpha.keyStart, text.indexOf('"alpha"'));
  assert.equal(beta.keyStart, text.indexOf('"beta"'));
  assert.equal(beta.node.members[0].keyStart, text.indexOf('"gamma"'));
});

test('scanJson: string nodes decode escapes, including in keys', () => {
  const text = String.raw`{"config\u0075rations": "a\"b\\c\/d\u00e9\n\t", "k": "\ud83d\ude00"}`;
  const root = scanJson(text);
  assert.equal(root.members[0].key, 'configurations');
  assert.equal(root.members[0].node.value, 'a"b\\c/d\u00e9\n\t');
  assert.equal(root.members[1].node.value, '\u{1F600}');
});

test('scanJson: skips a leading BOM and surrounding whitespace', () => {
  const text = `${BOM} \r\n\t{"a": 1} \r\n`;
  const root = scanJson(text);
  assert.equal(root.start, text.indexOf('{'));
  assert.equal(root.end, text.indexOf('}') + 1);
  assert.equal(text.slice(root.start, root.end), '{"a": 1}');
});

test('scanJson: accepts every JSON root kind and number form JSON.parse accepts', () => {
  const ok = ['0', '-0', '12', '-1.5', '1e5', '1E+5', '-1.5e-3', '0.0', 'true', 'false', 'null',
    '""', '"\\u00e9"', '[]', '{}', ' \t\r\n{} \r\n', '[[[]]]', '{"":""}', '[1,{"a":[2,{"b":null}]},"]"]'];
  for (const text of ok) {
    assert.doesNotThrow(() => JSON.parse(text), `fixture must be valid JSON: ${text}`);
    const root = scanJson(text);
    assert.equal(text.slice(root.start, root.end), text.trim(), `root span for ${JSON.stringify(text)}`);
  }
});

test('scanJson: brackets, braces, commas, colons and escaped quotes inside strings do not confuse it', () => {
  const text = String.raw`{"s": "] } [ { , : \" \\", "t": ["}]", "\"]\"", "\\\\"], "u": "\u005d\u007d", "v": 1}`;
  const root = scanJson(text);
  assert.deepEqual(root.members.map((m) => m.key), ['s', 't', 'u', 'v']);
  assert.equal(root.members[0].node.value, '] } [ { , : " \\');
  assert.deepEqual(root.members[1].node.elements.map((el) => el.value), ['}]', '"]"', '\\\\']);
  assert.equal(root.members[2].node.value, ']}');
  assert.equal(text.slice(root.members[3].node.start, root.members[3].node.end), '1');
  assert.equal(root.end, text.length);
});

test('scanJson: agrees with JSON.parse on round-tripped, deeply nested data', () => {
  const data = { list: [], deep: {} };
  let cur = data.deep;
  for (let k = 0; k < 60; k++) { cur.next = { k, arr: [k, `s${k}]`, { x: '{' }] }; cur = cur.next; }
  data.list.push(data.deep, 'tail');
  for (const unit of [undefined, 2, 4, '\t']) {
    const text = JSON.stringify(data, null, unit);
    const root = scanJson(text);
    assert.equal(root.start, 0);
    assert.equal(root.end, text.length);
    assert.deepEqual(root.members.map((m) => m.key), ['list', 'deep']);
  }
});

test('scanJson: rejects everything that is not strict JSON with a SyntaxError', async (t) => {
  const bad = {
    'empty text': '',
    'whitespace only': ' \n\t ',
    'BOM only': BOM,
    'line comment': '// launch config\n{}',
    'trailing line comment': '{} // done',
    'block comment': '/* c */ {}',
    'comment inside object': '{"a": 1 /* c */}',
    'trailing comma in object': '{"a": 1,}',
    'trailing comma in array': '{"a": [1, 2,]}',
    'leading comma': '[,1]',
    'double comma': '[1,,2]',
    'missing comma in array': '[1 2]',
    'missing comma in object': '{"a": 1 "b": 2}',
    'missing colon': '{"a" 1}',
    'single-quoted string': "{'a': 1}",
    'unquoted key': '{a: 1}',
    'numeric key': '{1: 1}',
    'leading zero': '{"a": 01}',
    'bare fraction': '{"a": .5}',
    'trailing dot': '{"a": 1.}',
    'plus sign': '{"a": +1}',
    'hex number': '{"a": 0x10}',
    'NaN': 'NaN',
    'Infinity': '[Infinity]',
    'undefined': '{"a": undefined}',
    'truncated literal': '[tru]',
    'literal with suffix': '[truex]',
    'capitalised literal': '[True]',
    'unterminated string': '{"a": "abc}',
    'unterminated object': '{"a": 1',
    'unterminated array': '[1, 2',
    'raw newline in string': '["a\nb"]',
    'raw tab in string': '["a\tb"]',
    'invalid escape': String.raw`["\x41"]`,
    'short unicode escape': String.raw`["\u12"]`,
    'trailing content': '{} x',
    'two roots': '{}{}',
    'second root after newline': '{"a":1}\n{"b":2}',
    'BOM in the middle': `{}${BOM}`,
    'non-JSON whitespace (NBSP)': '\u00a0{}',
  };
  for (const [label, text] of Object.entries(bad)) {
    await t.test(label, () => {
      assert.throws(() => JSON.parse(stripBom(text)), 'fixture must be invalid for JSON.parse too');
      assert.throws(() => scanJson(text), SyntaxError);
    });
  }
});

test('scanJson: its own errors name the offset', () => {
  assert.throws(() => scanJson('{"a": 1,}'), (e) => e instanceof SyntaxError && /offset \d+/.test(e.message));
  assert.throws(() => scanJson('{} x'), /trailing/);
});

// ---------------------------------------------------------------------------------------
// mergeLaunchEntry: creating a file
// ---------------------------------------------------------------------------------------

test('merge: null text creates a file with version 0.0.1 and the one entry', () => {
  const r = mergeLaunchEntry(null, ENTRY);
  assert.equal(r.ok, true);
  assert.equal(r.action, 'created');
  assert.equal(r.text, [
    '{',
    '  "version": "0.0.1",',
    '  "configurations": [',
    '    {',
    '      "name": "show-site",',
    '      "runtimeExecutable": "node",',
    '      "runtimeArgs": [',
    '        "serve",',
    '        "--port",',
    '        "4401"',
    '      ],',
    '      "port": 4401',
    '    }',
    '  ]',
    '}',
    '',
  ].join('\n'));
  assert.deepEqual(JSON.parse(r.text), { version: '0.0.1', configurations: [ENTRY] });
});

test('merge: undefined, empty and whitespace-only text are all treated as a new file', () => {
  for (const text of [undefined, '', ' ', '\n', '\r\n', ' \t\r\n  ']) {
    const r = mergeLaunchEntry(text, WIN_ENTRY);
    assert.equal(r.ok, true, `ok for ${JSON.stringify(text)}`);
    assert.equal(r.action, 'created', `created for ${JSON.stringify(text)}`);
    assert.equal(r.text, `${JSON.stringify({ version: '0.0.1', configurations: [WIN_ENTRY] }, null, 2)}\n`);
  }
});

test('merge: a BOM-only file counts as empty and is created afresh', () => {
  const r = mergeLaunchEntry(BOM, ENTRY);
  assert.equal(r.ok, true);
  assert.equal(r.action, 'created');
  assert.deepEqual(parse(r.text), { version: '0.0.1', configurations: [ENTRY] });
});

test('merge: never mutates the entry it is given (entry is deep-frozen)', () => {
  const entry = deepFreeze({ name: 'frozen', runtimeExecutable: 'node', runtimeArgs: ['a'], port: 1, env: { A: '1' } });
  const snapshot = JSON.stringify(entry);
  for (const text of [null, pretty(BASE), pretty({ version: '0.0.1', configurations: [{ ...entry, port: 2 }] })]) {
    const r = mergeLaunchEntry(text, entry);
    assert.equal(r.ok, true);
  }
  assert.equal(JSON.stringify(entry), snapshot);
});

// ---------------------------------------------------------------------------------------
// mergeLaunchEntry: adding to an existing configurations array
// ---------------------------------------------------------------------------------------

test('merge: adds to a 2-space file; exact insertion, every other byte identical', () => {
  const original = pretty(BASE, '  ');
  const at = original.length - '\n  ]\n}\n'.length; // just after the last element's "}"
  const r = mergeLaunchEntry(original, ENTRY);
  assert.equal(r.ok, true);
  assert.equal(r.action, 'added');
  const inserted = assertPureInsertion(original, r.text, at);
  assert.equal(inserted, [
    ',',
    '    {',
    '      "name": "show-site",',
    '      "runtimeExecutable": "node",',
    '      "runtimeArgs": [',
    '        "serve",',
    '        "--port",',
    '        "4401"',
    '      ],',
    '      "port": 4401',
    '    }',
  ].join('\n'));
  assert.deepEqual(JSON.parse(r.text), { version: '0.0.1', configurations: [WEB, API, ENTRY] });
});

test('merge: adds to a 4-space file using 4-space indentation', () => {
  const original = pretty(BASE, '    ');
  const at = original.length - '\n    ]\n}\n'.length;
  const r = mergeLaunchEntry(original, WIN_ENTRY);
  assert.equal(r.ok, true);
  assert.equal(r.action, 'added');
  const inserted = assertPureInsertion(original, r.text, at);
  assert.equal(inserted, `,\n        ${block(WIN_ENTRY, '    ', '        ')}`);
  assertIndentUnit(inserted, '    ', '\n');
  assert.deepEqual(JSON.parse(r.text), { version: '0.0.1', configurations: [WEB, API, WIN_ENTRY] });
});

test('merge: adds to a tab-indented file using tabs', () => {
  const original = pretty(BASE, '\t');
  const at = original.length - '\n\t]\n}\n'.length;
  const r = mergeLaunchEntry(original, ENTRY);
  assert.equal(r.ok, true);
  assert.equal(r.action, 'added');
  const inserted = assertPureInsertion(original, r.text, at);
  assert.equal(inserted, `,\n\t\t${block(ENTRY, '\t', '\t\t')}`);
  assert.ok(!/\n +/.test(inserted), 'no space indentation in a tab file');
  assertIndentUnit(inserted, '\t', '\n');
  assert.deepEqual(JSON.parse(r.text), { version: '0.0.1', configurations: [WEB, API, ENTRY] });
});

test('merge: adds after the last of many entries and keeps members that follow the array', () => {
  const doc = { $schema: 'x', version: '0.0.1', configurations: [WEB, API, DB], extra: { keep: [1, 2, { deep: true }] }, tail: 'end' };
  const original = pretty(doc, '  ');
  const dbSource = `    ${block(DB, '  ', '    ')}`;
  const { end } = spanOf(original, dbSource);
  const r = mergeLaunchEntry(original, ENTRY);
  assert.equal(r.action, 'added');
  assertPureInsertion(original, r.text, end);
  assert.deepEqual(JSON.parse(r.text), { ...doc, configurations: [WEB, API, DB, ENTRY] });
});

test('merge: blank lines and odd spacing before "]" survive an add', () => {
  const original = '{\n  "version": "0.0.1",\n  "configurations": [\n    {"name": "web", "port": 3000}   \n\n\n  ]  ,\n  "x": 1\n}\n';
  const at = original.indexOf('3000}') + '3000}'.length;
  const r = mergeLaunchEntry(original, ENTRY);
  assert.equal(r.action, 'added');
  assertPureInsertion(original, r.text, at);
  assert.deepEqual(JSON.parse(r.text), { version: '0.0.1', configurations: [{ name: 'web', port: 3000 }, ENTRY], x: 1 });
});

test('merge: uses the root-level "configurations", never one nested deeper', () => {
  const doc = { meta: { configurations: [{ name: 'show-site', port: 1 }] }, version: '0.0.1', configurations: [WEB] };
  const original = pretty(doc);
  const r = mergeLaunchEntry(original, ENTRY);
  assert.equal(r.ok, true);
  assert.equal(r.action, 'added', 'the nested same-name object is not a launch entry');
  const parsed = JSON.parse(r.text);
  assert.deepEqual(parsed.meta, doc.meta);
  assert.deepEqual(parsed.configurations, [WEB, ENTRY]);
});

test('merge: name matching is exact and case-sensitive', () => {
  const original = pretty({ version: '0.0.1', configurations: [{ name: 'Show-Site', port: 1 }, { name: 'show-site ', port: 2 }] });
  const r = mergeLaunchEntry(original, ENTRY);
  assert.equal(r.action, 'added');
  assert.equal(JSON.parse(r.text).configurations.length, 3);
});

test('merge: non-object elements in configurations are tolerated and indexes stay aligned', () => {
  const original = '{\n  "configurations": [\n    1,\n    "web",\n    null,\n    [],\n    {"name": "api", "port": 1}\n  ]\n}\n';
  const added = mergeLaunchEntry(original, ENTRY);
  assert.equal(added.action, 'added');
  assert.deepEqual(JSON.parse(added.text).configurations, [1, 'web', null, [], { name: 'api', port: 1 }, ENTRY]);

  const next = { name: 'api', port: 2 };
  const updated = mergeLaunchEntry(original, next);
  assert.equal(updated.action, 'updated');
  const span = spanOf(original, '{"name": "api", "port": 1}');
  assertOnlyRangeChanged(original, updated.text, span.start, span.end);
  assert.deepEqual(JSON.parse(updated.text).configurations, [1, 'web', null, [], next]);
});

// ---------------------------------------------------------------------------------------
// mergeLaunchEntry: inline arrays
// ---------------------------------------------------------------------------------------

test('merge: a one-line file stays one line when adding', () => {
  const original = '{"version":"0.0.1","configurations":[{"name":"web","port":3000}]}';
  const r = mergeLaunchEntry(original, WIN_ENTRY);
  assert.equal(r.action, 'added');
  assert.equal(r.text, `{"version":"0.0.1","configurations":[{"name":"web","port":3000}, ${JSON.stringify(WIN_ENTRY)}]}`);
  assert.ok(!r.text.includes('\n'));
  assert.deepEqual(JSON.parse(r.text).configurations, [{ name: 'web', port: 3000 }, WIN_ENTRY]);
});

test('merge: an inline array inside a multi-line file stays on its line when adding', () => {
  const line = '  "configurations": [{"name": "web", "port": 3000}, {"name": "api", "port": 8080}]';
  const original = `{\n  "version": "0.0.1",\n${line}\n}\n`;
  const at = original.indexOf('8080}') + '8080}'.length;
  const r = mergeLaunchEntry(original, ENTRY);
  assert.equal(r.action, 'added');
  const inserted = assertPureInsertion(original, r.text, at);
  assert.equal(inserted, `, ${JSON.stringify(ENTRY)}`);
  assert.equal(r.text.split('\n').length, original.split('\n').length, 'no line added');
});

test('merge: several compact entries sharing one line — a new one joins that line', () => {
  const original = '{\n  "configurations": [\n    {"name": "a"}, {"name": "b"}\n  ]\n}\n';
  const at = original.indexOf('{"name": "b"}') + '{"name": "b"}'.length;
  const r = mergeLaunchEntry(original, ENTRY);
  assert.equal(r.action, 'added');
  assertPureInsertion(original, r.text, at);
  assert.deepEqual(JSON.parse(r.text).configurations, [{ name: 'a' }, { name: 'b' }, ENTRY]);
});

test('merge: updating an entry in an inline one-line array keeps the array inline', () => {
  const line = '  "configurations": [{"name": "a", "port": 1}, {"name": "b", "port": 2}]';
  const original = `{\n  "version": "0.0.1",\n${line}\n}\n`;
  const span = spanOf(original, '{"name": "b", "port": 2}');
  const next = { name: 'b', port: 3 };
  const r = mergeLaunchEntry(original, next);
  assert.equal(r.ok, true);
  assert.equal(r.action, 'updated');
  const replacement = assertOnlyRangeChanged(original, r.text, span.start, span.end);
  assert.deepEqual(JSON.parse(replacement), next);
  assert.ok(!replacement.includes('\n'), `inline entry was expanded over several lines: ${JSON.stringify(replacement)}`);
  assert.equal(r.text.split('\n').length, original.split('\n').length, 'the one-line array must stay one line');
});

// ---------------------------------------------------------------------------------------
// mergeLaunchEntry: empty configurations array
// ---------------------------------------------------------------------------------------

test('merge: fills an empty "configurations": [] (2-space) with exact layout', () => {
  const original = pretty({ version: '0.0.1', configurations: [] });
  const at = original.indexOf('[]') + 1;
  const r = mergeLaunchEntry(original, ENTRY);
  assert.equal(r.ok, true);
  assert.equal(r.action, 'added');
  const inserted = assertPureInsertion(original, r.text, at);
  assert.equal(inserted, `\n    ${block(ENTRY, '  ', '    ')}\n  `);
  assert.equal(r.text, pretty({ version: '0.0.1', configurations: [ENTRY] }), 'reads exactly like a freshly written file');
});

test('merge: fills an empty array whose brackets hold whitespace; only the inside changes', async (t) => {
  const cases = {
    'space inside': '{\n  "version": "0.0.1",\n  "configurations": [ ],\n  "after": true\n}\n',
    'newline inside': '{\n  "version": "0.0.1",\n  "configurations": [\n  ],\n  "after": true\n}\n',
    'tab file': '{\n\t"version": "0.0.1",\n\t"configurations": [\n\t],\n\t"after": true\n}\n',
    'inline empty array': '{"version": "0.0.1", "configurations": [], "after": true}',
  };
  for (const [label, original] of Object.entries(cases)) {
    await t.test(label, () => {
      const open = original.indexOf('[') + 1;
      const close = original.indexOf(']');
      const r = mergeLaunchEntry(original, ENTRY);
      assert.equal(r.ok, true);
      assert.equal(r.action, 'added');
      assertOnlyRangeChanged(original, r.text, open, close);
      assert.deepEqual(JSON.parse(r.text), { version: '0.0.1', configurations: [ENTRY], after: true });
    });
  }
});

test('merge: an empty array in a tab file is filled with tab indentation', () => {
  const original = '{\n\t"version": "0.0.1",\n\t"configurations": []\n}\n';
  const r = mergeLaunchEntry(original, ENTRY);
  const at = original.indexOf('[]') + 1;
  const inserted = assertPureInsertion(original, r.text, at);
  assert.equal(inserted, `\n\t\t${block(ENTRY, '\t', '\t\t')}\n\t`);
});

// ---------------------------------------------------------------------------------------
// mergeLaunchEntry: no configurations key
// ---------------------------------------------------------------------------------------

test('merge: adds a "configurations" member after the last member (2-space), exact text', () => {
  const doc = { version: '0.0.1', other: { a: 1 } };
  const original = pretty(doc);
  const at = original.length - '\n}\n'.length;
  const r = mergeLaunchEntry(original, ENTRY);
  assert.equal(r.ok, true);
  assert.equal(r.action, 'added');
  const inserted = assertPureInsertion(original, r.text, at);
  assert.equal(inserted, `,\n  "configurations": [\n    ${block(ENTRY, '  ', '    ')}\n  ]`);
  assert.deepEqual(JSON.parse(r.text), { ...doc, configurations: [ENTRY] });
});

test('merge: adds a "configurations" member in a 4-space file with 4-space layout', () => {
  const doc = { version: '0.0.1', nested: { list: [1, { x: '}' }] } };
  const original = pretty(doc, '    ');
  const at = original.length - '\n}\n'.length;
  const r = mergeLaunchEntry(original, ENTRY);
  const inserted = assertPureInsertion(original, r.text, at);
  assert.equal(inserted, `,\n    "configurations": [\n        ${block(ENTRY, '    ', '        ')}\n    ]`);
  assert.deepEqual(JSON.parse(r.text), { ...doc, configurations: [ENTRY] });
});

test('merge: a one-line root without configurations gains the member without touching the rest', () => {
  const original = '{"version": "0.0.1"}';
  const r = mergeLaunchEntry(original, ENTRY);
  assert.equal(r.action, 'added');
  assertPureInsertion(original, r.text, original.indexOf('"0.0.1"') + '"0.0.1"'.length);
  assert.deepEqual(JSON.parse(r.text), { version: '0.0.1', configurations: [ENTRY] });
});

test('merge: nested "configurations" keys do not count as the root member', () => {
  const doc = { settings: { configurations: [] } };
  const original = pretty(doc);
  const r = mergeLaunchEntry(original, ENTRY);
  assert.equal(r.action, 'added');
  assertPureInsertion(original, r.text, original.length - '\n}\n'.length);
  assert.deepEqual(JSON.parse(r.text), { settings: { configurations: [] }, configurations: [ENTRY] });
});

test('merge: an empty root object gets a "configurations" member; bytes outside the braces are kept', async (t) => {
  const cases = { '{}': '{}', '{}\\n': '{}\n', '{ }': '{ }', '{\\n}\\n': '{\n}\n', 'padded': '  \n{\n\n}\n\n' };
  for (const [label, original] of Object.entries(cases)) {
    await t.test(label, () => {
      const r = mergeLaunchEntry(original, ENTRY);
      assert.equal(r.ok, true);
      assert.equal(r.action, 'added');
      assertOnlyRangeChanged(original, r.text, original.indexOf('{') + 1, original.lastIndexOf('}'));
      assert.deepEqual(JSON.parse(r.text), { configurations: [ENTRY] });
    });
  }
});

// ---------------------------------------------------------------------------------------
// mergeLaunchEntry: same-name entry already present
// ---------------------------------------------------------------------------------------

test('merge: an identical same-name entry is "unchanged" and the text is returned as is', () => {
  const original = pretty({ version: '0.0.1', configurations: [WEB, ENTRY, API] });
  const r = mergeLaunchEntry(original, ENTRY);
  assert.equal(r.ok, true);
  assert.equal(r.action, 'unchanged');
  assert.equal(r.text, original);
});

test('merge: "unchanged" ignores key order and formatting of the existing entry', () => {
  const original = '{"configurations":[ { "port" : 4401 , "runtimeArgs":["serve","--port","4401"],\n "runtimeExecutable":"node", "name":"show-site" } ] }';
  const r = mergeLaunchEntry(original, ENTRY);
  assert.equal(r.action, 'unchanged');
  assert.equal(r.text, original);
});

test('merge: "unchanged" compares values, not spellings (4401.0, 4.401e3, \\u escapes)', () => {
  const original = String.raw`{"configurations": [{"name": "show-\u0073ite", "runtimeExecutable": "n\u006fde", "runtimeArgs": ["serve", "--port", "4401"], "port": 4.401e3}]}`;
  const r = mergeLaunchEntry(original, ENTRY);
  assert.equal(r.action, 'unchanged');
  assert.equal(r.text, original);
});

test('merge: a different same-name entry is "updated"; only that entry\'s bytes change (2-space, exact)', () => {
  const original = pretty({ version: '0.0.1', configurations: [WEB, API, DB] });
  const { start, end } = spanOf(original, block(API, '  ', '    '));
  const next = { ...API, runtimeArgs: ['server.js', '--inspect'], port: 9090 };
  const r = mergeLaunchEntry(original, next);
  assert.equal(r.ok, true);
  assert.equal(r.action, 'updated');
  const replacement = assertOnlyRangeChanged(original, r.text, start, end);
  assert.equal(replacement, block(next, '  ', '    '));
  assert.equal(r.text, original.slice(0, start) + block(next, '  ', '    ') + original.slice(end));
  assert.deepEqual(JSON.parse(r.text).configurations, [WEB, next, DB]);
});

test('merge: updating the first and the last entries touches only their spans', () => {
  const original = pretty({ version: '0.0.1', configurations: [WEB, API, DB] }, '    ');
  for (const [old, next] of [[WEB, { ...WEB, port: 3001 }], [DB, { ...DB, port: 5433 }]]) {
    const { start, end } = spanOf(original, block(old, '    ', '        '));
    const r = mergeLaunchEntry(original, next);
    assert.equal(r.action, 'updated');
    const replacement = assertOnlyRangeChanged(original, r.text, start, end);
    assert.equal(replacement, block(next, '    ', '        '));
  }
});

test('merge: an update replaces the whole entry (keys missing from the new entry are dropped)', () => {
  const old = { name: 'show-site', runtimeExecutable: 'node', runtimeArgs: ['old'], port: 4401, env: { A: '1' } };
  const original = pretty({ version: '0.0.1', configurations: [WEB, old] });
  const r = mergeLaunchEntry(original, ENTRY);
  assert.equal(r.action, 'updated');
  assert.deepEqual(JSON.parse(r.text).configurations, [WEB, ENTRY]);
});

test('merge: a change of array order alone counts as a change', () => {
  const original = pretty({ configurations: [{ ...ENTRY, runtimeArgs: ['--port', '4401', 'serve'] }] });
  const r = mergeLaunchEntry(original, ENTRY);
  assert.equal(r.action, 'updated');
  assert.deepEqual(JSON.parse(r.text).configurations, [ENTRY]);
});

test('merge: with duplicate names, the first is updated and the second left byte-identical', () => {
  const first = { name: 'show-site', port: 1 };
  const second = { name: 'show-site', port: 2 };
  const original = pretty({ configurations: [first, WEB, second] });
  const firstSpan = spanOf(original, block(first, '  ', '    '));
  const r = mergeLaunchEntry(original, ENTRY);
  assert.equal(r.action, 'updated');
  assertOnlyRangeChanged(original, r.text, firstSpan.start, firstSpan.end);
  assert.deepEqual(JSON.parse(r.text).configurations, [ENTRY, WEB, second]);
});

test('merge: an update keeps the element\'s own indentation in tab files', () => {
  const original = pretty({ version: '0.0.1', configurations: [WEB, API] }, '\t');
  const { start, end } = spanOf(original, block(WEB, '\t', '\t\t'));
  const next = { ...WEB, port: 1234 };
  const r = mergeLaunchEntry(original, next);
  assert.equal(r.action, 'updated');
  assert.equal(assertOnlyRangeChanged(original, r.text, start, end), block(next, '\t', '\t\t'));
});

// ---------------------------------------------------------------------------------------
// mergeLaunchEntry: line endings and BOM
// ---------------------------------------------------------------------------------------

test('merge: CRLF files keep CRLF on add, update, empty array and missing key', async (t) => {
  const shapes = {
    add: pretty(BASE, '  ', '\r\n'),
    update: pretty({ version: '0.0.1', configurations: [WEB, { ...ENTRY, port: 1 }] }, '  ', '\r\n'),
    'empty array': pretty({ version: '0.0.1', configurations: [] }, '  ', '\r\n'),
    'missing key': pretty({ version: '0.0.1' }, '  ', '\r\n'),
    'empty root, CRLF after it': '{}\r\n\r\n',
  };
  for (const [label, original] of Object.entries(shapes)) {
    await t.test(label, () => {
      assert.ok(noBareLf(original), 'fixture is CRLF');
      const r = mergeLaunchEntry(original, WIN_ENTRY);
      assert.equal(r.ok, true);
      assert.ok(noBareLf(r.text), `bare LF in result: ${JSON.stringify(r.text)}`);
      assert.ok(parse(r.text).configurations.some((c) => JSON.stringify(c) === JSON.stringify(WIN_ENTRY)));
    });
  }
});

test('merge: CRLF add is a pure insertion with CRLF-joined lines', () => {
  const original = pretty(BASE, '  ', '\r\n');
  const at = original.length - '\r\n  ]\r\n}\r\n'.length;
  const r = mergeLaunchEntry(original, ENTRY);
  const inserted = assertPureInsertion(original, r.text, at);
  assert.equal(inserted, `,\r\n    ${block(ENTRY, '  ', '    ', '\r\n')}`);
});

test('merge: CRLF update replaces only the element, joined with CRLF', () => {
  const original = pretty({ version: '0.0.1', configurations: [WEB, API] }, '    ', '\r\n');
  const { start, end } = spanOf(original, block(API, '    ', '        ', '\r\n'));
  const next = { ...API, port: 1 };
  const r = mergeLaunchEntry(original, next);
  assert.equal(r.action, 'updated');
  assert.equal(assertOnlyRangeChanged(original, r.text, start, end), block(next, '    ', '        ', '\r\n'));
  assert.ok(noBareLf(r.text));
});

test('merge: a BOM is preserved on add, update, empty array and missing key', async (t) => {
  const shapes = {
    add: pretty(BASE, '  ', '\n', true),
    update: pretty({ version: '0.0.1', configurations: [{ ...ENTRY, port: 1 }, WEB] }, '  ', '\n', true),
    'empty array': pretty({ version: '0.0.1', configurations: [] }, '  ', '\n', true),
    'missing key': pretty({ version: '0.0.1' }, '  ', '\n', true),
    'empty root': `${BOM}{}`,
    'one line': `${BOM}{"configurations":[{"name":"web"}]}`,
  };
  for (const [label, original] of Object.entries(shapes)) {
    await t.test(label, () => {
      const r = mergeLaunchEntry(original, ENTRY);
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.equal(r.text.charCodeAt(0), 0xfeff, 'BOM kept as the first character');
      assert.equal(r.text.indexOf(BOM, 1), -1, 'no second BOM');
      assert.ok(parse(r.text).configurations.some((c) => c.name === ENTRY.name && c.port === ENTRY.port));
    });
  }
});

test('merge: an identical entry in a BOM + CRLF file is "unchanged" with the exact same text', () => {
  const original = pretty({ version: '0.0.1', configurations: [ENTRY] }, '\t', '\r\n', true);
  const r = mergeLaunchEntry(original, ENTRY);
  assert.equal(r.action, 'unchanged');
  assert.equal(r.text, original);
});

// ---------------------------------------------------------------------------------------
// mergeLaunchEntry: the byte-preservation contract across a matrix of layouts
// ---------------------------------------------------------------------------------------

test('merge: contract matrix — indent x EOL x BOM x shape, add is a pure insertion', async (t) => {
  const units = { '2sp': '  ', '4sp': '    ', tab: '\t' };
  const eols = { LF: '\n', CRLF: '\r\n' };
  const shapes = {
    'existing entries': { doc: { version: '0.0.1', configurations: [WEB, API], after: { x: [1] } }, expect: (d) => ({ ...d, configurations: [WEB, API, WIN_ENTRY] }) },
    'empty array': { doc: { version: '0.0.1', configurations: [] }, expect: (d) => ({ ...d, configurations: [WIN_ENTRY] }) },
    'missing key': { doc: { version: '0.0.1', other: 'x' }, expect: (d) => ({ ...d, configurations: [WIN_ENTRY] }) },
    'empty root': { doc: {}, expect: () => ({ configurations: [WIN_ENTRY] }) },
  };
  for (const [uName, unit] of Object.entries(units)) {
    for (const [eName, eol] of Object.entries(eols)) {
      for (const bom of [false, true]) {
        for (const [sName, shape] of Object.entries(shapes)) {
          await t.test(`${uName} ${eName} ${bom ? 'BOM' : 'no-BOM'} ${sName}`, () => {
            const original = pretty(shape.doc, unit, eol, bom);
            const r = mergeLaunchEntry(original, WIN_ENTRY);
            assert.equal(r.ok, true);
            assert.equal(r.action, 'added');
            const d = diffSpan(original, r.text);
            assert.equal(d.endA, d.start, 'original bytes must all survive around one insertion point');
            const inserted = r.text.slice(d.start, d.endB);
            assert.deepEqual(parse(r.text), shape.expect(shape.doc));
            if (eol === '\r\n') assert.ok(noBareLf(r.text), 'CRLF kept');
            else assert.ok(!r.text.includes('\r'), 'no CR introduced into an LF file');
            // An empty root has no indentation to learn from; it falls back to two spaces.
            assertIndentUnit(inserted, sName === 'empty root' ? '  ' : unit, eol);
            assert.equal(r.text.startsWith(BOM), bom);
          });
        }
      }
    }
  }
});

test('merge: contract matrix — indent x EOL x BOM, update changes only the target entry', async (t) => {
  for (const unit of ['  ', '    ', '\t']) {
    for (const eol of ['\n', '\r\n']) {
      for (const bom of [false, true]) {
        await t.test(`${JSON.stringify(unit)} ${JSON.stringify(eol)} bom=${bom}`, () => {
          const old = { ...ENTRY, port: 1 };
          const original = pretty({ version: '0.0.1', configurations: [WEB, old, API] }, unit, eol, bom);
          const { start, end } = spanOf(original, block(old, unit, unit + unit, eol));
          const r = mergeLaunchEntry(original, ENTRY);
          assert.equal(r.action, 'updated');
          const d = diffSpan(original, r.text);
          assert.ok(d.start >= start && d.endA <= end, 'changes stay inside the target entry');
          assert.equal(assertOnlyRangeChanged(original, r.text, start, end), block(ENTRY, unit, unit + unit, eol));
          assert.deepEqual(parse(r.text).configurations, [WEB, ENTRY, API]);
          assert.equal(r.text.startsWith(BOM), bom);
          if (eol === '\r\n') assert.ok(noBareLf(r.text));
        });
      }
    }
  }
});

// ---------------------------------------------------------------------------------------
// mergeLaunchEntry: strings that look like structure
// ---------------------------------------------------------------------------------------

const TRICKY = deepFreeze({
  name: 'tricky ] } [ { , :',
  runtimeExecutable: 'C:\\Program Files\\nodejs\\node.exe',
  runtimeArgs: [
    '--eval', 'console.log("}]\\"[{")', 'ends with backslash\\', '"quoted"', '{"configurations": []}',
    '"name": "show-site"', '\u05e9\u05dc\u05d5\u05dd', '\u{1F600}', 'line\u2028sep\u2029', 'tab\tnl\nx', '\u0000\u001f',
  ],
  env: { 'key "with" quotes': '[', '}': ']', '\\': '\\\\' },
  port: 1,
});

test('merge: brackets, braces, escaped quotes and unicode inside other entries do not confuse the scanner', () => {
  const original = pretty({ version: '0.0.1', configurations: [TRICKY, WEB] });
  const at = original.length - '\n  ]\n}\n'.length;
  const r = mergeLaunchEntry(original, ENTRY);
  assert.equal(r.action, 'added', 'the decoy "name": "show-site" string is not an entry');
  assertPureInsertion(original, r.text, at);
  assert.deepEqual(JSON.parse(r.text).configurations, [TRICKY, WEB, ENTRY]);
});

test('merge: the tricky entry itself can be matched, left unchanged, and updated in place', () => {
  const original = pretty({ version: '0.0.1', configurations: [WEB, TRICKY, API] }, '\t', '\r\n');
  const same = mergeLaunchEntry(original, TRICKY);
  assert.equal(same.action, 'unchanged');
  assert.equal(same.text, original);

  const next = { ...TRICKY, port: 2 };
  const { start, end } = spanOf(original, block(TRICKY, '\t', '\t\t', '\r\n'));
  const r = mergeLaunchEntry(original, next);
  assert.equal(r.action, 'updated');
  assert.equal(assertOnlyRangeChanged(original, r.text, start, end), block(next, '\t', '\t\t', '\r\n'));
  assert.deepEqual(JSON.parse(r.text).configurations, [WEB, next, API]);
});

test('merge: hand-written escapes (\\u005d, \\", \\\\, surrogate pairs) in neighbours survive byte for byte', () => {
  const neighbour = String.raw`{"name": "n\u005d\u007d", "runtimeArgs": ["a\"]b", "C:\\dir\\", "\ud83d\ude00", "[{\"x\":1}]"], "port": 7}`;
  const original = `{\n  "version": "0.0.1",\n  "configurations": [\n    ${neighbour}\n  ]\n}\n`;
  const at = original.indexOf(neighbour) + neighbour.length;
  const r = mergeLaunchEntry(original, ENTRY);
  assert.equal(r.action, 'added');
  assertPureInsertion(original, r.text, at);
  assert.ok(r.text.includes(neighbour), 'escapes were not normalised');
  assert.deepEqual(JSON.parse(r.text).configurations, [JSON.parse(neighbour), ENTRY]);
});

test('merge: a new entry full of special characters is written as valid JSON in every layout', () => {
  for (const original of [null, pretty(BASE), pretty(BASE, '\t', '\r\n', true), '{"configurations":[{"name":"web"}]}', '{}']) {
    const r = mergeLaunchEntry(original, TRICKY);
    assert.equal(r.ok, true);
    assert.deepEqual(parse(r.text).configurations.at(-1), TRICKY);
    assert.deepEqual(scanJson(r.text).type, 'object', 'result is strict JSON the scanner accepts');
  }
});

// ---------------------------------------------------------------------------------------
// mergeLaunchEntry: refusing input
// ---------------------------------------------------------------------------------------

test('merge: text that is not strict JSON is refused as invalid-json with no text', async (t) => {
  const bad = {
    'JSONC line comment': '{\n  // preview servers\n  "version": "0.0.1",\n  "configurations": []\n}\n',
    'JSONC block comment': '{\n  /* preview */\n  "configurations": []\n}\n',
    'comment after the last entry': '{"configurations": [{"name": "web"} // web\n]}',
    'trailing comma in configurations': '{\n  "configurations": [\n    {"name": "web"},\n  ]\n}\n',
    'trailing comma in root': '{\n  "version": "0.0.1",\n  "configurations": [],\n}\n',
    'trailing comma inside an entry': '{"configurations": [{"name": "web", "port": 1,}]}',
    'single quotes': "{'configurations': []}",
    'unquoted key': '{configurations: []}',
    'truncated file': '{\n  "version": "0.0.1",\n  "configurations": [\n    {"name": "web"',
    'garbage after root': '{"configurations": []}\n}',
    'two roots': '{}\n{}',
    'raw newline inside a string': '{"configurations": [{"name": "we\nb"}]}',
  };
  for (const [label, text] of Object.entries(bad)) {
    await t.test(label, () => {
      const r = mergeLaunchEntry(text, ENTRY);
      assert.equal(r.ok, false);
      assert.equal(r.error, 'invalid-json');
      assert.equal(typeof r.detail, 'string');
      assert.match(r.detail, /left untouched/);
      assert.equal('text' in r, false, 'no replacement text is offered');
    });
  }
});

test('merge: a root that is not an object is refused as invalid-json', async (t) => {
  for (const text of ['[]', '[{"name": "web"}]', '"configurations"', '42', 'null', 'true', `${BOM}[]`]) {
    await t.test(text, () => {
      const r = mergeLaunchEntry(text, ENTRY);
      assert.equal(r.ok, false);
      assert.equal(r.error, 'invalid-json');
      assert.match(r.detail, /root is not an object/);
    });
  }
});

test('merge: "configurations" that is not an array is refused as invalid-json', async (t) => {
  for (const value of ['{}', '{"name": "show-site"}', '"x"', 'null', '0', 'true']) {
    await t.test(value, () => {
      const r = mergeLaunchEntry(`{\n  "version": "0.0.1",\n  "configurations": ${value}\n}\n`, ENTRY);
      assert.equal(r.ok, false);
      assert.equal(r.error, 'invalid-json');
      assert.match(r.detail, /"configurations" is not an array/);
    });
  }
});

test('merge: an entry without a usable name is refused as bad-entry', async (t) => {
  const bad = {
    undefined, null: null, 'empty object': {}, 'empty name': { name: '', port: 1 }, 'numeric name': { name: 5 },
    'null name': { name: null }, 'object name': { name: { a: 1 } }, 'array entry': [], string: 'show-site', number: 7,
  };
  for (const [label, entry] of Object.entries(bad)) {
    await t.test(label, () => {
      for (const text of [null, pretty(BASE), '// not json']) {
        const r = mergeLaunchEntry(text, entry);
        assert.equal(r.ok, false);
        assert.equal(r.error, 'bad-entry', 'checked before the file is even read');
        assert.match(r.detail, /name/);
        assert.equal('text' in r, false);
      }
    });
  }
});

test('merge: a duplicate root key is refused as invalid-json, never guessed (not even "last one wins")', async (t) => {
  // JSON.parse accepts duplicate keys (last one wins), but which one the desktop app reads is a
  // guess. The documented policy (show-serve SKILL.md) is to leave such a file untouched.
  const cases = {
    'array then null': ['{"configurations": [], "configurations": null}', 'configurations'],
    'empty array then entries': ['{"configurations": [], "configurations": [{"name": "show-site", "port": 1}]}', 'configurations'],
    'two arrays, target in the last': ['{"configurations": [{"name": "keep-me", "port": 1}], "configurations": [{"name": "show-site", "port": 2}]}', 'configurations'],
    'two versions': ['{"version": "0.0.1", "version": "0.0.2", "configurations": []}', 'version'],
  };
  for (const [label, [text, key]] of Object.entries(cases)) {
    await t.test(label, () => {
      let r;
      assert.doesNotThrow(() => { r = mergeLaunchEntry(text, ENTRY); });
      assert.equal(r.ok, false, `a duplicate "${key}" must not be merged into`);
      assert.equal(r.error, 'invalid-json');
      assert.match(r.detail, new RegExp(`"${key}" twice`));
      assert.match(r.detail, /left untouched/);
      assert.equal('text' in r, false, 'no rewritten text is offered');
    });
  }
});

// ---------------------------------------------------------------------------------------
// launchJsonPath / writeLaunchEntry (real temp folders, no windows)
// ---------------------------------------------------------------------------------------

test('launchJsonPath: <cwd>/.claude/launch.json', () => {
  const cwd = path.join('some', 'project');
  assert.equal(launchJsonPath(cwd), path.join('some', 'project', '.claude', 'launch.json'));
});

test('write: creates .claude/ and launch.json when missing, leaving siblings alone', () => {
  const { dir, cleanup } = tempDir();
  try {
    const file = path.join(dir, '.claude', 'launch.json');
    assert.equal(existsSync(path.join(dir, '.claude')), false);
    const r = writeLaunchEntry(dir, ENTRY);
    assert.deepEqual(r, { ok: true, file, action: 'created' });
    assert.equal(readFileSync(file, 'utf8'), `${JSON.stringify({ version: '0.0.1', configurations: [ENTRY] }, null, 2)}\n`);

    const other = path.join(dir, '.claude', 'settings.json');
    writeFileSync(other, '{"keep": true}');
    const again = writeLaunchEntry(dir, WIN_ENTRY);
    assert.equal(again.action, 'added');
    assert.equal(readFileSync(other, 'utf8'), '{"keep": true}');
  } finally {
    cleanup();
  }
});

test('write: creates the whole folder chain when cwd itself does not exist yet', () => {
  const { dir, cleanup } = tempDir();
  try {
    const cwd = path.join(dir, 'a', 'b');
    const r = writeLaunchEntry(cwd, ENTRY);
    assert.equal(r.ok, true);
    assert.equal(r.action, 'created');
    assert.deepEqual(JSON.parse(readFileSync(path.join(cwd, '.claude', 'launch.json'), 'utf8')).configurations, [ENTRY]);
  } finally {
    cleanup();
  }
});

test('write: an existing empty file is filled as a new one', () => {
  const { dir, cleanup } = tempDir();
  try {
    mkdirSync(path.join(dir, '.claude'));
    const file = launchJsonPath(dir);
    writeFileSync(file, '');
    const r = writeLaunchEntry(dir, ENTRY);
    assert.equal(r.action, 'created');
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { version: '0.0.1', configurations: [ENTRY] });
  } finally {
    cleanup();
  }
});

test('write: add and update land on disk exactly as mergeLaunchEntry computes them', () => {
  const { dir, cleanup } = tempDir();
  try {
    mkdirSync(path.join(dir, '.claude'));
    const file = launchJsonPath(dir);
    const original = pretty(BASE, '    ');
    writeFileSync(file, original);

    const added = writeLaunchEntry(dir, ENTRY);
    assert.deepEqual(added, { ok: true, file, action: 'added' });
    const afterAdd = readFileSync(file, 'utf8');
    assert.equal(afterAdd, mergeLaunchEntry(original, ENTRY).text);

    const next = { ...ENTRY, port: 4499 };
    const updated = writeLaunchEntry(dir, next);
    assert.deepEqual(updated, { ok: true, file, action: 'updated' });
    const afterUpdate = readFileSync(file, 'utf8');
    assert.equal(afterUpdate, mergeLaunchEntry(afterAdd, next).text);
    assert.deepEqual(JSON.parse(afterUpdate).configurations, [WEB, API, next]);

    assert.equal(writeLaunchEntry(dir, next).action, 'unchanged', 'idempotent on the second call');
  } finally {
    cleanup();
  }
});

test('write: "unchanged" does not rewrite the file (bytes and mtime untouched)', () => {
  const { dir, cleanup } = tempDir();
  try {
    mkdirSync(path.join(dir, '.claude'));
    const file = launchJsonPath(dir);
    const original = pretty({ version: '0.0.1', configurations: [WEB, ENTRY] }, '\t', '\r\n', true);
    writeFileSync(file, original);
    utimesSync(file, PAST, PAST);
    const before = statSync(file).mtimeMs;
    const bytes = readFileSync(file);

    const r = writeLaunchEntry(dir, { ...ENTRY, runtimeArgs: [...ENTRY.runtimeArgs] });
    assert.deepEqual(r, { ok: true, file, action: 'unchanged' });
    assert.equal(statSync(file).mtimeMs, before, 'file was rewritten');
    assert.ok(readFileSync(file).equals(bytes));
  } finally {
    cleanup();
  }
});

test('write: invalid JSON on disk is reported and the file is left byte-identical', async (t) => {
  const files = {
    jsonc: '{\n  // mine\n  "configurations": [\n    {"name": "web", "port": 3000},\n  ]\n}\n',
    'root array': '[{"name": "web"}]',
    'configurations object': '{"configurations": {"name": "web"}}',
    truncated: '{"configurations": [',
  };
  for (const [label, content] of Object.entries(files)) {
    await t.test(label, () => {
      const { dir, cleanup } = tempDir();
      try {
        mkdirSync(path.join(dir, '.claude'));
        const file = launchJsonPath(dir);
        writeFileSync(file, content);
        utimesSync(file, PAST, PAST);
        const before = statSync(file).mtimeMs;
        const r = writeLaunchEntry(dir, ENTRY);
        assert.equal(r.ok, false);
        assert.equal(r.error, 'invalid-json');
        assert.equal(r.file, file);
        assert.equal(typeof r.detail, 'string');
        assert.equal(readFileSync(file, 'utf8'), content);
        assert.equal(statSync(file).mtimeMs, before, 'invalid file was rewritten');
      } finally {
        cleanup();
      }
    });
  }
});

test('write: a bad entry writes nothing and creates no folder', () => {
  const { dir, cleanup } = tempDir();
  try {
    const r = writeLaunchEntry(dir, { port: 1 });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'bad-entry');
    assert.equal(r.file, launchJsonPath(dir));
    assert.equal(existsSync(path.join(dir, '.claude')), false);
  } finally {
    cleanup();
  }
});

test('write: a UTF-8 BOM and CRLF on disk survive an add, byte for byte outside the new entry', () => {
  const { dir, cleanup } = tempDir();
  try {
    mkdirSync(path.join(dir, '.claude'));
    const file = launchJsonPath(dir);
    const original = pretty(BASE, '  ', '\r\n', true);
    writeFileSync(file, original);
    const r = writeLaunchEntry(dir, ENTRY);
    assert.equal(r.action, 'added');
    const raw = readFileSync(file);
    assert.deepEqual([...raw.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'BOM bytes kept');
    const text = raw.toString('utf8');
    assert.ok(noBareLf(text), 'CRLF kept');
    const at = original.length - '\r\n  ]\r\n}\r\n'.length;
    assertPureInsertion(original, text, at);
    assert.deepEqual(parse(text).configurations, [WEB, API, ENTRY]);
  } finally {
    cleanup();
  }
});

test('write: non-ASCII content on disk round-trips as UTF-8', () => {
  const { dir, cleanup } = tempDir();
  try {
    mkdirSync(path.join(dir, '.claude'));
    const file = launchJsonPath(dir);
    const original = pretty({ version: '0.0.1', configurations: [TRICKY] });
    writeFileSync(file, original, 'utf8');
    const r = writeLaunchEntry(dir, ENTRY);
    assert.equal(r.action, 'added');
    const text = readFileSync(file, 'utf8');
    assertPureInsertion(original, text, original.length - '\n  ]\n}\n'.length);
    assert.deepEqual(JSON.parse(text).configurations, [TRICKY, ENTRY]);
  } finally {
    cleanup();
  }
});

test('write: duplicate "configurations" keys on disk are refused and the file is left byte-for-byte untouched', () => {
  const { dir, cleanup } = tempDir();
  try {
    mkdirSync(path.join(dir, '.claude'));
    const file = launchJsonPath(dir);
    for (const content of [
      '{"configurations": [], "configurations": null}',
      '{"configurations": [{"name": "keep-me", "port": 1}], "configurations": [{"name": "show-site", "port": 2}]}',
    ]) {
      writeFileSync(file, content);
      const mtime = statSync(file).mtimeMs;
      let r;
      assert.doesNotThrow(() => { r = writeLaunchEntry(dir, ENTRY); });
      assert.equal(r.file, file);
      assert.equal(r.ok, false, content);
      assert.equal(r.error, 'invalid-json');
      assert.equal(readFileSync(file, 'utf8'), content, 'refused, so untouched');
      assert.equal(statSync(file).mtimeMs, mtime, 'not even rewritten with the same bytes');
      assert.deepEqual(readdirSync(path.join(dir, '.claude')), ['launch.json'], 'no temp or backup file left behind');
    }
  } finally {
    cleanup();
  }
});
