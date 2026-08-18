/**
 * Tests for `macf fleet delete-apps` / `macf fleet destroy` — DR-043
 * Amendment G, the IRREVERSIBLE half of the fleet teardown ladder
 * (groundnuty/macf#867). Fully offline: every dep is injected
 * (`FleetDeleteAppsDeps` / `FleetDestroyDeps`), no `gh`/network/stdin
 * involved.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DESTROY_ENV_ACK_VAR,
  runFleetDeleteApps,
  runFleetDestroy,
  type FleetDeleteAppsDeps,
  type FleetDestroyDeps,
} from '../../src/cli/commands/fleet-teardown-destructive.js';

const FLEET_YAML = `apiVersion: macf/v0
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

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function writeManifest(body = FLEET_YAML): string {
  const dir = mkdtempSync(join(tmpdir(), 'macf-fleet-teardown-destructive-test-'));
  dirs.push(dir);
  const p = join(dir, 'fleet.yaml');
  writeFileSync(p, body);
  return p;
}

function captureConsole(): { logs: string[]; errs: string[]; restore: () => void } {
  const logs: string[] = [];
  const errs: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  const origStderrWrite = process.stderr.write.bind(process.stderr);
  console.log = (...a: unknown[]) => logs.push(a.map(String).join(' '));
  console.error = (...a: unknown[]) => errs.push(a.map(String).join(' '));
  process.stderr.write = ((chunk: string | Uint8Array) => {
    errs.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return true;
  }) as typeof process.stderr.write;
  return {
    logs,
    errs,
    restore: () => {
      console.log = origLog;
      console.error = origErr;
      process.stderr.write = origStderrWrite;
    },
  };
}

/** Gate allowed (`ours`) by default; every mutating call throws unless a test overrides it — surfaces an unexpected touch immediately (same discipline `fleet-teardown.test.ts` uses). */
function deleteAppsDepsFor(overrides: Partial<FleetDeleteAppsDeps> = {}): FleetDeleteAppsDeps {
  return {
    checkMeta: async () => ({ presence: 'present', archived: false }),
    readManifestFile: async () => FLEET_YAML,
    checkRegistryPresence: async () => 'present',
    deleteRegistryVariable: async () => {
      throw new Error('must not be called — this test did not override deleteRegistryVariable');
    },
    archiveRepo: async () => {
      throw new Error('must not be called — this test did not override archiveRepo');
    },
    confirm: async () => true,
    ...overrides,
  };
}

/** Env-ack absent by default (matches a fresh shell that never exported `DESTROY_ENV_ACK_VAR`) — tests that need the ack TRUE pass `readEnv: READ_ENV_ACK_TRUE`. `assertAgeIdentityReadable` defaults to a no-op PASS (most tests never touch `--shred-age-key`, and giving it a real filesystem check by default would make every destroy test that doesn't care about shredding depend on a real path existing). */
function destroyDepsFor(overrides: Partial<FleetDestroyDeps> = {}): FleetDestroyDeps {
  return {
    checkMeta: async () => ({ presence: 'present', archived: false }),
    readManifestFile: async () => FLEET_YAML,
    checkRegistryPresence: async () => 'present',
    deleteRegistryVariable: async () => {
      throw new Error('must not be called — this test did not override deleteRegistryVariable');
    },
    deleteRepo: async () => {
      throw new Error('must not be called — this test did not override deleteRepo');
    },
    confirmFleetName: async () => {
      throw new Error('must not be called — this test did not override confirmFleetName');
    },
    readEnv: () => undefined,
    assertAgeIdentityReadable: () => {},
    ...overrides,
  };
}

/** Fake `readEnv` reporting the destroy env-acknowledgment as SET — the ONLY way these tests flip `envAck` to true (never a plain options field; see `FleetDestroyDeps.readEnv`'s doc for why the read lives inside the tested unit). */
const READ_ENV_ACK_TRUE = (name: string): string | undefined => (name === DESTROY_ENV_ACK_VAR ? '1' : undefined);

