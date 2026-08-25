/**
 * Tests for `manifest-scaffold.ts` (groundnuty/macf#1153).
 *
 * **This file deliberately never imports `plan.ts::computePlan`.** Per the
 * amendment on macf#1153 (citing `#1132`'s modal-pin defect) and the
 * canonical `assert-the-wrong-path.md` worked example, "scaffolded manifest
 * ⇒ empty plan" is a circular verification — `observer.ts` is what `plan`
 * diffs a manifest AGAINST, so a manifest scaffolded from that same
 * observation would trivially self-agree regardless of whether the draft is
 * actually correct. The decisive test below instead asserts the exact
 * TODO/schema-issue SET a fully-observable fixture produces, and that
 * flipping ONE conditionally-observable field (a) marks it TODO, (b)
 * changes the TODO count by exactly one, and (c) never lets the untried
 * candidate value leak into the draft as a DECLARED field.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import {
  MANIFEST_SCAFFOLD_AUDIT_TABLE,
  scaffoldManifest,
  type ManifestScaffoldDeps,
  type ManifestScaffoldInput,
} from '../../../src/cli/bootstrap/manifest-scaffold.js';

const AGENTS = [
  { role: 'code-agent', repo: 'groundnuty/macf-code-agent' },
  { role: 'science-agent', repo: 'groundnuty/macf-science-agent' },
] as const;

const INPUT: ManifestScaffoldInput = { owner: 'groundnuty', fleetName: 'macf', agents: AGENTS };

/** Every dep resolves cleanly — the "fully observable fleet" fixture. */
function fullyObservableDeps(): ManifestScaffoldDeps {
  return {
    fetchOwnerType: vi.fn(async () => 'org'),
    checkRegistryVariablePresence: vi.fn(async () => 'present'),
    readAgentRegistryInfo: vi.fn(async (_registry, _fleet, role: string) => ({
      status: 'confirmed' as const,
      presence: 'present' as const,
      info: { host: '100.64.1.2', port: 8443, type: 'permanent' as const, instance_id: `${role}-inst`, started: '2026-01-01T00:00:00Z' },
    })),
    checkRepoArchivedState: vi.fn(async () => ({ presence: 'present' as const, archived: false })),
    readCallerActionsPin: vi.fn(async () => 'v3.4.1'),
    resolveAgentRepoState: vi.fn(async () => ({ repo: 'present' as const, caRepo: 'present' as const, routingClientRepo: 'present' as const })),
    readAgentConfigWorkspaceDir: vi.fn(async (repo: string) => `/home/ubuntu/repos/${repo}`),
    readVault: vi.fn(async () => ({})),
    readVaultRecipientCount: vi.fn(() => ({ status: 'absent' as const })),
  };
}

const IRREDUCIBLE_SCHEMA_ISSUE_PATHS = ['defaults.role_template', 'defaults.app_manifest', 'transport.age_recipients', '0.profile', '1.profile'].map(
  (p) => (p.endsWith('.profile') ? `agents.${p}` : p),
);

