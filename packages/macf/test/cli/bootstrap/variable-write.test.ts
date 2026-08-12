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
import { buildCreateVariableArgs } from '../../../src/cli/bootstrap/variable-write.js';

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
