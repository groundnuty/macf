#!/usr/bin/env node
/**
 * Publish-sync for the macf-bootstrap product (groundnuty/macf#657).
 *
 * macf-bootstrap is a SEPARATE PRODUCT, delivered as the standalone repo
 * `groundnuty/macf-automated-github-setup` (the unit users clone) — NOT a path
 * inside the macf repo. Its source is DEVELOPED here in the monorepo at
 * `tools/macf-bootstrap/` (so its tests stay in `make check` and it stays in
 * lockstep with the framework it calls) and PUBLISHED to the product repo at
 * each version by this helper — the same develop-in-monorepo / publish-to-a-
 * separate-repo pattern as `packages/macf/plugin/` -> `groundnuty/macf-marketplace`
 * and the `groundnuty/macf-actions` workflow repo (operator decision 2026-06-29,
 * DR-035 §7 "Option B"). See DR-035 §7 + `sync-marketplace-plugin.mjs` (the
 * precedent this mirrors).
 *
 *   --target <product-repo-checkout>  (required) a local checkout of
 *                                      groundnuty/macf-automated-github-setup
 *   --check                           (optional) report mismatches; exit 1 if
 *                                      the target is NOT in sync with the dev
 *                                      source, exit 0 if in sync (a verify/CI
 *                                      gate). Default (no --check): perform the
 *                                      mirror, print written/removed counts.
 *   --source <dir>                    (optional) override the dev-source dir
 *                                      (default: `tools/macf-bootstrap/`,
 *                                      resolved relative to this script).
 *                                      Mainly for tests/CI flexibility.
 *
 * Self-contained: node built-ins only — NO dependency on a `dist/` build (the
 * recursive dir mirror is inlined). Mirrors the WHOLE source dir (the entire
 * workspace IS the product), excluding `.git`, `node_modules`, `.bootstrap-work`
 * (runtime scratch), and any stray secret files (`*.app.json`, `vault*.age`,
 * `vault-age-key.txt`, `vault.plain`) — defense-in-depth so a stray secret is
 * never published even though it shouldn't be in the source. The target's
 * `.git/` is NEVER touched (it is the product repo's own history). File modes
 * are preserved (the `.sh` scripts must stay executable).
 */
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url)); // packages/macf/scripts
const REPO_ROOT = resolve(SCRIPT_DIR, '..', '..', '..'); // -> monorepo root
const DEFAULT_SOURCE_DIR = join(REPO_ROOT, 'tools', 'macf-bootstrap');

/** Directory names never descended on EITHER side (target `.git/` is sacred). */
const SKIP_DIRS = new Set(['.git', 'node_modules', '.bootstrap-work']);

/**
 * Stray-secret file patterns excluded from the SOURCE copy (defense-in-depth;
 * these are git-ignored and shouldn't be in the source, but never publish one).
 */
const SECRET_PATTERNS = [
  /\.app\.json$/, // *.app.json (per-agent App creds + PEM)
  /^vault.*\.age$/, // vault*.age (encrypted vault)
  /^vault-age-key\.txt$/, // the age decryption key
  /^vault\.plain$/, // a decrypted-vault intermediate
];

function isSecretFile(name) {
  return SECRET_PATTERNS.some((re) => re.test(name));
}

/**
 * Recursively list regular-file paths under `dir`, relative to `dir`, sorted.
 * Skips `SKIP_DIRS` directories on both sides; when `excludeSecrets` also skips
 * stray-secret files (used for the SOURCE so they are never published). Returns
 * `[]` when `dir` is absent.
 */
function listFiles(dir, { excludeSecrets }) {
  if (!existsSync(dir)) return [];
  const out = [];
  const walk = (relBase) => {
    const abs = relBase ? join(dir, relBase) : dir;
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      const name = entry.name;
      const rel = relBase ? join(relBase, name) : name;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(name)) continue;
        walk(rel);
      } else if (entry.isFile()) {
        if (excludeSecrets && isSecretFile(name)) continue;
        out.push(rel);
      }
    }
  };
  walk('');
  return out.sort();
}

/** Byte-equal comparison of two files. */
function filesEqual(a, b) {
  return readFileSync(a).equals(readFileSync(b));
}

/** Exec-bit (0o111) of a file's mode. */
function execBits(path) {
  return statSync(path).mode & 0o111;
}

/**
 * Compare the dev source against the product checkout. Reports file-set
 * differences (missing / extra), byte-content differences, and exec-bit
 * differences. The target's secret-pattern files (if any leaked in) surface as
 * `extra in target` — a clean mirror has none.
 */
