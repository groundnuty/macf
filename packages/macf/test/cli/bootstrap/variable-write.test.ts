/**
 * Tests for `variable-write.ts` — DR-043 Phase 2b (groundnuty/macf#838
 * Amendment D phase 2, macf#854's CA/routing gap).
 *
 * `buildCreateVariableArgs` is the ONLY thing tested here — the "POST, not
 * PATCH" create-only guarantee pinned as a literal argv array, per the
 * macf#838 Phase 2b review ("pin the create-only wire shape with a pure
 * args builder... don't let the guarantee rest on a comment"). `realCreateVariable`
 * itself is a thin `execFile('gh', ...)` leaf — untested directly, same
 * posture as `observer.ts`'s `gh api` shell-outs (see that file's test-file
 * doc comment) and `repo-create.ts`'s `realCreateRepo`.
 */
import { describe, it, expect } from 'vitest';
import { buildCreateVariableArgs, buildDeleteVariableArgs, buildUpdateVariableArgs } from '../../../src/cli/bootstrap/variable-write.js';

describe('buildCreateVariableArgs (pure)', () => {
  it('is a POST, never a PATCH — the load-bearing create-only property', () => {
    const args = buildCreateVariableArgs('repos/groundnuty/demo', 'ICSOC_2026_CA_CERT', 'cert-pem-value');
    expect(args).toContain('--method');
    expect(args[args.indexOf('--method') + 1]).toBe('POST');
    expect(args).not.toContain('PATCH');
  });

  it('targets <prefix>/actions/variables (the create endpoint, not .../variables/<name>)', () => {
    const args = buildCreateVariableArgs('repos/groundnuty/demo', 'NAME', 'value');
    expect(args).toContain('repos/groundnuty/demo/actions/variables');
    expect(args).not.toContain('repos/groundnuty/demo/actions/variables/NAME');
  });

  it('strips a leading slash from a registry-scope prefix (registryPathPrefix shape)', () => {
    const args = buildCreateVariableArgs('/repos/groundnuty/groundnuty', 'NAME', 'value');
    expect(args).toContain('repos/groundnuty/groundnuty/actions/variables');
  });

  it('leaves a repo-scope prefix (no leading slash) unchanged', () => {
    const args = buildCreateVariableArgs('repos/groundnuty/demo', 'NAME', 'value');
    expect(args).toContain('repos/groundnuty/demo/actions/variables');
  });

  it('carries name and value as separate -f form fields, never string-concatenated', () => {
    const args = buildCreateVariableArgs('repos/o/r', 'MY_NAME', 'my value with spaces');
    expect(args).toEqual(['api', 'repos/o/r/actions/variables', '--method', 'POST', '-f', 'name=MY_NAME', '-f', 'value=my value with spaces']);
  });

  it('passes a multi-line PEM value through as ONE argv element (no shell involved — execFile, not exec)', () => {
    const pem = '-----BEGIN CERTIFICATE-----\nMIIB...\n-----END CERTIFICATE-----\n';
    const args = buildCreateVariableArgs('repos/o/r', 'CA_CERT', pem);
    expect(args).toContain(`value=${pem}`);
  });
});

describe('buildCreateVariableArgs — org-scope visibility (macf#866)', () => {
  it('appends -f visibility=all for an org-scope prefix (POST /orgs/{org}/actions/variables 422s without it)', () => {
    const args = buildCreateVariableArgs('orgs/macf-experiment', 'MACF_EXPERIMENT_CA_CERT', 'cert-pem-value');
    expect(args).toEqual([
      'api',
      'orgs/macf-experiment/actions/variables',
      '--method',
      'POST',
      '-f',
      'name=MACF_EXPERIMENT_CA_CERT',
      '-f',
      'value=cert-pem-value',
      '-f',
      'visibility=all',
    ]);
  });

  it('strips the leading slash before detecting org scope (registryPathPrefix\'s "/orgs/<org>" shape)', () => {
    const args = buildCreateVariableArgs('/orgs/macf-experiment', 'NAME', 'value');
    expect(args).toContain('-f');
    expect(args[args.length - 1]).toBe('visibility=all');
  });

  it('does NOT append visibility for repo scope (including {type: "profile"}\'s repos/<user>/<user> shape — no user-level Actions-variables endpoint exists)', () => {
    const repoArgs = buildCreateVariableArgs('repos/groundnuty/demo', 'NAME', 'value');
    expect(repoArgs).not.toContain('visibility=all');

    const profileArgs = buildCreateVariableArgs('/repos/groundnuty/groundnuty', 'NAME', 'value');
    expect(profileArgs).not.toContain('visibility=all');
  });
});

describe('buildDeleteVariableArgs (pure) — DR-043 Amendment G (groundnuty/macf#867)', () => {
  it('is a DELETE, targeting .../actions/variables/<name> (unlike create, which targets the collection endpoint)', () => {
    const args = buildDeleteVariableArgs('repos/groundnuty/demo', 'ICSOC_2026_CA_CERT');
    expect(args).toEqual(['api', 'repos/groundnuty/demo/actions/variables/ICSOC_2026_CA_CERT', '--method', 'DELETE']);
  });

  it('strips a leading slash from a registry-scope prefix, same as buildCreateVariableArgs', () => {
    const args = buildDeleteVariableArgs('/orgs/macf-experiment', 'MACF_EXPERIMENT_CA_CERT');
    expect(args).toContain('orgs/macf-experiment/actions/variables/MACF_EXPERIMENT_CA_CERT');
  });

  it('never carries a -f/-F value field — a delete has no value to send', () => {
    const args = buildDeleteVariableArgs('repos/o/r', 'NAME');
    expect(args).not.toContain('-f');
    expect(args).not.toContain('-F');
  });
});

describe('buildUpdateVariableArgs (pure) — groundnuty/macf#1319 (DR-043 Amendment P row 3 applied to MACF_TRUSTED_ACTORS)', () => {
  it('is a PATCH, never a POST — the load-bearing overwrite property (opposite of create-only)', () => {
    const args = buildUpdateVariableArgs('repos/groundnuty/demo', 'MACF_TRUSTED_ACTORS', 'macf-code-agent[bot]');
    expect(args).toContain('--method');
    expect(args[args.indexOf('--method') + 1]).toBe('PATCH');
    expect(args).not.toContain('POST');
  });

  it('targets .../actions/variables/<name> (the single-resource endpoint, matching delete — NOT the create collection endpoint)', () => {
    const args = buildUpdateVariableArgs('repos/groundnuty/demo', 'MACF_TRUSTED_ACTORS', 'value');
    expect(args).toContain('repos/groundnuty/demo/actions/variables/MACF_TRUSTED_ACTORS');
    expect(args).not.toContain('repos/groundnuty/demo/actions/variables');
  });

  it('strips a leading slash from a registry-scope prefix, same as buildCreateVariableArgs/buildDeleteVariableArgs', () => {
    const args = buildUpdateVariableArgs('/repos/groundnuty/demo', 'NAME', 'value');
    expect(args).toContain('repos/groundnuty/demo/actions/variables/NAME');
  });

  it('carries ONLY value= — no name= field (the endpoint already names the variable in its path)', () => {
    const args = buildUpdateVariableArgs('repos/o/r', 'MY_NAME', 'my value with spaces');
    expect(args).toEqual(['api', 'repos/o/r/actions/variables/MY_NAME', '--method', 'PATCH', '-f', 'value=my value with spaces']);
    expect(args.join(' ')).not.toContain('name=');
  });
});
