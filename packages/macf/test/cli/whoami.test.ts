/**
 * Tests for `macf whoami` (groundnuty/macf#672) — deterministic
 * self-discovery. Pure-function coverage of the identity resolution, cert
 * introspection, and token-type classification; the network-touching
 * bot_login resolution (`fetchAppSlug`) is exercised in doctor.test.ts and
 * intentionally not re-tested here (this file reuses it read-only).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import {
  UNKNOWN_FIELD,
  buildIdentityReport,
  classifyTokenType,
  extractSubjectCNFromNodeCert,
  formatPeersSection,
  readAgentCertInfo,
  readPeersFromRegistry,
  resolveRegistryConfigForPeers,
  resolvePeersReport,
} from '../../src/cli/commands/whoami.js';
import type { MacfAgentConfig } from '../../src/cli/config.js';
import type { AgentInfo, Registry } from '@groundnuty/macf-core';

function baseConfig(overrides: Partial<MacfAgentConfig> = {}): MacfAgentConfig {
  return {
    project: 'testproj',
    agent_name: 'test-agent',
    agent_role: 'code-agent',
    agent_type: 'permanent',
    registry: { type: 'repo', owner: 'acme', repo: 'widgets' },
    github_app: { app_id: '111', install_id: '222', key_path: 'k.pem', bot_login: 'macf-test-agent[bot]' },
    advertise_host: '10.0.0.5',
    versions: { cli: '0.2.58', plugin: 'v3.0.0', actions: 'v3.4.1' },
    operator_login: 'the-operator',
    ...overrides,
  };
}

describe('buildIdentityReport — decisive pair (macf#672)', () => {
  it('(1) a fully-configured workspace reports the REAL identity, read from macf-agent.json', () => {
    const report = buildIdentityReport(baseConfig(), {});

    expect(report.project).toEqual({ value: 'testproj', source: 'config' });
    expect(report.agentName).toEqual({ value: 'test-agent', source: 'config' });
    expect(report.agentRole).toEqual({ value: 'code-agent', source: 'config' });
    expect(report.routingLabel).toEqual({ value: 'test-agent', source: 'config' });
    expect(report.registryScope).toEqual({ value: 'repo', source: 'config' });
    expect(report.registryTarget).toEqual({ value: 'acme/widgets', source: 'config' });
    expect(report.appId).toEqual({ value: '111', source: 'config' });
    expect(report.installId).toEqual({ value: '222', source: 'config' });
    expect(report.botLogin).toEqual({ value: 'macf-test-agent[bot]', source: 'config' });
    expect(report.advertiseHost).toEqual({ value: '10.0.0.5', source: 'config' });
    expect(report.operatorLogin).toEqual({ value: 'the-operator', source: 'config' });
    expect(report.cliVersion).toEqual({ value: '0.2.58', source: 'config' });
    expect(report.pluginVersion).toEqual({ value: 'v3.0.0', source: 'config' });
    expect(report.actionsVersion).toEqual({ value: 'v3.4.1', source: 'config' });
  });

  it('(2) a workspace missing BOTH sources reports "unknown" for every affected field — never a guess', () => {
    const report = buildIdentityReport(null, {});

    expect(report.project).toEqual(UNKNOWN_FIELD);
    expect(report.agentName).toEqual(UNKNOWN_FIELD);
    expect(report.agentRole).toEqual(UNKNOWN_FIELD);
    expect(report.routingLabel).toEqual(UNKNOWN_FIELD);
    expect(report.agentType).toEqual(UNKNOWN_FIELD);
    expect(report.registryScope).toEqual(UNKNOWN_FIELD);
    expect(report.registryTarget).toEqual(UNKNOWN_FIELD);
    expect(report.appId).toEqual(UNKNOWN_FIELD);
    expect(report.installId).toEqual(UNKNOWN_FIELD);
    expect(report.botLogin).toEqual(UNKNOWN_FIELD);
    expect(report.advertiseHost).toEqual(UNKNOWN_FIELD);
    expect(report.operatorLogin).toEqual(UNKNOWN_FIELD);
    expect(report.cliVersion).toEqual(UNKNOWN_FIELD);
    expect(report.pluginVersion).toEqual(UNKNOWN_FIELD);
    expect(report.actionsVersion).toEqual(UNKNOWN_FIELD);
    // canonicalBranch is the one field with a real, documented, rule-backed
    // default ('main' per resolveCanonicalBranch/DEFAULT_CANONICAL_BRANCH)
    // — that's a defined default, not a guess, hence source:'default'
    // rather than 'unknown'. Every OTHER field has no such rule and must
    // be honest-unknown.
    expect(report.canonicalBranch).toEqual({ value: 'main', source: 'default' });
  });
});

describe('buildIdentityReport — per-field honest-unknown WITHIN a resolved config (macf#672)', () => {
  // These pin the specific case a coarse "config resolved => trust every
  // field" mutation would silently break: a config file CAN resolve
  // (project/agent_name/agent_role present) while individual OPTIONAL
  // sub-fields are still genuinely absent (local-registry mode has no
  // github_app block at all; a fresh workspace may have no operator_login
  // or no versions pin yet). Those must each still report 'unknown', not a
  // fabricated placeholder — this is exactly the class of bug a resolver
  // that substitutes a plausible-looking default for a missing optional
  // field would introduce.

  it('local-registry-mode config (no github_app block) reports app_id/install_id/bot_login as unknown', () => {
    const { github_app: _github_app, ...withoutGithubApp } = baseConfig();
    const report = buildIdentityReport(withoutGithubApp as MacfAgentConfig, {});
    expect(report.appId).toEqual(UNKNOWN_FIELD);
    expect(report.installId).toEqual(UNKNOWN_FIELD);
    expect(report.botLogin).toEqual(UNKNOWN_FIELD);
    // The rest of the config is still real, not collaterally blanked.
    expect(report.project).toEqual({ value: 'testproj', source: 'config' });
  });

  it('a config with github_app present but bot_login unset reports bot_login as unknown', () => {
    const report = buildIdentityReport(
      baseConfig({ github_app: { app_id: '111', install_id: '222', key_path: 'k.pem' } }),
      {},
    );
    expect(report.botLogin).toEqual(UNKNOWN_FIELD);
    expect(report.appId).toEqual({ value: '111', source: 'config' });
  });

  it('a config with no operator_login set reports operator_login as unknown, not a placeholder', () => {
    const { operator_login: _operator_login, ...withoutOperatorLogin } = baseConfig();
    const report = buildIdentityReport(withoutOperatorLogin as MacfAgentConfig, {});
    expect(report.operatorLogin).toEqual(UNKNOWN_FIELD);
  });

  it('a config with no versions block reports cli/plugin/actions versions as unknown', () => {
    const { versions: _versions, ...withoutVersions } = baseConfig();
    const report = buildIdentityReport(withoutVersions as MacfAgentConfig, {});
    expect(report.cliVersion).toEqual(UNKNOWN_FIELD);
    expect(report.pluginVersion).toEqual(UNKNOWN_FIELD);
    expect(report.actionsVersion).toEqual(UNKNOWN_FIELD);
  });
});

describe('buildIdentityReport — env-only source (linked-worktree worker, macf#672)', () => {
  it('resolves project/agent_name/agent_role/routing_label from MACF_* env when macf-agent.json is absent', () => {
    const env = {
      MACF_PROJECT: 'testproj',
      MACF_AGENT_NAME: 'test-agent',
      MACF_AGENT_ROLE: 'code-agent',
      MACF_AGENT_TYPE: 'permanent',
      MACF_ROUTING_LABEL: 'code-agent-routing',
      MACF_REGISTRY_TYPE: 'repo',
      MACF_REGISTRY_REPO: 'acme/widgets',
      APP_ID: '111',
      INSTALL_ID: '222',
      MACF_ADVERTISE_HOST: '10.0.0.9',
      MACF_OPERATOR_LOGIN: 'the-operator',
      MACF_VERSION: '0.2.58',
    };
    const report = buildIdentityReport(null, env);

    expect(report.project).toEqual({ value: 'testproj', source: 'env' });
    expect(report.agentName).toEqual({ value: 'test-agent', source: 'env' });
    expect(report.agentRole).toEqual({ value: 'code-agent', source: 'env' });
    expect(report.routingLabel).toEqual({ value: 'code-agent-routing', source: 'env' });
    expect(report.registryScope).toEqual({ value: 'repo', source: 'env' });
    expect(report.registryTarget).toEqual({ value: 'acme/widgets', source: 'env' });
    expect(report.appId).toEqual({ value: '111', source: 'env' });
    expect(report.advertiseHost).toEqual({ value: '10.0.0.9', source: 'env' });
    expect(report.operatorLogin).toEqual({ value: 'the-operator', source: 'env' });
    expect(report.cliVersion).toEqual({ value: '0.2.58', source: 'env' });
    // Never exported to env by any generator — genuinely unknown from this
    // source, not a degraded guess at a plausible-looking value.
    expect(report.botLogin).toEqual(UNKNOWN_FIELD);
    expect(report.pluginVersion).toEqual(UNKNOWN_FIELD);
    expect(report.actionsVersion).toEqual(UNKNOWN_FIELD);
  });

  it('does NOT treat a partial env (missing agent_role) as a resolved identity', () => {
    const report = buildIdentityReport(null, {
      MACF_PROJECT: 'testproj',
      MACF_AGENT_NAME: 'test-agent',
      // MACF_AGENT_ROLE deliberately absent
    });
    expect(report.project).toEqual(UNKNOWN_FIELD);
    expect(report.agentName).toEqual(UNKNOWN_FIELD);
  });

  it('config, when present, takes priority over env even when both resolve', () => {
    const report = buildIdentityReport(baseConfig({ project: 'from-config' }), {
      MACF_PROJECT: 'from-env',
      MACF_AGENT_NAME: 'from-env',
      MACF_AGENT_ROLE: 'from-env',
    });
    expect(report.project).toEqual({ value: 'from-config', source: 'config' });
  });
});

describe('extractSubjectCNFromNodeCert (macf#672)', () => {
  it('parses the CN out of a newline-separated node:crypto X509Certificate subject', () => {
    expect(extractSubjectCNFromNodeCert('O=Test\nCN=code-agent')).toBe('code-agent');
    expect(extractSubjectCNFromNodeCert('CN=code-agent')).toBe('code-agent');
  });

  it('returns undefined when no CN field is present', () => {
    expect(extractSubjectCNFromNodeCert('O=Test\nOU=Widgets')).toBeUndefined();
  });

  it('is NOT interchangeable with macf-core extractCN (comma-based) — regression guard', () => {
    // macf-core's certs/agent-cert.ts::extractCN expects "O=Foo,CN=bar"
    // (comma-separated). node:crypto's X509Certificate.subject is
    // newline-separated. Verified empirically against an openssl-generated
    // leaf cert before writing extractSubjectCNFromNodeCert rather than
    // reusing extractCN and getting a silent no-match — this test pins that
    // finding so a future "just reuse extractCN" refactor fails loud.
    const nodeCryptoStyleSubject = 'O=Test\nCN=code-agent';
    expect(extractSubjectCNFromNodeCert(nodeCryptoStyleSubject)).toBe('code-agent');
  });
});

describe('readAgentCertInfo (macf#672)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'macf-whoami-cert-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports unknown CN/expiry when the cert path is undefined', () => {
    const info = readAgentCertInfo(undefined, 'config');
    expect(info.path).toEqual(UNKNOWN_FIELD);
    expect(info.cn).toEqual(UNKNOWN_FIELD);
    expect(info.expiresAt).toEqual(UNKNOWN_FIELD);
  });

  it('reports unknown CN/expiry (but a known path) when the cert file does not exist', () => {
    const missing = join(dir, 'does-not-exist.pem');
    const info = readAgentCertInfo(missing, 'config');
    expect(info.path).toEqual({ value: missing, source: 'config' });
    expect(info.cn).toEqual(UNKNOWN_FIELD);
    expect(info.expiresAt).toEqual(UNKNOWN_FIELD);
  });

  it('reads CN + expiry from a real leaf cert on disk', () => {
    const certPath = join(dir, 'agent-cert.pem');
    const keyPath = join(dir, 'agent-key.pem');
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', keyPath, '-out', certPath,
      '-days', '30', '-subj', '/O=Test/CN=whoami-test-agent',
    ]);

    const info = readAgentCertInfo(certPath, 'config');
    expect(info.path).toEqual({ value: certPath, source: 'config' });
    expect(info.cn).toEqual({ value: 'whoami-test-agent', source: 'config' });
    expect(info.expiresAt.source).toBe('config');
    expect(info.expiresAt.value).not.toBe('unknown');
    // ISO-8601 sanity check, not an exact-date assertion (would be flaky).
    expect(() => new Date(info.expiresAt.value).toISOString()).not.toThrow();
  });
});

describe('classifyTokenType (macf#672 — kept as a sub-section, mirrors macf-whoami.sh)', () => {
  it('classifies a ghs_ installation token as bot', () => {
    const r = classifyTokenType('ghs_abc123');
    expect(r.kind).toBe('bot');
    expect(r.prefix).toBe('ghs_');
  });

  it('classifies ghp_/gho_/ghu_ as user-attributed with a warning detail', () => {
    for (const prefix of ['ghp_', 'gho_', 'ghu_']) {
      const r = classifyTokenType(`${prefix}abc123`);
      expect(r.kind).toBe('user');
      expect(r.detail).toMatch(/NOT a bot installation token/);
    }
  });

  it('classifies an unset token as unset, never a guess', () => {
    const r = classifyTokenType(undefined);
    expect(r.kind).toBe('unset');
    expect(r.prefix).toBeNull();
  });

  it('classifies an unrecognized prefix as unknown-prefix', () => {
    const r = classifyTokenType('xyz_whatever');
    expect(r.kind).toBe('unknown-prefix');
  });
});

// ---------------------------------------------------------------------------
// Peers (macf#672, science-agent's 2026-08-31 correction of the earlier
// over-broad refusal). `readPeersFromRegistry` is deliberately isolated
// from scope resolution + token minting so it's testable with a fake
// `{ list }` — no network mocking, same convention as this file's existing
// bot_login-untested-here policy (see file-top docblock).
// ---------------------------------------------------------------------------

function fakeAgentInfo(overrides: Partial<AgentInfo> = {}): AgentInfo {
  return {
    host: '10.0.0.5',
    port: 8443,
    type: 'permanent',
    instance_id: 'inst-1',
    started: '2026-08-31T00:00:00.000Z',
    ...overrides,
  };
}

describe('readPeersFromRegistry — decisive pair (macf#672)', () => {
  it('(1) a registry with <PROJECT>_AGENT_* entries lists exactly those peers, from the registry', async () => {
    const fakeRegistry: Pick<Registry, 'list'> = {
      list: async () => [
        {
          name: 'science-agent',
          info: fakeAgentInfo({
            host: '10.0.0.5',
            port: 8443,
            type: 'permanent',
            started: '2026-08-31T00:00:00.000Z',
            // macf#1393 decisive pair (1/2): names differ — agent_name
            // carries the OTEL wire identity distinct from the registry key.
            agent_name: 'macf-science-agent',
          }),
        },
        {
          name: 'writing-agent',
          // macf#1393 decisive pair (2/2): a pre-existing entry with no
          // `agent_name` — must read as unknown, not defaulted to the name.
          info: fakeAgentInfo({ host: '10.0.0.6', port: 8444, type: 'worker', started: '2026-08-31T01:00:00.000Z' }),
        },
      ],
    };

    const result = await readPeersFromRegistry(fakeRegistry, 'config');

    expect(result.kind).toBe('found');
    expect(result.source).toBe('config');
    expect(result.peers).toEqual([
      {
        name: 'science-agent',
        agentName: 'macf-science-agent',
        host: '10.0.0.5',
        port: 8443,
        type: 'permanent',
        started: '2026-08-31T00:00:00.000Z',
      },
      {
        name: 'writing-agent',
        agentName: null,
        host: '10.0.0.6',
        port: 8444,
        type: 'worker',
        started: '2026-08-31T01:00:00.000Z',
      },
    ]);
  });

  it('(2) a registry readable but EMPTY reports "none registered" — a RESULT, not an error, and not unknown', async () => {
    const fakeRegistry: Pick<Registry, 'list'> = { list: async () => [] };

    const result = await readPeersFromRegistry(fakeRegistry, 'config');

    expect(result.kind).toBe('empty');
    expect(result.peers).toEqual([]);
    expect(result.detail).toBe('none registered');
    // "none registered" carries the SAME source provenance every other
    // identity field does — this is the "exactly like an unknown identity
    // field" parallel #672's comment thread asked for, applied to a
    // KNOWN-empty result rather than an unknown one.
    expect(result.source).toBe('config');
    // The specific defect this must not have: an empty-but-readable
    // registry masquerading as "I could not look" (kind 'unreadable').
    expect(result.kind).not.toBe('unreadable');
  });
});

describe('readPeersFromRegistry — the third state (unreadable), distinct from both found and empty (macf#672)', () => {
  it('a registry that fails to read (network/permission error) reports kind "unreadable", never "empty"', async () => {
    const fakeRegistry: Pick<Registry, 'list'> = {
      list: async () => {
        throw new Error('GitHub API 401: Bad credentials');
      },
    };

    const result = await readPeersFromRegistry(fakeRegistry, 'config');

    expect(result.kind).toBe('unreadable');
    expect(result.peers).toEqual([]);
    expect(result.detail).toContain('401');
    expect(result.detail).not.toBe('none registered');
  });
});

describe('readPeersFromRegistry — mutation guard: empty and unreadable must never collapse (macf#672)', () => {
  it('MUTATION GUARD: "nobody registered" (empty) and "I could not look" (unreadable) are never the same kind', async () => {
    const emptyRegistry: Pick<Registry, 'list'> = { list: async () => [] };
    const brokenRegistry: Pick<Registry, 'list'> = {
      list: async () => {
        throw new Error('boom');
      },
    };

    const emptyResult = await readPeersFromRegistry(emptyRegistry, 'config');
    const unreadableResult = await readPeersFromRegistry(brokenRegistry, 'config');

    // A mutation that makes the empty branch return 'unreadable' (or the
    // unreadable branch return 'empty') fails THIS assertion — see
    // whoami.ts's PeersKind doc comment for the invariant this pins.
    expect(emptyResult.kind).not.toBe(unreadableResult.kind);
    expect(emptyResult.kind).toBe('empty');
    expect(unreadableResult.kind).toBe('unreadable');
  });
});

describe('formatPeersSection — agent_name rendering (macf#1393)', () => {
  it('renders agent_name beside the label, and "unknown" (never "—") when absent', async () => {
    const fakeRegistry: Pick<Registry, 'list'> = {
      list: async () => [
        {
          name: 'science-agent',
          info: fakeAgentInfo({ host: '10.0.0.5', port: 8443, agent_name: 'macf-science-agent' }),
        },
        {
          name: 'writing-agent',
          // No agent_name — a pre-existing entry.
          info: fakeAgentInfo({ host: '10.0.0.6', port: 8444, type: 'worker' }),
        },
      ],
    };
    const peers = await readPeersFromRegistry(fakeRegistry, 'config');

    const lines = formatPeersSection(peers);

    expect(lines.find((l) => l.includes('science-agent'))).toContain('agent_name=macf-science-agent');
    const writingLine = lines.find((l) => l.startsWith('  writing-agent'));
    expect(writingLine).toContain('agent_name=unknown');
    // '—' is this file's offline/not-applicable glyph elsewhere — must never
    // leak into the agent_name column, which has its own honest-unknown word.
    expect(writingLine).not.toContain('—');
  });
});

describe('resolveRegistryConfigForPeers — reuses the scope buildIdentityReport already resolved (macf#672)', () => {
  it('config-sourced: reuses config.registry directly — zero re-derivation (same reference)', () => {
    const config = baseConfig();
    const identity = buildIdentityReport(config, {});

    const registryConfig = resolveRegistryConfigForPeers(identity, config, {});

    expect(registryConfig).toBe(config.registry);
  });

  it('env-sourced repo type: splits the combined MACF_REGISTRY_REPO "owner/repo" back apart', () => {
    const env = {
      MACF_PROJECT: 'testproj',
      MACF_AGENT_NAME: 'test-agent',
      MACF_AGENT_ROLE: 'code-agent',
      MACF_REGISTRY_TYPE: 'repo',
      MACF_REGISTRY_REPO: 'acme/widgets',
    };
    const identity = buildIdentityReport(null, env);

    expect(resolveRegistryConfigForPeers(identity, null, env)).toEqual({
      type: 'repo',
      owner: 'acme',
      repo: 'widgets',
    });
  });

  it('env-sourced org type', () => {
    const env = {
      MACF_PROJECT: 'testproj',
      MACF_AGENT_NAME: 'test-agent',
      MACF_AGENT_ROLE: 'code-agent',
      MACF_REGISTRY_TYPE: 'org',
      MACF_REGISTRY_ORG: 'acme-org',
    };
    const identity = buildIdentityReport(null, env);

    expect(resolveRegistryConfigForPeers(identity, null, env)).toEqual({ type: 'org', org: 'acme-org' });
  });

  it('neither source resolved a scope: returns null (the widest "cannot resolve" case)', () => {
    const identity = buildIdentityReport(null, {});

    expect(resolveRegistryConfigForPeers(identity, null, {})).toBeNull();
  });
});

describe('resolvePeersReport — side-effect-free early-return branches (macf#672)', () => {
  it('offline/opt-out (--no-resolve-peers): returns kind "skipped" immediately, reporting why — does not hang, no network attempted', async () => {
    const config = baseConfig();
    const identity = buildIdentityReport(config, {});

    const result = await resolvePeersReport('/nonexistent/dir', config, identity, { resolvePeers: false });

    expect(result.kind).toBe('skipped');
    expect(result.peers).toEqual([]);
    expect(result.detail).toContain('--no-resolve-peers');
    // The skip carries the resolved scope's provenance even though the
    // read itself was never attempted — a config-backed workspace still
    // reports WHICH scope it declined to read.
    expect(result.source).toBe('config');
  });

  it('registry scope unknown (neither config nor env resolved it): kind "unreadable", distinct from "skipped" and "empty"', async () => {
    const identity = buildIdentityReport(null, {});

    const result = await resolvePeersReport('/nonexistent/dir', null, identity, {});

    expect(result.kind).toBe('unreadable');
    expect(result.detail).toContain('registry scope is unknown');
    expect(result.source).toBe('unknown');
  });
});

