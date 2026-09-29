// lib/detect.mjs and lib/shortpath.mjs: every mode, the reasons behind "serve" (local data
// included), Windows long paths and their 8.3 short form, folder ranking, dev ports from the
// script, the project's config and .env files, lockfiles, titles and awkward file names.
// detect() is pure apart from reading the target, so these tests only create files in temp
// folders; nothing is opened, served or spawned, except the one real 8.3 lookup on Windows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fakeRun, lib, tempDir } from './helpers.mjs';

const {
  detect, needsServer, pickMainFile, devPort, packageManager, portProperties, cmdUnsafe, readPackageJson,
  HTML_EXT, WINDOWS_LONG_PATH, DATA_EXT, MAX_DATA_CHECKS, MAX_CONFIG_DEPTH, MAX_PACKAGE_JSON,
} = await import(lib('detect.mjs'));
const { shortPath, SHORT_PATH_SCRIPT } = await import(lib('shortpath.mjs'));

// devPort reads the environment a dev server would inherit (process.env by default): a port
// exported in the shell that runs these tests must not leak into them.
for (const key of ['PORT', 'NUXT_PORT', 'NITRO_PORT']) delete process.env[key];

// ---------------------------------------------------------------------------------------------
// helpers

const T0 = 1_700_000_000; // fixed epoch seconds, so mtimes are deterministic

/** Write a file (creating parent folders); optionally pin its mtime (seconds). */
function put(file, content = '', mtimeSec) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
  if (mtimeSec !== undefined) utimesSync(file, mtimeSec, mtimeSec);
  return file;
}

/** Run fn(dir) inside a fresh temp folder that is always removed. */
function inTemp(fn) {
  const { dir, cleanup } = tempDir('show-local-detect-');
  try { return fn(dir); } finally { cleanup(); }
}

const page = (body = '', title = 'T') =>
  `<!doctype html>\n<html><head><meta charset="utf-8"><title>${title}</title></head>\n<body>${body}</body></html>\n`;

const REASON = {
  module: 'ES module script (blocked under file://)',
  dynImport: 'dynamic import()',
  fetch: 'fetch() call',
  xhr: 'XMLHttpRequest',
  worker: 'Web Worker',
  serviceWorker: 'service worker',
  manifest: 'web app manifest',
  importmap: 'import map',
};
const MODULE_BODY = '<script type="module" src="m.js"></script>';
const dataReason = (names, script) => `loads local data (${names})${script ? ` in ${script}` : ''} — file:// would block it`;

/** A nested folder chain under base whose path is at least minLen characters long. */
function deepDir(base, minLen) {
  let d = base;
  let i = 0;
  while (d.length < minLen) d = path.join(d, `level-${String(i++).padStart(2, '0')}-${'d'.repeat(28)}`);
  mkdirSync(d, { recursive: true });
  return d;
}

/** A path inside dir whose total length is exactly `total` characters. */
function pathOfLength(dir, total, ext = '.html') {
  const stem = total - dir.length - path.sep.length - ext.length;
  assert.ok(stem >= 1 && stem <= 200, `cannot build a ${total}-char path under a ${dir.length}-char folder`);
  const p = path.join(dir, 'p'.repeat(stem) + ext);
  assert.equal(p.length, total);
  return p;
}

// ---------------------------------------------------------------------------------------------
// exports

test('HTML_EXT covers .html, .htm and .xhtml; WINDOWS_LONG_PATH is 256', () => {
  assert.deepEqual([...HTML_EXT].sort(), ['.htm', '.html', '.xhtml']);
  assert.equal(WINDOWS_LONG_PATH, 256);
});

test('cmdUnsafe: true for a path with any of & % ^ | < > ! ", false otherwise', () => {
  for (const ch of ['&', '%', '^', '|', '<', '>', '!', '"']) {
    assert.equal(cmdUnsafe(`C:\\Users\\me\\a${ch}b\\site`), true, ch);
  }
  assert.equal(cmdUnsafe('C:\\Users\\me\\R&D\\%USERNAME%\\site'), true);
  for (const p of [
    'C:\\Users\\me\\site', "C:\\Users\\me\\it's $HOME; `tick` (1) [2] {3} #4 @5 ~6 =7 +8 ,9", 'C:\\פרויקטים\\אתר עם רווח',
    '/home/me/site', '', null, undefined,
  ]) {
    assert.equal(cmdUnsafe(p), false, String(p));
  }
});

// ---------------------------------------------------------------------------------------------
// errors: empty target, bad URLs, missing paths

test('empty, whitespace-only, null and undefined targets report no-target', () => {
  const expected = { ok: false, error: 'no-target', detail: 'Nothing to show: pass a path or a URL.' };
  for (const target of ['', '   ', '\t\n ', null, undefined]) {
    assert.deepEqual(detect(target), expected, `target ${JSON.stringify(target)}`);
  }
  assert.deepEqual(detect(), expected);
});

test('malformed http(s) URLs report bad-url with the raw target in the detail', () => {
  for (const u of ['http://', 'https://exa mple.com', 'http://:80', 'http://[::1']) {
    assert.deepEqual(detect(u), { ok: false, error: 'bad-url', detail: `Not a valid URL: ${u}` }, u);
  }
});

test('a malformed file:// URL reports bad-url instead of throwing', () => {
  const u = 'file:///a%2Fb.html'; // encoded slash: rejected by fileURLToPath on every OS
  assert.deepEqual(detect(u), { ok: false, error: 'bad-url', detail: `Not a valid file URL: ${u}` });
});

test('a missing path reports not-found with the resolved absolute path', () => inTemp((dir) => {
  const missing = path.join(dir, 'nope.html');
  const expected = { ok: false, error: 'not-found', detail: `No such file or folder: ${missing}` };
  assert.deepEqual(detect('nope.html', { cwd: dir }), expected, 'relative');
  assert.deepEqual(detect(missing), expected, 'absolute');
  assert.deepEqual(detect(pathToFileURL(missing).href), expected, 'file:// URL');
}));

test('relative targets default to process.cwd()', () => {
  const name = 'show-local-definitely-missing-8c1f.html';
  assert.equal(detect(name).detail, `No such file or folder: ${path.resolve(process.cwd(), name)}`);
});

test('non-http schemes and scheme-less hosts are treated as paths, not URLs', () => inTemp((dir) => {
  for (const t of ['ftp://example.com/x.html', 'www.example.com', 'http:/example.com']) {
    const r = detect(t, { cwd: dir });
    assert.equal(r.ok, false, t);
    assert.equal(r.error, 'not-found', t);
  }
}));

// ---------------------------------------------------------------------------------------------
// url mode

test('http(s) targets become url mode with the WHATWG-normalised href', () => {
  const cases = [
    ['http://example.com', 'http://example.com/'],
    ['HTTPS://Example.COM/Path?q=1#h', 'https://example.com/Path?q=1#h'],
    ['  http://localhost:3000/app  ', 'http://localhost:3000/app'],
    ['http://127.0.0.1:4401/index.html', 'http://127.0.0.1:4401/index.html'],
    ['http://[::1]:8080/', 'http://[::1]:8080/'],
    ['https://example.com/a b', 'https://example.com/a%20b'],
    ['https://example.com:443/', 'https://example.com/'],
  ];
  for (const [input, href] of cases) {
    assert.deepEqual(detect(input), { ok: true, mode: 'url', url: href }, input);
  }
});

test('url mode never looks at the file system (a missing cwd is irrelevant)', () => {
  const r = detect('http://example.com/does/not/exist.html', { cwd: path.join('no', 'such', 'cwd') });
  assert.deepEqual(r, { ok: true, mode: 'url', url: 'http://example.com/does/not/exist.html' });
});

test('Hebrew host and path are punycoded and percent-encoded', () => {
  const r = detect('https://דוגמה.קום/שלום');
  assert.equal(r.ok, true);
  assert.equal(r.mode, 'url');
  assert.match(r.url, /^https:\/\/xn--[a-z0-9-]+\.xn--[a-z0-9-]+\/%D7%A9%D7%9C%D7%95%D7%9D$/);
});

// ---------------------------------------------------------------------------------------------
// file mode

test('a self-contained HTML file is file mode with its title', () => inTemp((dir) => {
  const f = put(path.join(dir, 'report.html'), page('<p>hello</p>', 'Weekly report'));
  assert.deepEqual(detect(f), { ok: true, mode: 'file', path: f, title: 'Weekly report' });
}));

test('.htm, .xhtml and upper-case .HTML are all treated as HTML', () => inTemp((dir) => {
  for (const name of ['a.htm', 'b.xhtml', 'C.HTML', 'd.Html']) {
    const f = put(path.join(dir, name), page('', name));
    assert.deepEqual(detect(f), { ok: true, mode: 'file', path: f, title: name }, name);
  }
}));

test('classic scripts, stylesheets and prefetch hints stay file mode', () => inTemp((dir) => {
  const body = [
    '<link rel="stylesheet" href="style.css">',
    '<link rel="prefetch" href="next.html">',
    '<link rel="modulepreload" href="x.js">',
    '<script src="app.js"></script>',
    '<script type="text/javascript">prefetch(); refetch(); var Worker = 1;</script>',
    '<img src="logo.png"><video src="clip.mp4"></video>',
  ].join('\n');
  const f = put(path.join(dir, 'page.html'), page(body));
  assert.deepEqual(detect(f), { ok: true, mode: 'file', path: f, title: 'T' });
}));

test('HTML without a <title> reports title null', () => inTemp((dir) => {
  const f = put(path.join(dir, 'bare.html'), '<p>no head at all</p>');
  assert.deepEqual(detect(f), { ok: true, mode: 'file', path: f, title: null });
}));

test('an empty HTML file is file mode with title null', () => inTemp((dir) => {
  const f = put(path.join(dir, 'empty.html'), '');
  assert.deepEqual(detect(f), { ok: true, mode: 'file', path: f, title: null });
}));

test('relative targets resolve against the cwd option; . and .. segments are normalised', () => inTemp((dir) => {
  const f = put(path.join(dir, 'site', 'page.html'), page());
  assert.equal(detect(path.join('site', 'page.html'), { cwd: dir }).path, f);
  assert.equal(detect('page.html', { cwd: path.join(dir, 'site') }).path, f);
  assert.equal(detect(`${dir}${path.sep}ghost${path.sep}..${path.sep}site${path.sep}.${path.sep}page.html`).path, f);
}));

test('forward-slash paths resolve to the native path', () => inTemp((dir) => {
  const f = put(path.join(dir, 'sub', 'page.html'), page());
  const r = detect(`${dir.replace(/\\/g, '/')}/sub/page.html`);
  assert.equal(r.mode, 'file');
  assert.equal(r.path, f);
}));

test('surrounding whitespace around a path is trimmed', () => inTemp((dir) => {
  const f = put(path.join(dir, 'page.html'), page());
  assert.equal(detect(`  ${f}\n`).path, f);
}));

// ---------------------------------------------------------------------------------------------
// file:// input

