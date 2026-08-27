/**
 * Tests for per-project CA path namespacing — PR #36.
 */
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { homedir } from 'node:os';
import {
  caDir, caCertPath, caKeyPath, isValidProjectName,
} from '../../src/cli/config.js';

const GLOBAL = join(homedir(), '.macf');

describe('isValidProjectName', () => {
  it('accepts alphanumeric and underscore and hyphen', () => {
    expect(isValidProjectName('macf')).toBe(true);
    expect(isValidProjectName('MACF')).toBe(true);
    expect(isValidProjectName('my-project')).toBe(true);
    expect(isValidProjectName('my_project')).toBe(true);
    expect(isValidProjectName('project123')).toBe(true);
  });

  it('rejects path separators', () => {
    expect(isValidProjectName('my/project')).toBe(false);
    expect(isValidProjectName('my\\project')).toBe(false);
    expect(isValidProjectName('../escape')).toBe(false);
    expect(isValidProjectName('..')).toBe(false);
  });

  it('rejects dots and spaces', () => {
    expect(isValidProjectName('my.project')).toBe(false);
    expect(isValidProjectName('my project')).toBe(false);
    expect(isValidProjectName('.hidden')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(isValidProjectName('')).toBe(false);
  });
});

// macf#1277: caDir/caCertPath/caKeyPath are now owner+project-scoped
// (`~/.macf/certs/<owner>/<project>/`). Owner-scoping-SPECIFIC coverage
// (the decisive pair, the legacy fallback, resolveExistingCaPaths) lives
// in the dedicated `ca-owner-scoping.test.ts`, mirroring the macf#1214
// precedent's `fleet-deploy-owner-scoping.test.ts` split. This file keeps
// its original PR #36 project-namespacing coverage, updated to pass a
// fixed owner through every call.
describe('caDir / caCertPath / caKeyPath', () => {
  it('returns per-owner, per-project subdirectory', () => {
    expect(caDir('acme', 'macf')).toBe(join(GLOBAL, 'certs', 'acme', 'macf'));
    expect(caDir('acme', 'academic-resume')).toBe(join(GLOBAL, 'certs', 'acme', 'academic-resume'));
  });

  it('different projects get different directories (no collision)', () => {
    expect(caDir('acme', 'proj-a')).not.toBe(caDir('acme', 'proj-b'));
    expect(caCertPath('acme', 'proj-a')).not.toBe(caCertPath('acme', 'proj-b'));
    expect(caKeyPath('acme', 'proj-a')).not.toBe(caKeyPath('acme', 'proj-b'));
  });

  it('caCertPath returns ca-cert.pem in owner/project dir', () => {
    expect(caCertPath('acme', 'macf')).toBe(join(GLOBAL, 'certs', 'acme', 'macf', 'ca-cert.pem'));
  });

  it('caKeyPath returns ca-key.pem in owner/project dir', () => {
    expect(caKeyPath('acme', 'macf')).toBe(join(GLOBAL, 'certs', 'acme', 'macf', 'ca-key.pem'));
  });

  it('rejects invalid project names to prevent path traversal', () => {
    expect(() => caDir('acme', '../escape')).toThrow('Invalid project name');
    expect(() => caCertPath('acme', '../escape')).toThrow('Invalid project name');
    expect(() => caKeyPath('acme', '../escape')).toThrow('Invalid project name');
    expect(() => caDir('acme', 'with/slash')).toThrow('Invalid project name');
  });

  it('rejects empty project name', () => {
    expect(() => caDir('acme', '')).toThrow('Invalid project name');
  });

  it('rejects invalid owner names to prevent path traversal', () => {
    expect(() => caDir('../escape', 'macf')).toThrow('Invalid owner name');
    expect(() => caDir('with/slash', 'macf')).toThrow('Invalid owner name');
  });

  it('rejects empty owner name', () => {
    expect(() => caDir('', 'macf')).toThrow('Invalid owner name');
  });
});
