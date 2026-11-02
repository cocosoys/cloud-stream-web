// Postbuild: write dist/.asset-manifest.json — the hash table that answers
// "what exactly is in this bundle". Two consumers:
//
//   * the deploy chain, which can diff a target machine against the table
//     instead of comparing zip timestamps or copying 2007 files blindly;
//   * the stream server, which reads it to turn every static response's
//     ETag into the file's real SHA-256, so a browser revalidates the bundle
//     with a 304 instead of downloading it again.
//
// Granularity is deliberately mixed. The handful of files that change per
// build are listed individually; the gamepad DB is folded into one unit per
// platform because gendb.js rewrites all of it from a single upstream
// snapshot — a client either has that snapshot or does not, so 1992 rows
// would bloat the table to ~250 KB and buy nothing.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, 'dist');
const OUT_NAME = '.asset-manifest.json';

// Path prefixes folded into per-unit aggregates instead of per-file rows.
const UNIT_PREFIXES = ['jsdb/'];

// Written with a long, immutable lifetime by the server: Vite stamps a content
// hash into these names, so a changed byte means a changed URL.
const IMMUTABLE_PREFIX = 'assets/';

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function walk(dir, rel = '', out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const next = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) walk(path.join(dir, entry.name), next, out);
    else if (entry.isFile()) out.push(next);
  }
  return out;
}

function unitOf(rel) {
  const prefix = UNIT_PREFIXES.find((p) => rel.startsWith(p));
  if (!prefix) return null;
  const rest = rel.slice(prefix.length);
  // jsdb/windows/045e-028e.json -> jsdb/windows; a file sitting directly in
  // the prefix directory would fold into the prefix itself.
  const platform = rest.includes('/') ? rest.slice(0, rest.indexOf('/')) : '';
  return platform ? `${prefix}${platform}` : prefix.replace(/\/$/, '');
}

if (!fs.existsSync(dist)) {
  console.error(`ERROR: ${dist} missing — run vite build first.`);
  process.exit(1);
}

const files = {};
const units = {};
let totalBytes = 0;
let totalFiles = 0;

for (const rel of walk(dist).sort()) {
  if (rel === OUT_NAME) continue; // never list the table inside itself
  const buf = fs.readFileSync(path.join(dist, rel));
  const digest = sha256(buf);
  totalBytes += buf.length;
  totalFiles += 1;

  const unit = unitOf(rel);
  if (unit) {
    const acc = units[unit] ??= { files: 0, bytes: 0, digest: crypto.createHash('sha256') };
    acc.files += 1;
    acc.bytes += buf.length;
    // Feed the unit digest in sorted path order (walk() already sorted) so a
    // rename, an add or a byte change all move the aggregate. The NUL keeps
    // "a" + "bc" from hashing the same as "ab" + "c".
    acc.digest.update(`${rel}\0${digest}\n`);
    continue;
  }

  files[rel] = {
    size: buf.length,
    sha256: digest,
    cache: rel.startsWith(IMMUTABLE_PREFIX) ? 'immutable' : 'revalidate',
  };
}

const unitTable = {};
for (const [name, acc] of Object.entries(units)) {
  unitTable[name] = {
    files: acc.files,
    bytes: acc.bytes,
    sha256: acc.digest.digest('hex'),
    // Units are fetched on demand (a gamepad lookup, an Opus module), never as
    // part of first paint, so they revalidate rather than cache forever.
    cache: 'revalidate',
  };
}

const manifest = {
  schema: 1,
  generated: new Date().toISOString(),
  total_files: totalFiles,
  total_bytes: totalBytes,
  files,
  units: unitTable,
};

fs.writeFileSync(path.join(dist, OUT_NAME), `${JSON.stringify(manifest, null, 2)}\n`);

const listed = Object.keys(files).length;
const folded = Object.keys(unitTable).length;
console.log(
  `manifest: ${listed} file(s) + ${folded} unit(s) covering ${totalFiles} files, ` +
  `${(totalBytes / 1024 / 1024).toFixed(1)} MiB -> dist/${OUT_NAME}`
);
