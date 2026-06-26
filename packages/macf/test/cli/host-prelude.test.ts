/**
 * Tests for the host-prelude generator (DR-031 piece 4, host-prelude.ts).
 *
 * `detectToolchainBackend` is exercised with a FAKE probe (no real FS / PATH
 * touch); `generateHostPrelude` is a pure function over a detection result;
 * `writeHostPrelude` is exercised with an injected detection against a tmpdir
 * so the on-disk shape + mode are pinned without depending on the host's
 * actual toolchain.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  detectToolchainBackend,
  generateHostPrelude,
  writeHostPrelude,
} from '../../src/cli/host-prelude.js';
import type { ToolchainProbe, ToolchainDetection } from '../../src/cli/host-prelude.js';

// ---------------------------------------------------------------------------
// Fake-probe builder
// ---------------------------------------------------------------------------

/**
 * Build a fake probe. `pathCmds` maps a command name → resolved abs path
 * (for `which`); `existing` is the set of absolute paths that `exists`
 * reports true for.
 */
function fakeProbe(opts: {
  which?: Record<string, string>;
  existing?: readonly string[];
}): ToolchainProbe {
  const which = opts.which ?? {};
  const existing = new Set(opts.existing ?? []);
  return {
    which: (cmd) => which[cmd] ?? null,
    exists: (p) => existing.has(p),
  };
}

// ---------------------------------------------------------------------------
// detectToolchainBackend
// ---------------------------------------------------------------------------

describe('detectToolchainBackend', () => {
  it('picks devbox first when devbox is resolvable on PATH', () => {
    const probe = fakeProbe({
      which: { devbox: '/usr/local/bin/devbox', brew: '/home/linuxbrew/.linuxbrew/bin/brew' },
      existing: ['/home/linuxbrew/.linuxbrew/bin/brew'],
    });
    expect(detectToolchainBackend(probe)).toEqual({
      backend: 'devbox',
      path: '/usr/local/bin/devbox',
    });
  });

  it('falls back to brew (known location) when devbox is absent', () => {
    const probe = fakeProbe({
      existing: ['/home/linuxbrew/.linuxbrew/bin/brew'],
    });
    expect(detectToolchainBackend(probe)).toEqual({
      backend: 'brew',
      path: '/home/linuxbrew/.linuxbrew/bin/brew',
    });
  });

  it('checks the brew known locations in order (linuxbrew > opt > usr/local)', () => {
    // Only the macOS Apple-silicon location exists.
    const probe = fakeProbe({ existing: ['/opt/homebrew/bin/brew'] });
    expect(detectToolchainBackend(probe)).toEqual({
      backend: 'brew',
      path: '/opt/homebrew/bin/brew',
    });
  });

  it('falls back to brew on PATH when no known location exists', () => {
    const probe = fakeProbe({ which: { brew: '/custom/prefix/bin/brew' } });
    expect(detectToolchainBackend(probe)).toEqual({
      backend: 'brew',
      path: '/custom/prefix/bin/brew',
    });
  });

  it('returns none when neither devbox nor brew is found', () => {
    const probe = fakeProbe({});
    expect(detectToolchainBackend(probe)).toEqual({ backend: 'none', path: null });
  });

  it('treats empty-string which() as not-found (devbox)', () => {
    const probe = fakeProbe({ which: { devbox: '' }, existing: ['/opt/homebrew/bin/brew'] });
    expect(detectToolchainBackend(probe).backend).toBe('brew');
  });
});

// ---------------------------------------------------------------------------
// generateHostPrelude
// ---------------------------------------------------------------------------