describe('scaffoldManifest — decisive pair', () => {
  it('test 1: a fully-observable fleet gets exactly the irreducible TODO/schema-issue set, nothing more', async () => {
    const deps = fullyObservableDeps();
    const result = await scaffoldManifest(INPUT, deps);

    // Wrong-path guard: this is NOT "it printed some TODOs" — it is EXACT
    // set equality against the whitelist named in the module doc. A future
    // change that silently adds a spurious TODO (or silently drops a real
    // one) fails this immediately.
    expect(result.schemaIssuePaths.slice().sort()).toEqual(IRREDUCIBLE_SCHEMA_ISSUE_PATHS.slice().sort());

    const parsed = parseYaml(result.yaml) as Record<string, unknown>;
    expect(parsed['owner']).toEqual({ account: 'groundnuty', type: 'org', registry: { type: 'org', org: 'groundnuty' } });
    expect(parsed['network']).toEqual({ advertise_host: '100.64.1.2' });
    const agents = parsed['agents'] as readonly Record<string, unknown>[];
    expect(agents).toHaveLength(2);
    expect(agents[0]?.['repo']).toBe('groundnuty/macf-code-agent');
    expect(agents[0]?.['deploy_path']).toBe('/home/ubuntu/repos/groundnuty/macf-code-agent');
    expect(agents[0]?.['profile']).toBeUndefined();

    // versions is optional at the schema level, so it never appears in
    // schemaIssuePaths — but it must ALSO never be declared, per Amendment L.
    expect(parsed['versions']).toBeUndefined();
    expect(result.yaml).not.toMatch(/^versions:/m);
  });

  it('test 2: an unconfirmed owner.registry becomes TODO, the count moves by exactly one, and the untried candidate is never declared', async () => {
    const baseline = await scaffoldManifest(INPUT, fullyObservableDeps());

    const flipped = fullyObservableDeps();
    flipped.checkRegistryVariablePresence = vi.fn(async () => 'absent');
    const result = await scaffoldManifest(INPUT, flipped);

    expect(result.todoCount).toBe(baseline.todoCount + 1);
    expect(result.schemaIssuePaths.slice().sort()).toEqual([...IRREDUCIBLE_SCHEMA_ISSUE_PATHS, 'owner.registry'].sort());

    const parsed = parseYaml(result.yaml) as Record<string, unknown>;
    const owner = parsed['owner'] as Record<string, unknown>;
    expect(owner['registry']).toBeUndefined();
    // The untried candidate must never appear as a DECLARED `registry:` key
    // — only a real key line (2-space indent, no leading `#`) would count;
    // the explanatory TODO comment naming the candidate scope is expected
    // and fine (transparency, not a guess accepted as fact).
    expect(result.yaml).not.toMatch(/^ {2}registry:/m);
    expect(owner['type']).toBe('org'); // owner.type itself is unaffected by this flip
  });
});

describe('scaffoldManifest — the two most consequential defaults', () => {
  it('never emits transport.age_recipients: [] for an already-provisioned fleet', async () => {
    const result = await scaffoldManifest(INPUT, fullyObservableDeps());
    const parsed = parseYaml(result.yaml) as Record<string, unknown>;
    const transport = parsed['transport'] as Record<string, unknown> | undefined;
    expect(transport?.['age_recipients']).toBeUndefined();
    expect(result.yaml).not.toMatch(/age_recipients:\s*\[\s*\]/);
    expect(result.todos.some((t) => t.includes('age_recipients'))).toBe(true);
  });

  it('agents[].profile is never derived from role, even when a plausible role->profile guess exists', async () => {
    const result = await scaffoldManifest(INPUT, fullyObservableDeps());
    const parsed = parseYaml(result.yaml) as Record<string, unknown>;
    const agents = parsed['agents'] as readonly Record<string, unknown>[];
    for (const agent of agents) {
      expect(agent['profile']).toBeUndefined();
    }
    // Real fixtures elsewhere in this codebase show role and profile are NOT
    // related by any suffix-stripping rule (science-agent -> research,
    // runner-ops -> code) — this module must never attempt one.
    expect(result.yaml).not.toMatch(/profile:\s*"code"/);
    expect(result.yaml).not.toMatch(/profile:\s*"science"/);
  });
});

