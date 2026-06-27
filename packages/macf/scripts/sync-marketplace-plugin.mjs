#!/usr/bin/env node
/**
 * Thin CLI for the marketplace plugin sync (groundnuty/macf#605).
 *
 *   --target <macf-agent-dir>   (required) the marketplace `macf-agent/` dir
 *   --check                     (optional) report mismatches; exit 1 if NOT in
 *                               sync (the publish.yml CI gate), exit 0 if in sync
 *
 * Default (no `--check`): run the sync, print written/removed counts, exit 0.
 *
 * The canonical plugin dir is resolved relative to this script
 * (`packages/macf/plugin`). The sync core is imported from the built `dist/`
 * (`../dist/cli/marketplace-sync.js`) — CI builds the macf package before the
 * publish.yml sync gate runs (see that workflow's gate step). Node built-ins
 * only otherwise.
 */
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = dirname(SCRIPT_DIR); // packages/macf
const CANONICAL_PLUGIN_DIR = join(PKG_ROOT, 'plugin');
const CORE_PATH = join(PKG_ROOT, 'dist', 'cli', 'marketplace-sync.js');

function parseArgs(argv) {
  let target = '';
  let check = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--check') check = true;
    else if (arg === '--target') target = argv[++i] ?? '';
    else if (arg.startsWith('--target=')) target = arg.slice('--target='.length);
  }
  return { target, check };
}

const { target, check } = parseArgs(process.argv.slice(2));
if (!target) {
  console.error('Usage: sync-marketplace-plugin.mjs --target <macf-agent-dir> [--check]');
  process.exit(2);
}

const { checkPluginSync, syncPluginToMarketplace } = await import(pathToFileURL(CORE_PATH).href);
const targetDir = resolve(target);

if (check) {
  const { inSync, mismatches } = checkPluginSync(CANONICAL_PLUGIN_DIR, targetDir);
  if (inSync) {
    console.log(`OK marketplace plugin in sync with canonical (${CANONICAL_PLUGIN_DIR})`);
    process.exit(0);
  }
  console.error(`OUT OF SYNC: ${mismatches.length} mismatch(es) vs canonical plugin/:`);
  for (const m of mismatches) console.error(`  - ${m}`);
  process.exit(1);
}

const { written, removed } = syncPluginToMarketplace(CANONICAL_PLUGIN_DIR, targetDir);
console.log(`Synced canonical plugin -> ${targetDir}`);
console.log(`  written (${written.length}):`);
for (const w of written) console.log(`    + ${w}`);
console.log(`  removed (${removed.length}):`);
for (const r of removed) console.log(`    - ${r}`);
process.exit(0);