// ===================== delete-apps =====================

describe('runFleetDeleteApps', () => {
  it('manifest not found -> exit 1', async () => {
    const cap = captureConsole();
    try {
      const code = await runFleetDeleteApps({ file: '/definitely/not/a/real/path/fleet.yaml' }, deleteAppsDepsFor());
      expect(code).toBe(1);
    } finally {
      cap.restore();
    }
  });

  it('gate REFUSED (foreign) -> exit 1, deleteRegistryVariable/archiveRepo NEVER called, confirm NEVER asked', async () => {
    const file = writeManifest();
    let confirmCalled = false;
    const cap = captureConsole();
    try {
      const code = await runFleetDeleteApps(
        { file, yes: true },
        deleteAppsDepsFor({
          readManifestFile: async () => FLEET_YAML.replace('name: demo-fleet', 'name: some-other-fleet'),
          confirm: async () => {
            confirmCalled = true;
            return true;
          },
        }),
      );
      expect(code).toBe(1);
      expect(confirmCalled).toBe(false);
      expect(cap.errs.join('\n')).toMatch(/⚠ REFUSED/);
    } finally {
      cap.restore();
    }
  });

  it('gate allowed + operator DECLINES -> exit 1, nothing removed/archived', async () => {
    const file = writeManifest();
    const cap = captureConsole();
    try {
      const code = await runFleetDeleteApps({ file }, deleteAppsDepsFor({ confirm: async () => false }));
      expect(code).toBe(1);
    } finally {
      cap.restore();
    }
  });

  it('inventory (including App identities) is rendered BEFORE the confirm prompt is asked', async () => {
    const file = writeManifest();
    const cap = captureConsole();
    try {
      let sawInventoryBeforeConfirm = false;
      await runFleetDeleteApps(
        { file },
        deleteAppsDepsFor({
          confirm: async () => {
            sawInventoryBeforeConfirm = cap.errs.join('\n').includes('demo-fleet-code-agent');
            return true;
          },
          deleteRegistryVariable: async () => 'deleted',
          archiveRepo: async () => {},
        }),
      );
      expect(sawInventoryBeforeConfirm).toBe(true);
    } finally {
      cap.restore();
    }
  });

  it('irreversible items rendered separately: repo section says ARCHIVED (reversible), not the destroy wording', async () => {
    const file = writeManifest();
    const cap = captureConsole();
    try {
      await runFleetDeleteApps({ file, yes: true }, deleteAppsDepsFor({ deleteRegistryVariable: async () => 'deleted', archiveRepo: async () => {} }));
      const text = cap.errs.join('\n');
      expect(text).toMatch(/RECOVERABLE/);
      expect(text).toMatch(/ARCHIVED \(reversible via `apply`\)/);
      expect(text).not.toMatch(/NO UNDO, EVER/);
    } finally {
      cap.restore();
    }
  });

  it('gate allowed + --yes -> deletes every registry target + archives every repo target, exit 1 (App identities always remain -> never green)', async () => {
    const file = writeManifest();
    const deleted: string[] = [];
    const archived: string[] = [];
    const cap = captureConsole();
    try {
      const code = await runFleetDeleteApps(
        { file, yes: true },
        deleteAppsDepsFor({
          deleteRegistryVariable: async (_r, name) => {
            deleted.push(name);
            return 'deleted';
          },
          archiveRepo: async (repo) => {
            archived.push(repo);
          },
        }),
      );
      // exit 1 despite every mutation succeeding — the App-identity report
      // NEVER lets this rung claim success (module doc's "never exit green").
      expect(code).toBe(1);
      expect(deleted.sort()).toEqual(['DEMO_FLEET_AGENT_CODE_AGENT', 'DEMO_FLEET_CA_CERT', 'DEMO_FLEET_FEDERATED_CAS'].sort());
      expect(archived).toEqual(['groundnuty/demo-fleet-control', 'groundnuty/demo-code']);
    } finally {
      cap.restore();
    }
  });

  it('App-deletion-not-API-able path reports the manual step LOUDLY (settings URL + role) and never claims deletion', async () => {
    const file = writeManifest();
    const cap = captureConsole();
    try {
      const code = await runFleetDeleteApps(
        { file, yes: true },
        deleteAppsDepsFor({ deleteRegistryVariable: async () => 'deleted', archiveRepo: async () => {} }),
      );
      expect(code).toBe(1);
      const out = cap.logs.join('\n') + cap.errs.join('\n');
      expect(out).toMatch(/MANUAL ACTION REQUIRED/);
      expect(out).toMatch(/demo-fleet-code-agent/);
      expect(out).toMatch(/settings\/apps/);
      // The App-identity outcome itself is NEVER reported as deleted — only
      // 'manual-action-required' is a possible status (see
      // app-identity-removal.ts); assert against the STRUCTURED outcome via
      // --json rather than a fragile substring match on the narration text.
    } finally {
      cap.restore();
    }
  });

  it('a registry-delete failure still surfaces (reported, contributes to exit 1)', async () => {
    const file = writeManifest();
    const cap = captureConsole();
    try {
      const code = await runFleetDeleteApps(
        { file, yes: true },
        deleteAppsDepsFor({
          deleteRegistryVariable: async () => {
            throw new Error('rate limited');
          },
          archiveRepo: async () => {},
        }),
      );
      expect(code).toBe(1);
      expect(cap.logs.join('\n')).toMatch(/rate limited/);
    } finally {
      cap.restore();
    }
  });

  // --- groundnuty/macf#917 — App already gone: the REPORT says already-absent, but the EXIT CODE stays red ---
  //
  // Deliberate, reviewed choice: even though groundnuty/macf#967 upgraded
  // the REAL wiring's confidence (`app-presence.ts::resolveAppPresenceStatus`
  // asks the org-installations listing first — an authoritative read when it
  // succeeds), that same resolver can still degrade to the predicted-slug
  // fallback (personal-account fleets, listing unavailable), which is NOT a
  // GitHub-confirmed "this App is gone everywhere" fact. This unit test
  // injects `checkAppPresence` directly (bypassing which resolution PATH
  // produced the 'absent'), so it exercises the CONSUMPTION contract only —
  // letting an 'absent' read flip the exit code to 0 would be exactly the
  // false-absent-drives-a-green-exit shape "never exit green" (Amendment G)
  // + DR-043 Amendment A's "honest-unknown over false-present" exist to
  // prevent — so ONLY the report text changes here, never the exit contract.

  it('App already gone (checkAppPresence confirms absent) -> renders ALREADY-ABSENT (not MANUAL ACTION REQUIRED), but exit code STAYS 1 — an absent read never green-lights the exit', async () => {
    const file = writeManifest();
    const cap = captureConsole();
    try {
      const code = await runFleetDeleteApps(
        { file, yes: true },
        deleteAppsDepsFor({
          deleteRegistryVariable: async () => 'deleted',
          archiveRepo: async () => {},
          checkAppPresence: async () => 'absent',
        }),
      );
      const out = cap.logs.join('\n') + cap.errs.join('\n');
      expect(out).toMatch(/ALREADY-ABSENT/);
      expect(out).not.toMatch(/MANUAL ACTION REQUIRED/);
      expect(code).toBe(1);
    } finally {
      cap.restore();
    }
  });

  // groundnuty/macf#967 — an explicitly-wired-but-inconclusive check now
  // renders its OWN distinct UNKNOWN line, never silently folded into
  // MANUAL ACTION REQUIRED (which would read as "confirmed present").
  it('App presence UNKNOWN (checkAppPresence wired but inconclusive) -> renders its OWN UNKNOWN line, exit stays 1 — never upgrades an unconfirmed read to either already-absent OR a confirmed-present claim', async () => {
    const file = writeManifest();
    const cap = captureConsole();
    try {
      const code = await runFleetDeleteApps(
        { file, yes: true },
        deleteAppsDepsFor({
          deleteRegistryVariable: async () => 'deleted',
          archiveRepo: async () => {},
          checkAppPresence: async () => 'unknown',
        }),
      );
      const out = cap.logs.join('\n') + cap.errs.join('\n');
      expect(code).toBe(1);
      expect(out).toMatch(/UNKNOWN/);
      expect(out).not.toMatch(/MANUAL ACTION REQUIRED/);
      expect(out).not.toMatch(/ALREADY-ABSENT/);
    } finally {
      cap.restore();
    }
  });

  it('--json emits a valid, non-empty schema-versioned object with app_outcomes present', async () => {
    const file = writeManifest();
    const cap = captureConsole();
    try {
      const code = await runFleetDeleteApps(
        { file, yes: true, json: true },
        deleteAppsDepsFor({ deleteRegistryVariable: async () => 'deleted', archiveRepo: async () => {} }),
      );
      expect(code).toBe(1);
      const parsed = JSON.parse(cap.logs.join('\n')) as { schema_version: number; mode: string; app_outcomes: { status: string }[] };
      expect(parsed.schema_version).toBe(1);
      expect(parsed.mode).toBe('delete-apps');
      expect(parsed.app_outcomes).toHaveLength(1);
      expect(parsed.app_outcomes[0]?.status).toBe('manual-action-required');
    } finally {
      cap.restore();
    }
  });

  it('--json on a refused gate STILL emits a valid, non-empty object (macf#830 lesson)', async () => {
    const file = writeManifest();
    const cap = captureConsole();
    try {
      const code = await runFleetDeleteApps({ file, yes: true, json: true }, deleteAppsDepsFor({ checkMeta: async () => ({ presence: 'absent' }) }));
      expect(code).toBe(1);
      const parsed = JSON.parse(cap.logs.join('\n')) as { schema_version: number; gate: { allowed: boolean } };
      expect(parsed.schema_version).toBe(1);
      expect(parsed.gate.allowed).toBe(false);
    } finally {
      cap.restore();
    }
  });
});

