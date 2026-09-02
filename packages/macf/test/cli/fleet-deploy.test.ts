/**
 * Tests for the `macf fleet deploy` CLI entry point (`commands/fleet-deploy.ts`).
 * Fully offline: every dep is injected (`FleetDeployCommandDeps`), no `gh` /
 * network / real `age` involved here — the real-`age` decrypt contract is
 * covered by `bootstrap/fleet-deploy.test.ts`'s dedicated block; this file
 * is about flag resolution (--vault default derivation, the --identity-key
 * requirement), manifest/role loading, and rendering.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runFleetDeploy, type FleetDeployCommandDeps } from '../../src/cli/commands/fleet-deploy.js';
import type { InitOptions } from '../../src/cli/commands/init.js';
import { agentCertPath, agentKeyPath, writeAgentConfig } from '../../src/cli/config.js';
import { createCA } from '@groundnuty/macf-core';

/**
 * A cert-AWARE `initAgent` fake (macf#1000) — mirrors
 * `bootstrap/fleet-deploy.test.ts`'s own `fakeInitAgentWithCertSim`: unlike
 * a pure no-op, this writes a sentinel cert+key at the destination's
 * conventional `agentCertPath`/`agentKeyPath` when a CA is present
 * (matching `opts.skipCertIfPresent`'s skip-if-already-there contract).
 * `deployAgent` no longer issues the agent cert itself (macf#1000) — a
 * no-op `initAgent` fake now correctly leaves the cert-facing render tests
 * below seeing NO cert on disk, which is accurate to "the delegate did
 * nothing," not a regression. This fake exists so these RENDERING tests
 * (whose point is the `nextStepLines` / `--json` shape, not cert crypto)
 * can still exercise the "a cert IS present" branch cheaply.
 */
function fakeInitAgentWritingCertWhenCaPresent(caPaths: { certPath: string; keyPath: string }): FleetDeployCommandDeps['initAgent'] {
  return async (dir, opts) => {
    if (!(existsSync(caPaths.certPath) && existsSync(caPaths.keyPath))) return;
    const certDest = agentCertPath(dir);
    const keyDest = agentKeyPath(dir);
    if (opts.skipCertIfPresent === true && existsSync(certDest) && existsSync(keyDest)) return;
    mkdirSync(dirname(certDest), { recursive: true });
    writeFileSync(certDest, 'SIMULATED-AGENT-CERT-SENTINEL');
    writeFileSync(keyDest, 'SIMULATED-AGENT-KEY-SENTINEL');
  };
}