export function checkBootstrapSync(sourceDir, targetDir) {
  const srcFiles = listFiles(sourceDir, { excludeSecrets: true });
  const tgtFiles = listFiles(targetDir, { excludeSecrets: false });
  const srcSet = new Set(srcFiles);
  const tgtSet = new Set(tgtFiles);
  const mismatches = [];
  for (const rel of srcFiles) {
    if (!tgtSet.has(rel)) {
      mismatches.push(`${rel} (missing in target)`);
      continue;
    }
    const s = join(sourceDir, rel);
    const t = join(targetDir, rel);
    if (!filesEqual(s, t)) mismatches.push(`${rel} (content differs)`);
    else if (execBits(s) !== execBits(t)) mismatches.push(`${rel} (mode differs)`);
  }
  for (const rel of tgtFiles) {
    if (!srcSet.has(rel)) mismatches.push(`${rel} (extra in target)`);
  }
  mismatches.sort();
  return { inSync: mismatches.length === 0, mismatches };
}

/**
 * Make the product checkout a true mirror of the dev source: copy/overwrite
 * every source file (preserving mode), then REMOVE target files no longer in
 * the source. Never descends `SKIP_DIRS` (so the target's `.git/` is untouched);
 * never publishes excluded source files.
 */
export function syncBootstrapToProduct(sourceDir, targetDir) {
  const srcFiles = listFiles(sourceDir, { excludeSecrets: true });
  const tgtFiles = listFiles(targetDir, { excludeSecrets: false });
  const srcSet = new Set(srcFiles);
  const written = [];
  const removed = [];
  for (const rel of srcFiles) {
    const srcPath = join(sourceDir, rel);
    const dstPath = join(targetDir, rel);
    mkdirSync(dirname(dstPath), { recursive: true });
    copyFileSync(srcPath, dstPath);
    chmodSync(dstPath, statSync(srcPath).mode & 0o777);
    written.push(rel);
  }
  for (const rel of tgtFiles) {
    if (!srcSet.has(rel)) {
      rmSync(join(targetDir, rel), { force: true });
      removed.push(rel);
    }
  }
  written.sort();
  removed.sort();
  return { written, removed };
}

function parseArgs(argv) {
  let target = '';
  let source = '';
  let check = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--check') check = true;
    else if (arg === '--target') target = argv[++i] ?? '';
    else if (arg.startsWith('--target=')) target = arg.slice('--target='.length);
    else if (arg === '--source') source = argv[++i] ?? '';
    else if (arg.startsWith('--source=')) source = arg.slice('--source='.length);
  }
  return { target, source, check };
}

function main() {
  const { target, source, check } = parseArgs(process.argv.slice(2));
  if (!target) {
    console.error(
      'Usage: sync-bootstrap-product.mjs --target <product-repo-checkout> [--check] [--source <dir>]',
    );
    console.error('  --target  a local checkout of groundnuty/macf-automated-github-setup');
    process.exit(2);
  }

  const sourceDir = source ? resolve(source) : DEFAULT_SOURCE_DIR;
  if (!existsSync(sourceDir) || !statSync(sourceDir).isDirectory()) {
    console.error(`FATAL: dev-source dir not found or not a directory: ${sourceDir}`);
    process.exit(2);
  }

  const targetDir = resolve(target);
  if (!existsSync(targetDir) || !statSync(targetDir).isDirectory()) {
    console.error(`FATAL: --target is not a directory: ${targetDir}`);
    console.error('  Clone groundnuty/macf-automated-github-setup first, then pass its path.');
    process.exit(2);
  }

  if (check) {
    const { inSync, mismatches } = checkBootstrapSync(sourceDir, targetDir);
    if (inSync) {
      console.log(`OK macf-bootstrap product in sync with dev source (${sourceDir})`);
      process.exit(0);
    }
    console.error(`OUT OF SYNC: ${mismatches.length} mismatch(es) vs ${sourceDir}:`);
    for (const m of mismatches) console.error(`  - ${m}`);
    console.error('Re-publish: node packages/macf/scripts/sync-bootstrap-product.mjs --target <checkout>');
    process.exit(1);
  }

  const { written, removed } = syncBootstrapToProduct(sourceDir, targetDir);
  console.log(`Published macf-bootstrap dev source -> ${targetDir}`);
  console.log(`  source: ${sourceDir}`);
  console.log(`  written (${written.length}):`);
  for (const w of written) console.log(`    + ${w}`);
  console.log(`  removed (${removed.length}):`);
  for (const r of removed) console.log(`    - ${r}`);
  console.log('Next: commit + push the product repo (first publish = operator `gh repo create`).');
  process.exit(0);
}

// Run the CLI only when invoked directly (not when imported by tests).
const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  main();
}
