/**
 * Tests for `scripts/harvest-reflection.sh` — the PreCompact hook that harvests
 * a *staged* reflection (`.claude/.macf/reflections/pending.json`), wraps it in
 * the versioned reflection-schema envelope, appends it to a per-session JSONL
 * ledger, and clears the stage. groundnuty/macf#500, DR-026 F2.
 *
 * Hook contract (PreCompact): JSON on stdin carrying `session_id`,
 * `transcript_path?`, `cwd`, `trigger` ("auto"|"manual"). Matcher-less +
 * NON-BLOCKING per DR-023 §UC-3 — the script ALWAYS exits 0 (no exit 2 path),
 * so it can never delay/block compaction. Override:
 * MACF_SKIP_REFLECTION_HARVEST=1.
 *
 * The emitted JSONL line is validated against `ReflectionRecordSchema` from
 * `@groundnuty/macf-core` (the same schema F4's Monitor reads the ledger with).
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReflectionRecordSchema } from '@groundnuty/macf-core';
import { findCliPackageRoot } from '../../src/cli/rules.js';

const HOOK_SCRIPT = join(findCliPackageRoot(), 'scripts', 'harvest-reflection.sh');

const REFLECTIONS_REL = join('.claude', '.macf', 'reflections');

interface RunResult {
  readonly status: number | null;
  readonly stderr: string;
  readonly projectDir: string;
  /** Read + JSON-parse every line of a ledger file (empty if absent). */
  readonly ledger: (sessionId: string) => unknown[];
  /** Read the pending.json staged file (undefined if absent). */
  readonly pending: () => string | undefined;
}

function runHook(opts: {
  /** PreCompact stdin payload. Pass a raw string to test malformed stdin. */
  readonly payload: Record<string, unknown> | string;
  /** Pre-seed pending.json with this content (string written verbatim). */
  readonly stagedPending?: string;
  readonly env?: Record<string, string | undefined>;
}): RunResult {
  const projectDir = mkdtempSync(join(tmpdir(), 'macf-reflect-'));
  const reflectionsDir = join(projectDir, REFLECTIONS_REL);
  if (opts.stagedPending !== undefined) {
    mkdirSync(reflectionsDir, { recursive: true });
    writeFileSync(join(reflectionsDir, 'pending.json'), opts.stagedPending);
  }

  const input = typeof opts.payload === 'string' ? opts.payload : JSON.stringify(opts.payload);

  // Clean env so the runner's ambient MACF_* doesn't leak identity into the
  // record; CLAUDE_PROJECT_DIR points the hook at the temp workspace.
  const cleanEnv: Record<string, string> = {
    PATH: process.env['PATH'] ?? '',
    CLAUDE_PROJECT_DIR: projectDir,
  };
  if (opts.env) {
    for (const [k, v] of Object.entries(opts.env)) {
      if (v === undefined) delete cleanEnv[k];
      else cleanEnv[k] = v;
    }
  }

  const res = spawnSync('bash', [HOOK_SCRIPT], {
    input,
    env: cleanEnv,
    encoding: 'utf-8',
  });

  return {
    status: res.status,
    stderr: res.stderr ?? '',
    projectDir,
    ledger: (sessionId: string) => {
      const p = join(reflectionsDir, `${sessionId}.jsonl`);
      if (!existsSync(p)) return [];
      return readFileSync(p, 'utf-8')
        .split('\n')
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l));
    },
    pending: () => {
      const p = join(reflectionsDir, 'pending.json');
      return existsSync(p) ? readFileSync(p, 'utf-8') : undefined;
    },
  };
}

const RICH_STAGE = JSON.stringify({
  observed_patterns: [{ pattern: 'p1', evidence: 'e1', tier_hint: 'tier-1', key: 'k1' }],
  breaches: [{ rule: 'r1', what: 'w1', ref: '#500' }],
  rule_evolution_signals: [{ signal: 's1', proposed_tier: 't2', rationale: 'because' }],
  unresolved: ['u1', 'u2'],
  synthesis: 'the session synthesis',
});