describe('scaffoldManifest — vault-conditional derivation', () => {
  it('declares transport.tailscale_oauth_required: true only when the vault confirms both TS_OAUTH fields', async () => {
    const deps = fullyObservableDeps();
    // vault-read.ts::vaultTsOauthClientId/vaultTsOauthSecret read these
    // EXACT raw keys (verified against their source) — a fixture with the
    // wrong key names would silently exercise the omitted branch instead,
    // which is why this test asserts the TRUE branch directly rather than
    // conditionally.
    deps.readVault = vi.fn(async () => ({ TS_OAUTH_CLIENT_ID: 'x', TS_OAUTH_SECRET: 'y' }));

    const result = await scaffoldManifest(INPUT, deps, { vaultPath: '/tmp/vault.age', identityKeyPath: '/tmp/id.key' });
    const parsed = parseYaml(result.yaml) as Record<string, unknown>;
    const transport = parsed['transport'] as Record<string, unknown>;
    expect(transport['age_recipients']).toBeUndefined();
    expect(transport['tailscale_oauth_required']).toBe(true);
  });

  it('omits tailscale_oauth_required (schema default applies) when no --vault is given — never a TODO', async () => {
    const result = await scaffoldManifest(INPUT, fullyObservableDeps());
    expect(result.todos.some((t) => t.includes('tailscale_oauth_required'))).toBe(false);
    expect(result.schemaIssuePaths).not.toContain('transport.tailscale_oauth_required');
  });
});

describe('MANIFEST_SCAFFOLD_AUDIT_TABLE', () => {
  it('is non-empty and classifies the fields this module treats as irreducible TODOs', () => {
    const byField = new Map(MANIFEST_SCAFFOLD_AUDIT_TABLE.map((row) => [row.field, row.verdict]));
    expect(byField.get('defaults.role_template')).toBe('unconfirmable');
    expect(byField.get('defaults.app_manifest')).toBe('unconfirmable');
    expect(byField.get('transport.age_recipients')).toBe('unconfirmable');
    expect(byField.get('agents[].profile')).toBe('unconfirmable');
    expect(byField.get('owner.type')).toBe('observable');
    expect(byField.get('agents[].repo')).toBe('input');
    expect(MANIFEST_SCAFFOLD_AUDIT_TABLE.length).toBeGreaterThanOrEqual(20);
  });
});

describe('no-write source-shape guard', () => {
  // Matches this codebase's ACTUAL call shape (`execFileAsync('gh', [...])`
  // array-literal args, per observer.ts's established style — not a shell
  // string), so the self-test below exercises a realistic line, not a
  // shape the real source would never produce.
  const MUTATION_VERB_PATTERN =
    /execFileAsync\(\s*['"]gh['"].*(['"]-X['"]|['"]--method['"]).*['"](POST|PATCH|PUT|DELETE)['"]|execFileAsync\(\s*['"]gh['"].*['"](pr|issue|repo)['"].*['"](create|merge|comment|close|edit|archive|delete)['"]|execFileAsync\(\s*['"]git['"].*['"]push['"]/;

  function nonCommentLines(source: string): readonly string[] {
    return source.split('\n').filter((line) => {
      const trimmed = line.trim();
      return !(trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*'));
    });
  }

  it('manifest-scaffold.ts never invokes a GitHub/git mutation verb', () => {
    const source = readFileSync(new URL('../../../src/cli/bootstrap/manifest-scaffold.ts', import.meta.url), 'utf-8');
    const offenders = nonCommentLines(source).filter((line) => MUTATION_VERB_PATTERN.test(line));
    expect(offenders).toEqual([]);
  });

  it('commands/bootstrap-manifest-scaffold.ts never invokes a GitHub/git mutation verb (only a LOCAL --out write)', () => {
    const source = readFileSync(new URL('../../../src/cli/commands/bootstrap-manifest-scaffold.ts', import.meta.url), 'utf-8');
    const offenders = nonCommentLines(source).filter((line) => MUTATION_VERB_PATTERN.test(line));
    expect(offenders).toEqual([]);
    // Decisive half: prove the guard can actually fire on a REALISTIC line
    // (this codebase's actual execFileAsync array-literal shape), not just
    // that the real file happens to be clean (assert-the-wrong-path.md).
    expect(MUTATION_VERB_PATTERN.test("await execFileAsync('gh', ['pr', 'create', '--title', t]);")).toBe(true);
    expect(MUTATION_VERB_PATTERN.test("await execFileAsync('gh', ['api', repoPath, '-X', 'POST']);")).toBe(true);
    expect(MUTATION_VERB_PATTERN.test("await execFileAsync('git', ['push', 'origin', 'main']);")).toBe(true);
  });
});
