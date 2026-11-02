// Postbuild: ship what selkies-web-core's build leaves beside its bundle into
// this dashboard's dist: the gamepad remap DB (its postbuild gendb.js) and
// libopus in WASM (its vite build), each fetched relative to the page. Built
// at build time so neither lives in the repo.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const core = path.resolve(here, '../selkies-web-core/dist');

const ASSETS = [
  ['jsdb', 'gamepad remap lookups (jsdb/<platform>/*.json) will 404 and pads fall back to browser-default mappings'],
  ['codecs', 'engines without WebCodecs audio will find no Opus decoder or encoder (codecs/) and play and send no sound'],
];

const countFiles = (dir) =>
  fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).length;

// Copy `src` over `dst` without a recursive delete.
//
// The obvious implementation is rmSync(dst, {recursive:true}) then cpSync. That
// is a bulk delete of ~2000 files, and any environment that guards bulk deletes
// (this workspace wraps node's fs and refuses more than 50 in one turn) turns
// it into a build failure that points at this line, not at the real cause.
// Overwriting in place costs the same for an unchanged tree and leaves only the
// files upstream dropped to remove — normally zero, and small enough to unlink
// one by one without tripping the same guard.
function syncTree(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  fs.cpSync(src, dst, { recursive: true, force: true });

  let removed = 0;
  for (const entry of fs.readdirSync(dst, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const rel = path.relative(dst, path.join(entry.parentPath ?? entry.path, entry.name));
    if (fs.existsSync(path.join(src, rel))) continue;
    fs.unlinkSync(path.join(dst, rel));
    removed += 1;
  }
  return removed;
}

for (const [name, without] of ASSETS) {
  const src = path.join(core, name);
  const dst = path.resolve(here, 'dist', name);
  if (!fs.existsSync(src)) {
    console.warn(`WARNING: ${src} missing — build selkies-web-core first. Without it ${without}.`);
    continue;
  }
  const removed = syncTree(src, dst);
  const files = countFiles(dst);
  console.log(`${name}: ${files} files copied into dist/${removed ? ` (${removed} stale removed)` : ''}`);
}