describe('harvest-reflection.sh (PreCompact hook)', () => {
  describe('(a) staged pending.json with rich fields → schema-valid merged record', () => {
    it('emits a single JSONL line that validates + carries the merged fields', () => {
      const r = runHook({
        payload: { session_id: 'sess-a', trigger: 'manual', cwd: '/somewhere' },
        stagedPending: RICH_STAGE,
        env: { MACF_AGENT_NAME: 'macf-code-agent', MACF_AGENT_ROLE: 'implementer', MACF_PROJECT: 'macf' },
      });
      expect(r.status).toBe(0);

      const lines = r.ledger('sess-a');
      expect(lines).toHaveLength(1);

      // Schema-valid per the canonical macf-core schema.
      const rec = ReflectionRecordSchema.parse(lines[0]);
      expect(rec.schema_version).toBe('1.0');
      expect(rec.kind).toBe('macf.reflection');
      expect(rec.trigger).toBe('pre-compact');
      expect(rec.compaction_type).toBe('manual');
      expect(rec.session_id).toBe('sess-a');

      // Identity merged from env.
      expect(rec.agent.name).toBe('macf-code-agent');
      expect(rec.agent.role).toBe('implementer');
      expect(rec.agent.login).toBe('macf-code-agent[bot]');
      expect(rec.project).toBe('macf');

      // Staged fields merged through.
      expect(rec.observed_patterns).toEqual([
        { pattern: 'p1', evidence: 'e1', tier_hint: 'tier-1', key: 'k1' },
      ]);
      expect(rec.breaches).toEqual([{ rule: 'r1', what: 'w1', ref: '#500' }]);
      expect(rec.rule_evolution_signals).toEqual([
        { signal: 's1', proposed_tier: 't2', rationale: 'because' },
      ]);
      expect(rec.unresolved).toEqual(['u1', 'u2']);
      expect(rec.synthesis).toBe('the session synthesis');

      // ISO8601 UTC timestamp.
      expect(rec.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    });

    it('records compaction_type "auto" from an auto-trigger payload', () => {
      const r = runHook({
        payload: { session_id: 'sess-auto', trigger: 'auto' },
        stagedPending: RICH_STAGE,
      });
      expect(r.status).toBe(0);
      const rec = ReflectionRecordSchema.parse(r.ledger('sess-auto')[0]);
      expect(rec.compaction_type).toBe('auto');
    });
  });

  describe('(b) no pending.json → mechanical-only valid envelope', () => {
    it('emits an empty-arrays/empty-synthesis record (still schema-valid)', () => {
      const r = runHook({ payload: { session_id: 'sess-b', trigger: 'manual' } });
      expect(r.status).toBe(0);

      const lines = r.ledger('sess-b');
      expect(lines).toHaveLength(1);
      const rec = ReflectionRecordSchema.parse(lines[0]);
      expect(rec.observed_patterns).toEqual([]);
      expect(rec.breaches).toEqual([]);
      expect(rec.rule_evolution_signals).toEqual([]);
      expect(rec.unresolved).toEqual([]);
      expect(rec.synthesis).toBe('');
    });
  });

  describe('(c) pending.json cleared after run', () => {
    it('overwrites the stage with an empty template after harvesting', () => {
      const r = runHook({
        payload: { session_id: 'sess-c', trigger: 'manual' },
        stagedPending: RICH_STAGE,
      });
      expect(r.status).toBe(0);
      // The record was harvested...
      expect(r.ledger('sess-c')).toHaveLength(1);
      // ...and the stage is cleared to an empty object (next session starts fresh).
      const pending = r.pending();
      expect(pending).toBeDefined();
      expect(JSON.parse(pending!)).toEqual({});
    });
  });

  describe('(d) MACF_SKIP_REFLECTION_HARVEST=1 → no-op, stage untouched', () => {
    it('exits 0 without writing a ledger or touching the stage', () => {
      const r = runHook({
        payload: { session_id: 'sess-d', trigger: 'manual' },
        stagedPending: RICH_STAGE,
        env: { MACF_SKIP_REFLECTION_HARVEST: '1' },
      });
      expect(r.status).toBe(0);
      // No ledger written.
      expect(r.ledger('sess-d')).toHaveLength(0);
      // Stage preserved verbatim (NOT cleared).
      expect(r.pending()).toBe(RICH_STAGE);
    });
  });

  describe('(e) malformed input → exit 0 (never blocks), does not crash', () => {
    it('malformed stdin → exit 0 + mechanical record under unknown-session', () => {
      const r = runHook({ payload: 'this is not json {{{' });
      expect(r.status).toBe(0);
      // session_id couldn't be parsed → fallback ledger filename.
      const lines = r.ledger('unknown-session');
      expect(lines).toHaveLength(1);
      const rec = ReflectionRecordSchema.parse(lines[0]);
      expect(rec.session_id).toBe('');
      expect(rec.compaction_type).toBeNull();
    });

    it('malformed pending.json → exit 0 + mechanical record, stage cleared', () => {
      const r = runHook({
        payload: { session_id: 'sess-e', trigger: 'manual' },
        stagedPending: 'BROKEN {{{ not json',
      });
      expect(r.status).toBe(0);
      const lines = r.ledger('sess-e');
      expect(lines).toHaveLength(1);
      const rec = ReflectionRecordSchema.parse(lines[0]);
      // Broken stage → treated as empty (mechanical-only), not a crash.
      expect(rec.observed_patterns).toEqual([]);
      expect(rec.synthesis).toBe('');
      // Stage still cleared so the broken file doesn't recur next session.
      expect(JSON.parse(r.pending()!)).toEqual({});
    });
  });

  describe('(f) exit code is 0 in ALL cases', () => {
    const cases: { readonly name: string; readonly opts: Parameters<typeof runHook>[0] }[] = [
      { name: 'rich staged', opts: { payload: { session_id: 's1', trigger: 'manual' }, stagedPending: RICH_STAGE } },
      { name: 'mechanical-only', opts: { payload: { session_id: 's2', trigger: 'auto' } } },
      { name: 'malformed stdin', opts: { payload: '{{{garbage' } },
      { name: 'malformed pending', opts: { payload: { session_id: 's3' }, stagedPending: 'nope' } },
      { name: 'empty stdin', opts: { payload: '' } },
      { name: 'no trigger field', opts: { payload: { session_id: 's4' } } },
      { name: 'unknown trigger value', opts: { payload: { session_id: 's5', trigger: 'whatever' } } },
      { name: 'skip override', opts: { payload: { session_id: 's6' }, env: { MACF_SKIP_REFLECTION_HARVEST: '1' } } },
    ];
    for (const c of cases) {
      it(`exits 0: ${c.name}`, () => {
        expect(runHook(c.opts).status).toBe(0);
      });
    }

    it('an unknown trigger value records compaction_type null (not the raw string)', () => {
      const r = runHook({ payload: { session_id: 's5b', trigger: 'whatever' } });
      const rec = ReflectionRecordSchema.parse(r.ledger('s5b')[0]);
      expect(rec.compaction_type).toBeNull();
    });
  });
});
