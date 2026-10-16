import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isEntrypoint } from '../../../src/plugin/lib/entrypoint.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'entrypoint-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('isEntrypoint (groundnuty/macf#1490)', () => {
  it('is true when node was started through a symlinked directory, as macf update installs dist', () => {
    const realDist = join(root, 'npx-cache', 'dist', 'plugin', 'bin');
    mkdirSync(realDist, { recursive: true });
    const realFile = join(realDist, 'macf-plugin-cli.js');
    writeFileSync(realFile, '');
    symlinkSync(join(root, 'npx-cache', 'dist'), join(root, 'dist'));
    const viaSymlink = join(root, 'dist', 'plugin', 'bin', 'macf-plugin-cli.js');
    // node resolves import.meta.url to the real path; argv[1] keeps the symlinked one.
    expect(isEntrypoint(pathToFileURL(realFile).href, viaSymlink)).toBe(true);
  });

  it('is true for a direct path and false for a different file', () => {
    const a = join(root, 'a.js');
    const b = join(root, 'b.js');
    writeFileSync(a, '');
    writeFileSync(b, '');
    expect(isEntrypoint(pathToFileURL(a).href, a)).toBe(true);
    expect(isEntrypoint(pathToFileURL(a).href, b)).toBe(false);
  });

  it('is false with no argv[1] or an unresolvable one', () => {
    const a = join(root, 'a.js');
    writeFileSync(a, '');
    expect(isEntrypoint(pathToFileURL(a).href, undefined)).toBe(false);
    expect(isEntrypoint(pathToFileURL(a).href, join(root, 'missing.js'))).toBe(false);
  });
});
