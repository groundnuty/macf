/**
 * Host-toolchain bootstrap generator (DR-031 piece 4 — portable bootstrap).
 *
 * `claude.sh` today *inherits* the operator's login-shell toolchain (the
 * brew / devbox PATH). cron, a detached restart-self relauncher (DR-031
 * piece 3), and container entrypoints run with a MINIMAL env and do NOT
 * inherit it — so `claude` / `jq` / `node` / `tmux` aren't found. The fix:
 * the launch must **re-establish** its toolchain, not inherit it.
 *
 * Mechanism: a generated `.claude/.macf/host-prelude.sh` that `claude.sh`
 * sources **FIRST** (before the `env.*` loop, the tmux self-wrap, and
 * `exec claude`). The toolchain backend is detected at `macf init` /
 * `macf update` time (this code runs in Node on the host, in the operator's
 * full env), and the file emits a **DYNAMIC re-source** (e.g.
 * `eval "$(/abs/brew shellenv)"`) — NOT a frozen PATH snapshot, so it can't
 * go stale (DR-031 §"Portable bootstrap"). The same file path is consumed by
 * restart-self's relauncher; keep it at exactly
 * `.claude/.macf/host-prelude.sh`.
 *
 * Backends, in priority order:
 *   1. devbox — this repo's mandatory toolchain. `eval "$(devbox global
 *      shellenv)"` recomputes the global Devbox (nix-profile) environment.
 *      Canonical idiom per jetify-com/devbox docs ("add to ~/.bashrc or
 *      ~/.zshrc: eval \"$(devbox global shellenv)\"").
 *   2. brew — linuxbrew / macOS. `eval "$(<abs-brew> shellenv)"`.
 *   3. none — a no-op prelude (managed header + guidance pointing the
 *      operator at the `env.local.<name>` extension convention).
 *
 * macf-managed: regenerated (re-detected) on every `macf update`. Operator
 * host-specifics that auto-detection misses belong in a
 * `.claude/.macf/env.local.<name>` file (sourced after the canonical env.*
 * files), NOT here — this file is overwritten on every update.
 */