test('a file:// URL behaves exactly like the path it points to', () => inTemp((dir) => {
  const f = put(path.join(dir, 'page.html'), page('', 'From URL'));
  const href = pathToFileURL(f).href;
  assert.match(href, /^file:\/\//);
  assert.deepEqual(detect(href), { ok: true, mode: 'file', path: f, title: 'From URL' });
  assert.deepEqual(detect(href), detect(f));
}));

test('file:// is matched case-insensitively and trimmed', () => inTemp((dir) => {
  const f = put(path.join(dir, 'page.html'), page());
  const href = pathToFileURL(f).href.replace(/^file:/, 'FILE:');
  assert.equal(detect(` ${href} `).path, f);
}));

test('a file:// URL to a folder, a module page and a PDF picks the same mode as the path', () => inTemp((dir) => {
  put(path.join(dir, 'site', 'index.html'), page());
  const mod = put(path.join(dir, 'mod.html'), page('<script type="module" src="m.js"></script>'));
  const pdf = put(path.join(dir, 'doc.pdf'), '%PDF-1.4');
  for (const p of [path.join(dir, 'site'), mod, pdf, dir]) {
    assert.deepEqual(detect(pathToFileURL(p).href), detect(p), p);
  }
  assert.equal(detect(pathToFileURL(path.join(dir, 'site')).href).mode, 'serve');
  assert.equal(detect(pathToFileURL(mod).href).mode, 'serve');
  assert.equal(detect(pathToFileURL(pdf).href).mode, 'app');
}));

// ---------------------------------------------------------------------------------------------
// needsServer (pure)

test('needsServer: plain HTML and empty input need nothing', () => {
  assert.deepEqual(needsServer(''), { needed: false, reasons: [] });
  assert.deepEqual(needsServer(page('<p>hi</p><script src="a.js"></script>')), { needed: false, reasons: [] });
});

test('needsServer: module script attribute variants', () => {
  const yes = [
    '<script type="module" src="main.js"></script>',
    "<script type='module'>import './a.js'</script>",
    '<script type=module src=main.js></script>',
    '<SCRIPT TYPE="MODULE"></SCRIPT>',
    '<script src="a.js"\n    type = "module" defer></script>',
  ];
  for (const html of yes) assert.deepEqual(needsServer(html), { needed: true, reasons: [REASON.module] }, html);
  for (const html of ['<script type="text/javascript"></script>', '<script>let type = "module"</script>']) {
    assert.deepEqual(needsServer(html), { needed: false, reasons: [] }, html);
  }
});

test('needsServer: dynamic import() with a string specifier', () => {
  for (const html of ['import("./a.js")', "import('./a.js')", 'import(`./a.js`)', "import ( './a.js' )"]) {
    assert.deepEqual(needsServer(`<script>${html}</script>`), { needed: true, reasons: [REASON.dynImport] }, html);
  }
  assert.deepEqual(needsServer('<script>// important stuff</script>'), { needed: false, reasons: [] });
});

test('needsServer: fetch() but not prefetch()/refetch()', () => {
  for (const html of ["fetch('data.json')", 'window.fetch (url)', 'await fetch(`/api`)']) {
    assert.deepEqual(needsServer(`<script>${html}</script>`), { needed: true, reasons: [REASON.fetch] }, html);
  }
  for (const html of ['prefetch(x)', 'refetch()', '<link rel="prefetch" href="a.html">']) {
    assert.deepEqual(needsServer(html), { needed: false, reasons: [] }, html);
  }
});

test('needsServer: XMLHttpRequest, workers and service workers', () => {
  assert.deepEqual(needsServer('<script>var x = new XMLHttpRequest();</script>').reasons, [REASON.xhr]);
  for (const html of ["new Worker('w.js')", "new  SharedWorker ('s.js')", 'new Worker(url)']) {
    assert.deepEqual(needsServer(`<script>${html}</script>`).reasons, [REASON.worker], html);
  }
  assert.deepEqual(needsServer("<script>navigator.serviceWorker.register('/sw.js')</script>").reasons, [REASON.serviceWorker]);
  assert.deepEqual(needsServer('<script>const Worker = 1; makeWorker()</script>').reasons, []);
});

test('needsServer: web app manifest and import map variants', () => {
  for (const html of ['<link rel="manifest" href="m.json">', "<link href='m.json' rel='manifest'>", '<LINK REL=MANIFEST HREF=m.json>']) {
    assert.deepEqual(needsServer(html), { needed: true, reasons: [REASON.manifest] }, html);
  }
  for (const html of ['<script type="importmap">{"imports":{}}</script>', "<script type='importmap'></script>", '<SCRIPT TYPE=IMPORTMAP></SCRIPT>']) {
    assert.deepEqual(needsServer(html), { needed: true, reasons: [REASON.importmap] }, html);
  }
  assert.deepEqual(needsServer('<link rel="stylesheet" href="manifest.css">').reasons, []);
});

test('needsServer: every reason at once, in the declared order', () => {
  const html = [
    '<script type="importmap">{}</script>',
    '<link rel="manifest" href="m.json">',
    '<script>navigator.serviceWorker.register("sw.js"); new Worker("w.js"); new XMLHttpRequest(); fetch("d"); import("./x.js")</script>',
    '<script type="module" src="main.js"></script>',
  ].join('\n');
  assert.deepEqual(needsServer(html), {
    needed: true,
    reasons: [REASON.module, REASON.dynImport, REASON.fetch, REASON.xhr, REASON.worker, REASON.serviceWorker, REASON.manifest, REASON.importmap],
  });
});

// ---------------------------------------------------------------------------------------------
// needsServer: local data loaded through libraries

test('needsServer: library calls on a relative path name the file, with or without the folder', () => {
  const cases = [
    ["d3.json('data.json')", 'data.json'],
    ['d3.csv("data/cities.csv").then(draw)', 'data/cities.csv'],
    ['d3 . tsv ( `rows.tsv` )', 'rows.tsv'],
    ["d3.dsv(';', 'semi.csv')", 'semi.csv'],
    ["d3.xml('./shapes.xml')", 'shapes.xml'],
    ["d3.text('notes.txt?v=3#top')", 'notes.txt'],
    ["$.getJSON('config.json', cb)", 'config.json'],
    ['jQuery.get("rows.csv")', 'rows.csv'],
    ["$.getScript('plugin.js')", 'plugin.js'],
    ["$('#box').load('partial.html')", 'partial.html'],
    ["axios.get('api/items.json')", 'api/items.json'],
    ["axios('list.json')", 'list.json'],
    ["new GLTFLoader().load('models/scene.glb', onLoad)", 'models/scene.glb'],
    ["loader.loadAsync('bunny.gltf')", 'bunny.gltf'],
    ["vegaEmbed('#vis', 'spec.json')", 'spec.json'],
    ["d3.json('my%20data.json')", 'my data.json'],
    ["d3.json('../shared/data.json')", '../shared/data.json'],
  ];
  for (const [js, name] of cases) {
    const html = `<script>${js}</script>`;
    assert.deepEqual(needsServer(html), { needed: true, reasons: [dataReason(name)] }, js);
    assert.deepEqual(needsServer(html, { dir: path.join('no', 'such', 'dir'), platform: 'linux' }).reasons, [dataReason(name)], `${js} with dir`);
  }
});

test('needsServer: remote, root-relative, data: and non-path arguments are not local data', () => {
  for (const js of [
    "d3.json('https://example.com/data.json')", "d3.csv('//cdn.example/x.csv')", "d3.json('/api/data.json')",
    "d3.json('data:application/json,{}')", "axios.get('blob:abc')", 'd3.json(url)', 'd3.json(`${base}/x.json`)',
    "document.fonts.load('12px Roboto')", "document.fonts.load('1.5em Heebo')", "yaml.load('a: 1')", "$.get('')",
    "d3.select('#chart')", "window.addEventListener('load', go)",
  ]) {
    assert.deepEqual(needsServer(`<script>${js}</script>`), { needed: false, reasons: [] }, js);
  }
});

test('needsServer: a quoted address of an existing data file next to the page counts, in the page and in its scripts', () => inTemp((dir) => {
  put(path.join(dir, 'data', 'cities.csv'), 'a,b\n1,2\n');
  put(path.join(dir, 'points.geojson'), '{}');
  const html = page("<script>const url = 'data/cities.csv'; draw(url);</script>");
  assert.deepEqual(needsServer(html, { dir, platform: 'linux' }), { needed: true, reasons: [dataReason('data/cities.csv')] });
  assert.deepEqual(needsServer(html), { needed: false, reasons: [] }, 'without the folder nothing is looked up');
  assert.deepEqual(needsServer(page("<script>const url = 'data/missing.csv'</script>"), { dir, platform: 'linux' }).reasons, [], 'a missing file is no data');
  put(path.join(dir, 'app.js'), 'const src = "points.geojson"; map.addSource("pts", { type: "geojson", data: src });');
  assert.deepEqual(needsServer(page('<script src="app.js"></script>'), { dir, platform: 'linux' }).reasons, [dataReason('points.geojson', 'app.js')]);
}));

test('needsServer: every data type counts; other types, and data files the page never names, do not', () => inTemp((dir) => {
  assert.deepEqual(DATA_EXT, ['json', 'csv', 'tsv', 'xml', 'geojson', 'topojson', 'txt', 'wasm', 'glb', 'gltf']);
  for (const ext of DATA_EXT) {
    put(path.join(dir, `f.${ext}`), 'x');
    assert.deepEqual(needsServer(page(`<script>load("f.${ext}")</script>`), { dir, platform: 'linux' }).reasons, [dataReason(`f.${ext}`)], ext);
    put(path.join(dir, 'upper', `U.${ext.toUpperCase()}`), 'x');
    assert.deepEqual(needsServer(page(`<script>load('upper/U.${ext.toUpperCase()}')</script>`), { dir, platform: 'linux' }).reasons, [dataReason(`upper/U.${ext.toUpperCase()}`)], `${ext} in upper case`);
  }
  put(path.join(dir, 'logo.png'), 'x');
  put(path.join(dir, 'style.css'), 'x');
  assert.deepEqual(needsServer(page('<script>var a = "logo.png", b = "style.css";</script>'), { dir, platform: 'linux' }).reasons, []);
  const f = put(path.join(dir, 'report.html'), page('<p>see the data</p>', 'R'));
  assert.equal(detect(f, { platform: 'linux' }).mode, 'file', 'data files next to a page that never names them change nothing');
}));

test('needsServer: links, images, frames and objects are loaded by the browser itself; data-*, custom elements, options and handlers count', () => inTemp((dir) => {
  for (const name of ['data.csv', 'feed.xml', 'notes.txt', 'shape.xml', 'scene.glb', 'config.json', '2020.csv', 'click.json']) put(path.join(dir, name), 'x');
  const native = [
    '<a href="data.csv" download>Download</a>', '<link rel="alternate" type="application/rss+xml" href="feed.xml">',
    '<iframe src="notes.txt"></iframe>', '<object data="shape.xml"></object>', '<embed src="shape.xml">',
    '<link rel="preload" href="config.json" as="fetch">', '<!-- <model-viewer src="scene.glb"></model-viewer> -->',
    '<script type="application/json">{"url": "config.json"}</script>', '<p>"notes.txt" is plain text in the page</p>',
  ];
  for (const body of native) assert.deepEqual(needsServer(page(body), { dir, platform: 'linux' }).reasons, [], body);
  const loaded = [
    ['<model-viewer src="scene.glb" camera-controls></model-viewer>', 'scene.glb'],
    ['<div id="chart" data-src="config.json"></div>', 'config.json'],
    ["<div data-config='{\"url\": \"data.csv\"}'></div>", 'data.csv'],
    ['<select><option value="2020.csv">2020</option></select>', '2020.csv'],
    [`<button onclick="load('click.json')">Load</button>`, 'click.json'],
    ['<a-asset-item id="m" src="scene.glb"></a-asset-item>', 'scene.glb'],
  ];
  for (const [body, name] of loaded) assert.deepEqual(needsServer(page(body), { dir, platform: 'linux' }).reasons, [dataReason(name)], body);
}));

test('needsServer: each data file is named once, the page first; more than three are summed up', () => inTemp((dir) => {
  for (const n of ['a', 'b', 'c', 'd', 'e']) put(path.join(dir, `${n}.json`), '{}');
  put(path.join(dir, 'app.js'), 'd3.json("a.json"); const more = ["d.json", "e.json"];');
  const html = page("<script>d3.json('a.json'); d3.json('b.json?x=1'); const c = 'c.json';</script><script src='app.js'></script>");
  assert.deepEqual(needsServer(html, { dir, platform: 'linux' }).reasons, [
    dataReason('a.json, b.json, c.json'),
    dataReason('d.json, e.json', 'app.js'),
  ]);
  const many = page(`<script>${['a', 'b', 'c', 'd', 'e'].map((n) => `d3.json("${n}.json");`).join('')}</script>`);
  assert.deepEqual(needsServer(many).reasons, [dataReason('a.json, b.json, c.json and 2 more')]);
}));

test('needsServer: data next to a page that also calls fetch() gives both reasons, and the page is served', () => inTemp((dir) => {
  put(path.join(dir, 'data.json'), '{}');
  const f = put(path.join(dir, 'dash.html'), page("<script>fetch('data.json').then((r) => r.json())</script>", 'Dash'));
  assert.deepEqual(detect(f, { platform: 'linux' }), {
    ok: true, mode: 'serve', path: f, root: dir, entry: 'dash.html', reasons: [REASON.fetch, dataReason('data.json')], title: 'Dash',
  });
  const d3 = put(path.join(dir, 'chart.html'), page("<script src='https://cdn.jsdelivr.net/npm/d3@7'></script><script>d3.json('data.json').then(draw)</script>", 'Chart'));
  assert.deepEqual(detect(d3, { platform: 'linux' }).reasons, [dataReason('data.json')]);
  assert.equal(detect(d3, { platform: 'linux' }).mode, 'serve');
}));

test(`needsServer: at most ${MAX_DATA_CHECKS} data addresses are looked up per page`, () => inTemp((dir) => {
  assert.equal(MAX_DATA_CHECKS, 64);
  put(path.join(dir, 'late.json'), '{}');
  const misses = Array.from({ length: MAX_DATA_CHECKS }, (_, i) => `"miss${i}.json"`).join(',');
  assert.deepEqual(needsServer(page(`<script>var a = [${misses}, "late.json"]</script>`), { dir, platform: 'linux' }).reasons, []);
  assert.deepEqual(needsServer(page('<script>var a = ["late.json"]</script>'), { dir, platform: 'linux' }).reasons, [dataReason('late.json')]);
}));

test('needsServer: a page of unclosed tags, quotes, comments and scripts is read in one pass', () => inTemp((dir) => {
  // A regex that rescans from every "<" took minutes on the first of these; each is linear now.
  const fill = (unit) => unit.repeat(Math.ceil((1024 * 1024) / unit.length));
  for (const html of [`<div title="${fill('<a ')}`, fill('<script>'), fill('<!--'), `<div ${fill('a=b c="d" ')}>`, `<script>${fill("'")}</script>`]) {
    const t0 = Date.now();
    assert.deepEqual(needsServer(html, { dir, platform: 'linux' }), { needed: false, reasons: [] });
    assert.ok(Date.now() - t0 < 5000, `${Date.now() - t0} ms for ${html.slice(0, 12)}…`);
  }
  const t0 = Date.now();
  assert.deepEqual(portProperties(`${'{a:'.repeat(50000)}1${'}'.repeat(50000)}`).ports, []);
  assert.ok(Date.now() - t0 < 5000, 'a deeply nested config');
}));

test('needsServer: a long name after "<" with no ">" (a token in the text) is read in one pass', () => inTemp((dir) => {
  // The tag name used to give characters back to the attributes one at a time: 50k took 3 s.
  const run = 'a'.repeat(80000);
  for (const html of [`<p>id: <x${run}</p>`, `<p>token <eyJ${run}.${'b_c-d'.repeat(4000)}</p>`, `<a${run}`]) {
    const t0 = Date.now();
    assert.deepEqual(needsServer(html, { dir, platform: 'linux' }), { needed: false, reasons: [] });
    assert.ok(Date.now() - t0 < 1000, `${Date.now() - t0} ms for ${html.slice(0, 12)}…`);
  }
  const f = put(path.join(dir, 'report.html'), `<!doctype html><title>r</title><p>id: <x${run}</p>`);
  const t0 = Date.now();
  assert.deepEqual(detect(f, { platform: 'linux' }), { ok: true, mode: 'file', path: f, title: 'r' });
  assert.ok(Date.now() - t0 < 1000, `detect: ${Date.now() - t0} ms`);
  // The same tags are still found: a custom element's value and a handler's call count.
  put(path.join(dir, 'scene.glb'), 'glb');
  assert.deepEqual(needsServer('<model-viewer src="scene.glb"></model-viewer>', { dir, platform: 'linux' }).reasons, [dataReason('scene.glb')]);
  assert.deepEqual(needsServer(`<x-a${run} data-src="scene.glb">`, { dir, platform: 'linux' }).reasons, [dataReason('scene.glb')]);
  assert.deepEqual(needsServer('<button onclick="d3.csv(\'rows.csv\')">', { platform: 'linux' }).reasons, [dataReason('rows.csv')]);
}));

test('detect: a page of unclosed <title> tags is classified promptly, with title null', () => inTemp((dir) => {
  for (const [name, html, title] of [
    ['open.html', '<title>'.repeat(150000), null],
    ['early.html', `</title>${'<title x>'.repeat(120000)}`, null],
    ['closed.html', `${'<title>'.repeat(150000)}</title>`, '<title>'.repeat(149999)],
    ['normal.html', `<title>Real</title>${'<title>'.repeat(150000)}`, 'Real'],
  ]) {
    const f = put(path.join(dir, name), html);
    const t0 = Date.now();
    const d = detect(f, { platform: 'linux' });
    assert.ok(Date.now() - t0 < 5000, `${name}: ${Date.now() - t0} ms`);
    assert.equal(d.mode, 'file', name);
    assert.equal(d.title, title, name);
  }
}));

test('needsServer on Windows: device names, drive letters and streams in a data address are never looked up', () => inTemp((dir) => {
  for (const ref of ['con.json', 'NUL.txt', 'c:evil.json', 'a.txt:stream.json', 'aux/x.csv']) {
    assert.deepEqual(needsServer(page(`<script>var u = "${ref}"</script>`), { dir, platform: 'win32' }).reasons, [], ref);
  }
}));

// ---------------------------------------------------------------------------------------------
// serve mode for HTML files

test('HTML that needs http is serve mode with root, entry, reasons and title', async (t) => {
  const cases = [
    ['module script', '<script type="module" src="main.js"></script>', REASON.module],
    ['fetch()', "<script>fetch('data.json').then((r) => r.json())</script>", REASON.fetch],
    ['dynamic import()', "<script>import('./chunk.js').then((m) => m.go())</script>", REASON.dynImport],
    ['XMLHttpRequest', "<script>var x = new XMLHttpRequest(); x.open('GET', 'd.json')</script>", REASON.xhr],
    ['Worker', "<script>const w = new Worker('w.js')</script>", REASON.worker],
    ['SharedWorker', "<script>const w = new SharedWorker('s.js')</script>", REASON.worker],
    ['service worker', "<script>navigator.serviceWorker.register('/sw.js')</script>", REASON.serviceWorker],
    ['import map', '<script type="importmap">{"imports":{"x":"./x.js"}}</script>', REASON.importmap],
    ['manifest', '<link rel="manifest" href="app.webmanifest">', REASON.manifest],
  ];
  for (const [label, body, reason] of cases) {
    await t.test(label, () => inTemp((dir) => {
      const f = put(path.join(dir, 'app', 'page.html'), page(body, `Title ${label}`));
      assert.deepEqual(detect(f, { platform: 'linux' }), {
        ok: true, mode: 'serve', path: f, root: path.join(dir, 'app'), entry: 'page.html', reasons: [reason], title: `Title ${label}`,
      });
    }));
  }
});

test('an import-map app reports module and import map together, module first', () => inTemp((dir) => {
  const f = put(path.join(dir, 'index.html'), page('<script type="importmap">{}</script><script type="module">import "x"</script>'));
  const r = detect(f, { platform: 'darwin' });
  assert.equal(r.mode, 'serve');
  assert.deepEqual(r.reasons, [REASON.module, REASON.importmap]);
}));

test('serve-mode HTML with no title still carries title: null', () => inTemp((dir) => {
  const f = put(path.join(dir, 'x.htm'), '<script type="module"></script>');
  assert.deepEqual(detect(f, { platform: 'linux' }), {
    ok: true, mode: 'serve', path: f, root: dir, entry: 'x.htm', reasons: [REASON.module], title: null,
  });
}));

// ---------------------------------------------------------------------------------------------
// Windows long paths: the 8.3 short path first, served only without one

/** A shortPathFn stand-in that records its calls and answers with `answer(p)`. */
function fakeShort(answer) {
  const calls = [];
  const fn = (p, opts) => { calls.push({ p, opts }); return typeof answer === 'function' ? answer(p) : answer; };
  fn.calls = calls;
  return fn;
}
const noShort = () => null;
const servedLong = (n) => `path is ${n} characters; file:/// may fail past Windows MAX_PATH and it has no 8.3 short path of ${WINDOWS_LONG_PATH} characters or fewer, so it is served: the link works only while this session is open`;
const viaShortReason = (n, m) => `path is ${n} characters, past what Windows opens as file:///, so it opens through its 8.3 short path (${m} characters)`;
const SHORT = 'C:\\Users\\me\\AppData\\Local\\Temp\\SL-DET~1\\LEVEL-~1\\PPPPPP~1.HTM';

test(`win32: an HTML path of ${WINDOWS_LONG_PATH + 1} characters without an 8.3 short path is served, ${WINDOWS_LONG_PATH} still opens as a file`, () => inTemp((dir) => {
  const deep = deepDir(dir, 170);
  const atLimit = put(pathOfLength(deep, WINDOWS_LONG_PATH), page('', 'Edge'));
  const pastLimit = put(pathOfLength(deep, WINDOWS_LONG_PATH + 1), page('', 'Long'));

  const unused = fakeShort(SHORT);
  assert.deepEqual(detect(atLimit, { platform: 'win32', shortPathFn: unused }), { ok: true, mode: 'file', path: atLimit, title: 'Edge' });
  assert.equal(unused.calls.length, 0, 'a path that fits never asks for a short path');
  assert.deepEqual(detect(pastLimit, { platform: 'win32', shortPathFn: noShort }), {
    ok: true,
    mode: 'serve',
    path: pastLimit,
    root: deep,
    entry: path.basename(pastLimit),
    reasons: [servedLong(WINDOWS_LONG_PATH + 1)],
    title: 'Long',
  });
}));

test('win32: a long HTML path with an 8.3 short path that fits stays file mode, opened through openPath', () => inTemp((dir) => {
  const deep = deepDir(dir, 170);
  const f = put(pathOfLength(deep, WINDOWS_LONG_PATH + 40), page('', 'Deep'));
  const short = fakeShort(SHORT);
  assert.deepEqual(detect(f, { platform: 'win32', shortPathFn: short }), {
    ok: true,
    mode: 'file',
    path: f,
    openPath: SHORT,
    shortPath: true,
    title: 'Deep',
    reasons: [viaShortReason(WINDOWS_LONG_PATH + 40, SHORT.length)],
  });
  assert.deepEqual(short.calls, [{ p: f, opts: { platform: 'win32' } }], 'asked once, for the real path');
  // Exactly WINDOWS_LONG_PATH characters still fits.
  const edge = `C:\\${'s'.repeat(WINDOWS_LONG_PATH - 7)}.HTM`;
  assert.equal(edge.length, WINDOWS_LONG_PATH);
  assert.equal(detect(f, { platform: 'win32', shortPathFn: () => edge }).openPath, edge);
}));

test('win32: a short path that is still too long, missing, empty, not a string, or a failing lookup means served', () => inTemp((dir) => {
  const deep = deepDir(dir, 170);
  const f = put(pathOfLength(deep, WINDOWS_LONG_PATH + 12), page('', 'Long'));
  const tooLong = `C:\\${'s'.repeat(WINDOWS_LONG_PATH - 6)}.HTM`;
  assert.equal(tooLong.length, WINDOWS_LONG_PATH + 1);
  for (const [label, fn] of [
    ['too long', () => tooLong], ['null', noShort], ['empty', () => ''], ['not a string', () => 42],
    ['throws', () => { throw new Error('PowerShell is blocked'); }],
  ]) {
    const d = detect(f, { platform: 'win32', shortPathFn: fn });
    assert.equal(d.mode, 'serve', label);
    assert.deepEqual(d.reasons, [servedLong(WINDOWS_LONG_PATH + 12)], label);
    assert.equal('openPath' in d || 'shortPath' in d, false, label);
  }
}));

test('the same long HTML path stays file mode on linux and darwin, and never asks for a short path', () => inTemp((dir) => {
  const deep = deepDir(dir, 170);
  const f = put(pathOfLength(deep, WINDOWS_LONG_PATH + 10), page('', 'Long'));
  assert.ok(f.length > WINDOWS_LONG_PATH);
  const unused = fakeShort(SHORT);
  for (const platform of ['linux', 'darwin']) {
    assert.deepEqual(detect(f, { platform, shortPathFn: unused }), { ok: true, mode: 'file', path: f, title: 'Long' }, platform);
  }
  assert.equal(unused.calls.length, 0);
  assert.equal(detect(f, { platform: 'win32', shortPathFn: noShort }).mode, 'serve');
}));

test('win32 long path + module script: served anyway, both reasons with the http reason first, no short-path lookup', () => inTemp((dir) => {
  const deep = deepDir(dir, 170);
  const f = put(pathOfLength(deep, WINDOWS_LONG_PATH + 5), page('<script type="module" src="m.js"></script>'));
  const unused = fakeShort(SHORT);
  const d = detect(f, { platform: 'win32', shortPathFn: unused });
  assert.equal(d.mode, 'serve');
  assert.deepEqual(d.reasons, [
    REASON.module,
    `path is ${WINDOWS_LONG_PATH + 5} characters; file:/// may fail past Windows MAX_PATH`,
  ]);
  assert.equal(unused.calls.length, 0, 'a served page does not need the short path');
}));

test('win32 hidden long page: it can never be served, so it opens as a file, through the short path when there is one', () => inTemp((dir) => {
  const deep = deepDir(dir, 170);
  const f = put(pathOfLength(deep, WINDOWS_LONG_PATH + 3).replace(/[/\\]p(p+\.html)$/, (m, rest) => `${path.sep}.${rest}`), page(MODULE_BODY, 'Hidden'));
  assert.equal(f.length, WINDOWS_LONG_PATH + 3);
  const d = detect(f, { platform: 'win32', shortPathFn: () => SHORT });
  assert.equal(d.mode, 'file');
  assert.equal(d.openPath, SHORT);
  assert.equal(d.shortPath, true);
  assert.deepEqual(d.reasons.slice(0, 2), [REASON.module, viaShortReason(WINDOWS_LONG_PATH + 3, SHORT.length)]);
  assert.match(d.reasons[2], /never serves hidden files/);
  const without = detect(f, { platform: 'win32', shortPathFn: noShort });
  assert.equal(without.mode, 'file');
  assert.equal('openPath' in without, false);
  assert.deepEqual(without.reasons.slice(0, 2), [REASON.module, `path is ${WINDOWS_LONG_PATH + 3} characters; file:/// may fail past Windows MAX_PATH`]);
}));

test('win32 long-path length is measured on the resolved path (relative target, long cwd)', () => inTemp((dir) => {
  const deep = deepDir(dir, 170);
  const f = put(pathOfLength(deep, WINDOWS_LONG_PATH + 2), page());
  const short = fakeShort(null);
  const r = detect(path.basename(f), { cwd: deep, platform: 'win32', shortPathFn: short });
  assert.equal(r.mode, 'serve');
  assert.equal(r.path, f);
  assert.deepEqual(r.reasons, [servedLong(WINDOWS_LONG_PATH + 2)]);
  assert.equal(short.calls[0].p, f, 'the short path is asked for the resolved absolute path');
}));

// ---------------------------------------------------------------------------------------------
// lib/shortpath.mjs

test('shortPath: null off Windows and for anything but a drive-letter path, without running anything', () => {
  const run = fakeRun([]);
  const stat = () => { throw new Error('must not stat'); };
  assert.equal(shortPath('C:\\x\\y.html', { platform: 'linux', runFn: run, statFn: stat }), null);
  assert.equal(shortPath('C:\\x\\y.html', { platform: 'darwin', runFn: run, statFn: stat }), null);
  for (const p of ['\\\\server\\share\\x.html', 'relative\\x.html', '/tmp/x.html', '', null, undefined, 'C:x.html', 'C:\\a\0b']) {
    assert.equal(shortPath(p, { platform: 'win32', runFn: run, statFn: stat }), null, String(p));
  }
  assert.equal(run.calls.length, 0);
});

/** A statFn over a fixed table: path → { ino, dev, dir }. */
function fakeStat(table) {
  return (p) => {
    const e = table[p];
    if (!e) throw Object.assign(new Error(`ENOENT ${p}`), { code: 'ENOENT' });
    return { ino: BigInt(e.ino), dev: BigInt(e.dev ?? 1), isDirectory: () => !!e.dir };
  };
}

const LONG_FILE = `C:\\Users\\me\\AppData\\Local\\Temp\\${'deep-folder-name\\'.repeat(16)}report of the week.html`;
const SHORT_FILE = 'C:\\Users\\me\\AppData\\Local\\Temp\\DEEP-F~1\\REPORT~1.HTM';

test('shortPath: asks PowerShell through an environment variable only, and returns the verified short path', () => {
  const run = fakeRun([['powershell.exe', { stdout: `\uFEFF${SHORT_FILE}\r\n` }]]);
  const stat = fakeStat({ [LONG_FILE]: { ino: 7 }, [SHORT_FILE]: { ino: 7 } });
  assert.ok(LONG_FILE.length > WINDOWS_LONG_PATH);
  assert.equal(shortPath(LONG_FILE, { platform: 'win32', runFn: run, statFn: stat }), SHORT_FILE);
  assert.equal(run.calls.length, 1);
  const [{ cmd, args, opts }] = run.calls;
  assert.equal(cmd, 'powershell.exe');
  assert.deepEqual(args.slice(0, -1), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command']);
  assert.equal(args[args.length - 1], SHORT_PATH_SCRIPT);
  assert.ok(args.every((a) => !a.includes('deep-folder-name')), 'the path is never on the command line');
  assert.deepEqual(opts.env, { SHOW_LOCAL_P: LONG_FILE, SHOW_LOCAL_KIND: 'file' });
  // The script reads that variable and uses FileSystemObject's GetFile / GetFolder ShortPath.
  assert.match(SHORT_PATH_SCRIPT, /\$env:SHOW_LOCAL_P/);
  assert.match(SHORT_PATH_SCRIPT, /Scripting\.FileSystemObject/);
  assert.match(SHORT_PATH_SCRIPT, /GetFile\(\$next\)\.ShortPath/);
  assert.match(SHORT_PATH_SCRIPT, /GetFolder\(\$next\)\.ShortPath/);
  assert.match(SHORT_PATH_SCRIPT, /UTF8Encoding/);
});

test('shortPath: a folder is looked up as a folder', () => {
  const longDir = LONG_FILE.replace(/\\[^\\]+$/, '');
  const shortDir = 'C:\\Users\\me\\AppData\\Local\\Temp\\DEEP-F~1';
  const run = fakeRun([['powershell.exe', { stdout: `${shortDir}\n` }]]);
  const stat = fakeStat({ [longDir]: { ino: 9, dir: true }, [shortDir]: { ino: 9, dir: true } });
  assert.equal(shortPath(longDir, { platform: 'win32', runFn: run, statFn: stat }), shortDir);
  assert.equal(run.calls[0].opts.env.SHOW_LOCAL_KIND, 'folder');
});

test('shortPath: null when the lookup fails, is not shorter, is not a path, or leads to another file', () => {
  const stat = fakeStat({ [LONG_FILE]: { ino: 7 }, [SHORT_FILE]: { ino: 7 }, 'C:\\OTHER~1.HTM': { ino: 8 }, 'C:\\ONDEV~1.HTM': { ino: 7, dev: 2 }, 'C:\\ADIR~1': { ino: 7, dir: true } });
  const cases = [
    ['non-zero exit (8.3 names off, PowerShell blocked)', { status: 1, stderr: 'CTL_E_FILENOTFOUND' }],
    ['no output', { stdout: '' }],
    ['the same length', { stdout: LONG_FILE }],
    ['longer', { stdout: `${LONG_FILE}x` }],
    ['not a drive path', { stdout: 'Exception calling "GetFile"' }],
    ['a different file', { stdout: 'C:\\OTHER~1.HTM' }],
    ['the same index on another volume', { stdout: 'C:\\ONDEV~1.HTM' }],
    ['a folder for a file', { stdout: 'C:\\ADIR~1' }],
    ['a path that does not exist', { stdout: 'C:\\GONE~1.HTM' }],
  ];
  for (const [label, result] of cases) {
    assert.equal(shortPath(LONG_FILE, { platform: 'win32', runFn: fakeRun([['powershell.exe', result]]), statFn: stat }), null, label);
  }
  const throwing = () => { throw new Error('spawn EPERM'); };
  assert.equal(shortPath(LONG_FILE, { platform: 'win32', runFn: throwing, statFn: stat }), null, 'runFn throws');
  assert.equal(shortPath(LONG_FILE, { platform: 'win32', runFn: () => null, statFn: stat }), null, 'runFn returns nothing');
  const run = fakeRun([]);
  assert.equal(shortPath('C:\\missing\\x.html', { platform: 'win32', runFn: run, statFn: stat }), null, 'a missing target');
  assert.equal(run.calls.length, 0, 'a missing target is not looked up');
});

// Measured on this Windows 11 machine (2026-09-29): FileSystemObject.GetFile(<whole path>)
// answered at 250 and 258 characters and threw CTL_E_FILENOTFOUND at 262 and 300, so
// shortPath walks one name at a time; that walk turned a 330-character and a 370-character
// temp path into 115 characters each, in 0.38–0.48 s per PowerShell run.
test('shortPath (real, Windows): a path past 256 characters under os.tmpdir() gets a short path that fits and opens as a file', { skip: process.platform !== 'win32' && 'needs Windows' }, (t) => inTemp((dir) => {
  const probe = path.join(dir, 'a-folder-name-long-enough-for-an-8dot3-alias');
  mkdirSync(probe);
  if (shortPath(probe) === null) return t.skip('this volume creates no 8.3 names (8dot3name is off)');
  const deep = deepDir(dir, 290);
  const f = put(path.join(deep, `${'weekly report '.repeat(3).trim()}.html`), page('', 'Measured'));
  assert.ok(f.length > WINDOWS_LONG_PATH + 40, `${f.length} characters`);
  const t0 = Date.now();
  const short = shortPath(f);
  const ms = Date.now() - t0;
  t.diagnostic(`${f.length}-character path → ${short?.length}-character short path in ${ms} ms: ${short}`);
  assert.equal(typeof short, 'string');
  assert.ok(short.length <= WINDOWS_LONG_PATH, `${short.length} characters`);
  assert.match(short, /~\d/);
  assert.equal(statSync(short, { bigint: true }).ino, statSync(f, { bigint: true }).ino, 'the same file');
  assert.equal(readFileSync(short, 'utf8'), page('', 'Measured'));
  assert.ok(ms < 5000, `${ms} ms`);
  const d = detect(f, { platform: 'win32' });
  assert.equal(d.mode, 'file', JSON.stringify(d));
  assert.equal(d.path, f);
  assert.equal(d.openPath, short);
  assert.equal(d.shortPath, true);
  assert.deepEqual(d.reasons, [viaShortReason(f.length, short.length)]);
  assert.equal(shortPath(deep)?.length < deep.length, true, 'a folder gets one too');
}));

const SHORT_PDF = 'C:\\Users\\me\\AppData\\Local\\Temp\\SL-DET~1\\LEVEL-~1\\PPPPPP~1.PDF';
const appViaShort = (n, m) => `path is ${n} characters, past what Windows opens reliably (MAX_PATH), so it opens through its 8.3 short path (${m} characters)`;

test('win32: a long PDF, video or image path stays app mode, handed to its app through the 8.3 short path', () => inTemp((dir) => {
  const deep = deepDir(dir, 170);
  for (const ext of ['.pdf', '.mp4', '.png', '.docx']) {
    const f = put(pathOfLength(deep, WINDOWS_LONG_PATH + 8, ext), 'x');
    const short = fakeShort(SHORT_PDF);
    assert.deepEqual(detect(f, { platform: 'win32', shortPathFn: short }), {
      ok: true, mode: 'app', path: f, ext, openPath: SHORT_PDF, shortPath: true, reasons: [appViaShort(WINDOWS_LONG_PATH + 8, SHORT_PDF.length)],
    }, ext);
    assert.deepEqual(short.calls, [{ p: f, opts: { platform: 'win32' } }], `${ext}: asked once, for the real path`);
  }
}));

test('win32: a long app path without a short path that fits opens as it is, and says it may fail', () => inTemp((dir) => {
  const deep = deepDir(dir, 170);
  const f = put(pathOfLength(deep, WINDOWS_LONG_PATH + 8, '.pdf'), '%PDF-1.4');
  const tooLong = `C:\\${'s'.repeat(WINDOWS_LONG_PATH - 6)}.PDF`;
  for (const [label, fn] of [['null', noShort], ['too long', () => tooLong], ['throws', () => { throw new Error('PowerShell is blocked'); }]]) {
    assert.deepEqual(detect(f, { platform: 'win32', shortPathFn: fn }), {
      ok: true, mode: 'app', path: f, ext: '.pdf',
      reasons: [`path is ${WINDOWS_LONG_PATH + 8} characters; opening it may fail past Windows MAX_PATH, and it has no 8.3 short path of ${WINDOWS_LONG_PATH} characters or fewer`],
    }, label);
  }
}));

test('an app path that fits, or any app path off Windows, never asks for a short path', () => inTemp((dir) => {
  const deep = deepDir(dir, 170);
  const atLimit = put(pathOfLength(deep, WINDOWS_LONG_PATH, '.pdf'), '%PDF-1.4');
  const past = put(pathOfLength(deep, WINDOWS_LONG_PATH + 8, '.mp4'), 'x');
  const unused = fakeShort(SHORT_PDF);
  assert.deepEqual(detect(atLimit, { platform: 'win32', shortPathFn: unused }), { ok: true, mode: 'app', path: atLimit, ext: '.pdf' });
  for (const platform of ['linux', 'darwin']) {
    assert.deepEqual(detect(past, { platform, shortPathFn: unused }), { ok: true, mode: 'app', path: past, ext: '.mp4' }, platform);
  }
  assert.equal(unused.calls.length, 0);
  // A long file that is revealed rather than opened is left to the folder open (lib/open.mjs).
  const script = put(pathOfLength(deep, WINDOWS_LONG_PATH + 8, '.ps1'), 'x');
  assert.equal(detect(script, { platform: 'win32', shortPathFn: unused }).mode, 'folder');
  assert.equal(unused.calls.length, 0);
}));

// ---------------------------------------------------------------------------------------------
// serve mode for folders

test('a folder with index.html is serve mode rooted at the folder', () => inTemp((dir) => {
  put(path.join(dir, 'index.html'), page());
  put(path.join(dir, 'app.js'), 'console.log(1)');
  assert.deepEqual(detect(dir), {
    ok: true, mode: 'serve', path: dir, root: dir, entry: 'index.html', reasons: ['folder with index.html'],
  });
}));

test('a folder with only index.htm is serve mode with entry index.htm', () => inTemp((dir) => {
  put(path.join(dir, 'index.htm'), page());
  const r = detect(dir);
  assert.equal(r.ok, true);
  assert.equal(r.mode, 'serve');
  assert.equal(r.root, dir);
  assert.equal(r.entry, 'index.htm');
  assert.equal(r.reasons.length, 1);
  assert.match(r.reasons[0], /^folder with index\.html?$/);
}));

test('index.html wins over index.htm', () => inTemp((dir) => {
  put(path.join(dir, 'index.htm'), page());
  put(path.join(dir, 'index.html'), page());
  assert.equal(detect(dir).entry, 'index.html');
}));

test('a folder index is served even when the page itself is self-contained', () => inTemp((dir) => {
  put(path.join(dir, 'index.html'), '<p>static</p>');
  assert.equal(detect(dir).mode, 'serve');
  assert.equal(detect(path.join(dir, 'index.html')).mode, 'file');
}));

test('index.html only in a subfolder does not make the parent a site', () => inTemp((dir) => {
  put(path.join(dir, 'dist', 'index.html'), page());
  const r = detect(dir);
  assert.equal(r.mode, 'folder');
  assert.equal(r.select, null);
  assert.equal(detect(path.join(dir, 'dist')).mode, 'serve');
}));

test('a folder named like an HTML file is still a folder', () => inTemp((dir) => {
  const d = path.join(dir, 'site.html');
  mkdirSync(d);
  assert.deepEqual(detect(d), { ok: true, mode: 'folder', path: d, select: null });
  put(path.join(d, 'index.html'), page());
  assert.equal(detect(d).mode, 'serve');
}));

test('a trailing separator on a folder target is dropped', () => inTemp((dir) => {
  put(path.join(dir, 'index.html'), page());
  assert.equal(detect(dir + path.sep).path, dir);
  assert.equal(detect(`${dir}/`).path, dir);
}));

// ---------------------------------------------------------------------------------------------
// dev mode

test('a package.json with scripts.dev is dev mode with the full plan', () => inTemp((dir) => {
  put(path.join(dir, 'package.json'), JSON.stringify({ scripts: { dev: 'vite', build: 'vite build' }, devDependencies: { vite: '^5' } }));
  assert.deepEqual(detect(dir), {
    ok: true, mode: 'dev', path: dir, root: dir, script: 'vite', port: 5173, portSource: 'framework:vite', packageManager: 'npm',
  });
}));

test('dev mode wins over an index.html in the same folder', () => inTemp((dir) => {
  put(path.join(dir, 'index.html'), page('<script type="module" src="/src/main.ts"></script>'));
  put(path.join(dir, 'package.json'), JSON.stringify({ scripts: { dev: 'vite' } }));
  assert.equal(detect(dir).mode, 'dev');
}));

test('dev mode: explicit port, unknown runner, and lockfile-based package manager', () => inTemp((dir) => {
  const a = path.join(dir, 'a');
  put(path.join(a, 'package.json'), JSON.stringify({ scripts: { dev: 'next dev -p 3003' }, dependencies: { next: '14' } }));
  put(path.join(a, 'pnpm-lock.yaml'), '');
  const ra = detect(a);
  assert.equal(ra.mode, 'dev');
  assert.equal(ra.port, 3003);
  assert.equal(ra.portSource, 'script');
  assert.equal(ra.packageManager, 'pnpm');

  const b = path.join(dir, 'b');
  put(path.join(b, 'package.json'), JSON.stringify({ scripts: { dev: 'node server.js' } }));
  put(path.join(b, 'yarn.lock'), '');
  const rb = detect(b);
  assert.equal(rb.mode, 'dev');
  assert.equal(rb.script, 'node server.js');
  assert.equal(rb.port, null);
  assert.equal(rb.portSource, 'unknown');
  assert.equal(rb.packageManager, 'yarn');
}));

test('package.json without a dev script falls back to serve or folder', () => inTemp((dir) => {
  const site = path.join(dir, 'site');
  put(path.join(site, 'package.json'), JSON.stringify({ scripts: { start: 'node server.js', build: 'x' } }));
  put(path.join(site, 'index.html'), page());
  assert.equal(detect(site).mode, 'serve');

  const lib = path.join(dir, 'lib');
  put(path.join(lib, 'package.json'), JSON.stringify({ name: 'lib' }));
  assert.equal(detect(lib).mode, 'folder');

  const blank = path.join(dir, 'blank');
  put(path.join(blank, 'package.json'), JSON.stringify({ scripts: { dev: '' } }));
  assert.equal(detect(blank).mode, 'folder');
}));

test('a malformed package.json is ignored rather than throwing', () => inTemp((dir) => {
  put(path.join(dir, 'package.json'), '{ "scripts": { "dev": "vite", } '); // trailing comma, unclosed
  put(path.join(dir, 'index.html'), page());
  assert.equal(detect(dir).mode, 'serve');
}));

test('a package.json saved with a UTF-8 BOM (Windows editors) still counts as a dev project', () => inTemp((dir) => {
  // npm itself strips the BOM, so `npm run dev` works here; detect should agree.
  put(path.join(dir, 'package.json'), `﻿${JSON.stringify({ scripts: { dev: 'vite' } }, null, 2)}`);
  const r = detect(dir);
  assert.equal(r.mode, 'dev');
  assert.equal(r.script, 'vite');
  assert.equal(r.port, 5173);
}));

test('a package.json over 1 MB, or a folder named package.json, is not read', () => inTemp((dir) => {
  const limit = 1024 * 1024;
  const pkg = (size) => {
    const bare = JSON.stringify({ scripts: { dev: 'vite' }, x: '' });
    return JSON.stringify({ scripts: { dev: 'vite' }, x: 'x'.repeat(size - bare.length) });
  };
  const big = path.join(dir, 'big');
  put(path.join(big, 'package.json'), pkg(limit + 1));
  assert.deepEqual(detect(big, { platform: 'linux' }), { ok: true, mode: 'folder', path: big, select: path.join(big, 'package.json') });
  const fits = path.join(dir, 'fits');
  put(path.join(fits, 'package.json'), pkg(limit));
  assert.equal(detect(fits, { platform: 'linux' }).mode, 'dev');
  const folder = path.join(dir, 'folder');
  mkdirSync(path.join(folder, 'package.json'), { recursive: true });
  put(path.join(folder, 'index.html'), page());
  assert.equal(detect(folder, { platform: 'linux' }).mode, 'serve');
  assert.equal(MAX_PACKAGE_JSON, limit);
  assert.equal(readPackageJson(big, 'linux'), null);
  assert.equal(readPackageJson(folder, 'linux'), null);
  assert.equal(readPackageJson(fits, 'linux').scripts.dev, 'vite');
}));

/** detect(dir) in a child process, killed after 10 s, so a read that blocks or never ends cannot hang the tests. */
function detectInChild(dir, platform) {
  const code = `import(${JSON.stringify(lib('detect.mjs'))}).then((m) => process.stdout.write(JSON.stringify(m.detect(${JSON.stringify(dir)}, { platform: ${JSON.stringify(platform)} }))))`;
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (b) => { out += b; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
    child.on('exit', () => {
      clearTimeout(timer);
      let r = null;
      try { r = JSON.parse(out); } catch { /* killed before it answered */ }
      resolve({ r, ms: Date.now() - t0 });
    });
  });
}

test('a package.json that is a FIFO, or a link to a named pipe, is never opened or read', async (t) => {
  const { dir, cleanup } = tempDir('show-local-detect-');
  let server = null;
  try {
    const file = path.join(dir, 'package.json');
    if (process.platform === 'win32') {
      // A pipe that answers like a package.json: read through the link, it made a dev project.
      const pipe = `\\\\.\\pipe\\show-local-detect-${process.pid}-${Date.now()}`;
      server = net.createServer((s) => { s.on('error', () => {}); s.end(JSON.stringify({ scripts: { dev: 'vite' } })); });
      await new Promise((resolve) => server.listen(pipe, resolve));
      try { symlinkSync(pipe, file, 'file'); } catch { return t.skip('symlinks are not allowed here'); }
    } else if (spawnSync('mkfifo', [file]).status !== 0) {
      // Opened for reading, a FIFO with no writer blocks forever.
      return t.skip('mkfifo is not available');
    }
    const { r, ms } = await detectInChild(dir, process.platform);
    assert.ok(r, `detect did not answer within 10 s (${ms} ms)`);
    assert.deepEqual([r.ok, r.mode], [true, 'folder']);
    assert.equal(readPackageJson(dir), null);
  } finally {
    server?.close();
    cleanup();
  }
});

test('the package.json file itself is an app target, not a dev project', () => inTemp((dir) => {
  const f = put(path.join(dir, 'package.json'), JSON.stringify({ scripts: { dev: 'vite' } }));
  assert.deepEqual(detect(f), { ok: true, mode: 'app', path: f, ext: '.json' });
}));

test('detect has no side effects on the target folder', () => inTemp((dir) => {
  put(path.join(dir, 'package.json'), JSON.stringify({ scripts: { dev: 'vite' } }));
  put(path.join(dir, 'index.html'), page());
  const before = readdirSync(dir).sort();
  detect(dir);
  detect(path.join(dir, 'index.html'), { platform: 'win32' });
  assert.deepEqual(readdirSync(dir).sort(), before);
}));

// ---------------------------------------------------------------------------------------------
// folder and app modes

test('a folder of outputs is folder mode with the main file selected', () => inTemp((dir) => {
  put(path.join(dir, 'clip.mp4'), 'v', T0 + 100);
  put(path.join(dir, 'report.html'), page(), T0);
  put(path.join(dir, 'notes.txt'), 'n', T0 + 200);
  assert.deepEqual(detect(dir), { ok: true, mode: 'folder', path: dir, select: path.join(dir, 'report.html') });
}));

test('an empty folder is folder mode with select null', () => inTemp((dir) => {
  assert.deepEqual(detect(dir), { ok: true, mode: 'folder', path: dir, select: null });
}));

test('documents, images, video and text files are app mode with a lower-cased extension', () => inTemp((dir) => {
  const cases = [
    ['Report.PDF', '.pdf'],
    ['clip.mp4', '.mp4'],
    ['photo.JPEG', '.jpeg'],
    ['page.html.txt', '.txt'],
  ];
  for (const [name, ext] of cases) {
    const f = put(path.join(dir, name), 'x');
    assert.deepEqual(detect(f, { platform: 'win32' }), { ok: true, mode: 'app', path: f, ext }, name);
  }
}));

test('a file with no extension, or one outside the viewable types, is revealed in its folder, never opened', () => inTemp((dir) => {
  // Makefile and .env have no extension (either may be a program); .gz is not a viewable type.
  for (const name of ['Makefile', '.env', 'archive.tar.gz']) {
    const f = put(path.join(dir, name), 'x');
    for (const platform of ['win32', 'darwin', 'linux']) {
      const d = detect(f, { platform });
      assert.equal(d.ok, true, `${platform} ${name}`);
      assert.equal(d.mode, 'folder', `${platform} ${name}`);
      assert.equal(d.path, dir, `${platform} ${name}`);
      assert.equal(d.select, f, `${platform} ${name}: the file itself is selected`);
      assert.ok(Array.isArray(d.reasons) && d.reasons.length > 0, `${platform} ${name}: says why`);
    }
  }
}));

// ---------------------------------------------------------------------------------------------
// pickMainFile

test('pickMainFile: html > video > pdf > image > audio > anything else, regardless of age', () => inTemp((dir) => {
  const order = ['page.html', 'clip.mp4', 'doc.pdf', 'pic.png', 'song.mp3', 'notes.txt'];
  order.forEach((name, i) => put(path.join(dir, name), 'x', T0 + i * 100)); // better rank = older
  for (const name of order) {
    assert.equal(pickMainFile(dir), path.join(dir, name), `expected ${name}`);
    rmSync(path.join(dir, name));
  }
  assert.equal(pickMainFile(dir), null);
}));

test('pickMainFile: every extension in a rank beats the next rank even when older', () => {
  const pairs = [
    ['index.htm', 'clip.mp4'],
    ['clip.mov', 'doc.pdf'], ['clip.webm', 'doc.pdf'], ['clip.mkv', 'doc.pdf'],
    ['doc.pdf', 'pic.jpg'], ['doc.pdf', 'pic.svg'],
    ['pic.jpg', 'song.mp3'], ['pic.jpeg', 'song.wav'], ['pic.webp', 'song.m4a'], ['pic.gif', 'song.mp3'], ['pic.svg', 'song.mp3'],
    ['song.mp3', 'data.csv'], ['song.wav', 'archive.zip'], ['song.m4a', 'readme.md'],
  ];
  for (const [winner, loser] of pairs) {
    inTemp((dir) => {
      put(path.join(dir, winner), 'w', T0);
      put(path.join(dir, loser), 'l', T0 + 500);
      assert.equal(pickMainFile(dir), path.join(dir, winner), `${winner} should beat newer ${loser}`);
    });
  }
});

test('pickMainFile: every video, image and audio type ranks with its kind', () => {
  const pairs = [
    ['clip.wmv', 'doc.pdf'], ['clip.avi', 'doc.pdf'], ['clip.m4v', 'doc.pdf'], ['clip.mpg', 'doc.pdf'], ['clip.mts', 'doc.pdf'], ['clip.ogv', 'doc.pdf'],
    ['doc.pdf', 'pic.heif'], ['pic.jfif', 'song.wma'], ['pic.tiff', 'song.aiff'], ['pic.avif', 'song.opus'],
    ['song.wma', 'notes.txt'], ['song.flac', 'data.json'], ['song.mid', 'readme.md'],
  ];
  for (const [winner, loser] of pairs) {
    inTemp((dir) => {
      put(path.join(dir, winner), 'w', T0);
      put(path.join(dir, loser), 'l', T0 + 500);
      assert.equal(pickMainFile(dir), path.join(dir, winner), `${winner} should beat newer ${loser}`);
    });
  }
});

test('pickMainFile: broadcast and disc video, camera RAW photos and Matroska audio rank with their kind', () => {
  const pairs = [
    ...['mxf', 'vob', 'f4v', 'dv', 'divx', 'asf', 'm2v'].map((ext) => [`clip.${ext}`, 'doc.pdf']),
    ...['dng', 'cr2', 'cr3', 'nef', 'arw', 'orf', 'rw2', 'raf'].map((ext) => [`photo.${ext}`, 'song.mp3']),
    ['doc.pdf', 'photo.nef'], ['song.mka', 'notes.txt'], ['pic.png', 'song.mka'],
    // XPS is a document: viewable, but not ranked above other files.
    ['song.mka', 'doc.xps'],
  ];
  for (const [winner, loser] of pairs) {
    inTemp((dir) => {
      put(path.join(dir, winner), 'w', T0);
      put(path.join(dir, loser), 'l', T0 + 500);
      assert.equal(pickMainFile(dir), path.join(dir, winner), `${winner} should beat newer ${loser}`);
    });
  }
});

test('pickMainFile: .xhtml ranks with HTML, consistent with HTML_EXT', () => inTemp((dir) => {
  put(path.join(dir, 'page.xhtml'), page(), T0);
  put(path.join(dir, 'clip.mp4'), 'v', T0 + 500);
  assert.equal(pickMainFile(dir), path.join(dir, 'page.xhtml'));
}));

test('pickMainFile: within a rank the newest file wins', () => inTemp((dir) => {
  put(path.join(dir, 'a.html'), page(), T0);
  put(path.join(dir, 'b.html'), page(), T0 + 60);
  put(path.join(dir, 'c.htm'), page(), T0 + 30);
  assert.equal(pickMainFile(dir), path.join(dir, 'b.html'));
  put(path.join(dir, 'c.htm'), page(), T0 + 120); // .htm shares the HTML rank
  assert.equal(pickMainFile(dir), path.join(dir, 'c.htm'));
}));

test('pickMainFile: same rank and same mtime falls back to name order', () => inTemp((dir) => {
  put(path.join(dir, 'b.png'), 'x', T0);
  put(path.join(dir, 'a.png'), 'x', T0);
  put(path.join(dir, 'c.jpg'), 'x', T0);
  assert.equal(pickMainFile(dir), path.join(dir, 'a.png'));
}));

test('pickMainFile: extensions are compared case-insensitively', () => inTemp((dir) => {
  put(path.join(dir, 'PAGE.HTML'), page(), T0);
  put(path.join(dir, 'clip.MP4'), 'v', T0 + 500);
  put(path.join(dir, 'doc.Pdf'), 'p', T0 + 900);
  assert.equal(pickMainFile(dir), path.join(dir, 'PAGE.HTML'));
  rmSync(path.join(dir, 'PAGE.HTML'));
  assert.equal(pickMainFile(dir), path.join(dir, 'clip.MP4'));
}));

test('pickMainFile: dotfiles, Thumbs.db and desktop.ini are ignored (any case)', () => inTemp((dir) => {
  put(path.join(dir, '.hidden.html'), page(), T0 + 900);
  put(path.join(dir, '.DS_Store'), 'x', T0 + 900);
  put(path.join(dir, 'Thumbs.db'), 'x', T0 + 900);
  put(path.join(dir, 'Desktop.ini'), 'x', T0 + 900);
  put(path.join(dir, 'pic.png'), 'x', T0);
  assert.equal(pickMainFile(dir), path.join(dir, 'pic.png'));

  const only = path.join(dir, 'only-ignored');
  put(path.join(only, 'THUMBS.DB'), 'x');
  put(path.join(only, 'desktop.INI'), 'x');
  put(path.join(only, '.gitkeep'), '');
  assert.equal(pickMainFile(only), null);

  const lookalike = path.join(dir, 'lookalike');
  put(path.join(lookalike, 'my-thumbs.db'), 'x');
  assert.equal(pickMainFile(lookalike), path.join(lookalike, 'my-thumbs.db'), 'only exact names are ignored');
}));

test('pickMainFile: subfolders are never selected, even ones named like HTML', () => inTemp((dir) => {
  mkdirSync(path.join(dir, 'site.html'));
  mkdirSync(path.join(dir, 'video.mp4'));
  put(path.join(dir, 'pic.png'), 'x', T0);
  assert.equal(pickMainFile(dir), path.join(dir, 'pic.png'));
}));

test('pickMainFile: empty, missing or non-folder paths return null', () => inTemp((dir) => {
  assert.equal(pickMainFile(dir), null, 'empty');
  assert.equal(pickMainFile(path.join(dir, 'missing')), null, 'missing');
  const f = put(path.join(dir, 'file.html'), page());
  assert.equal(pickMainFile(f), null, 'a file, not a folder');
}));

// ---------------------------------------------------------------------------------------------
// devPort

test('devPort: explicit --port, --port=, -p and PORT= win and report source "script"', () => {
  const cases = [
    ['vite --port 3001', 3001],
    ['astro dev --port=3002', 3002],
    ['next dev -p 3003', 3003],
    ['PORT=3004 node server.js', 3004],
    ['-p 3005', 3005],
    ['cross-env PORT=3006 react-scripts start', 3006],
    ['set PORT=3007&& react-scripts start', 3007],
    ['vite --port  3008 --host', 3008],
    ['nuxt dev --port 30011', 30011],
    ['serve --port 80', 80],
  ];
  for (const [script, port] of cases) {
    assert.deepEqual(devPort(script), { port, source: 'script' }, script);
  }
});

test('devPort: an explicit port beats the framework default', () => {
  assert.deepEqual(devPort('next dev -p 4000', { dependencies: { next: '14' } }), { port: 4000, source: 'script' });
  assert.deepEqual(devPort('vite --port=5174', { devDependencies: { vite: '5' } }), { port: 5174, source: 'script' });
});

test('devPort: framework defaults from dependencies and devDependencies', () => {
  const cases = [
    ['next', 3000], ['nuxt', 3000], ['astro', 4321], ['@sveltejs/kit', 5173], ['vite', 5173],
    ['gatsby', 8000], ['parcel', 1234], ['webpack-dev-server', 8080], ['@11ty/eleventy', 8080], ['react-scripts', 3000],
  ];
  for (const [name, port] of cases) {
    const expected = { port, source: `framework:${name}` };
    assert.deepEqual(devPort('run-my-dev', { dependencies: { [name]: '1.0.0' } }), expected, `${name} in dependencies`);
    assert.deepEqual(devPort('run-my-dev', { devDependencies: { [name]: '1.0.0' } }), expected, `${name} in devDependencies`);
  }
});

test('devPort: framework defaults from the script text', () => {
  const cases = [
    ['next dev', 3000, 'next'],
    ['next', 3000, 'next'],
    ['vite', 5173, 'vite'],
    ['vite dev --host', 5173, 'vite'],
    ['npx vite', 5173, 'vite'],
    ['astro dev', 4321, 'astro'],
    ['nuxt dev', 3000, 'nuxt'],
    ['@sveltejs/kit dev', 5173, '@sveltejs/kit'],
    ['node_modules/.bin/next dev', 3000, 'next'],
    ['npm run build && astro dev', 4321, 'astro'],
    ['gatsby develop', 8000, 'gatsby'],
    ['parcel index.html', 1234, 'parcel'],
    ['webpack-dev-server --open', 8080, 'webpack-dev-server'],
    ['react-scripts start', 3000, 'react-scripts'],
  ];
  for (const [script, port, name] of cases) {
    assert.deepEqual(devPort(script, {}), { port, source: `framework:${name}` }, script);
  }
});

test('devPort: framework names inside other words, lookalike flags and bad numbers do not count', () => {
  const unknown = { port: null, source: 'unknown' };
  for (const script of [
    'vitest', 'nextra build', 'my-vite-plugin serve', 'astronaut', 'next-sitemap',
    'MYPORT=5000 node s.js', 'VITE_PORT=5000 node s.js', 'node s.js --portal 3000',
    'serve -p 3', 'tsc -p tsconfig.json && node dist/server.js', 'node s.js --port 123456',
  ]) {
    assert.deepEqual(devPort(script, {}), unknown, script);
  }
});

test('devPort: missing, empty or unrelated inputs give port null / source unknown', () => {
  const unknown = { port: null, source: 'unknown' };
  assert.deepEqual(devPort(), unknown);
  assert.deepEqual(devPort(undefined, undefined), unknown);
  assert.deepEqual(devPort(null, null), unknown);
  assert.deepEqual(devPort('', {}), unknown);
  assert.deepEqual(devPort('node server.js', { dependencies: { react: '18', express: '4' } }), unknown);
  assert.deepEqual(devPort('node server.js', { dependencies: null, devDependencies: null }), unknown);
});

test('devPort: with several frameworks in dependencies the more specific one wins', () => {
  const cases = [
    [{ next: '14', vite: '5' }, 3000, 'next'],
    [{ astro: '4', vite: '5' }, 4321, 'astro'],
    [{ nuxt: '3', vite: '5' }, 3000, 'nuxt'],
    [{ '@sveltejs/kit': '2', vite: '5' }, 5173, '@sveltejs/kit'],
  ];
  for (const [deps, port, name] of cases) {
    assert.deepEqual(devPort('run-my-dev', { devDependencies: deps }), { port, source: `framework:${name}` }, name);
  }
});

test('devPort: the framework the dev script runs beats a different one that is only a dependency', () => {
  // e.g. a Gatsby site with vite in devDependencies for Vitest/Storybook: `gatsby develop` listens on 8000.
  assert.deepEqual(devPort('gatsby develop', { devDependencies: { vite: '5', gatsby: '5' } }), { port: 8000, source: 'framework:gatsby' });
  assert.deepEqual(devPort('react-scripts start', { devDependencies: { vite: '5' } }), { port: 3000, source: 'framework:react-scripts' });
});

test('devPort: Angular (ng serve) defaults to 4200', () => {
  assert.deepEqual(devPort('ng serve', {}), { port: 4200, source: 'framework:@angular/cli' });
  assert.deepEqual(devPort('run-my-dev', { devDependencies: { '@angular/cli': '17' } }), { port: 4200, source: 'framework:@angular/cli' });
});

test('devPort: `vite preview` serves on Vite\'s preview port 4173, and a `build` before it serves nothing', () => {
  const preview = { port: 4173, source: 'framework:vite' };
  for (const script of ['vite preview', 'npx vite preview --host', 'vite  preview --open', 'vite build && vite preview', 'tsc && vite build && vite preview']) {
    assert.deepEqual(devPort(script, { devDependencies: { vite: '5' } }, { env: {} }), preview, script);
  }
  // The explicit port still comes first; plain `vite` and `vite dev` stay the dev server.
  assert.deepEqual(devPort('vite preview --port 8080', {}, { env: {} }), { port: 8080, source: 'script' });
  assert.deepEqual(devPort('vite', {}, { env: {} }), { port: 5173, source: 'framework:vite' });
  assert.deepEqual(devPort('vite dev', {}, { env: {} }), { port: 5173, source: 'framework:vite' });
  assert.deepEqual(devPort('next build && next start', {}, { env: {} }), { port: 3000, source: 'framework:next' });
  // Only the script says "preview": vite in the dependencies is the dev server.
  assert.deepEqual(devPort('run-my-preview', { devDependencies: { vite: '5' } }, { env: {} }), { port: 5173, source: 'framework:vite' });
});

test('devPort: `remix vite:dev` is Vite\'s dev server (5173); Remix alone is not guessed', () => {
  assert.deepEqual(devPort('remix vite:dev', {}, { env: {} }), { port: 5173, source: 'framework:vite' });
  assert.deepEqual(devPort('cross-env NODE_ENV=development remix vite:dev --host', {}, { env: {} }), { port: 5173, source: 'framework:vite' });
  assert.deepEqual(devPort('remix vite:dev --port 3000', {}, { env: {} }), { port: 3000, source: 'script' });
  for (const script of ['remix dev', 'remix vite:build', 'myremix vite:dev']) {
    assert.deepEqual(devPort(script, { devDependencies: { '@remix-run/dev': '2' } }, { env: {} }), { port: null, source: 'unknown' }, script);
  }
});

// ---------------------------------------------------------------------------------------------
// devPort: the project's own config and .env files come before the framework default

/** A dev project in a fresh folder: package.json plus the given files; returns detect(dir). */
function project(dir, dev, files = {}, deps = {}) {
  put(path.join(dir, 'package.json'), JSON.stringify({ scripts: { dev }, devDependencies: deps }));
  for (const [name, content] of Object.entries(files)) put(path.join(dir, name), content);
  return detect(dir, { platform: 'linux' });
}

test('devPort: vite.config.ts server.port 3000 → 3000 from config:vite.config.ts', () => inTemp((dir) => {
  const cfg = "import { defineConfig } from 'vite';\nexport default defineConfig({\n  plugins: [react()],\n  server: { port: 3000, strictPort: true },\n});\n";
  const d = project(dir, 'vite', { 'vite.config.ts': cfg }, { vite: '5' });
  assert.deepEqual(d, {
    ok: true, mode: 'dev', path: dir, root: dir, script: 'vite', port: 3000, portSource: 'config:vite.config.ts', packageManager: 'npm',
  });
  assert.deepEqual(devPort('vite', { devDependencies: { vite: '5' } }, { dir, platform: 'linux' }), { port: 3000, source: 'config:vite.config.ts' });
  assert.deepEqual(devPort('vite', { devDependencies: { vite: '5' } }), { port: 5173, source: 'framework:vite' }, 'no folder, no config');
}));

test('devPort: an explicit port in the script beats the config file', () => inTemp((dir) => {
  const d = project(dir, 'vite --port 3005', { 'vite.config.ts': 'export default { server: { port: 3000 } }' });
  assert.equal(d.port, 3005);
  assert.equal(d.portSource, 'script');
}));

test('devPort: `vite preview` reads preview.port from the config, never server.port; `remix vite:dev` reads server.port', () => inTemp((dir) => {
  const both = 'export default defineConfig({\n  server: { port: 3000 },\n  preview: { port: 8080 },\n});\n';
  let d = project(dir, 'vite preview', { 'vite.config.ts': both });
  assert.equal(d.port, 8080);
  assert.equal(d.portSource, 'config:vite.config.ts');
  d = project(dir, 'vite build && vite preview', { 'vite.config.ts': 'export default { server: { port: 3000 } }' });
  assert.deepEqual([d.port, d.portSource], [4173, 'framework:vite'], 'server.port is the dev server\'s, not the preview\'s');
  d = project(dir, 'vite preview --port 9000', { 'vite.config.ts': both });
  assert.deepEqual([d.port, d.portSource], [9000, 'script']);
  d = project(dir, 'remix vite:dev', { 'vite.config.ts': both });
  assert.deepEqual([d.port, d.portSource], [3000, 'config:vite.config.ts']);
  d = project(dir, 'vite', { 'vite.config.ts': both });
  assert.deepEqual([d.port, d.portSource], [3000, 'config:vite.config.ts'], 'the dev server still reads server.port');
}));

test('devPort: config shapes that name the port: arrow functions, return, variables, quoted keys, JS/MJS/CJS', () => {
  const cases = [
    ['vite.config.js', 'export default defineConfig(({ command }) => ({ server: { port: 3100 } }))', 3100],
    ['vite.config.mjs', 'export default defineConfig(({ mode }) => {\n  const env = loadEnv(mode, process.cwd());\n  return { server: { host: true, port: 3101 } };\n});', 3101],
    ['vite.config.ts', 'const serverOptions = { port: 3102, open: false };\nexport default defineConfig({ server: serverOptions });', 3102],
    ['vite.config.ts', 'const server = { port: 3103 };\nexport default defineConfig({ server });', 3103],
    ['vite.config.cjs', "module.exports = { 'server': { \"port\": 3104 } };", 3104],
    ['vite.config.ts', 'export default { server: { port: 3105 } } satisfies UserConfig;', 3105],
  ];
  for (const [file, code, port] of cases) {
    inTemp((dir) => {
      const d = project(dir, 'vite', { [file]: code });
      assert.equal(d.port, port, code);
      assert.equal(d.portSource, `config:${file}`, code);
    });
  }
});

test('devPort: ports of other settings (hmr, preview, test, plugins), comments and strings are not the dev port', () => inTemp((dir) => {
  const cfg = [
    '// server: { port: 9999 },',
    '/* server: { port: 9998 } */',
    "const note = 'server: { port: 9997 }';",
    'const re = /server: { port: 9996 }/;',
    'export default defineConfig({',
    '  server: { hmr: { port: 24678, clientPort: 443 }, proxy: { "/api": { target: "http://localhost:4000" } } },',
    '  preview: { port: 4173 },',
    '  test: { browser: { api: { port: 63315 } } },',
    '  plugins: [inspect({ port: 5555 })],',
    '});',
  ].join('\n');
  const d = project(dir, 'vite', { 'vite.config.ts': cfg });
  assert.equal(d.port, 5173);
  assert.equal(d.portSource, 'framework:vite');
}));

test('devPort: only the config\'s own server counts, not a plugin\'s, another tool\'s or a mock server\'s', () => {
  const cases = [
    // A plugin's options, even when they are named `server`.
    ['vite', 'vite.config.ts', 'export default defineConfig({ plugins: [react(), mockApi({ server: { port: 9999 } })] })', 5173, 'framework:vite'],
    ['vite', 'vite.config.ts', 'const mockOptions = { port: 9999 };\nexport default defineConfig({ plugins: [mock({ server: mockOptions })] })', 5173, 'framework:vite'],
    // A top-level variable that holds what a call returns is not an object literal named `server`.
    ['vite', 'vite.config.js', 'const server = startMock({ port: 8787 });\nexport default defineConfig({ plugins: [react()] })', 5173, 'framework:vite'],
    // Astro starts Vite on its own server.port; nitro's devServer is not nuxi's.
    ['astro dev', 'astro.config.mjs', 'export default defineConfig({ vite: { server: { port: 5000 } } })', 4321, 'framework:astro'],
    ['nuxt dev', 'nuxt.config.ts', 'export default defineNuxtConfig({ nitro: { devServer: { port: 7777 } } })', 3000, 'framework:nuxt'],
    // The real port is kept next to a plugin's.
    ['vite', 'vite.config.ts', 'export default defineConfig({ server: { port: 3001 }, plugins: [api({ server: { port: 9999 } })] })', 3001, 'config:vite.config.ts'],
    // Still the config's own: through a variable, a wrapper call or mergeConfig.
    ['vite', 'vite.config.ts', 'const config = defineConfig({ server: { port: 3200 } });\nexport default config;', 3200, 'config:vite.config.ts'],
    ['vite', 'vite.config.ts', 'const config = { server: { port: 3201 } };\nexport default defineConfig(config);', 3201, 'config:vite.config.ts'],
    ['vite', 'vite.config.ts', 'export default mergeConfig(base, { server: { port: 3202 } })', 3202, 'config:vite.config.ts'],
    ['nuxt dev', 'nuxt.config.ts', 'export default defineNuxtConfig({ nitro: { devServer: { port: 7777 } }, devServer: { port: 3203 } })', 3203, 'config:nuxt.config.ts'],
  ];
  for (const [dev, file, code, port, source] of cases) {
    inTemp((dir) => {
      const d = project(dir, dev, { [file]: code });
      assert.deepEqual([d.port, d.portSource], [port, source], code);
    });
  }
});

test('devPort: a config nested more than 64 objects deep makes the port unknown, promptly', () => inTemp((dir) => {
  // Every port used to copy the whole nesting: 200k levels and 46k ports (a 512 KB file) ran
  // out of memory. 5k by 5k already made 25M path entries. (Counts only: a failing deepEqual
  // would print all of them.)
  let t0 = Date.now();
  for (const [depth, n] of [[5000, 5000], [200000, 46000]]) {
    const r = portProperties(`${'{'.repeat(depth)}${'port:1,'.repeat(n)}`);
    assert.deepEqual([r.tooDeep, r.ports.length, r.aliases.length], [true, 0, 0], `${depth} deep, ${n} ports`);
  }
  assert.ok(Date.now() - t0 < 5000, `${Date.now() - t0} ms`);
  const d = project(dir, 'vite', { 'vite.config.ts': `export default { server: { port: 3000 } };\n${'{'.repeat(5000)}${'port:1,'.repeat(5000)}` });
  assert.deepEqual([d.port, d.portSource, d.portNote], [null, 'unknown', 'vite.config.ts nests objects more than 64 deep, too deep to read']);
  // Up to the limit a config is read as before, however many ports it has.
  assert.equal(MAX_CONFIG_DEPTH, 64);
  t0 = Date.now();
  assert.equal(portProperties(`${'{'.repeat(MAX_CONFIG_DEPTH)}${'port:1,'.repeat(70000)}`).ports.length, 70000);
  assert.ok(Date.now() - t0 < 5000, `${Date.now() - t0} ms at the limit`);
  const deep = (n) => `export default { server: ${'{ a: '.repeat(n - 2)}{ port: 3000 }${' }'.repeat(n - 2)}, x: { server: { port: 1 } } }`;
  assert.equal(portProperties(deep(MAX_CONFIG_DEPTH)).tooDeep, undefined);
  assert.equal(portProperties(deep(MAX_CONFIG_DEPTH + 1)).tooDeep, true);
}));

test('devPort: a config port that is not a literal number makes the port unknown, never the framework default', () => {
  const cases = [
    ['export default { server: { port: Number(process.env.PORT) || 3000 } }', /sets the port to Number\(process\.env\.PORT\) \|\| 3000,/],
    ['export default { server: { port: process.env.PORT } }', /sets the port to process\.env\.PORT,/],
    ['export default { server: { port: env?.PORT } }', /sets the port to env\?\.PORT,/],
    ['const port = 3000;\nexport default { server: { port } }', /sets the port to port,/],
    ['export default { server: { port: isCI ? 4000 : 3000 } }', /isCI \? 4000 : 3000/],
    ["export default { server: { port: '3000' } }", /'3000'/],
    ['export default { server: { port: 0 } }', /sets the port to 0,/],
    ['export default defineConfig(({ command }) => ({ server: { port: command === "build" ? 1 : 2 } }))', /command === "build"/],
  ];
  for (const [code, text] of cases) {
    inTemp((dir) => {
      const d = project(dir, 'vite', { 'vite.config.ts': code });
      assert.equal(d.port, null, code);
      assert.equal(d.portSource, 'unknown', code);
      assert.match(d.portNote, /^vite\.config\.ts sets the port to .*, not a literal number$/, code);
      assert.match(d.portNote, text, code);
    });
  }
  inTemp((dir) => {
    const d = project(dir, 'vite', { 'vite.config.ts': 'export default process.env.CI ? { server: { port: 3000 } } : { server: { port: 4000 } }' });
    assert.equal(d.port, null);
    assert.equal(d.portNote, 'vite.config.ts names several ports (3000, 4000)');
  });
});

test('devPort: the first config file in the framework\'s own lookup order is the one read', () => inTemp((dir) => {
  const d = project(dir, 'vite', {
    'vite.config.ts': 'export default { server: { port: 3001 } }',
    'vite.config.js': 'export default { server: { port: 3002 } }',
  });
  assert.equal(d.port, 3002);
  assert.equal(d.portSource, 'config:vite.config.js');
}));

test('devPort: Astro, SvelteKit, Nuxt, webpack-dev-server and Angular read their own config files', () => {
  const cases = [
    ['astro dev', { 'astro.config.mjs': "import { defineConfig } from 'astro/config';\nexport default defineConfig({ server: { port: 4322 } });" }, 4322, 'config:astro.config.mjs'],
    ['vite dev', { 'vite.config.ts': "import { sveltekit } from '@sveltejs/kit/vite';\nexport default { plugins: [sveltekit()], server: { port: 5180 } };" }, 5180, 'config:vite.config.ts'],
    ['nuxt dev', { 'nuxt.config.ts': 'export default defineNuxtConfig({ devtools: { enabled: true }, devServer: { port: 3333 } })' }, 3333, 'config:nuxt.config.ts'],
    ['webpack serve', { 'webpack.config.js': "module.exports = { entry: './src', devServer: { static: './dist', port: 8081 } };" }, 8081, 'config:webpack.config.js'],
    ['ng serve', {
      'angular.json': JSON.stringify({ projects: { app: { architect: { build: { options: { outputPath: 'dist' } }, serve: { builder: '@angular-devkit/build-angular:dev-server', options: { port: 4300 } } } } } }, null, 2),
    }, 4300, 'config:angular.json'],
  ];
  for (const [dev, files, port, source] of cases) {
    inTemp((dir) => {
      const d = project(dir, dev, files);
      assert.equal(d.port, port, dev);
      assert.equal(d.portSource, source, dev);
    });
  }
});

test('devPort: a config file of a framework the project does not run is not read', () => inTemp((dir) => {
  // A Next.js app with vite.config.ts for Vitest: next listens on 3000 whatever vite would do.
  const d = project(dir, 'next dev', { 'vite.config.ts': 'export default { server: { port: 3999 } }' }, { next: '14', vite: '5' });
  assert.equal(d.port, 3000);
  assert.equal(d.portSource, 'framework:next');
}));

test('devPort: .env PORT=3001 → 3001 from env:.env, for the runners that read it', () => inTemp((dir) => {
  const cra = path.join(dir, 'cra');
  let d = project(cra, 'react-scripts start', { '.env': 'BROWSER=none\nPORT=3001\n' });
  assert.equal(d.port, 3001);
  assert.equal(d.portSource, 'env:.env');
  // A server show-local does not know (node + dotenv) reads it too.
  const custom = path.join(dir, 'custom');
  d = project(custom, 'node server.js', { '.env': 'PORT=3001' });
  assert.deepEqual([d.port, d.portSource], [3001, 'env:.env']);
  assert.deepEqual(devPort('node server.js', {}, { dir: custom, platform: 'linux' }), { port: 3001, source: 'env:.env' });
}));

test('devPort: .env files, most specific first; quotes, export, comments and a BOM are handled', () => inTemp((dir) => {
  const dev = 'node server.js';
  const cases = [
    [{ '.env': 'PORT=3001', '.env.development': 'PORT=3002' }, 3002, '.env.development'],
    [{ '.env': 'PORT=3001', '.env.development': 'PORT=3002', '.env.local': 'PORT=3003' }, 3003, '.env.local'],
    [{ '.env.local': 'PORT=3003', '.env.development.local': 'PORT=3004' }, 3004, '.env.development.local'],
    [{ '.env.local': 'API=1\n', '.env': 'PORT=3005' }, 3005, '.env'],
    [{ '.env': 'export PORT="3006" # dev' }, 3006, '.env'],
    [{ '.env': "PORT='3007'" }, 3007, '.env'],
    [{ '.env': 'PORT = 3008   # the dev server' }, 3008, '.env'],
    [{ '.env': '\uFEFFPORT=3009\r\nHOST=x\r\n' }, 3009, '.env'],
    [{ '.env': 'PORT=3010\nPORT=3011' }, 3011, '.env'],
    [{ '.env': 'PORT=3012 # a\r# b\rHOST=x' }, 3012, '.env'],
  ];
  cases.forEach(([files, port, file], i) => {
    const d = project(path.join(dir, `p${i}`), dev, files);
    assert.deepEqual([d.port, d.portSource], [port, `env:${file}`], JSON.stringify(files));
  });
  const none = project(path.join(dir, 'none'), dev, { '.env': 'API_PORT=4000\nMYPORT=1\n# PORT=5\n' });
  assert.deepEqual([none.port, none.portSource], [null, 'unknown']);
}));

test('devPort: an empty PORT= in a more specific .env file hides the others, as dotenv never overrides a set variable', () => inTemp((dir) => {
  // Create React App then takes parseInt('') || 3000; a server show-local does not know, unknown.
  const cra = project(path.join(dir, 'cra'), 'react-scripts start', { '.env.development.local': 'PORT=\n', '.env': 'PORT=4002\n' });
  assert.deepEqual([cra.port, cra.portSource], [3000, 'framework:react-scripts']);
  const custom = project(path.join(dir, 'custom'), 'node server.js', { '.env.local': 'PORT=', '.env': 'PORT=3012' });
  assert.deepEqual([custom.port, custom.portSource], [null, 'unknown']);
}));

test('devPort: a .env line with a long run of spaces is read in one pass', () => inTemp((dir) => {
  // .replace(/\s+#.*$/) retried from every space: 100k spaces took 17 s.
  const t0 = Date.now();
  const d = project(dir, 'node server.js', { '.env': `PORT=1${' '.repeat(100000)}x\n` });
  assert.ok(Date.now() - t0 < 1000, `${Date.now() - t0} ms`);
  assert.deepEqual([d.port, d.portSource], [null, 'unknown']);
  assert.match(d.portNote, /^\.env sets PORT to "1 {58}…", not a literal number$/);
  const c = project(path.join(dir, 'c'), 'node server.js', { '.env': `PORT=3013${' '.repeat(100000)}# comment\n` });
  assert.deepEqual([c.port, c.portSource], [3013, 'env:.env']);
}));

test('devPort: a .env PORT that is not a literal number makes the port unknown, with a note', () => inTemp((dir) => {
  for (const [value, i] of [['${API_PORT}', 0], ['abc', 1], ['70000', 2], ['0', 3]]) {
    const d = project(path.join(dir, `p${i}`), 'react-scripts start', { '.env': `PORT=${value}` });
    assert.equal(d.port, null, value);
    assert.equal(d.portSource, 'unknown', value);
    assert.equal(d.portNote, `.env sets PORT to "${value}", not a literal number`, value);
  }
}));

test('devPort: Vite, Next.js, Astro and other runners that ignore .env PORT keep their own port', () => inTemp((dir) => {
  const cases = [['vite', 5173, 'framework:vite'], ['next dev', 3000, 'framework:next'], ['astro dev', 4321, 'framework:astro'], ['gatsby develop', 8000, 'framework:gatsby']];
  cases.forEach(([dev, port, source], i) => {
    const d = project(path.join(dir, `p${i}`), dev, { '.env': 'PORT=4000' });
    assert.deepEqual([d.port, d.portSource], [port, source], dev);
  });
  const both = project(path.join(dir, 'both'), 'vite', { '.env': 'PORT=4000', 'vite.config.ts': 'export default { server: { port: 3000 } }' });
  assert.deepEqual([both.port, both.portSource], [3000, 'config:vite.config.ts']);
}));

test('devPort: nuxi reads only .env, NUXT_PORT first, then NITRO_PORT, then PORT', () => inTemp((dir) => {
  const cases = [
    [{ '.env.local': 'PORT=4001' }, 3000, 'framework:nuxt'],
    [{ '.env.development': 'PORT=4003', '.env.development.local': 'NUXT_PORT=4004' }, 3000, 'framework:nuxt'],
    [{ '.env': 'NUXT_PORT=4000' }, 4000, 'env:.env'],
    [{ '.env': 'NITRO_PORT=4002' }, 4002, 'env:.env'],
    [{ '.env': 'PORT=4005\nNUXT_PORT=4004' }, 4004, 'env:.env'],
    [{ '.env': 'PORT=4005\nNITRO_PORT=4006' }, 4006, 'env:.env'],
    [{ '.env': 'NUXT_PORT=\nPORT=4007' }, 4007, 'env:.env'],
  ];
  cases.forEach(([files, port, source], i) => {
    const d = project(path.join(dir, `p${i}`), 'nuxt dev', files);
    assert.deepEqual([d.port, d.portSource], [port, source], JSON.stringify(files));
  });
  const bad = project(path.join(dir, 'bad'), 'nuxi dev', { '.env': 'NUXT_PORT=abc\nPORT=4008' });
  assert.deepEqual([bad.port, bad.portSource, bad.portNote], [null, 'unknown', '.env sets NUXT_PORT to "abc", not a literal number']);
}));

test('devPort: a nuxi .env port that nuxt.config or the environment contradicts is unknown, as nuxi versions disagree', () => inTemp((dir) => {
  // nuxi 3.15 took .env over devServer.port; later versions read .env only for the default.
  const config = 'export default defineNuxtConfig({ devServer: { port: 3400 } })';
  const both = project(path.join(dir, 'both'), 'nuxt dev', { '.env': 'PORT=3401', 'nuxt.config.ts': config });
  assert.deepEqual([both.port, both.portSource, both.portNote], [
    null, 'unknown', '.env sets PORT to 3401 but nuxt.config.ts sets the port to 3400, and versions of nuxt differ on which wins',
  ]);
  const same = project(path.join(dir, 'same'), 'nuxt dev', { '.env': 'PORT=3400', 'nuxt.config.ts': config });
  assert.deepEqual([same.port, same.portSource], [3400, 'env:.env']);
  const onlyConfig = project(path.join(dir, 'config'), 'nuxt dev', { 'nuxt.config.ts': config });
  assert.deepEqual([onlyConfig.port, onlyConfig.portSource], [3400, 'config:nuxt.config.ts']);
  const exprConfig = project(path.join(dir, 'expr'), 'nuxt dev', { '.env': 'PORT=3401', 'nuxt.config.ts': 'export default defineNuxtConfig({ devServer: { port: Number(process.env.P) } })' });
  assert.deepEqual([exprConfig.port, exprConfig.portSource], [null, 'unknown']);
  // What nuxi inherits decides in every version, over nuxt.config and over .env.
  put(path.join(dir, 'both', '.env'), 'NUXT_PORT=3402');
  assert.deepEqual(devPort('nuxt dev', {}, { dir: path.join(dir, 'both'), platform: 'linux', env: { NUXT_PORT: '3500' } }), { port: 3500, source: 'env:NUXT_PORT' });
  assert.deepEqual(devPort('nuxt dev', {}, { dir: path.join(dir, 'config'), platform: 'linux', env: { PORT: '3501' } }), { port: 3501, source: 'env:PORT' });
  // An inherited PORT against a .env NUXT_PORT: 3.15 took NUXT_PORT, later versions PORT.
  assert.deepEqual(devPort('nuxt dev', {}, { dir: path.join(dir, 'both'), platform: 'linux', env: { PORT: '3502' } }), {
    port: null, source: 'unknown', note: '.env sets NUXT_PORT to 3402 but PORT in the environment is 3502, and versions of nuxt differ on which wins',
  });
}));

test('devPort: the environment the runner inherits beats its .env files, for the runners that read it', () => inTemp((dir) => {
  const at = (name, dev, files) => { project(path.join(dir, name), dev, files); return { dir: path.join(dir, name), platform: 'linux' }; };
  const cra = at('cra', 'react-scripts start', { '.env': 'PORT=4002' });
  assert.deepEqual(devPort('react-scripts start', {}, { ...cra, env: { PORT: '5055' } }), { port: 5055, source: 'env:PORT' });
  assert.deepEqual(devPort('react-scripts start', {}, { ...cra, env: {} }), { port: 4002, source: 'env:.env' });
  // Set but empty: dotenv leaves it empty, and CRA falls back to 3000.
  assert.deepEqual(devPort('react-scripts start', {}, { ...cra, env: { PORT: '' } }), { port: 3000, source: 'framework:react-scripts' });
  assert.deepEqual(devPort('react-scripts start', {}, { ...cra, env: { PORT: 'abc' } }), {
    port: null, source: 'unknown', note: 'PORT in the environment is "abc", not a literal number',
  });
  // next dev reads PORT from what it inherits, but not from .env.
  const next = at('next', 'next dev', { '.env': 'PORT=4002' });
  assert.deepEqual(devPort('next dev', {}, { ...next, env: { PORT: '5056' } }), { port: 5056, source: 'env:PORT' });
  assert.deepEqual(devPort('next dev', {}, { ...next, env: {} }), { port: 3000, source: 'framework:next' });
  assert.deepEqual(devPort('next dev', {}, { env: { PORT: '5056' } }), { port: 5056, source: 'env:PORT' }, 'no folder needed');
  const custom = at('custom', 'node server.js', {});
  assert.deepEqual(devPort('node server.js', {}, { ...custom, env: { PORT: '5057' } }), { port: 5057, source: 'env:PORT' });
  // Vite, Astro and the rest never read it; an explicit flag beats it.
  const vite = at('vite', 'vite', {});
  assert.deepEqual(devPort('vite', {}, { ...vite, env: { PORT: '5058' } }), { port: 5173, source: 'framework:vite' });
  assert.deepEqual(devPort('next dev -p 3100', {}, { ...next, env: { PORT: '5056' } }), { port: 3100, source: 'script' });
  // detect passes its env through, and defaults to process.env.
  const d = detect(path.join(dir, 'cra'), { platform: 'linux', env: { PORT: '5059' } });
  assert.deepEqual([d.port, d.portSource], [5059, 'env:PORT']);
  process.env.PORT = '5060';
  try {
    assert.deepEqual([detect(path.join(dir, 'cra'), { platform: 'linux' }).port], [5060]);
  } finally { delete process.env.PORT; }
}));

test('devPort: a port flag that names a variable takes it from the environment, or the port is unknown', () => {
  const cases = [
    ['vite --port $PORT', { PORT: '4100' }, { port: 4100, source: 'env:PORT' }],
    ['vite --port "$PORT"', { PORT: '4101' }, { port: 4101, source: 'env:PORT' }],
    ['vite --port=${DEV_PORT}', { DEV_PORT: '4102' }, { port: 4102, source: 'env:DEV_PORT' }],
    ['vite --port=%PORT%', { PORT: '4103' }, { port: 4103, source: 'env:PORT' }],
    ['next dev -p $PORT', { PORT: '4104' }, { port: 4104, source: 'env:PORT' }],
    ['PORT=$API_PORT react-scripts start', { API_PORT: '4105' }, { port: 4105, source: 'env:API_PORT' }],
    ['vite --port ${PORT:-4106}', {}, { port: 4106, source: 'env:PORT' }],
    ['vite --port ${PORT:-4106}', { PORT: '' }, { port: 4106, source: 'env:PORT' }],
    ['vite --port ${PORT-4106}', { PORT: '4107' }, { port: 4107, source: 'env:PORT' }],
    ['vite --port $PORT', {}, { port: null, source: 'unknown', note: 'the script takes the port from PORT, which is not set' }],
    ['vite --port=%PORT%', { PORT: '' }, { port: null, source: 'unknown', note: 'the script takes the port from PORT, which is empty' }],
    ['vite --port ${PORT-4106}', { PORT: '' }, { port: null, source: 'unknown', note: 'the script takes the port from PORT, which is empty' }],
    ['vite --port $PORT', { PORT: 'x' }, { port: null, source: 'unknown', note: 'the script takes the port from PORT, which is "x", not a literal number' }],
    ['concurrently "vite --port $PORT" "api --port 4000"', { PORT: '4108' }, { port: null, source: 'ambiguous', candidates: [4000, 4108] }],
    ['concurrently "vite --port $PORT" "api --port 4000"', {}, { port: null, source: 'unknown', note: 'the script takes the port from PORT, which is not set' }],
    ['vite --port 3000 --host $HOST', {}, { port: 3000, source: 'script' }],
  ];
  for (const [script, env, want] of cases) assert.deepEqual(devPort(script, {}, { env }), want, `${script} ${JSON.stringify(env)}`);
});

test('portProperties: every port property with the objects around it', () => {
  const { ports, aliases } = portProperties([
    'const base = { port: 1 };',
    'export default {',
    '  server: { port: 2, hmr: { port: 3 } },',
    '  preview: { port: 4 },',
    '  other: opts,',
    '  list: [{ port: 5 }],',
    '  f() { return { port: 6 } },',
    '  plugins: [p({ server: mockOptions })],',
    '};',
    'const mock = startMock({ port: 7 });',
  ].join('\n'));
  assert.deepEqual(ports.map((p) => [p.path, p.port]), [
    [['base'], 1], [[null, 'server'], 2], [[null, 'server', 'hmr'], 3], [[null, 'preview'], 4], [[null, 'list'], 5], [[null, null, null], 6],
    [[null], 7],
  ]);
  assert.deepEqual(aliases, [['other', 'opts', [null]], ['server', 'mockOptions', [null, 'plugins']]]);
  assert.deepEqual(portProperties('').ports, []);
  assert.deepEqual(portProperties('export default { server: { port: `${x}` } }').ports.map((p) => p.port), [null]);
  assert.deepEqual(portProperties('{ "port": 8080 }').ports.map((p) => [p.path, p.port]), [[[null], 8080]]);
});

// ---------------------------------------------------------------------------------------------
// packageManager

test('packageManager: chosen by lockfile, pnpm > yarn > bun > npm', () => inTemp((dir) => {
  const cases = [
    [[], 'npm'],
    [['package-lock.json'], 'npm'],
    [['pnpm-lock.yaml'], 'pnpm'],
    [['yarn.lock'], 'yarn'],
    [['bun.lockb'], 'bun'],
    [['bun.lock'], 'bun'],
    [['pnpm-lock.yaml', 'yarn.lock'], 'pnpm'],
    [['yarn.lock', 'bun.lock'], 'yarn'],
    [['bun.lockb', 'package-lock.json'], 'bun'],
  ];
  cases.forEach(([locks, pm], i) => {
    const d = path.join(dir, `p${i}`);
    mkdirSync(d);
    for (const l of locks) put(path.join(d, l), '');
    assert.equal(packageManager(d), pm, locks.join('+') || '(none)');
  });
  assert.equal(packageManager(path.join(dir, 'missing')), 'npm');
}));

// ---------------------------------------------------------------------------------------------
// titles

test('titles: entities decoded and whitespace collapsed', () => inTemp((dir) => {
  const f = put(path.join(dir, 'a.html'), page('', '\n  Tom &amp; Jerry&nbsp;&nbsp;&#8212; \t Part&#x20;2 \n'));
  assert.equal(detect(f).title, 'Tom & Jerry — Part 2');
}));

test('titles: quotes, apostrophes, upper-case named entities and numeric forms', () => inTemp((dir) => {
  const f = put(path.join(dir, 'a.html'), page('', '&quot;Q&quot; &#39;s&#39; &#x27;x&#x27; &LT;b&GT;'));
  assert.equal(detect(f).title, `"Q" 's' 'x' <b>`);
}));

test('titles: unknown entities are kept and decoding happens once', () => inTemp((dir) => {
  const f = put(path.join(dir, 'a.html'), page('', '&bogus; &amp;amp; 5 &lt 6'));
  assert.equal(detect(f).title, '&bogus; &amp; 5 &lt 6');
}));

test('titles: attributes, upper-case tag and multi-line Hebrew', () => inTemp((dir) => {
  const f = put(path.join(dir, 'a.html'), '<html><head><TITLE lang="he" dir="rtl">\n  שלום\n\n  עולם\n</TITLE></head></html>');
  assert.equal(detect(f).title, 'שלום עולם');
}));

test('titles: empty or whitespace-only titles are null; the first title wins', () => inTemp((dir) => {
  assert.equal(detect(put(path.join(dir, 'a.html'), page('', ''))).title, null);
  assert.equal(detect(put(path.join(dir, 'b.html'), page('', ' \n\t&nbsp; '))).title, null);
  const two = put(path.join(dir, 'c.html'), page('<svg><title>icon</title></svg>', 'Real'));
  assert.equal(detect(two).title, 'Real');
}));

test('titles are carried into serve mode too', () => inTemp((dir) => {
  const f = put(path.join(dir, 'a.html'), page('<script>fetch("x")</script>', 'Dash &amp; Board'));
  const r = detect(f);
  assert.equal(r.mode, 'serve');
  assert.equal(r.title, 'Dash & Board');
}));

// ---------------------------------------------------------------------------------------------
// awkward names: Hebrew, spaces, #, %, and shell metacharacters (legal on Windows, macOS, Linux)

const AWKWARD_FILES = [
  'דף הבית.html',
  'my page #1 100%.html',
  "it's $HOME & more; `tick`.html",
  'דוח #3 — 50% & more.html',
];

test('awkward HTML file names: raw path, relative path and file:// URL all agree', async (t) => {
  for (const name of AWKWARD_FILES) {
    await t.test(name, () => inTemp((dir) => {
      const f = put(path.join(dir, name), page('', `כותרת ${name}`));
      const expected = { ok: true, mode: 'file', path: f, title: `כותרת ${name}`.replace(/\s+/g, ' ') };
      assert.deepEqual(detect(f), expected, 'raw path');
      assert.deepEqual(detect(name, { cwd: dir }), expected, 'relative');
      const href = pathToFileURL(f).href;
      assert.ok(!href.includes('#') && !/%(?![0-9A-F]{2})/.test(href), `href is fully encoded: ${href}`);
      assert.deepEqual(detect(href), expected, 'file:// URL');
    }));
  }
});

test('awkward names on a page that needs http: entry keeps the exact basename', () => inTemp((dir) => {
  const name = "app #2 it's 100% $x & y; `z` — אפליקציה.html";
  const f = put(path.join(dir, name), page('<script type="module" src="m.js"></script>'));
  const r = detect(pathToFileURL(f).href, { platform: 'linux' });
  assert.equal(r.mode, 'serve');
  assert.equal(r.root, dir);
  assert.equal(r.entry, name);
}));

test('awkward folder names: a Hebrew / metacharacter folder with index.html is served from that folder', () => inTemp((dir) => {
  for (const folder of ['תיקייה עם רווח', "site #2 & 50% it's `x` $y;"]) {
    const d = path.join(dir, folder);
    put(path.join(d, 'index.html'), page());
    assert.deepEqual(detect(d), {
      ok: true, mode: 'serve', path: d, root: d, entry: 'index.html', reasons: ['folder with index.html'],
    }, folder);
    assert.deepEqual(detect(pathToFileURL(d).href), detect(d), `${folder} via file://`);
    assert.equal(detect(folder, { cwd: dir }).root, d, `${folder} relative`);
  }
}));

test('awkward names in a folder of outputs: the Hebrew-named video is selected', () => inTemp((dir) => {
  const d = path.join(dir, 'תוצרים');
  put(path.join(d, 'דוח סופי.pdf'), '%PDF', T0 + 500);
  put(path.join(d, 'סרטון #1 & 100%.mp4'), 'v', T0);
  put(path.join(d, 'תמונה.png'), 'i', T0 + 900);
  assert.deepEqual(detect(d), { ok: true, mode: 'folder', path: d, select: path.join(d, 'סרטון #1 & 100%.mp4') });
}));

test('awkward names in app mode', () => inTemp((dir) => {
  for (const name of ["résumé & notes #2 it's 50%.PDF", 'מצגת; `final` $v2.pptx']) {
    const f = put(path.join(dir, name), 'x');
    assert.deepEqual(detect(f), { ok: true, mode: 'app', path: f, ext: path.extname(name).toLowerCase() }, name);
    assert.deepEqual(detect(pathToFileURL(f).href), detect(f), `${name} via file://`);
  }
}));

test('a literal %20 in a plain path is not URL-decoded', () => inTemp((dir) => {
  const f = put(path.join(dir, 'a%20b.html'), page());
  assert.equal(detect('a%20b.html', { cwd: dir }).path, f);
  assert.equal(detect(pathToFileURL(f).href).path, f, 'file:// URL encodes the % and round-trips');
  assert.equal(detect('a b.html', { cwd: dir }).error, 'not-found');
}));