describe('generateHostPrelude', () => {
  it('emits a dynamic devbox global shellenv re-source (not a frozen PATH)', () => {
    const out = generateHostPrelude({ backend: 'devbox', path: '/usr/local/bin/devbox' });
    // Dynamic re-source: eval of `devbox global shellenv` output, re-evaluated
    // each launch. NOT a literal `export PATH=...` snapshot.
    expect(out).toContain(`eval "$('/usr/local/bin/devbox' global shellenv)"`);
    expect(out).not.toMatch(/^export PATH=/m);
  });

  it('emits a dynamic brew shellenv re-source (not a frozen PATH)', () => {
    const out = generateHostPrelude({
      backend: 'brew',
      path: '/home/linuxbrew/.linuxbrew/bin/brew',
    });
    expect(out).toContain(`eval "$('/home/linuxbrew/.linuxbrew/bin/brew' shellenv)"`);
    expect(out).not.toMatch(/^export PATH=/m);
  });

  it('shell-quotes the brew path and keeps it absolute', () => {
    const out = generateHostPrelude({
      backend: 'brew',
      path: '/home/linuxbrew/.linuxbrew/bin/brew',
    });
    // Single-quoted (shell-safe) AND absolute (leading slash inside the quote).
    expect(out).toMatch(/eval "\$\('\/[^']*brew' shellenv\)"/);
  });

  it('safely single-quotes a path containing a space', () => {
    const out = generateHostPrelude({ backend: 'brew', path: '/opt/my brew/bin/brew' });
    expect(out).toContain(`eval "$('/opt/my brew/bin/brew' shellenv)"`);
  });

  it('escapes an embedded single quote in the path', () => {
    const out = generateHostPrelude({ backend: 'devbox', path: "/o'dd/devbox" });
    // POSIX single-quote escape: ' -> '\''
    expect(out).toContain(`eval "$('/o'\\''dd/devbox' global shellenv)"`);
  });

  it('emits a no-op-with-guidance prelude for the none backend', () => {
    const out = generateHostPrelude({ backend: 'none', path: null });
    expect(out).toContain('backend: none');
    // A bash no-op body so the sourced file is always runnable.
    expect(out).toMatch(/^:$/m);
    // No eval re-source line for none.
    expect(out).not.toContain('shellenv');
    // Points the operator at the env.local extension convention.
    expect(out).toContain('env.local.<name>');
  });

  it('defensively degrades a devbox backend with no path to the no-op form', () => {
    const out = generateHostPrelude({ backend: 'devbox', path: null });
    expect(out).toContain('backend: none');
    expect(out).not.toContain('shellenv');
  });

  it('carries the managed-file header on every backend', () => {
    for (const det of [
      { backend: 'devbox', path: '/usr/local/bin/devbox' },
      { backend: 'brew', path: '/home/linuxbrew/.linuxbrew/bin/brew' },
      { backend: 'none', path: null },
    ] as ToolchainDetection[]) {
      const out = generateHostPrelude(det);
      expect(out).toContain('managed by `macf`');
      expect(out).toContain('overwritten (re-detected) on the next `macf update`');
      // Sourced FIRST contract documented in the header.
      expect(out).toContain('SOURCED (not executed) by claude.sh');
      // schema_version line present (matches the .claude/.macf/ family).
      expect(out).toContain('# schema_version: 1');
    }
  });

  it('ends with a trailing newline', () => {
    const out = generateHostPrelude({ backend: 'none', path: null });
    expect(out.endsWith('\n')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// writeHostPrelude
// ---------------------------------------------------------------------------

describe('writeHostPrelude', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'macf-host-prelude-test-'));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('writes .claude/.macf/host-prelude.sh and returns its absolute path', () => {
    const path = writeHostPrelude(tmpRoot, { backend: 'brew', path: '/opt/homebrew/bin/brew' });
    expect(path).toBe(join(tmpRoot, '.claude', '.macf', 'host-prelude.sh'));
    expect(path.startsWith('/')).toBe(true);
    expect(existsSync(path)).toBe(true);
  });

  it('creates .claude/.macf/ with mkdir -p semantics when absent', () => {
    expect(existsSync(join(tmpRoot, '.claude'))).toBe(false);
    writeHostPrelude(tmpRoot, { backend: 'none', path: null });
    expect(existsSync(join(tmpRoot, '.claude', '.macf'))).toBe(true);
  });

  it('writes the file at mode 0644 (sourced, not executed)', () => {
    const path = writeHostPrelude(tmpRoot, { backend: 'none', path: null });
    expect(statSync(path).mode & 0o777).toBe(0o644);
  });

  it('on-disk content matches generateHostPrelude(detection)', () => {
    const det: ToolchainDetection = { backend: 'devbox', path: '/usr/local/bin/devbox' };
    const path = writeHostPrelude(tmpRoot, det);
    expect(readFileSync(path, 'utf-8')).toBe(generateHostPrelude(det));
  });

  it('defaults to real-probe detection when no detection is injected', () => {
    // The host running tests may or may not have devbox/brew; either way the
    // file is written and is one of the valid shapes.
    const path = writeHostPrelude(tmpRoot);
    const content = readFileSync(path, 'utf-8');
    expect(content).toContain('managed by `macf`');
    const isReSource = content.includes('shellenv');
    const isNoOp = /^:$/m.test(content);
    expect(isReSource || isNoOp).toBe(true);
  });
});
