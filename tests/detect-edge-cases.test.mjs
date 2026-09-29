// lib/detect.mjs on the cases that are easy to get wrong: only viewable types reach their
// default app, only *.app folders are bundles, ambiguous dev ports keep their candidates,
// hidden pages open as files, nested pages are served from their site, and WSL, \\?\ and links
// to shares are told apart from network paths. Nothing here opens, serves or spawns anything.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { lib, tempDir } from './helpers.mjs';

const {
  detect, entryHref, needsServer, windowsPathKind, HTML_EXT, RUNNABLE_EXT, VIEWABLE_EXT, MAX_SITE_LEVELS,
} = await import(lib('detect.mjs'));

const PLATFORMS = ['win32', 'darwin', 'linux'];
const onWindows = process.platform === 'win32';

// ---------------------------------------------------------------------------------------------
// helpers

function put(file, content = 'x') {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
  return file;
}

/** Run fn(dir) in a fresh temp folder that is always removed (fn may be async). */
function inTemp(fn) {
  const { dir, cleanup } = tempDir('show-local-detect-edge-');
  let out;
  try { out = fn(dir); } catch (e) { cleanup(); throw e; }
  if (out && typeof out.then === 'function') return out.finally(cleanup);
  cleanup();
  return out;
}

/** Create a symlink (a junction for folders on Windows when possible); false when not allowed. */
function link(target, at, kind = 'file') {
  mkdirSync(path.dirname(at), { recursive: true });
  const type = kind === 'dir' ? (onWindows && path.isAbsolute(target) && !/^[\\/]{2}/.test(target) ? 'junction' : 'dir') : 'file';
  try { symlinkSync(target, at, type); return true; } catch { return false; }
}

const page = (body = '', title = 'T') => `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`;
const MODULE = '<script type="module" src="/assets/main.js"></script>';
const MODULE_REASON = 'ES module script (blocked under file://)';

/** An adapter that fails the test if anything tries to open or watch. */
const trap = () => new Proxy({}, { get: (_, k) => () => { throw new Error(`adapter.${String(k)} must not be called`); } });

// ---------------------------------------------------------------------------------------------
// app mode is an allowlist of viewable types

test('VIEWABLE_EXT is exactly the agreed allowlist of documents, images, audio, video and text', () => {
  const agreed = [
    '.pdf',
    '.png', '.jpg', '.jpeg', '.jpe', '.jfif', '.gif', '.webp', '.avif', '.bmp', '.tif', '.tiff', '.ico', '.heic', '.heif', '.jxl', '.svg',
    '.dng', '.cr2', '.cr3', '.nef', '.arw', '.orf', '.rw2', '.raf',
    '.mp4', '.m4v', '.mov', '.webm', '.mkv', '.avi', '.wmv', '.mpg', '.mpeg', '.flv', '.3gp', '.3g2', '.mts', '.m2ts', '.ogv',
    '.mxf', '.vob', '.f4v', '.dv', '.divx', '.asf', '.m2v',
    '.mp3', '.wav', '.m4a', '.flac', '.ogg', '.oga', '.aac', '.opus', '.wma', '.aiff', '.aif', '.aifc', '.weba', '.amr', '.mid', '.midi', '.mka',
    '.txt', '.md', '.csv', '.tsv', '.json', '.xml', '.log', '.srt', '.vtt',
    '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.odt', '.ods', '.odp', '.rtf', '.epub', '.xps',
  ];
  assert.deepEqual([...VIEWABLE_EXT].sort(), [...agreed].sort());
});

test('common video, image and audio types open in their app; none is ever called "not a video"', () => inTemp((dir) => {
  const media = [
    '.wmv', '.mpg', '.mpeg', '.flv', '.3gp', '.mts', '.m2ts', '.m4v', '.avi', '.mkv', '.webm', '.ogv',
    '.jfif', '.avif', '.heic', '.heif', '.tif', '.tiff',
    '.wma', '.aiff', '.aif', '.opus',
  ];
  for (const ext of media) {
    const f = put(path.join(dir, `media${ext}`));
    for (const platform of PLATFORMS) {
      assert.deepEqual(detect(f, { platform }), { ok: true, mode: 'app', path: f, ext }, `${ext} ${platform}`);
    }
  }
  // A type that is not on the list is described as exactly that.
  const odd = put(path.join(dir, 'capture.rm'));
  assert.deepEqual(detect(odd, { platform: 'win32' }).reasons, [
    ".rm is not on show-local's list of types it opens directly (documents, images, audio, video, text); shown in its folder instead",
  ]);
}));