// `versions:` declared (macf#1406) so every test in this file — fully
// offline per this file's own header doc — never falls into
// `deployAgent`'s network-resolving `resolveVersions` seam (which, left at
// its real default, would attempt a genuine network fetch and fail in a
// sandboxed test run). Matches `bootstrap/fleet-deploy.test.ts`'s own
// `manifestWith()` fixture, the same values, for consistency.
const FLEET_YAML = `apiVersion: macf/v0
kind: Fleet
metadata:
  name: demo-fleet
versions:
  macf: 0.2.56
  actions: v3.4.1
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
    deploy_path: /unused-in-tests
`;

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function scratchDir(prefix = 'macf-fleet-deploy-cmd-test-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

/** Writes fleet.yaml (and, unless suppressed, a placeholder secrets/vault.age sibling) into a fresh scratch dir — mirrors the control-repo layout `--vault`'s default derivation relies on. */
function writeManifest(opts: { withVaultSibling?: boolean } = {}): { manifestPath: string; dir: string } {
  const dir = scratchDir();
  const manifestPath = join(dir, 'fleet.yaml');
  writeFileSync(manifestPath, FLEET_YAML);
  if (opts.withVaultSibling !== false) {
    mkdirSync(join(dir, 'secrets'), { recursive: true });
    writeFileSync(join(dir, 'secrets', 'vault.age'), 'not-real-ciphertext-just-a-presence-marker');
  }
  return { manifestPath, dir };
}

/**
 * `keyPathFor` here NEVER falls through to the production default
 * (`defaultAgentKeyPath`, which resolves under the REAL operator's
 * `~/.macf/keys/`) — every test in this file MUST get a scratch-dir key
 * path from `depsFor`, never the bare production default. (A prior version
 * of this suite omitted this override and wrote a synthetic key straight
 * into the live `~/.macf/keys/code-agent.pem` on the host — caught during
 * this PR's own verification, fixed here structurally so it can't recur.)
 */
function depsFor(overrides: Partial<FleetDeployCommandDeps> = {}): FleetDeployCommandDeps {
  return {
    readVault: async () => {
      throw new Error('must not be called — this test does not exercise vault decrypt');
    },
    cloneRepo: async () => {
      throw new Error('must not be called');
    },
    // Lazy (macf#968) — never invoked unless a test's cloneRepo actually
    // runs. Fully offline: never shells out to real `gh`.
    mintCloneToken: async () => 'FAKE-CMD-TEST-TOKEN',
    initAgent: async () => {
      throw new Error('must not be called');
    },
    checkAgentCertPresent: () => true,
    keyPathFor: () => join(scratchDir(), 'scratch-agent-key.pem'),
    ...overrides,
  };
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

describe('runFleetDeploy — flag resolution', () => {
  it('--identity-key omitted, --vault omitted (neither given) -> vault_flags_incomplete, exit 1', async () => {
    const { manifestPath } = writeManifest();
    const cap = captureConsole();
    try {
      const code = await runFleetDeploy({ file: manifestPath, agent: 'code-agent', json: true }, depsFor());
      expect(code).toBe(1);
      const parsed = JSON.parse(cap.logs.join('')) as { error: { code: string } };
      expect(parsed.error.code).toBe('vault_flags_incomplete');
    } finally {
      cap.restore();
    }
  });

  it('--vault given WITHOUT --identity-key -> vault_flags_incomplete, exit 1 (half-given, direction 1)', async () => {
    const { manifestPath, dir } = writeManifest();
    const cap = captureConsole();
    try {
      const code = await runFleetDeploy(
        { file: manifestPath, agent: 'code-agent', vault: join(dir, 'secrets', 'vault.age'), json: true },
        depsFor(),
      );
      expect(code).toBe(1);
      const parsed = JSON.parse(cap.logs.join('')) as { error: { code: string } };
      expect(parsed.error.code).toBe('vault_flags_incomplete');
    } finally {
      cap.restore();
    }
  });

  it('--identity-key given WITHOUT --vault -> NOT incomplete; --vault defaults to <fleet.yaml dir>/secrets/vault.age (half-given, direction 2 does NOT refuse — vault has a default)', async () => {
    const { manifestPath, dir } = writeManifest();
    const cap = captureConsole();
    let seenVaultPath: string | undefined;
    try {
      const code = await runFleetDeploy(
        { file: manifestPath, agent: 'code-agent', identityKey: join(dir, 'identity.txt'), json: true },
        depsFor({
          readVault: async (o) => {
            seenVaultPath = o.vaultPath;
            return {};
          },
        }),
      );
      // Reaches the vault read (proves the XOR guard did NOT fire) and then
      // fails downstream on the empty-vault content — a DIFFERENT, later
      // refusal, not vault_flags_incomplete.
      expect(code).toBe(1);
      expect(seenVaultPath).toBe(join(dir, 'secrets', 'vault.age'));
      const parsed = JSON.parse(cap.logs.join('')) as { outcome: { status: string; reason: string } };
      expect(parsed.outcome.status).toBe('failed');
      expect(parsed.outcome.reason).not.toContain('vault_flags_incomplete');
    } finally {
      cap.restore();
    }
  });

  it('an explicit --vault overrides the default derivation', async () => {
    const { manifestPath, dir } = writeManifest({ withVaultSibling: false });
    const explicitVault = join(dir, 'elsewhere-vault.age');
    writeFileSync(explicitVault, 'marker');
    const cap = captureConsole();
    let seenVaultPath: string | undefined;
    try {
      await runFleetDeploy(
        { file: manifestPath, agent: 'code-agent', identityKey: join(dir, 'identity.txt'), vault: explicitVault, json: true },
        depsFor({ readVault: async (o) => { seenVaultPath = o.vaultPath; return {}; } }),
      );
      expect(seenVaultPath).toBe(explicitVault);
    } finally {
      cap.restore();
    }
  });
});

describe('runFleetDeploy — manifest / role loading', () => {
  it('manifest not found -> exit 1, never reaches readVault', async () => {
    const cap = captureConsole();
    try {
      const code = await runFleetDeploy(
        { file: '/definitely/not/a/real/fleet.yaml', agent: 'code-agent', identityKey: '/x' },
        depsFor(),
      );
      expect(code).toBe(1);
    } finally {
      cap.restore();
    }
  });

  it('manifest invalid -> exit 1', async () => {
    const dir = scratchDir();
    const manifestPath = join(dir, 'fleet.yaml');
    writeFileSync(manifestPath, 'not: [valid, fleet, yaml');
    const cap = captureConsole();
    try {
      const code = await runFleetDeploy({ file: manifestPath, agent: 'code-agent', identityKey: '/x' }, depsFor());
      expect(code).toBe(1);
    } finally {
      cap.restore();
    }
  });

  it('unknown --agent role -> exit 1, unknown_agent_role, names the known roles, never reaches readVault', async () => {
    const { manifestPath } = writeManifest();
    const cap = captureConsole();
    try {
      const code = await runFleetDeploy(
        { file: manifestPath, agent: 'not-a-real-role', identityKey: '/x', json: true },
        depsFor(),
      );
      expect(code).toBe(1);
      const parsed = JSON.parse(cap.logs.join('')) as { error: { code: string; message: string } };
      expect(parsed.error.code).toBe('unknown_agent_role');
      expect(parsed.error.message).toContain('code-agent');
    } finally {
      cap.restore();
    }
  });
});

describe('runFleetDeploy — happy path + rendering', () => {
  it('deploys, exit 0, prints the next-step launch line (never implies the agent is already running)', async () => {
    const { manifestPath, dir } = writeManifest();
    const destDir = join(dir, 'workspace');
    const keyPath = join(scratchDir(), 'code-agent.pem');
    const initCalls: { dir: string; opts: InitOptions }[] = [];
    const cap = captureConsole();
    try {
      const code = await runFleetDeploy(
        { file: manifestPath, agent: 'code-agent', identityKey: join(dir, 'identity.txt'), dir: destDir },
        depsFor({
          readVault: async () => {
            const seg = 'DEMO_FLEET_CODE_AGENT';
            return {
              [`MACF_AGENT_${seg}_APP_ID`]: '111',
              [`MACF_AGENT_${seg}_INSTALL_ID`]: '222',
              [`MACF_AGENT_${seg}_PRIVATE_KEY_B64`]: Buffer.from('SYNTH-PEM', 'utf-8').toString('base64'),
            };
          },
          cloneRepo: async (_url, d) => mkdirSync(d, { recursive: true }),
          initAgent: async (d, o) => {
            initCalls.push({ dir: d, opts: o });
          },
          keyPathFor: () => keyPath,
        }),
      );
      expect(code).toBe(0);
      expect(initCalls).toHaveLength(1);
      expect(initCalls[0]?.opts.appId).toBe('111');
      expect(initCalls[0]?.opts.installId).toBe('222');
      expect(initCalls[0]?.opts.keyPath).toBe(keyPath);
      const out = cap.logs.join('\n');
      expect(out).toContain('deployed');
      expect(out).toContain('NOT running yet');
      expect(out).toContain('./claude.sh');
      // Never a raw secret in operator-facing output.
      expect(out).not.toContain('SYNTH-PEM');
    } finally {
      cap.restore();
    }
  });

  it('macf#994: names BOTH first-launch prompts + the exact tmux attach command (falls back to role when no macf-agent.json was written)', async () => {
    const { manifestPath, dir } = writeManifest();
    const destDir = join(dir, 'workspace');
    const cap = captureConsole();
    try {
      const code = await runFleetDeploy(
        { file: manifestPath, agent: 'code-agent', identityKey: join(dir, 'identity.txt'), dir: destDir },
        depsFor({
          readVault: async () => {
            const seg = 'DEMO_FLEET_CODE_AGENT';
            return {
              [`MACF_AGENT_${seg}_APP_ID`]: '111',
              [`MACF_AGENT_${seg}_INSTALL_ID`]: '222',
              [`MACF_AGENT_${seg}_PRIVATE_KEY_B64`]: Buffer.from('SYNTH-PEM', 'utf-8').toString('base64'),
            };
          },
          cloneRepo: async (_url, d) => mkdirSync(d, { recursive: true }),
          // No macf-agent.json written — nextStepLines must fall back to the
          // manifest-declared role, never crash.
          initAgent: async () => {},
        }),
      );
      expect(code).toBe(0);
      const out = cap.logs.join('\n');
      // Prompt 1 — the trust dialog. Named, never answered.
      expect(out).toContain('Do you trust this folder?');
      // Prompt 2 — the channels confirmation. Worded conditionally
      // (macf#994: "may ALSO need"), not asserted to always appear.
      expect(out).toContain('Loading development channels');
      expect(out).toContain('may ALSO need a manual answer');
      // The exact reach-it command, falling back to the manifest role
      // ("code-agent") since no on-disk config exists in this fixture.
      expect(out).toContain('tmux attach -t demo-fleet@code-agent');
    } finally {
      cap.restore();
    }
  });

  it('macf#994: the tmux attach command uses routing_label, NEVER agent_name, when a deployed workspace\'s config diverges (the decisive session-naming fixture)', async () => {
    const { manifestPath, dir } = writeManifest();
    const destDir = join(dir, 'workspace');
    const cap = captureConsole();
    try {
      const code = await runFleetDeploy(
        { file: manifestPath, agent: 'code-agent', identityKey: join(dir, 'identity.txt'), dir: destDir },
        depsFor({
          readVault: async () => {
            const seg = 'DEMO_FLEET_CODE_AGENT';
            return {
              [`MACF_AGENT_${seg}_APP_ID`]: '111',
              [`MACF_AGENT_${seg}_INSTALL_ID`]: '222',
              [`MACF_AGENT_${seg}_PRIVATE_KEY_B64`]: Buffer.from('SYNTH-PEM', 'utf-8').toString('base64'),
            };
          },
          cloneRepo: async (_url, d) => mkdirSync(d, { recursive: true }),
          // Simulates the REAL initAgent writing macf-agent.json with
          // agent_name != routing_label — the macf#678 science-agent shape
          // (`agent_name=macf-science-agent`, `routing_label=science-agent`).
          // A fixture where they COINCIDE would pass even with the wrong
          // field read; this is the decisive test macf#994 asks for.
          initAgent: async (d) => {
            writeAgentConfig(d, {
              project: 'demo-fleet',
              agent_name: 'demo-fleet-code-agent',
              agent_role: 'code-agent',
              routing_label: 'totally-different-routing-label',
              agent_type: 'permanent',
              registry: { type: 'profile', user: 'groundnuty' },
            });
          },
        }),
      );
      expect(code).toBe(0);
      const out = cap.logs.join('\n');
      expect(out).toContain('tmux attach -t demo-fleet@totally-different-routing-label');
      expect(out).not.toContain('demo-fleet@demo-fleet-code-agent');
      expect(out).not.toContain('demo-fleet@code-agent');
    } finally {
      cap.restore();
    }
  });

  it('when the vault has NO per-project CA, the next-step block names the real gap (provision the CA) — NEVER hand-copy advice (macf#976)', async () => {
    const { manifestPath, dir } = writeManifest();
    const destDir = join(dir, 'workspace');
    const cap = captureConsole();
    try {
      const code = await runFleetDeploy(
        { file: manifestPath, agent: 'code-agent', identityKey: join(dir, 'identity.txt'), dir: destDir },
        depsFor({
          readVault: async () => {
            const seg = 'DEMO_FLEET_CODE_AGENT';
            return {
              [`MACF_AGENT_${seg}_APP_ID`]: '111',
              [`MACF_AGENT_${seg}_INSTALL_ID`]: '222',
              [`MACF_AGENT_${seg}_PRIVATE_KEY_B64`]: Buffer.from('SYNTH-PEM', 'utf-8').toString('base64'),
              // Deliberately NO CA_KEY_B64 / CA_CERT_B64 fields — the vault
              // genuinely has no CA for this fleet.
            };
          },
          cloneRepo: async (_url, d) => mkdirSync(d, { recursive: true }),
          initAgent: async () => {},
          // checkAgentCertPresent NOT overridden here — the real default
          // (existsSync at destDir) correctly reports "absent" since
          // nothing in this fake chain ever wrote a cert there.
          checkAgentCertPresent: undefined,
        }),
      );
      expect(code).toBe(0);
      const out = cap.logs.join('\n');
      const caWarnIdx = out.indexOf('No mTLS cert');
      const nextStepIdx = out.indexOf('Next step:');
      expect(caWarnIdx).toBeGreaterThan(-1);
      expect(nextStepIdx).toBeGreaterThan(caWarnIdx);
      expect(out).toContain('vault has no per-project CA yet');
      expect(out).toContain('macf bootstrap apply');
      // The OLD, unsafe advice must never appear again anywhere in this render.
      expect(out).not.toContain('an already-deployed agent host');
      expect(out).not.toContain('CA materialization is out of scope');
      expect(out).not.toContain('macf certs rotate');
    } finally {
      cap.restore();
    }
  });

  it('when the vault HAS a per-project CA, deploy materializes it + issues a REAL, usable agent cert — next-step block shows NO warning (macf#976, the decisive rendering assertion)', async () => {
    const { manifestPath, dir } = writeManifest();
    const destDir = join(dir, 'workspace');
    const mintDir = scratchDir();
    const ca = await createCA({
      project: 'cmd-deploy-ca-test',
      certPath: join(mintDir, 'minted-ca-cert.pem'),
      keyPath: join(mintDir, 'minted-ca-key.pem'),
    });
    const caCertFilePath = join(scratchDir(), 'materialized-ca-cert.pem');
    const caKeyFilePath = join(scratchDir(), 'materialized-ca-key.pem');
    const cap = captureConsole();
    try {
      const code = await runFleetDeploy(
        { file: manifestPath, agent: 'code-agent', identityKey: join(dir, 'identity.txt'), dir: destDir },
        depsFor({
          readVault: async () => {
            const seg = 'DEMO_FLEET_CODE_AGENT';
            return {
              [`MACF_AGENT_${seg}_APP_ID`]: '111',
              [`MACF_AGENT_${seg}_INSTALL_ID`]: '222',
              [`MACF_AGENT_${seg}_PRIVATE_KEY_B64`]: Buffer.from('SYNTH-PEM', 'utf-8').toString('base64'),
              MACF_DEMO_FLEET_CA_KEY_B64: Buffer.from(ca.keyPem, 'utf-8').toString('base64'),
              MACF_DEMO_FLEET_CA_CERT_B64: Buffer.from(ca.certPem, 'utf-8').toString('base64'),
            };
          },
          cloneRepo: async (_url, d) => mkdirSync(d, { recursive: true }),
          // `deployAgent` delegates ALL agent-cert issuance to `initAgent`
          // (macf#1000) — this fake simulates `initAgent` writing a cert
          // when a CA is present, so `nextStepLines`' `checkAgentCertPresent`
          // read-side sees the SAME conventional `agentCertPath(destDir)`/
          // `agentKeyPath(destDir)` a real deploy would have populated.
          initAgent: fakeInitAgentWritingCertWhenCaPresent({ certPath: caCertFilePath, keyPath: caKeyFilePath }),
          // Only the per-project CA path resolvers need overriding (their
          // real default resolves under the operator's home). The agent
          // leaf-cert path resolvers have no override seam anymore
          // (macf#1000 removed `agentCertPathFor`/`agentKeyPathFor` from
          // `FleetDeployDeps` — `agentCertPath(destDir)`/`agentKeyPath(destDir)`
          // are already scoped under THIS test's own scratch `destDir`, so
          // exercising the real function is both safe and the more
          // faithful test of the actual wiring (the fake's write side and
          // `nextStepLines`' read side must agree on the SAME path).
          caCertPathFor: () => caCertFilePath,
          caKeyPathFor: () => caKeyFilePath,
        }),
      );
      expect(code).toBe(0);
      const out = cap.logs.join('\n');
      expect(out).not.toContain('No mTLS cert');
      expect(out).not.toContain('vault has no per-project CA');
      expect(out).toContain('Next step:');
      expect(out).toContain('./claude.sh');
    } finally {
      cap.restore();
    }
  });

  it('--json render never carries the secret value', async () => {
    const { manifestPath, dir } = writeManifest();
    const destDir = join(dir, 'workspace');
    const cap = captureConsole();
    try {
      await runFleetDeploy(
        { file: manifestPath, agent: 'code-agent', identityKey: join(dir, 'identity.txt'), dir: destDir, json: true },
        depsFor({
          readVault: async () => {
            const seg = 'DEMO_FLEET_CODE_AGENT';
            return {
              [`MACF_AGENT_${seg}_APP_ID`]: '111',
              [`MACF_AGENT_${seg}_INSTALL_ID`]: '222',
              [`MACF_AGENT_${seg}_PRIVATE_KEY_B64`]: Buffer.from('SYNTH-SECRET-PEM', 'utf-8').toString('base64'),
            };
          },
          cloneRepo: async (_url, d) => mkdirSync(d, { recursive: true }),
          initAgent: async () => {},
        }),
      );
      const out = cap.logs.join('\n');
      expect(out).not.toContain('SYNTH-SECRET-PEM');
      expect(out).not.toContain(Buffer.from('SYNTH-SECRET-PEM', 'utf-8').toString('base64'));
      const parsed = JSON.parse(out) as { outcome: { status: string; key_fingerprint?: string; ca?: { status: string }; cert_issue?: string } };
      expect(parsed.outcome.status).toBe('deployed');
      expect(parsed.outcome.key_fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
      // No CA fields in this test's fake vault -> vault-absent, snake_case shape.
      expect(parsed.outcome.ca).toEqual({ status: 'vault-absent' });
      expect(parsed.outcome.cert_issue).toBe('not-attempted');
    } finally {
      cap.restore();
    }
  });

  it('--json render: the `ca` block is snake_case throughout (macf#976) — `cert_fingerprint`, never the camelCase `certFingerprint` the TS side uses internally', async () => {
    const { manifestPath, dir } = writeManifest();
    const destDir = join(dir, 'workspace');
    const ca = await createCA({
      project: 'json-shape-ca-test',
      certPath: join(scratchDir(), 'minted-ca-cert.pem'),
      keyPath: join(scratchDir(), 'minted-ca-key.pem'),
    });
    const caCertFilePath = join(scratchDir(), 'materialized-ca-cert.pem');
    const caKeyFilePath = join(scratchDir(), 'materialized-ca-key.pem');
    const cap = captureConsole();
    try {
      await runFleetDeploy(
        { file: manifestPath, agent: 'code-agent', identityKey: join(dir, 'identity.txt'), dir: destDir, json: true },
        depsFor({
          readVault: async () => {
            const seg = 'DEMO_FLEET_CODE_AGENT';
            return {
              [`MACF_AGENT_${seg}_APP_ID`]: '111',
              [`MACF_AGENT_${seg}_INSTALL_ID`]: '222',
              [`MACF_AGENT_${seg}_PRIVATE_KEY_B64`]: Buffer.from('SYNTH-PEM', 'utf-8').toString('base64'),
              MACF_DEMO_FLEET_CA_KEY_B64: Buffer.from(ca.keyPem, 'utf-8').toString('base64'),
              MACF_DEMO_FLEET_CA_CERT_B64: Buffer.from(ca.certPem, 'utf-8').toString('base64'),
            };
          },
          cloneRepo: async (_url, d) => mkdirSync(d, { recursive: true }),
          // See `fakeInitAgentWritingCertWhenCaPresent`'s own doc — deploy
          // no longer issues the cert itself (macf#1000); this fake
          // simulates `initAgent` doing so, needed here so `cert_issue`
          // actually renders `'issued'` (this test's assertion below).
          initAgent: fakeInitAgentWritingCertWhenCaPresent({ certPath: caCertFilePath, keyPath: caKeyFilePath }),
          caCertPathFor: () => caCertFilePath,
          caKeyPathFor: () => caKeyFilePath,
        }),
      );
      const out = cap.logs.join('\n');
      const parsed = JSON.parse(out) as {
        outcome: { status: string; ca: { status: string; cert_fingerprint?: string }; cert_issue: string };
      };
      expect(parsed.outcome.ca.status).toBe('materialized');
      expect(parsed.outcome.ca.cert_fingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(parsed.outcome.cert_issue).toBe('issued');
      // The camelCase TS-internal field name must never leak into the wire shape.
      expect(out).not.toContain('certFingerprint');
    } finally {
      cap.restore();
    }
  });
});

// Real RSA keys (macf#975): `materializeAgentKey`'s mismatch check parses
// whatever is on disk via `node:crypto` — a non-PEM sentinel string throws
// at parse time instead of exercising the mismatch branch these tests mean
// to drive (this codebase's own "a test that constructs the seam it should
// observe" lesson, applied to fixture data). Generated once, module scope.
function genRsaPem(): string {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  return privateKey;
}
const VAULT_KEY_PEM = genRsaPem();
const STALE_ON_DISK_PEM = genRsaPem();

describe('runFleetDeploy — App-key fingerprint mismatch (macf#975)', () => {
  it('a mismatched on-disk key REFUSES (exit 1, status "failed") and never reaches initAgent, without --force-key', async () => {
    const { manifestPath, dir } = writeManifest();
    const destDir = join(dir, 'workspace');
    const keyPath = join(scratchDir(), 'code-agent.pem');
    writeFileSync(keyPath, STALE_ON_DISK_PEM, { mode: 0o600 });
    const cap = captureConsole();
    try {
      const code = await runFleetDeploy(
        { file: manifestPath, agent: 'code-agent', identityKey: join(dir, 'identity.txt'), dir: destDir, json: true },
        depsFor({
          readVault: async () => {
            const seg = 'DEMO_FLEET_CODE_AGENT';
            return {
              [`MACF_AGENT_${seg}_APP_ID`]: '111',
              [`MACF_AGENT_${seg}_INSTALL_ID`]: '222',
              [`MACF_AGENT_${seg}_PRIVATE_KEY_B64`]: Buffer.from(VAULT_KEY_PEM, 'utf-8').toString('base64'),
            };
          },
          initAgent: async () => {
            throw new Error('must not be called — refused before initAgent');
          },
          keyPathFor: () => keyPath,
        }),
      );
      expect(code).toBe(1);
      const parsed = JSON.parse(cap.logs.join('\n')) as { outcome: { status: string; reason: string } };
      expect(parsed.outcome.status).toBe('failed');
      expect(parsed.outcome.reason).toContain('does not match');
      expect(parsed.outcome.reason).toContain('--force-key');
      expect(parsed.outcome.reason).not.toContain(STALE_ON_DISK_PEM);
      expect(parsed.outcome.reason).not.toContain(VAULT_KEY_PEM);
      // The stale on-disk key was never overwritten by the refusal path.
      expect(readFileSync(keyPath, 'utf-8')).toBe(STALE_ON_DISK_PEM);
    } finally {
      cap.restore();
    }
  });

  it('macf#994: a FAILED deploy emits NO first-launch guidance (no trust-dialog / tmux-attach text for an agent that never deployed)', async () => {
    const { manifestPath, dir } = writeManifest();
    const destDir = join(dir, 'workspace');
    const keyPath = join(scratchDir(), 'code-agent.pem');
    writeFileSync(keyPath, STALE_ON_DISK_PEM, { mode: 0o600 });
    const cap = captureConsole();
    try {
      const code = await runFleetDeploy(
        // Non-JSON render — this is the human-facing path `nextStepLines`
        // (and therefore macf#994's guidance block) would append to, IF it
        // were reached for a failed outcome. It must not be.
        { file: manifestPath, agent: 'code-agent', identityKey: join(dir, 'identity.txt'), dir: destDir },
        depsFor({
          readVault: async () => {
            const seg = 'DEMO_FLEET_CODE_AGENT';
            return {
              [`MACF_AGENT_${seg}_APP_ID`]: '111',
              [`MACF_AGENT_${seg}_INSTALL_ID`]: '222',
              [`MACF_AGENT_${seg}_PRIVATE_KEY_B64`]: Buffer.from(VAULT_KEY_PEM, 'utf-8').toString('base64'),
            };
          },
          initAgent: async () => {
            throw new Error('must not be called — refused before initAgent');
          },
          keyPathFor: () => keyPath,
        }),
      );
      expect(code).toBe(1);
      const out = [...cap.logs, ...cap.errs].join('\n');
      expect(out).not.toContain('tmux attach');
      expect(out).not.toContain('Do you trust this folder');
      expect(out).not.toContain('Loading development channels');
    } finally {
      cap.restore();
    }
  });

  it('--force-key re-materializes a mismatched key from the vault and proceeds to deploy (exit 0)', async () => {
    const { manifestPath, dir } = writeManifest();
    const destDir = join(dir, 'workspace');
    const keyPath = join(scratchDir(), 'code-agent.pem');
    writeFileSync(keyPath, STALE_ON_DISK_PEM, { mode: 0o600 });
    const initCalls: { dir: string; opts: InitOptions }[] = [];
    const cap = captureConsole();
    try {
      const code = await runFleetDeploy(
        { file: manifestPath, agent: 'code-agent', identityKey: join(dir, 'identity.txt'), dir: destDir, forceKey: true },
        depsFor({
          readVault: async () => {
            const seg = 'DEMO_FLEET_CODE_AGENT';
            return {
              [`MACF_AGENT_${seg}_APP_ID`]: '111',
              [`MACF_AGENT_${seg}_INSTALL_ID`]: '222',
              [`MACF_AGENT_${seg}_PRIVATE_KEY_B64`]: Buffer.from(VAULT_KEY_PEM, 'utf-8').toString('base64'),
            };
          },
          cloneRepo: async (_url, d) => mkdirSync(d, { recursive: true }),
          initAgent: async (d, o) => {
            initCalls.push({ dir: d, opts: o });
          },
          keyPathFor: () => keyPath,
        }),
      );
      expect(code).toBe(0);
      expect(initCalls).toHaveLength(1);
      expect(readFileSync(keyPath, 'utf-8')).toBe(VAULT_KEY_PEM);
    } finally {
      cap.restore();
    }
  });

  it('an unparseable on-disk key file REFUSES cleanly (not a raw OpenSSL error) and never reaches initAgent', async () => {
    const { manifestPath, dir } = writeManifest();
    const destDir = join(dir, 'workspace');
    const keyPath = join(scratchDir(), 'code-agent.pem');
    writeFileSync(keyPath, 'THIS IS NOT A PEM FILE AT ALL', { mode: 0o600 });
    const cap = captureConsole();
    try {
      const code = await runFleetDeploy(
        { file: manifestPath, agent: 'code-agent', identityKey: join(dir, 'identity.txt'), dir: destDir, json: true },
        depsFor({
          readVault: async () => {
            const seg = 'DEMO_FLEET_CODE_AGENT';
            return {
              [`MACF_AGENT_${seg}_APP_ID`]: '111',
              [`MACF_AGENT_${seg}_INSTALL_ID`]: '222',
              [`MACF_AGENT_${seg}_PRIVATE_KEY_B64`]: Buffer.from(VAULT_KEY_PEM, 'utf-8').toString('base64'),
            };
          },
          initAgent: async () => {
            throw new Error('must not be called — refused before initAgent');
          },
          keyPathFor: () => keyPath,
        }),
      );
      expect(code).toBe(1);
      const parsed = JSON.parse(cap.logs.join('\n')) as { outcome: { status: string; reason: string } };
      expect(parsed.outcome.status).toBe('failed');
      expect(parsed.outcome.reason).toContain('not a readable RSA private key');
      expect(parsed.outcome.reason).toContain(keyPath);
    } finally {
      cap.restore();
    }
  });
});

describe('runFleetDeploy — per-project CA fingerprint mismatch (macf#982)', () => {
  it('a mismatched on-disk CA REFUSES (exit 1, status "failed"), names --force-ca + the manual remedy, and never reaches initAgent', async () => {
    const { manifestPath, dir } = writeManifest();
    const destDir = join(dir, 'workspace');
    const localCa = await createCA({
      project: 'cmd-force-ca-local',
      certPath: join(scratchDir(), 'local-ca-cert.pem'),
      keyPath: join(scratchDir(), 'local-ca-key.pem'),
    });
    const vaultCa = await createCA({
      project: 'cmd-force-ca-vault',
      certPath: join(scratchDir(), 'vault-ca-cert.pem'),
      keyPath: join(scratchDir(), 'vault-ca-key.pem'),
    });
    const caCertFilePath = join(scratchDir(), 'materialized-ca-cert.pem');
    const caKeyFilePath = join(scratchDir(), 'materialized-ca-key.pem');
    writeFileSync(caCertFilePath, localCa.certPem, { mode: 0o644 });
    writeFileSync(caKeyFilePath, localCa.keyPem, { mode: 0o600 });
    const cap = captureConsole();
    try {
      const code = await runFleetDeploy(
        { file: manifestPath, agent: 'code-agent', identityKey: join(dir, 'identity.txt'), dir: destDir, json: true },
        depsFor({
          readVault: async () => {
            const seg = 'DEMO_FLEET_CODE_AGENT';
            return {
              [`MACF_AGENT_${seg}_APP_ID`]: '111',
              [`MACF_AGENT_${seg}_INSTALL_ID`]: '222',
              [`MACF_AGENT_${seg}_PRIVATE_KEY_B64`]: Buffer.from('SYNTH-PEM', 'utf-8').toString('base64'),
              MACF_DEMO_FLEET_CA_KEY_B64: Buffer.from(vaultCa.keyPem, 'utf-8').toString('base64'),
              MACF_DEMO_FLEET_CA_CERT_B64: Buffer.from(vaultCa.certPem, 'utf-8').toString('base64'),
            };
          },
          initAgent: async () => {
            throw new Error('must not be called — refused before initAgent');
          },
          caCertPathFor: () => caCertFilePath,
          caKeyPathFor: () => caKeyFilePath,
        }),
      );
      expect(code).toBe(1);
      const parsed = JSON.parse(cap.logs.join('\n')) as { outcome: { status: string; reason: string } };
      expect(parsed.outcome.status).toBe('failed');
      expect(parsed.outcome.reason).toContain('does NOT match');
      expect(parsed.outcome.reason.toLowerCase()).toContain('remove or rename');
      expect(parsed.outcome.reason).toContain('--force-ca');
      // The stale on-disk CA was never overwritten by the refusal path.
      expect(readFileSync(caCertFilePath, 'utf-8')).toBe(localCa.certPem);
    } finally {
      cap.restore();
    }
  });

  it('--force-ca re-materializes a mismatched CA from the vault and proceeds to deploy (exit 0)', async () => {
    const { manifestPath, dir } = writeManifest();
    const destDir = join(dir, 'workspace');
    const localCa = await createCA({
      project: 'cmd-force-ca-local2',
      certPath: join(scratchDir(), 'local2-ca-cert.pem'),
      keyPath: join(scratchDir(), 'local2-ca-key.pem'),
    });
    const vaultCa = await createCA({
      project: 'cmd-force-ca-vault2',
      certPath: join(scratchDir(), 'vault2-ca-cert.pem'),
      keyPath: join(scratchDir(), 'vault2-ca-key.pem'),
    });
    const caCertFilePath = join(scratchDir(), 'materialized2-ca-cert.pem');
    const caKeyFilePath = join(scratchDir(), 'materialized2-ca-key.pem');
    writeFileSync(caCertFilePath, localCa.certPem, { mode: 0o644 });
    writeFileSync(caKeyFilePath, localCa.keyPem, { mode: 0o600 });
    const initCalls: { dir: string; opts: InitOptions }[] = [];
    const cap = captureConsole();
    try {
      const code = await runFleetDeploy(
        { file: manifestPath, agent: 'code-agent', identityKey: join(dir, 'identity.txt'), dir: destDir, forceCa: true },
        depsFor({
          readVault: async () => {
            const seg = 'DEMO_FLEET_CODE_AGENT';
            return {
              [`MACF_AGENT_${seg}_APP_ID`]: '111',
              [`MACF_AGENT_${seg}_INSTALL_ID`]: '222',
              [`MACF_AGENT_${seg}_PRIVATE_KEY_B64`]: Buffer.from('SYNTH-PEM', 'utf-8').toString('base64'),
              MACF_DEMO_FLEET_CA_KEY_B64: Buffer.from(vaultCa.keyPem, 'utf-8').toString('base64'),
              MACF_DEMO_FLEET_CA_CERT_B64: Buffer.from(vaultCa.certPem, 'utf-8').toString('base64'),
            };
          },
          cloneRepo: async (_url, d) => mkdirSync(d, { recursive: true }),
          initAgent: async (d, o) => {
            initCalls.push({ dir: d, opts: o });
          },
          caCertPathFor: () => caCertFilePath,
          caKeyPathFor: () => caKeyFilePath,
        }),
      );
      expect(code).toBe(0);
      expect(initCalls).toHaveLength(1);
      expect(readFileSync(caCertFilePath, 'utf-8')).toBe(vaultCa.certPem);
      expect(readFileSync(caKeyFilePath, 'utf-8')).toBe(vaultCa.keyPem);
    } finally {
      cap.restore();
    }
  });
});
