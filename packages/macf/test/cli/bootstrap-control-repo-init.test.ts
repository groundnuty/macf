/**
 * Tests for `macf bootstrap control-repo init` (groundnuty/macf#878).
 * Offline + deterministic: `ControlRepoDeps` is injected throughout, same
 * fake-dependency shape `control-repo.test.ts` already uses for
 * `provisionControlRepo` itself — this file exercises the COMMAND layer
 * (manifest parsing, exit codes, `--json`/text rendering) on top of that
 * already-tested core, plus the decisive pre-Amendment-F-vs-already-migrated
 * pair and the idempotence + honest-unknown-floor properties this issue's
 * acceptance criteria require.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runBootstrapControlRepoInit } from '../../src/cli/commands/bootstrap-control-repo-init.js';
import type { ControlRepoDeps } from '../../src/cli/bootstrap/control-repo.js';

const VALID_FLEET_YAML = `apiVersion: macf/v0
kind: Fleet
metadata:
  name: demo-fleet
owner:
  account: groundnuty
  type: user
  registry: { type: profile, user: groundnuty }
network:
  advertise_host: example.ts.net
transport:
  age_recipients: []
defaults:
  role_template: groundnuty/agentic-repo-template
  app_manifest: dr-019
agents:
  - role: code-agent
    profile: code
    repo: groundnuty/demo-code
    deploy_path: /x
trust:
  ca: per-project
  federated_cas: []
`;

function writeManifest(text: string): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'macf-control-repo-init-test-'));
  const file = join(dir, 'fleet.yaml');
  writeFileSync(file, text);
  return { dir, file };
}

/** A `ControlRepoDeps` whose mutating methods THROW by default — any test that expects a mutation overrides the specific method it needs; every other test proves that method was never reached. */
function throwingDeps(overrides: Partial<ControlRepoDeps> = {}): ControlRepoDeps {
  return {
    checkMeta: async () => ({ presence: 'absent' }),
    readManifestFile: async () => undefined,
    createRepo: async () => {
      throw new Error('must not be called in this test');
    },
    unarchiveRepo: async () => {
      throw new Error('must not be called in this test');
    },
    cloneRepo: async () => {},
    commitAndPush: async () => {
      throw new Error('must not be called in this test');
    },
    ...overrides,
  };
}

