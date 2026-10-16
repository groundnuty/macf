import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * True when the module at `moduleUrl` is the file node was started with.
 *
 * Both sides are resolved to real paths: `macf update` installs the plugin's
 * `dist/` as a symlink into the npx cache, and node resolves `import.meta.url`
 * through it while `process.argv[1]` keeps the symlinked path. Comparing them
 * as written never matches, so the CLI would exit 0 without running
 * (groundnuty/macf#1490).
 */
export function isEntrypoint(moduleUrl: string, argv1: string | undefined = process.argv[1]): boolean {
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}
