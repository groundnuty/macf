import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as x509Lib from '@peculiar/x509';
import { createCA } from '../../src/certs/ca.js';
import { generateAgentCert, generateCSR, signCSR, extractCN, AgentCertError } from '../../src/certs/agent-cert.js';
// Ensure crypto provider is initialized
import '../../src/certs/crypto-provider.js';

function tempDir(): string {
  const dir = join(tmpdir(), `macf-cert-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('agent-cert', () => {
  let dir: string;
  let caCertPem: string;
  let caKeyPem: string;

  beforeAll(async () => {
    dir = tempDir();
    const ca = await createCA({
      project: 'TEST',
      certPath: join(dir, 'ca-cert.pem'),
      keyPath: join(dir, 'ca-key.pem'),
    });
    caCertPem = ca.certPem;
    caKeyPem = ca.keyPem;
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe('generateAgentCert', () => {
    it('generates cert with correct CN', async () => {
      const result = await generateAgentCert({
        agentName: 'code-agent',
        caCertPem,
        caKeyPem,
      });

      expect(result.certPem).toContain('-----BEGIN CERTIFICATE-----');
      expect(result.keyPem).toContain('-----BEGIN PRIVATE KEY-----');

      const cert = new x509Lib.X509Certificate(result.certPem);
      expect(cert.subject).toContain('CN=code-agent');
    });

    it('cert is signed by the CA', async () => {
      const result = await generateAgentCert({
        agentName: 'test-agent',
        caCertPem,
        caKeyPem,
      });

      const cert = new x509Lib.X509Certificate(result.certPem);
      const caCert = new x509Lib.X509Certificate(caCertPem);
      expect(cert.issuer).toBe(caCert.subject);
    });
  });

  describe('generateCSR', () => {
    it('creates CSR with correct subject', async () => {
      const result = await generateCSR('new-agent');

      expect(result.csrPem).toContain('-----BEGIN CERTIFICATE REQUEST-----');
      expect(result.keyPem).toContain('-----BEGIN PRIVATE KEY-----');

      const csr = new x509Lib.Pkcs10CertificateRequest(result.csrPem);
      expect(csr.subject).toContain('CN=new-agent');
    });
  });

  describe('signCSR', () => {
    it('signs CSR with matching CN', async () => {
      const { csrPem } = await generateCSR('new-agent');

      const certPem = await signCSR({
        csrPem,
        agentName: 'new-agent',
        caCertPem,
        caKeyPem,
      });

      expect(certPem).toContain('-----BEGIN CERTIFICATE-----');

      const cert = new x509Lib.X509Certificate(certPem);
      expect(cert.subject).toContain('CN=new-agent');

      const caCert = new x509Lib.X509Certificate(caCertPem);
      expect(cert.issuer).toBe(caCert.subject);
    });

    it('rejects CSR with CN mismatch', async () => {
      const { csrPem } = await generateCSR('wrong-name');

      await expect(signCSR({
        csrPem,
        agentName: 'expected-name',
        caCertPem,
        caKeyPem,
      })).rejects.toThrow(AgentCertError);
    });

    it('rejects invalid CSR', async () => {
      await expect(signCSR({
        csrPem: 'not-a-csr',
        agentName: 'test',
        caCertPem,
        caKeyPem,
      })).rejects.toThrow();
    });
  });

  describe('extractCN (#89 — strict single-CN parser)', () => {
    it('extracts a single CN from a bare subject', () => {
      expect(extractCN('CN=code-agent')).toBe('code-agent');
    });

    it('extracts the CN from a subject with other RDNs before it', () => {
      expect(extractCN('O=foo,CN=code-agent,OU=bar')).toBe('code-agent');
    });

    it('trims surrounding whitespace on the CN value', () => {
      expect(extractCN('CN= code-agent ')).toBe('code-agent');
    });

    it('is case-insensitive on the CN= prefix', () => {
      expect(extractCN('cn=code-agent')).toBe('code-agent');
    });

    it('returns undefined on a subject with ZERO CN fields', () => {
      expect(extractCN('O=foo,OU=bar')).toBeUndefined();
      expect(extractCN('')).toBeUndefined();
    });

    it('returns undefined on a subject with MULTIPLE CN fields (#89)', () => {
      // Core fix: multi-CN subjects are rejected so an attacker can't
      // craft `CN=attacker,CN=victim` and slip past the equality check.
      expect(extractCN('CN=attacker,CN=victim')).toBeUndefined();
      expect(extractCN('O=foo,CN=attacker,CN=victim')).toBeUndefined();
      expect(extractCN('CN=attacker,OU=baz,CN=victim')).toBeUndefined();
    });

    it('does not match CN as substring of another RDN', () => {
      // "OCN=foo" should NOT be interpreted as a CN.
      expect(extractCN('OCN=foo')).toBeUndefined();
      // "DCN=foo" similarly.
      expect(extractCN('DCN=bar')).toBeUndefined();
    });
  });
});