describe('runBootstrapControlRepoInit', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  const dirs: string[] = [];

  afterEach(() => {
    logSpy?.mockRestore();
    errSpy?.mockRestore();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('a missing manifest file: nonzero exit, plain-text mode prints to stderr only, nothing touched', async () => {
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const code = await runBootstrapControlRepoInit({ file: '/does/not/exist/fleet.yaml' }, throwingDeps());
    expect(code).toBe(1);
    expect(errSpy).toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('a missing manifest file under --json: non-empty JSON {error} on stdout, nonzero exit (macf#830 lesson)', async () => {
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const code = await runBootstrapControlRepoInit({ file: '/does/not/exist/fleet.yaml', json: true }, throwingDeps());
    expect(code).toBe(1);
    const out = logSpy.mock.calls.flat().join('');
    expect(out.length).toBeGreaterThan(0);
    expect(() => JSON.parse(out)).not.toThrow();
  });

  it('an invalid manifest (schema violation) under --json: non-empty JSON {error}, nonzero exit', async () => {
    const { dir, file } = writeManifest('apiVersion: macf/v0\nkind: Fleet\n');
    dirs.push(dir);
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const code = await runBootstrapControlRepoInit({ file, json: true }, throwingDeps());
    expect(code).toBe(1);
    const json = JSON.parse(logSpy.mock.calls.flat().join('')) as { error?: unknown };
    expect(json.error).toBeDefined();
  });

  // --- The decisive pair (this issue's own requirement) ---

  it('DECISIVE 1/2 — a pre-control-plane fleet (no control repo on GitHub yet): creates it, commits fleet.yaml, names EXACTLY what differs', async () => {
    const { dir, file } = writeManifest(VALID_FLEET_YAML);
    dirs.push(dir);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const createCalls: string[] = [];
    const commitCalls: string[] = [];
    const deps = throwingDeps({
      checkMeta: async () => ({ presence: 'absent' }),
      createRepo: async (repo) => {
        createCalls.push(repo);
      },
      commitAndPush: async (d) => {
        commitCalls.push(d);
        return 'pushed';
      },
    });

    const code = await runBootstrapControlRepoInit({ file, json: true }, deps);

    expect(code).toBe(0);
    expect(createCalls).toEqual(['groundnuty/demo-fleet-control']);
    expect(commitCalls).toHaveLength(1);
    const json = JSON.parse(logSpy.mock.calls.flat().join('')) as {
      status: string;
      mutated: boolean;
      repo: string;
      message: string;
    };
    expect(json.status).toBe('created');
    expect(json.mutated).toBe(true);
    expect(json.repo).toBe('groundnuty/demo-fleet-control');
    // The report must NAME what it did, not just say "done" — assert-the-wrong-path.md's
    // concern: a report that can't distinguish "created" from "already there" is a
    // no-op-in-disguise, which is exactly the failure mode this decisive pair guards.
    expect(json.message).toMatch(/had no control-plane repo before this run/);
    expect(json.message).toMatch(/NOT previously migrated/);
  });

  it('DECISIVE 2/2 — an already-migrated fleet (control repo exists, fleet.yaml matches): no-op, reported as already-correct', async () => {
    const { dir, file } = writeManifest(VALID_FLEET_YAML);
    dirs.push(dir);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const deps = throwingDeps({
      checkMeta: async () => ({ presence: 'present', archived: false }),
      readManifestFile: async () => VALID_FLEET_YAML,
      // createRepo / commitAndPush inherit the throwing default — this test
      // is exactly the one `assert-the-wrong-path.md` warns a lone no-op
      // check can't distinguish from "never looked": here it's paired with
      // DECISIVE 1/2 above, which proves the SAME command does mutate when
      // migration is actually needed.
    });

    const code = await runBootstrapControlRepoInit({ file, json: true }, deps);

    expect(code).toBe(0);
    const json = JSON.parse(logSpy.mock.calls.flat().join('')) as { status: string; mutated: boolean; message: string };
    expect(json.status).toBe('reused');
    expect(json.mutated).toBe(false);
    expect(json.message).toMatch(/already migrated/);
  });

  // --- Idempotence: running it twice against the SAME (initially unmigrated) fleet ---

  it('idempotent — a second run against a fleet this command JUST migrated makes no further GitHub writes', async () => {
    const { dir, file } = writeManifest(VALID_FLEET_YAML);
    dirs.push(dir);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    // Call 1: control repo does not exist yet.
    let created = false;
    const firstRunDeps = throwingDeps({
      checkMeta: async () => ({ presence: 'absent' }),
      createRepo: async () => {
        created = true;
      },
      commitAndPush: async () => 'pushed',
    });
    const code1 = await runBootstrapControlRepoInit({ file, json: true }, firstRunDeps);
    expect(code1).toBe(0);
    expect(created).toBe(true);

    // Call 2: simulates the control repo now existing with the SAME fleet.yaml
    // this run committed. createRepo/commitAndPush stay on the throwing
    // default from `throwingDeps()` — if the second call re-creates or
    // re-commits, the test fails on the throw, not on a soft assertion.
    logSpy.mockClear();
    const secondRunDeps = throwingDeps({
      checkMeta: async () => ({ presence: 'present', archived: false }),
      readManifestFile: async () => VALID_FLEET_YAML,
    });
    const code2 = await runBootstrapControlRepoInit({ file, json: true }, secondRunDeps);
    expect(code2).toBe(0);
    const json2 = JSON.parse(logSpy.mock.calls.flat().join('')) as { status: string; mutated: boolean };
    expect(json2.status).toBe('reused');
    expect(json2.mutated).toBe(false);
  });

  // --- Honest-unknown floor (macf#1078/#1096/#1117/#1136's floor, applied here) ---

  it('honest-unknown floor — existence unconfirmable (auth/network/rate-limit): FAILS the run, never reported as created or already-migrated', async () => {
    const { dir, file } = writeManifest(VALID_FLEET_YAML);
    dirs.push(dir);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const deps = throwingDeps({ checkMeta: async () => ({ presence: 'unknown' }) });

    const code = await runBootstrapControlRepoInit({ file, json: true }, deps);

    expect(code).toBe(1);
    const json = JSON.parse(logSpy.mock.calls.flat().join('')) as { status: string; mutated: boolean; message: string };
    expect(json.status).toBe('failed');
    expect(json.mutated).toBe(false);
    expect(json.message).not.toMatch(/already migrated/);
    expect(json.message).not.toMatch(/^Created/);
  });

  // --- Never destructive: an archived OWN control repo is refused, not silently revived ---

  it('an archived control repo belonging to THIS fleet is refused, not silently un-archived', async () => {
    const { dir, file } = writeManifest(VALID_FLEET_YAML);
    dirs.push(dir);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    let unarchiveCalled = false;
    const deps = throwingDeps({
      checkMeta: async () => ({ presence: 'present', archived: true }),
      readManifestFile: async () => VALID_FLEET_YAML,
      unarchiveRepo: async () => {
        unarchiveCalled = true;
      },
    });

    const code = await runBootstrapControlRepoInit({ file, json: true }, deps);

    expect(code).toBe(1);
    expect(unarchiveCalled).toBe(false);
    const json = JSON.parse(logSpy.mock.calls.flat().join('')) as { status: string; mutated: boolean };
    expect(json.status).toBe('archived');
    expect(json.mutated).toBe(false);
  });

  // --- Never destructive: a same-named repo belonging to someone/something else is refused ---

  it('a same-named repo that is NOT this fleet\'s control repo (foreign) is refused, never adopted', async () => {
    const { dir, file } = writeManifest(VALID_FLEET_YAML);
    dirs.push(dir);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const deps = throwingDeps({
      checkMeta: async () => ({ presence: 'present', archived: false }),
      readManifestFile: async () => undefined,
    });

    const code = await runBootstrapControlRepoInit({ file, json: true }, deps);

    expect(code).toBe(1);
    const json = JSON.parse(logSpy.mock.calls.flat().join('')) as { status: string };
    expect(json.status).toBe('foreign');
  });

  it('plain-text mode names the fleet + repo, not just a bare status word', async () => {
    const { dir, file } = writeManifest(VALID_FLEET_YAML);
    dirs.push(dir);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const deps = throwingDeps({
      checkMeta: async () => ({ presence: 'absent' }),
      createRepo: async () => {},
      commitAndPush: async () => 'pushed',
    });

    const code = await runBootstrapControlRepoInit({ file }, deps);

    expect(code).toBe(0);
    const text = logSpy.mock.calls.flat().join('\n');
    expect(text).toContain('groundnuty/demo-fleet-control');
    expect(readFileSync(file, 'utf-8')).toBe(VALID_FLEET_YAML);
  });
});
