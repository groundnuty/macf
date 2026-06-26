import { describe, it, expect } from 'vitest';
import { toVariableSegment, fromVariableSegment } from '../../src/registry/variable-name.js';

describe('toVariableSegment', () => {
  it('uppercases plain alphanumeric names', () => {
    expect(toVariableSegment('macf')).toBe('MACF');
    expect(toVariableSegment('cli')).toBe('CLI');
  });

  it('converts hyphens to underscores', () => {
    expect(toVariableSegment('academic-resume')).toBe('ACADEMIC_RESUME');
    expect(toVariableSegment('cv-architect')).toBe('CV_ARCHITECT');
  });

  it('handles multiple hyphens', () => {
    expect(toVariableSegment('foo-bar-baz')).toBe('FOO_BAR_BAZ');
  });

  it('preserves existing underscores', () => {
    expect(toVariableSegment('with_underscore')).toBe('WITH_UNDERSCORE');
    expect(toVariableSegment('mix-of_both')).toBe('MIX_OF_BOTH');
  });

  it('passes through already-uppercase input', () => {
    expect(toVariableSegment('MACF')).toBe('MACF');
    expect(toVariableSegment('CODE_AGENT')).toBe('CODE_AGENT');
  });

  it('produces identical output for equivalent inputs', () => {
    // Case-insensitive + hyphen/underscore-equivalent inputs collapse
    expect(toVariableSegment('code-agent')).toBe(toVariableSegment('CODE_AGENT'));
    expect(toVariableSegment('Code-Agent')).toBe(toVariableSegment('code_agent'));
  });

  it('handles digits', () => {
    expect(toVariableSegment('worker-a8f3c2')).toBe('WORKER_A8F3C2');
    expect(toVariableSegment('v1-0-0')).toBe('V1_0_0');
  });
});

describe('fromVariableSegment (macf#590)', () => {
  it('lowercases + converts underscores back to hyphens', () => {
    expect(fromVariableSegment('DEVOPS_AGENT')).toBe('devops-agent');
    expect(fromVariableSegment('CODE_AGENT')).toBe('code-agent');
    expect(fromVariableSegment('CV_ARCHITECT')).toBe('cv-architect');
  });

  it('is idempotent on already-kebab routing-labels', () => {
    expect(fromVariableSegment('devops-agent')).toBe('devops-agent');
    expect(fromVariableSegment('code-agent')).toBe('code-agent');
  });

  it('round-trips a canonical kebab agent name through toVariableSegment', () => {
    for (const name of ['devops-agent', 'code-agent', 'science-agent', 'cv-architect']) {
      expect(fromVariableSegment(toVariableSegment(name))).toBe(name);
    }
  });

  it('never emits an uppercase letter or underscore for a registry-key suffix', () => {
    const out = fromVariableSegment('MACF_DEVOPS_AGENT');
    expect(out).toBe('macf-devops-agent');
    expect(out).not.toMatch(/[A-Z_]/);
  });
});