test('broadcast and disc video, Matroska audio, camera RAW photos and XPS documents open in their app', () => inTemp((dir) => {
  const exts = [
    '.mxf', '.vob', '.f4v', '.dv', '.divx', '.asf', '.m2v', '.mka',
    '.dng', '.cr2', '.cr3', '.nef', '.arw', '.orf', '.rw2', '.raf', '.xps',
  ];
  for (const ext of exts) {
    const f = put(path.join(dir, `shot${ext}`));
    for (const platform of PLATFORMS) {
      assert.deepEqual(detect(f, { platform }), { ok: true, mode: 'app', path: f, ext }, `${ext} ${platform}`);
    }
  }
}));

test('.ts (TypeScript, not only a transport stream) and .mod (Go\'s go.mod) are source code: revealed, never opened as video', () => inTemp((dir) => {
  for (const name of ['server.ts', 'go.mod', 'CLIP.TS']) {
    const f = put(path.join(dir, name), 'export const x = 1;\n');
    const ext = path.extname(name).toLowerCase();
    assert.equal(VIEWABLE_EXT.has(ext), false, name);
    for (const platform of PLATFORMS) {
      assert.deepEqual(detect(f, { platform }), {
        ok: true, mode: 'folder', path: dir, select: f,
        reasons: [`${ext} is not on show-local's list of types it opens directly (documents, images, audio, video, text); shown in its folder instead`],
      }, `${name} ${platform}`);
    }
  }
}));

test('RUNNABLE_EXT is still exported, covers the script types, and never overlaps viewable or HTML types', () => {
  for (const ext of ['.exe', '.bat', '.js', '.sh', '.app', '.py', '.pyw', '.mjs', '.cjs', '.chm', '.scf', '.settingcontent-ms', '.terminal']) {
    assert.ok(RUNNABLE_EXT.has(ext), ext);
  }
  for (const ext of RUNNABLE_EXT) {
    assert.equal(VIEWABLE_EXT.has(ext), false, ext);
    assert.equal(HTML_EXT.has(ext), false, ext);
  }
});