// ===================== destroy =====================

describe('runFleetDestroy', () => {
  const ALL_ACKS = { destroyRepositories: true };
  const allAcksDeps = (overrides: Partial<FleetDestroyDeps> = {}): FleetDestroyDeps => destroyDepsFor({ readEnv: READ_ENV_ACK_TRUE, ...overrides });

  it('manifest not found -> exit 1', async () => {
    const cap = captureConsole();
    try {
      const code = await runFleetDestroy({ file: '/definitely/not/a/real/path/fleet.yaml', ...ALL_ACKS }, allAcksDeps());
      expect(code).toBe(1);
    } finally {
      cap.restore();
    }
  });

  it('foreign control repo -> refused BEFORE the acknowledgment ladder — confirmFleetName is NEVER called, even with every flag/env ack present', async () => {
    const file = writeManifest();
    let confirmCalled = false;
    const cap = captureConsole();
    try {
      const code = await runFleetDestroy(
        { file, ...ALL_ACKS },
        allAcksDeps({
          readManifestFile: async () => FLEET_YAML.replace('name: demo-fleet', 'name: some-other-fleet'),
          confirmFleetName: async () => {
            confirmCalled = true;
            return 'demo-fleet';
          },
        }),
      );
      expect(code).toBe(1);
      expect(confirmCalled).toBe(false);
      expect(cap.errs.join('\n')).toMatch(/⚠ REFUSED/);
    } finally {
      cap.restore();
    }
  });

  it('--destroy-repositories NOT passed -> refused, confirmFleetName never called, nothing mutated (even with env ack + would-be-correct typed name)', async () => {
    const file = writeManifest();
    const cap = captureConsole();
    try {
      const code = await runFleetDestroy({ file, destroyRepositories: false }, allAcksDeps());
      expect(code).toBe(1);
      expect(cap.errs.join('\n')).toMatch(/--destroy-repositories/);
    } finally {
      cap.restore();
    }
  });

  it(`env ack ${DESTROY_ENV_ACK_VAR} NOT set -> refused, confirmFleetName never called, nothing mutated (even with --destroy-repositories present)`, async () => {
    const file = writeManifest();
    const cap = captureConsole();
    try {
      // destroyDepsFor()'s default readEnv reports the ack ABSENT — no override needed to prove this case.
      const code = await runFleetDestroy({ file, destroyRepositories: true }, destroyDepsFor());
      expect(code).toBe(1);
      expect(cap.errs.join('\n')).toMatch(/MACF_I_UNDERSTAND_THIS_DELETES_REPOSITORIES/);
    } finally {
      cap.restore();
    }
  });

  it('typed fleet name WRONG (flag + env both present) -> refused, nothing mutated', async () => {
    const file = writeManifest();
    const cap = captureConsole();
    try {
      const code = await runFleetDestroy(
        { file, ...ALL_ACKS },
        allAcksDeps({ confirmFleetName: async () => 'not-the-right-name' }),
      );
      expect(code).toBe(1);
      expect(cap.errs.join('\n')).toMatch(/did not exactly match/);
    } finally {
      cap.restore();
    }
  });

  it('inventory — including the IRREVERSIBLE repo-delete section — is rendered BEFORE confirmFleetName is asked', async () => {
    const file = writeManifest();
    const cap = captureConsole();
    try {
      let sawInventoryBeforeConfirm = false;
      await runFleetDestroy(
        { file, ...ALL_ACKS },
        allAcksDeps({
          confirmFleetName: async () => {
            sawInventoryBeforeConfirm = cap.errs.join('\n').includes('NO UNDO, EVER') && cap.errs.join('\n').includes('groundnuty/demo-code');
            return 'demo-fleet';
          },
          deleteRegistryVariable: async () => 'deleted',
          deleteRepo: async () => 'deleted',
        }),
      );
      expect(sawInventoryBeforeConfirm).toBe(true);
    } finally {
      cap.restore();
    }
  });

  it('irreversible items (repos) rendered SEPARATELY from recoverable items (registry keys, App identities)', async () => {
    const file = writeManifest();
    const cap = captureConsole();
    try {
      await runFleetDestroy(
        { file, ...ALL_ACKS },
        allAcksDeps({ confirmFleetName: async () => 'demo-fleet', deleteRegistryVariable: async () => 'deleted', deleteRepo: async () => 'deleted' }),
      );
      const text = cap.errs.join('\n');
      const recoverableIdx = text.indexOf('RECOVERABLE');
      const irreversibleIdx = text.indexOf('IRREVERSIBLE — NO UNDO, EVER');
      expect(recoverableIdx).toBeGreaterThanOrEqual(0);
      expect(irreversibleIdx).toBeGreaterThan(recoverableIdx);
      // The repo target appears at/after the IRREVERSIBLE marker, not mixed into the recoverable section.
      const repoIdx = text.indexOf('groundnuty/demo-code', irreversibleIdx);
      expect(repoIdx).toBeGreaterThan(irreversibleIdx);
    } finally {
      cap.restore();
    }
  });

  it('gate allowed + ALL THREE acks correct -> deletes EXACTLY the registry + repo target sets (adversarial: nothing beyond them), reports App identities, exit 1 (App report always non-empty -> never green)', async () => {
    const file = writeManifest();
    const deletedVars: string[] = [];
    const deletedRepos: string[] = [];
    const cap = captureConsole();
    try {
      const code = await runFleetDestroy(
        { file, ...ALL_ACKS },
        allAcksDeps({
          confirmFleetName: async () => 'demo-fleet',
          deleteRegistryVariable: async (_r, name) => {
            deletedVars.push(name);
            return 'deleted';
          },
          deleteRepo: async (repo) => {
            deletedRepos.push(repo);
            return 'deleted';
          },
        }),
      );
      expect(code).toBe(1);
      expect(deletedVars.sort()).toEqual(['DEMO_FLEET_AGENT_CODE_AGENT', 'DEMO_FLEET_CA_CERT', 'DEMO_FLEET_FEDERATED_CAS'].sort());
      expect(deletedRepos.sort()).toEqual(['groundnuty/demo-fleet-control', 'groundnuty/demo-code'].sort());
      const out = cap.logs.join('\n');
      expect(out).toMatch(/MANUAL ACTION REQUIRED/);
      expect(out).toMatch(/DELETED/); // repo outcome status
    } finally {
      cap.restore();
    }
  });

  it('deletes the CONTROL repo LAST — agent repos are deleted BEFORE it, never after (see buildDestroyPlan\'s doc: a partial failure after the control repo is gone would strand teardown at "nothing to tear down")', async () => {
    const file = writeManifest();
    const deletionOrder: string[] = [];
    const cap = captureConsole();
    try {
      await runFleetDestroy(
        { file, ...ALL_ACKS },
        allAcksDeps({
          confirmFleetName: async () => 'demo-fleet',
          deleteRegistryVariable: async () => 'deleted',
          deleteRepo: async (repo) => {
            deletionOrder.push(repo);
            return 'deleted';
          },
        }),
      );
      expect(deletionOrder).toEqual(['groundnuty/demo-code', 'groundnuty/demo-fleet-control']);
    } finally {
      cap.restore();
    }
  });

  it('a repo-delete failure is reported, contributes to exit 1', async () => {
    const file = writeManifest();
    const cap = captureConsole();
    try {
      const code = await runFleetDestroy(
        { file, ...ALL_ACKS },
        allAcksDeps({
          confirmFleetName: async () => 'demo-fleet',
          deleteRegistryVariable: async () => 'deleted',
          deleteRepo: async (repo) => {
            if (repo.endsWith('-control')) throw new Error('required check blocks delete');
            return 'deleted';
          },
        }),
      );
      expect(code).toBe(1);
      expect(cap.logs.join('\n')).toMatch(/required check blocks delete/);
    } finally {
      cap.restore();
    }
  });

  // --- age-key shred: opt-in only, never implied ---

  it('shred NEVER attempted when --shred-age-key is not passed, even on a fully successful destroy', async () => {
    const file = writeManifest();
    let shredCalled = false;
    const cap = captureConsole();
    try {
      await runFleetDestroy(
        { file, ...ALL_ACKS },
        allAcksDeps({
          confirmFleetName: async () => 'demo-fleet',
          deleteRegistryVariable: async () => 'deleted',
          deleteRepo: async () => 'deleted',
          shredAgeIdentity: async () => {
            shredCalled = true;
          },
        }),
      );
      expect(shredCalled).toBe(false);
    } finally {
      cap.restore();
    }
  });

  it('--shred-age-key WITHOUT --age-identity -> refuses the ENTIRE run pre-flight (does not guess a path) — NOTHING mutated: no registry delete, no repo delete, confirmFleetName never called', async () => {
    const file = writeManifest();
    let shredCalled = false;
    let confirmCalled = false;
    let registryDeleteCalled = false;
    let repoDeleteCalled = false;
    const cap = captureConsole();
    try {
      const code = await runFleetDestroy(
        { file, ...ALL_ACKS, shredAgeKey: true },
        allAcksDeps({
          confirmFleetName: async () => {
            confirmCalled = true;
            return 'demo-fleet';
          },
          deleteRegistryVariable: async () => {
            registryDeleteCalled = true;
            return 'deleted';
          },
          deleteRepo: async () => {
            repoDeleteCalled = true;
            return 'deleted';
          },
          shredAgeIdentity: async () => {
            shredCalled = true;
          },
        }),
      );
      expect(shredCalled).toBe(false);
      expect(confirmCalled).toBe(false);
      expect(registryDeleteCalled).toBe(false);
      expect(repoDeleteCalled).toBe(false);
      expect(code).toBe(1);
      expect(cap.errs.join('\n')).toMatch(/--age-identity/);
    } finally {
      cap.restore();
    }
  });

  it('--shred-age-key with an UNREADABLE --age-identity path -> refuses the ENTIRE run pre-flight, BEFORE any repo is touched', async () => {
    const file = writeManifest();
    let repoDeleteCalled = false;
    let shredCalled = false;
    const cap = captureConsole();
    try {
      const code = await runFleetDestroy(
        { file, ...ALL_ACKS, shredAgeKey: true, ageIdentity: '/home/op/.age/identity.txt' },
        allAcksDeps({
          confirmFleetName: async () => 'demo-fleet',
          deleteRegistryVariable: async () => 'deleted',
          deleteRepo: async () => {
            repoDeleteCalled = true;
            return 'deleted';
          },
          shredAgeIdentity: async () => {
            shredCalled = true;
          },
          assertAgeIdentityReadable: () => {
            throw new Error('age identity key not found or not readable at "/home/op/.age/identity.txt"');
          },
        }),
      );
      expect(repoDeleteCalled).toBe(false);
      expect(shredCalled).toBe(false);
      expect(code).toBe(1);
      expect(cap.errs.join('\n')).toMatch(/not found or not readable/);
    } finally {
      cap.restore();
    }
  });

  it('--shred-age-key WITH a valid, readable --age-identity <path> -> shredAgeIdentity IS called with that exact path, AFTER repos are deleted, only after explicit opt-in', async () => {
    const file = writeManifest();
    const shredPaths: string[] = [];
    const order: string[] = [];
    const cap = captureConsole();
    try {
      const code = await runFleetDestroy(
        { file, ...ALL_ACKS, shredAgeKey: true, ageIdentity: '/home/op/.age/identity.txt' },
        allAcksDeps({
          confirmFleetName: async () => 'demo-fleet',
          deleteRegistryVariable: async () => 'deleted',
          deleteRepo: async (repo) => {
            order.push(`delete-repo:${repo}`);
            return 'deleted';
          },
          assertAgeIdentityReadable: () => {},
          shredAgeIdentity: async (p) => {
            order.push(`shred:${p}`);
            shredPaths.push(p);
          },
        }),
      );
      expect(shredPaths).toEqual(['/home/op/.age/identity.txt']);
      // Repos are deleted BEFORE the shred — the shred is the LAST action.
      expect(order[order.length - 1]).toBe('shred:/home/op/.age/identity.txt');
      // App-identity report still forces non-zero regardless of shred success.
      expect(code).toBe(1);
      expect(cap.errs.join('\n')).toMatch(/single action with NO recovery/);
    } finally {
      cap.restore();
    }
  });

  it('--json emits a valid, non-empty schema-versioned object on refusal (missing acknowledgments)', async () => {
    const file = writeManifest();
    const cap = captureConsole();
    try {
      const code = await runFleetDestroy({ file, destroyRepositories: false, json: true }, destroyDepsFor());
      expect(code).toBe(1);
      const parsed = JSON.parse(cap.logs.join('\n')) as { schema_version: number; mode: string; acknowledgments_missing: string[] };
      expect(parsed.schema_version).toBe(1);
      expect(parsed.mode).toBe('destroy');
      expect(parsed.acknowledgments_missing.length).toBeGreaterThan(0);
    } finally {
      cap.restore();
    }
  });

  it('--json on a gate-refused destroy STILL emits a valid, non-empty object (macf#830 lesson)', async () => {
    const file = writeManifest();
    const cap = captureConsole();
    try {
      const code = await runFleetDestroy(
        { file, ...ALL_ACKS, json: true },
        allAcksDeps({ checkMeta: async () => ({ presence: 'absent' }) }),
      );
      expect(code).toBe(1);
      const parsed = JSON.parse(cap.logs.join('\n')) as { schema_version: number; gate: { allowed: boolean } };
      expect(parsed.schema_version).toBe(1);
      expect(parsed.gate.allowed).toBe(false);
    } finally {
      cap.restore();
    }
  });
});