import { accessSync, constants, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';

/** The toolchain re-source backend the prelude emits. */
export type ToolchainBackend = 'devbox' | 'brew' | 'none';

/**
 * Injected probe so `detectToolchainBackend` is unit-testable without
 * touching the real filesystem / PATH.
 *
 *   which(cmd)    — resolve a command on PATH → its absolute path, or null
 *   exists(path)  — does this absolute path exist (as a file)?
 */
export interface ToolchainProbe {
  readonly which: (cmd: string) => string | null;
  readonly exists: (path: string) => boolean;
}

/** Result of toolchain detection: the backend + the absolute binary path. */
export interface ToolchainDetection {
  readonly backend: ToolchainBackend;
  /** Absolute path to the devbox / brew binary; null for the `none` backend. */
  readonly path: string | null;
}

/**
 * Known absolute brew install locations, checked in order. A minimal-env
 * launch context (cron / container) won't have brew on PATH, so the
 * detection probes these absolute locations first, then falls back to a
 * PATH lookup.
 */
const BREW_KNOWN_LOCATIONS: readonly string[] = [
  '/home/linuxbrew/.linuxbrew/bin/brew', // linuxbrew (default)
  '/opt/homebrew/bin/brew', // macOS Apple-silicon
  '/usr/local/bin/brew', // macOS Intel / older
];

/**
 * Detect the host toolchain backend + resolve the absolute binary path.
 *
 * Priority: devbox > brew > none.
 *
 *   - devbox is resolvable on PATH → `{ backend: 'devbox', path }`.
 *   - else a brew binary exists at a known location (or on PATH) →
 *     `{ backend: 'brew', path }`.
 *   - else `{ backend: 'none', path: null }`.
 *
 * Pure given the injected `probe`. The real-FS probe is built by
 * `writeHostPrelude` when no explicit detection is passed.
 */
export function detectToolchainBackend(probe: ToolchainProbe): ToolchainDetection {
  // Priority 1: devbox (this repo's mandatory toolchain).
  const devbox = probe.which('devbox');
  if (devbox !== null && devbox !== '') {
    return { backend: 'devbox', path: devbox };
  }

  // Priority 2: brew. Known absolute locations first (the minimal-env launch
  // context the prelude targets has no PATH to find brew on), then PATH.
  for (const loc of BREW_KNOWN_LOCATIONS) {
    if (probe.exists(loc)) {
      return { backend: 'brew', path: loc };
    }
  }
  const brewOnPath = probe.which('brew');
  if (brewOnPath !== null && brewOnPath !== '') {
    return { backend: 'brew', path: brewOnPath };
  }

  // Priority 3: none.
  return { backend: 'none', path: null };
}

/**
 * POSIX single-quote a string for safe embedding in the `eval "$(... )"`
 * command substitution. Wraps in single quotes and escapes any embedded
 * single quote via the canonical `'\''` sequence, so a brew/devbox path
 * containing spaces (or, rarely, quotes) doesn't break the substitution.
 */
function shellSingleQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

const SCHEMA_VERSION_LINE = '# schema_version: 1';

/**
 * Managed-file header for host-prelude.sh. Mirrors the warn-on-hand-edit
 * framing of the sibling `.claude/.macf/` managed files (see
 * `env-files.ts`), adapted for the prelude's "re-detected on every update"
 * contract + its sourced-FIRST role.
 */
function managedHeaderLines(): readonly string[] {
  return [
    '# This file is managed by `macf`. Do not edit directly — it is',
    '# overwritten (re-detected) on the next `macf update`. The template',
    '# lives at groundnuty/macf:src/cli/host-prelude.ts (`generateHostPrelude`).',
    '# To change it, file an issue or PR against that file, then run',
    '# `macf update` here.',
    '#',
    '# This file is SOURCED (not executed) by claude.sh — FIRST, before the',
    '# .claude/.macf/env.* loop, the tmux self-wrap, and `exec claude` — so the',
    '# host toolchain (claude / jq / node / tmux) is on PATH even when the',
    '# launch context has a MINIMAL env that did not inherit the operator',
    '# login-shell PATH: cron, a detached restart-self relauncher (DR-031',
    "# piece 3), or a container entrypoint. The same path is consumed by",
    "# restart-self's relauncher — keep it at exactly",
    '# .claude/.macf/host-prelude.sh.',
  ];
}

/**
 * Shared guidance comment: where operator host-specifics belong (NOT here,
 * since this file is regenerated on every `macf update`).
 */
const ENV_LOCAL_GUIDANCE: readonly string[] = [
  '#',
  '# Host-specifics that auto-detection misses do NOT belong here (this file',
  '# is regenerated on every `macf update`). Put them in a',
  '# `.claude/.macf/env.local.<name>` file — it sources AFTER the canonical',
  '# env.* files (the env.local.* / env.zz.* extension convention claude.sh',
  '# documents).',
];

/**
 * Build the `host-prelude.sh` content for a detection result. PURE — no I/O.
 *
 * Emits the dynamic re-source for devbox / brew (absolute, shell-quoted
 * binary path; re-evaluated on every launch), or a no-op-with-guidance for
 * `none`. A devbox/brew backend with a missing path defensively degrades to
 * the no-op form rather than emit a broken `eval "$( shellenv)"`.
 */
export function generateHostPrelude(detection: ToolchainDetection): string {
  const header = [...managedHeaderLines(), SCHEMA_VERSION_LINE, ''];

  const hasPath = detection.path !== null && detection.path !== '';
  const backend: ToolchainBackend =
    (detection.backend === 'devbox' || detection.backend === 'brew') && !hasPath
      ? 'none'
      : detection.backend;

  switch (backend) {
    case 'devbox': {
      const quoted = shellSingleQuote(detection.path as string);
      const body = [
        '# Generator: generateHostPrelude (host-prelude.ts) — backend: devbox',
        '#',
        '# Dynamic re-source (re-evaluated on EVERY launch), NOT a frozen PATH',
        '# snapshot — so the toolchain can never go stale. `devbox global',
        '# shellenv` recomputes the global Devbox environment (its nix profile)',
        '# and prints the export lines; eval applies them to this shell. The',
        '# absolute path to the devbox binary was detected at `macf init` /',
        '# `macf update` time, because a minimal-env launch context has no PATH',
        '# to find it on. Canonical idiom per jetify-com/devbox docs.',
        ...ENV_LOCAL_GUIDANCE,
        `eval "$(${quoted} global shellenv)"`,
      ];
      return assemble(header, body);
    }
    case 'brew': {
      const quoted = shellSingleQuote(detection.path as string);
      const body = [
        '# Generator: generateHostPrelude (host-prelude.ts) — backend: brew',
        '#',
        '# Dynamic re-source (re-evaluated on EVERY launch), NOT a frozen PATH',
        '# snapshot — so the toolchain can never go stale. `brew shellenv`',
        '# prints the export lines that put the Homebrew prefix on PATH; eval',
        '# applies them. The absolute path to the brew binary was detected at',
        '# `macf init` / `macf update` time, because a minimal-env launch',
        '# context has no PATH to find it on.',
        ...ENV_LOCAL_GUIDANCE,
        `eval "$(${quoted} shellenv)"`,
      ];
      return assemble(header, body);
    }
    case 'none': {
      const body = [
        '# Generator: generateHostPrelude (host-prelude.ts) — backend: none',
        '#',
        '# No devbox or brew toolchain was found at `macf init` / `macf update`',
        '# time, so this prelude is intentionally a NO-OP: claude.sh sources it',
        '# but nothing re-establishes a toolchain. If a minimal-env launch (cron,',
        "# the restart-self relauncher, or a container entrypoint) can't find",
        '# `claude` / `jq` / `node`, add the toolchain setup to a',
        '# `.claude/.macf/env.local.<name>` file (sourced AFTER the canonical',
        '# env.* files — the env.local.* / env.zz.* extension convention claude.sh',
        '# documents). Do NOT add it here: `macf update` re-detects + regenerates',
        '# this managed file on every run, so hand-edits are lost.',
        ':', // bash no-op so the sourced file always has a runnable body
      ];
      return assemble(header, body);
    }
  }
}

/**
 * Join header + body lines with a trailing newline. The schema_version line
 * lives in `header` (right after the comment block), matching the env-files
 * `assemble` shape.
 */
function assemble(header: readonly string[], body: readonly string[]): string {
  return [...header, ...body, ''].join('\n');
}

/**
 * Real-filesystem probe used when `writeHostPrelude` is called without an
 * explicit detection. `which` scans `$PATH`; `exists` stats the path.
 */
function realProbe(): ToolchainProbe {
  return {
    which: whichOnPath,
    exists: (p) => {
      try {
        return statSync(p).isFile();
      } catch {
        return false;
      }
    },
  };
}

/**
 * Resolve a command to its absolute path by scanning `$PATH` (dependency-free
 * `which`). Returns the first PATH entry that holds an executable file of
 * that name, or null. Skips empty PATH segments.
 */
function whichOnPath(cmd: string): string | null {
  const pathEnv = process.env['PATH'] ?? '';
  for (const dir of pathEnv.split(delimiter)) {
    if (dir === '') continue;
    const candidate = join(dir, cmd);
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // missing or not executable — keep scanning.
    }
  }
  return null;
}

/**
 * Write `.claude/.macf/host-prelude.sh` (mode 0644 — it is sourced, not
 * executed). Detects the toolchain backend via the real-FS probe by default;
 * `detection` is injectable for tests / explicit control. Creates
 * `.claude/.macf/` with mkdir -p semantics. Returns the absolute path written.
 */
export function writeHostPrelude(
  workspaceDir: string,
  detection?: ToolchainDetection,
): string {
  const absDir = resolve(workspaceDir);
  const envDir = join(absDir, '.claude', '.macf');
  mkdirSync(envDir, { recursive: true });
  const path = join(envDir, 'host-prelude.sh');
  const resolved = detection ?? detectToolchainBackend(realProbe());
  writeFileSync(path, generateHostPrelude(resolved), { mode: 0o644 });
  return path;
}