test('files whose app may run, install, mount or connect them are revealed, never opened', () => inTemp((dir) => {
  const exts = [
    '.py', '.pyw', '.pyz', '.mjs', '.cjs', '.pl', '.rb', '.php', '.ahk', '.au3', '.wsc', '.sct', '.scf', '.xll',
    '.chm', '.jnlp', '.settingcontent-ms', '.diagcab', '.diagcfg', '.msix', '.appx', '.appinstaller', '.msu',
    '.library-ms', '.search-ms', '.searchconnector-ms', '.website', '.rdp', '.theme', '.themepack', '.iso', '.img',
    '.vhd', '.vhdx', '.terminal', '.workflow', '.fileloc', '.inetloc', '.webloc', '.prefpane', '.sparsebundle',
    '.zip', '.gz', '.xlsm', '.docm', '.pptm', '.one', '.bin', '.dll', '.so', '.dylib',
  ];
  for (const ext of exts) {
    const f = put(path.join(dir, `tool${ext}`));
    for (const platform of PLATFORMS) {
      const d = detect(f, { platform });
      assert.equal(d.ok, true, `${ext} ${platform}`);
      assert.equal(d.mode, 'folder', `${ext} ${platform}: ${JSON.stringify(d)}`);
      assert.equal(d.path, dir, `${ext} ${platform}`);
      assert.equal(d.select, f, `${ext} ${platform}`);
      assert.equal(d.reasons.length, 1, `${ext} ${platform}`);
      assert.match(d.reasons[0], /shown in its folder instead$/, `${ext} ${platform}`);
      assert.match(d.reasons[0], RUNNABLE_EXT.has(ext) ? /run when opened/ : /is not on show-local's list of types it opens directly \(documents, images, audio, video, text\); shown in its folder instead$/, ext);
    }
  }
  // The extension is compared case-insensitively.
  const upper = put(path.join(dir, 'Build.PY'));
  assert.equal(detect(upper, { platform: 'win32' }).mode, 'folder');
  assert.match(detect(upper, { platform: 'win32' }).reasons[0], /^\.py files run when opened/);
}));

test('a file without an extension (a binary, a script, Makefile, .env) is revealed, never opened', () => inTemp((dir) => {
  for (const name of ['deploy', 'mytool', 'Makefile', '.env', '.gitignore', 'x.']) {
    const f = put(path.join(dir, name), '#!/bin/sh\necho hi\n');
    for (const platform of PLATFORMS) {
      assert.deepEqual(detect(f, { platform }), {
        ok: true, mode: 'folder', path: dir, select: f,
        reasons: ['it has no file extension, so it may be a program: shown in its folder instead'],
      }, `${name} ${platform}`);
    }
  }
}));

test('an executable (+x) with no extension is revealed on macOS and Linux', { skip: onWindows && 'no exec bit on Windows' }, () => inTemp((dir) => {
  for (const name of ['mytool', 'deploy']) {
    const f = put(path.join(dir, 'target', 'release', name), '#!/bin/sh\necho ran > ran.txt\n');
    chmodSync(f, 0o755);
    for (const platform of ['darwin', 'linux']) {
      const d = detect(f, { platform });
      assert.equal(d.mode, 'folder', `${name} ${platform}`);
      assert.equal(d.path, path.dirname(f));
      assert.equal(d.select, f);
    }
  }
  assert.equal(existsSync(path.join(dir, 'ran.txt')), false);
}));

test('every viewable type still opens in its default app, in any case', () => inTemp((dir) => {
  for (const ext of VIEWABLE_EXT) {
    const lower = put(path.join(dir, `lower${ext}`));
    const upper = put(path.join(dir, `UPPER${ext.toUpperCase()}`));
    for (const platform of PLATFORMS) {
      assert.deepEqual(detect(lower, { platform }), { ok: true, mode: 'app', path: lower, ext }, `${ext} ${platform}`);
      assert.deepEqual(detect(upper, { platform }), { ok: true, mode: 'app', path: upper, ext }, `${ext.toUpperCase()} ${platform}`);
    }
  }
}));

test('a link that looks like a document but leads to a script is revealed; a link between documents opens', (t) => inTemp((dir) => {
  const script = put(path.join(dir, 'real', 'tool.py'), 'print(1)');
  const image = put(path.join(dir, 'real', 'shot.png'), 'png');
  const disguised = path.join(dir, 'out', 'report.pdf');
  const honest = path.join(dir, 'out', 'latest.png');
  if (!link(script, disguised) || !link(image, honest)) return t.skip('symlinks are not allowed here');
  for (const platform of PLATFORMS) {
    const d = detect(disguised, { platform });
    assert.equal(d.mode, 'folder', `${platform}: ${JSON.stringify(d)}`);
    assert.equal(d.path, path.dirname(disguised));
    assert.equal(d.select, disguised);
    assert.match(d.reasons[0], /leads to tool\.py/);
    assert.deepEqual(detect(honest, { platform }), { ok: true, mode: 'app', path: honest, ext: '.png' }, platform);
  }
}));

test('a Finder alias is revealed on macOS whatever it is named; elsewhere it is just bytes', () => inTemp((dir) => {
  const alias = put(path.join(dir, 'Report.pdf'), Buffer.concat([
    Buffer.from('book'), Buffer.alloc(4), Buffer.from('mark'), Buffer.alloc(4), Buffer.from('\u0000\u0000\u0000\u0000rest'),
  ]));
  const d = detect(alias, { platform: 'darwin' });
  assert.equal(d.mode, 'folder');
  assert.equal(d.select, alias);
  assert.match(d.reasons[0], /Finder alias/);
  assert.equal(detect(alias, { platform: 'linux' }).mode, 'app');
  assert.equal(detect(alias, { platform: 'win32' }).mode, 'app');
  // A real PDF next to it is untouched on macOS.
  const pdf = put(path.join(dir, 'real.pdf'), '%PDF-1.4\n');
  assert.equal(detect(pdf, { platform: 'darwin' }).mode, 'app');
}));

test('win32: a path naming an alternate data stream is revealed, whatever its extension', { skip: !onWindows && 'NTFS streams only on Windows' }, (t) => inTemp((dir) => {
  const host = put(path.join(dir, 'host.txt'), 'text');
  const stream = `${host}:payload.pdf`;
  try { writeFileSync(stream, '%PDF'); } catch { return t.skip('this volume has no alternate data streams'); }
  if (!existsSync(stream)) return t.skip('streams are not visible here');
  const d = detect(stream, { platform: 'win32' });
  assert.equal(d.mode, 'folder', JSON.stringify(d));
  assert.match(d.reasons[0], /alternate data stream/);
}));

// ---------------------------------------------------------------------------------------------
// only a folder named *.app is an application bundle

test('folders named like runnable files (mysite.com, reveal.js, x.sh…) are served, run or opened like any folder', () => inTemp((dir) => {
  for (const name of ['mysite.com', 'reveal.js', 'next.js', 'tools.sh', 'build.exe', 'links.url', 'go.run', 'setup.pkg']) {
    const site = path.join(dir, 'sites', name);
    put(path.join(site, 'index.html'), page());
    const project = path.join(dir, 'projects', name);
    put(path.join(project, 'package.json'), JSON.stringify({ scripts: { dev: 'vite' } }));
    const outputs = path.join(dir, 'outputs', name);
    const shot = put(path.join(outputs, 'shot.png'));
    for (const platform of PLATFORMS) {
      assert.deepEqual(detect(site, { platform }), {
        ok: true, mode: 'serve', path: site, root: site, entry: 'index.html', reasons: ['folder with index.html'],
      }, `${name} site ${platform}`);
      const dev = detect(project, { platform });
      assert.equal(dev.mode, 'dev', `${name} dev ${platform}`);
      assert.equal(dev.root, project);
      assert.deepEqual(detect(outputs, { platform }), { ok: true, mode: 'folder', path: outputs, select: shot }, `${name} outputs ${platform}`);
      // --folder opens the folder itself, not its parent.
      assert.deepEqual(detect(site, { platform, asFolder: true }), {
        ok: true, mode: 'folder', path: site, select: path.join(site, 'index.html'), reasons: ['opened as a folder (--folder)'],
      }, `${name} --folder ${platform}`);
    }
  }
}));

test('a folder named *.app (any case) is revealed in its parent on every platform, even with --folder', () => inTemp((dir) => {
  for (const name of ['Tool.app', 'Other.APP']) {
    const app = path.join(dir, name);
    put(path.join(app, 'Contents', 'Info.plist'), '<plist/>');
    for (const platform of PLATFORMS) {
      for (const asFolder of [false, true]) {
        assert.deepEqual(detect(app, { platform, asFolder }), {
          ok: true, mode: 'folder', path: dir, select: app, reasons: ['an application bundle: revealed, not launched'],
        }, `${name} ${platform} asFolder=${asFolder}`);
      }
    }
  }
}));

test('a link to an .app bundle is revealed too, never handed to the opener as a folder', (t) => inTemp((dir) => {
  const app = path.join(dir, 'build', 'MyApp.app');
  put(path.join(app, 'Contents', 'Info.plist'), '<plist/>');
  const latest = path.join(dir, 'dist', 'latest');
  if (!link(app, latest, 'dir')) return t.skip('folder links are not allowed here');
  for (const platform of PLATFORMS) {
    for (const asFolder of [false, true]) {
      assert.deepEqual(detect(latest, { platform, asFolder }), {
        ok: true, mode: 'folder', path: path.dirname(latest), select: latest, reasons: ['an application bundle: revealed, not launched'],
      }, `${platform} asFolder=${asFolder}`);
    }
  }
}));

// ---------------------------------------------------------------------------------------------
// several ports in the dev script

test('an ambiguous dev script keeps its candidate ports in the dev result', () => inTemp((dir) => {
  const script = 'concurrently "vite --port 3001" "api --port 4001"';
  put(path.join(dir, 'package.json'), JSON.stringify({ scripts: { dev: script } }));
  assert.deepEqual(detect(dir), {
    ok: true, mode: 'dev', path: dir, root: dir, script, port: null, portSource: 'ambiguous', candidates: [3001, 4001], packageManager: 'npm',
  });
  // A single port leaves no candidates field behind.
  put(path.join(dir, 'package.json'), JSON.stringify({ scripts: { dev: 'vite --port 3001' } }));
  assert.equal('candidates' in detect(dir), false);
}));

test('plan on an ambiguous dev script reports dev-port-unknown with the candidates, not an internal error', async () => inTemp(async (dir) => {
  const { show } = await import(lib('open.mjs'));
  put(path.join(dir, 'package.json'), JSON.stringify({ scripts: { dev: 'concurrently "vite --port 3001" "api --port 4001"' } }));
  const r = await show(dir, { planOnly: true, adapter: trap(), cwd: dir, timeoutMs: 100, waitMs: 100 });
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(r.error, 'dev-port-unknown', JSON.stringify(r));
  assert.match(r.detail, /3001, 4001/);
  assert.equal(typeof r.next?.start, 'string');
  assert.notEqual(r.opened, true);
}));

// ---------------------------------------------------------------------------------------------
// a hidden page can never be served

test('a hidden HTML page that needs http opens as file:/// with a reason, not on a server that answers 403', () => inTemp((dir) => {
  const hidden = put(path.join(dir, 'dotentry', '.preview.html'), page(MODULE, 'Preview'));
  for (const platform of PLATFORMS) {
    const d = detect(hidden, { platform });
    assert.equal(d.mode, 'file', `${platform}: ${JSON.stringify(d)}`);
    assert.equal(d.path, hidden);
    assert.equal(d.title, 'Preview');
    assert.equal(d.reasons.length, 2);
    assert.equal(d.reasons[0], MODULE_REASON);
    assert.match(d.reasons[1], /starts with "\." .*never serves hidden files/);
    assert.equal('root' in d || 'entry' in d, false);
  }
  // A hidden page that needs nothing stays a plain file open, and a page inside a dot-folder is
  // still served from that folder (only request segments are checked).
  const plain = put(path.join(dir, 'dotentry', '.plain.html'), page('', 'Plain'));
  assert.deepEqual(detect(plain, { platform: 'linux' }), { ok: true, mode: 'file', path: plain, title: 'Plain' });
  const inDot = put(path.join(dir, '.cache', 'page.html'), page(MODULE, 'Dot'));
  assert.deepEqual(detect(inDot, { platform: 'linux', home: dir }), {
    ok: true, mode: 'serve', path: inDot, root: path.dirname(inDot), entry: 'page.html', reasons: [MODULE_REASON], title: 'Dot',
  });
}));

// ---------------------------------------------------------------------------------------------
// letters whose lower case is longer ("İ" → "i̇") do not move the page's script tags

test('a page with Turkish "İ" before its inline script still finds the data the script loads', () => inTemp((dir) => {
  put(path.join(dir, 'data.csv'), 'a,b\n1,2\n');
  const reason = (name) => `loads local data (${name}) — file:// would block it`;
  for (const heading of ['Rapor', 'İstanbul İzmir']) {
    for (const code of ['d3.csv("data.csv")', 'const rows = "data.csv"']) {
      const html = page(`<h1>${heading}</h1><script>${code}</script>`);
      assert.deepEqual(needsServer(html, { dir, platform: 'linux' }).reasons, [reason('data.csv')], `${heading}: ${code}`);
    }
    // Without a folder only the library call counts, and it still does.
    const call = page(`<h1>${heading}</h1><SCRIPT>$.getJSON("rows.json")</SCRIPT>`);
    assert.deepEqual(needsServer(call, { platform: 'linux' }).reasons, [reason('rows.json')], heading);
  }
  const f = put(path.join(dir, 'rapor.html'), page('<h1>İletişim</h1><script>d3.csv("data.csv")</script>'));
  const d = detect(f, { platform: 'linux', home: dir });
  assert.equal(d.mode, 'serve', JSON.stringify(d));
  assert.deepEqual(d.reasons, [reason('data.csv')]);
}));

// ---------------------------------------------------------------------------------------------
// a nested page is served from its site

test('a nested page is served from the nearest folder above with index.html, entry = the relative path', () => inTemp((dir) => {
  const site = path.join(dir, 'site');
  put(path.join(site, 'index.html'), page('', 'Home'));
  const post = put(path.join(site, 'blog', 'post.html'), page(MODULE, 'Post'));
  for (const platform of PLATFORMS) {
    const d = detect(post, { platform, home: dir });
    assert.deepEqual({ ...d, reasons: d.reasons.slice(0, 1) }, {
      ok: true, mode: 'serve', path: post, root: site, entry: 'blog/post.html', reasons: [MODULE_REASON], title: 'Post',
    }, platform);
    assert.equal(d.reasons.length, 2);
    assert.ok(d.reasons[1].includes(site), d.reasons[1]);
    assert.match(d.reasons[1], /one level up with index\.html/);
  }
}));

test('the site walk goes at most MAX_SITE_LEVELS (3) up, and the nearest index wins', () => inTemp((dir) => {
  assert.equal(MAX_SITE_LEVELS, 3);
  const site = path.join(dir, 'site');
  put(path.join(site, 'index.htm'), page()); // index.htm counts too
  const three = put(path.join(site, 'a', 'b', 'c', 'three.html'), page(MODULE));
  const four = put(path.join(site, 'a', 'b', 'c', 'd', 'four.html'), page(MODULE));
  const r3 = detect(three, { platform: 'linux', home: dir });
  assert.equal(r3.root, site);
  assert.equal(r3.entry, 'a/b/c/three.html');
  assert.match(r3.reasons[1], /3 levels up/);
  const r4 = detect(four, { platform: 'linux', home: dir });
  assert.equal(r4.root, path.dirname(four));
  assert.equal(r4.entry, 'four.html');
  assert.deepEqual(r4.reasons, [MODULE_REASON]);

  const docs = path.join(site, 'docs');
  put(path.join(docs, 'index.html'), page());
  const guide = put(path.join(docs, 'guide', 'page.html'), page(MODULE));
  const g = detect(guide, { platform: 'win32', home: dir });
  assert.equal(g.root, docs);
  assert.equal(g.entry, 'guide/page.html', 'forward slashes on every platform');
}));

test('a page whose own folder has index.html, or that needs no server, is left where it is', () => inTemp((dir) => {
  const site = path.join(dir, 'site');
  put(path.join(site, 'index.html'), page());
  const blog = path.join(site, 'blog');
  put(path.join(blog, 'index.html'), page());
  const post = put(path.join(blog, 'post.html'), page(MODULE));
  assert.equal(detect(post, { platform: 'linux', home: dir }).root, blog);
  const plain = put(path.join(site, 'notes', 'plain.html'), page('', 'Plain'));
  assert.deepEqual(detect(plain, { platform: 'linux', home: dir }), { ok: true, mode: 'file', path: plain, title: 'Plain' });
}));

test('the site walk never uses the home folder (or above), and never crosses a dot-folder', () => inTemp((dir) => {
  const home = path.join(dir, 'home');
  put(path.join(home, 'index.html'), page());
  const post = put(path.join(home, 'blog', 'post.html'), page(MODULE));
  assert.equal(detect(post, { platform: 'linux', home }).root, path.join(home, 'blog'), 'home itself is never the root');
  assert.equal(detect(post, { platform: 'linux', home: path.join(home, 'blog') }).root, path.join(home, 'blog'), 'never above home');
  assert.equal(detect(post, { platform: 'linux', home: dir }).root, home, 'a folder inside home is fine');
  assert.equal(detect(post, { platform: 'linux', home: path.join(dir, 'elsewhere') }).root, home, 'a page outside home has no home limit');
  // Case-insensitive platforms compare the home folder without case.
  assert.equal(detect(post, { platform: 'win32', home: home.toUpperCase() }).root, path.join(home, 'blog'));

  const site = path.join(dir, 'site');
  put(path.join(site, 'index.html'), page());
  const draft = put(path.join(site, '.drafts', 'post.html'), page(MODULE));
  assert.equal(detect(draft, { platform: 'linux', home: dir }).root, path.dirname(draft));
  const deep = put(path.join(site, '.x', 'blog', 'post.html'), page(MODULE));
  assert.equal(detect(deep, { platform: 'linux', home: dir }).root, path.dirname(deep));
}));

test('a page reached through a link that leads out of the site folder is served from its own folder', (t) => inTemp((dir) => {
  const outside = path.join(dir, 'outside', 'blog');
  put(path.join(outside, 'post.html'), page(MODULE));
  const site = path.join(dir, 'site');
  put(path.join(site, 'index.html'), page());
  const linked = path.join(site, 'blog');
  if (!link(outside, linked, 'dir')) return t.skip('folder links are not allowed here');
  const post = path.join(linked, 'post.html');
  const d = detect(post, { platform: 'linux', home: dir });
  assert.equal(d.mode, 'serve');
  assert.equal(d.root, linked);
  assert.equal(d.entry, 'post.html');
  // A link that stays inside the site is fine.
  const inner = path.join(site, 'posts');
  put(path.join(inner, 'p.html'), page(MODULE));
  const alias = path.join(site, 'alias');
  if (!link(inner, alias, 'dir')) return;
  const a = detect(path.join(alias, 'p.html'), { platform: 'linux', home: dir });
  assert.equal(realpathSync(a.root), realpathSync(site));
  assert.equal(a.entry, 'alias/p.html');
}));

test('awkward names in the relative entry are kept raw; entryHref encodes each segment, never the slash', () => inTemp((dir) => {
  const site = path.join(dir, 'site');
  put(path.join(site, 'index.html'), page());
  const folder = 'my blog #1 — בלוג';
  const name = "post 100% it's.html";
  const post = put(path.join(site, folder, name), page(MODULE));
  const d = detect(post, { platform: 'linux', home: dir });
  assert.equal(d.entry, `${folder}/${name}`);
  assert.equal(entryHref(d.entry), `${encodeURIComponent(folder)}/${encodeURIComponent(name)}`);
  assert.ok(!entryHref(d.entry).includes('%2F'));
  assert.equal(entryHref('index.html'), 'index.html');
  assert.equal(entryHref('a b/c#d.html'), 'a%20b/c%23d.html');
  assert.equal(entryHref(''), '');
}));

// ---------------------------------------------------------------------------------------------
// WSL and \\?\ paths are local, links to shares are not

test('windowsPathKind tells local prefixes from network paths', () => {
  const cases = [
    ['\\\\wsl.localhost\\Ubuntu\\home\\u\\site\\index.html', 'wsl'],
    ['\\\\WSL.LOCALHOST\\Ubuntu', 'wsl'],
    ['\\\\wsl$\\Ubuntu\\home\\u\\x.html', 'wsl'],
    ['//wsl.localhost/Ubuntu/home/u/x.html', 'wsl'],
    ['\\\\wsl.localhost', 'wsl'],
    ['\\\\server\\share\\x.html', 'remote'],
    ['//server/share/x.html', 'remote'],
    ['\\\\?\\UNC\\server\\share\\x.html', 'remote'],
    ['\\\\wsl.localhost.evil.example\\share', 'remote'],
    ['\\\\wslhost\\share', 'remote'],
    ['\\\\wsl$evil\\share', 'remote'],
    ['\\\\.\\pipe\\x', 'remote'],
    ['\\\\?\\Volume{0000}\\x', 'remote'],
    ['C:\\Users\\u\\x.html', 'plain'],
    ['/home/u/x.html', 'plain'],
    ['relative\\x.html', 'plain'],
  ];
  for (const [p, kind] of cases) assert.equal(windowsPathKind(p).kind, kind, p);
  assert.deepEqual(windowsPathKind('\\\\?\\C:\\very\\long\\report.html'), { kind: 'local', path: 'C:\\very\\long\\report.html' });
  assert.deepEqual(windowsPathKind('//?/d:/x/y.pdf'), { kind: 'local', path: 'd:\\x/y.pdf' });
  assert.deepEqual(windowsPathKind('\\\\?\\C:'), { kind: 'local', path: 'C:\\' });
  assert.deepEqual(windowsPathKind('\\\\wsl$\\Ubuntu\\x'), { kind: 'wsl', path: '\\\\wsl$\\Ubuntu\\x' });
});

test('\\\\?\\UNC and other network paths are still refused on Windows', () => {
  for (const t of ['\\\\?\\UNC\\server\\share\\x.html', '//?/UNC/server/share/x.html', '\\\\wsl.localhost.evil.example\\s\\x.html']) {
    const d = detect(t, { platform: 'win32' });
    assert.equal(d.error, 'remote-path', t);
  }
});

test('\\\\wsl.localhost and \\\\wsl$ targets (paths and file:// URLs) are not refused as network paths', { skip: onWindows && 'would touch the local WSL share' }, () => {
  for (const t of [
    '\\\\wsl.localhost\\Ubuntu\\home\\u\\site\\index.html',
    '\\\\wsl$\\Ubuntu\\home\\u\\report.pdf',
    '//wsl.localhost/Ubuntu/home/u/x.html',
    'file://wsl.localhost/Ubuntu/home/u/x.html',
    'file://WSL.LOCALHOST/Ubuntu/home/u/x.html',
  ]) {
    const d = detect(t, { platform: 'win32' });
    assert.notEqual(d.error, 'remote-path', `${t}: ${JSON.stringify(d)}`);
  }
  // Only on Windows: elsewhere a file://wsl.localhost URL names another machine.
  assert.equal(detect('file://wsl.localhost/Ubuntu/x.html', { platform: 'linux' }).error, 'remote-path');
});

test('a \\\\?\\C:\\… long-path target is local and reported without the prefix', { skip: !onWindows && 'Windows paths' }, () => inTemp((dir) => {
  const f = put(path.join(dir, 'long', 'report.pdf'), '%PDF-1.4');
  const expected = { ok: true, mode: 'app', path: f, ext: '.pdf' };
  assert.deepEqual(detect(`\\\\?\\${f}`, { platform: 'win32' }), expected);
  assert.deepEqual(detect(`//?/${f.replace(/\\/g, '/')}`, { platform: 'win32' }), expected);
  assert.deepEqual(detect('report.pdf', { platform: 'win32', cwd: `\\\\?\\${path.dirname(f)}` }), expected);
}));

test('a link on the way to the target that points at a network share is refused before anything touches it', (t) => inTemp((dir) => {
  const share = '\\\\show-local-test.invalid\\share';
  const net = path.join(dir, 'net');
  if (!link(share, net, 'dir')) return t.skip('links to a network path are not allowed here');
  for (const target of [net, path.join(net, 'x.pdf'), path.join(net, 'sub', 'page.html')]) {
    const d = detect(target, { platform: 'win32' });
    assert.equal(d.error, 'remote-path', `${target}: ${JSON.stringify(d)}`);
    assert.match(d.detail, /leads through a link to \\\\show-local-test\.invalid\\share/);
  }
  // Through a local link first, then the network link.
  const real = path.join(dir, 'real');
  mkdirSync(real);
  if (link(share, path.join(real, 'net'), 'dir') && link(real, path.join(dir, 'hop'), 'dir')) {
    assert.equal(detect(path.join(dir, 'hop', 'net', 'x.pdf'), { platform: 'win32' }).error, 'remote-path');
  }
  // Local links are followed as usual.
  const local = path.join(dir, 'docs');
  put(path.join(local, 'x.pdf'), '%PDF');
  if (link(local, path.join(dir, 'docs-link'), 'dir')) {
    assert.equal(detect(path.join(dir, 'docs-link', 'x.pdf'), { platform: 'win32' }).mode, 'app');
  }
  // Elsewhere a backslash target is an ordinary (missing) relative name.
  if (!onWindows) assert.equal(detect(path.join(net, 'x.pdf'), { platform: 'linux' }).error, 'not-found');
}));
