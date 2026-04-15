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

describe('caDir / caCertPath / caKeyPath', () => {
  it('returns per-project subdirectory', () => {
    expect(caDir('macf')).toBe(join(GLOBAL, 'certs', 'macf'));
    expect(caDir('academic-resume')).toBe(join(GLOBAL, 'certs', 'academic-resume'));
  });

  it('different projects get different directories (no collision)', () => {
    expect(caDir('proj-a')).not.toBe(caDir('proj-b'));
    expect(caCertPath('proj-a')).not.toBe(caCertPath('proj-b'));
    expect(caKeyPath('proj-a')).not.toBe(caKeyPath('proj-b'));
  });

  it('caCertPath returns ca-cert.pem in project dir', () => {
    expect(caCertPath('macf')).toBe(join(GLOBAL, 'certs', 'macf', 'ca-cert.pem'));
  });

  it('caKeyPath returns ca-key.pem in project dir', () => {
    expect(caKeyPath('macf')).toBe(join(GLOBAL, 'certs', 'macf', 'ca-key.pem'));
  });

  it('rejects invalid project names to prevent path traversal', () => {
    expect(() => caDir('../escape')).toThrow('Invalid project name');
    expect(() => caCertPath('../escape')).toThrow('Invalid project name');
    expect(() => caKeyPath('../escape')).toThrow('Invalid project name');
    expect(() => caDir('with/slash')).toThrow('Invalid project name');
  });

  it('rejects empty project name', () => {
    expect(() => caDir('')).toThrow('Invalid project name');
  });
});
