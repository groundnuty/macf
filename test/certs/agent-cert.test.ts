import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as x509Lib from '@peculiar/x509';
import { createCA } from '../../src/certs/ca.js';
import { generateAgentCert, generateClientCert, generateCSR, signCSR, extractCN, AgentCertError } from '../../src/certs/agent-cert.js';
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

    it('cert has clientAuth ExtendedKeyUsage (#125, step 1 of DR-004 v2 EKU rollout)', async () => {
      // Step 1: peer certs emit the EKU. Step 2 (operator-driven):
      // rotate existing peers. Step 3 (#121): server-side /notify
      // verifies the EKU. Until step 2 completes fleet-wide, #121
      // can't ship — but this step lands in isolation today.
      const result = await generateAgentCert({
        agentName: 'test-agent',
        caCertPem,
        caKeyPem,
      });
      const cert = new x509Lib.X509Certificate(result.certPem);
      const ekuExt = cert.getExtension('2.5.29.37'); // extKeyUsage OID
      expect(ekuExt).toBeDefined();
      const usages = (ekuExt as unknown as { usages: readonly string[] }).usages;
      // Belt-and-suspenders: pin exactly clientAuth, nothing else.
      // Catches future regressions that accidentally add e.g.
      // serverAuth to peer certs.
      expect([...usages]).toEqual(['1.3.6.1.5.5.7.3.2']);
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

    it('CSR-signed cert has clientAuth ExtendedKeyUsage (#125)', async () => {
      // /sign-endpoint peer certs must also carry the EKU so they
      // work after #121 tightens server-side verification. Matches
      // generateAgentCert behavior.
      const { csrPem } = await generateCSR('csr-agent');
      const certPem = await signCSR({
        csrPem,
        agentName: 'csr-agent',
        caCertPem,
        caKeyPem,
      });
      const cert = new x509Lib.X509Certificate(certPem);
      const ekuExt = cert.getExtension('2.5.29.37');
      expect(ekuExt).toBeDefined();
      const usages = (ekuExt as unknown as { usages: readonly string[] }).usages;
      // Exactly clientAuth — no serverAuth or others. See the
      // matching generateAgentCert test for rationale.
      expect([...usages]).toEqual(['1.3.6.1.5.5.7.3.2']);
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

  describe('generateClientCert (#119)', () => {
    // Primitive used by the `macf certs issue-routing-client` CLI to
    // mint the routing Action's mTLS client cert.

    it('generates cert with correct CN and validity window', async () => {
      const before = Date.now();
      const result = await generateClientCert({
        commonName: 'routing-action',
        validityDays: 365,
        caCertPem,
        caKeyPem,
      });
      const after = Date.now();

      expect(result.certPem).toContain('-----BEGIN CERTIFICATE-----');
      expect(result.keyPem).toContain('-----BEGIN PRIVATE KEY-----');

      const cert = new x509Lib.X509Certificate(result.certPem);
      expect(cert.subject).toContain('CN=routing-action');

      // Validity window: notAfter ~ now + 365 days, within tolerance.
      const notBefore = cert.notBefore.getTime();
      const notAfter = cert.notAfter.getTime();
      const spanDays = (notAfter - notBefore) / (1000 * 60 * 60 * 24);
      expect(spanDays).toBeGreaterThan(364.5);
      expect(spanDays).toBeLessThan(365.5);
      expect(notBefore).toBeGreaterThanOrEqual(before - 1000);
      expect(notBefore).toBeLessThanOrEqual(after + 1000);
    });

    it('accepts short validity (e.g. 7 days for short-lived rotations)', async () => {
      const result = await generateClientCert({
        commonName: 'short',
        validityDays: 7,
        caCertPem,
        caKeyPem,
      });
      const cert = new x509Lib.X509Certificate(result.certPem);
      const spanDays = (cert.notAfter.getTime() - cert.notBefore.getTime()) / (1000 * 60 * 60 * 24);
      expect(spanDays).toBeGreaterThan(6.5);
      expect(spanDays).toBeLessThan(7.5);
    });

    it('rejects non-integer validityDays', async () => {
      await expect(generateClientCert({
        commonName: 'x',
        validityDays: 1.5,
        caCertPem,
        caKeyPem,
      })).rejects.toThrow(AgentCertError);
    });

    it('rejects zero or negative validityDays', async () => {
      await expect(generateClientCert({
        commonName: 'x',
        validityDays: 0,
        caCertPem,
        caKeyPem,
      })).rejects.toThrow(/positive/);
      await expect(generateClientCert({
        commonName: 'x',
        validityDays: -5,
        caCertPem,
        caKeyPem,
      })).rejects.toThrow(/positive/);
    });

    it('cert is signed by the CA (issuer matches CA subject)', async () => {
      const result = await generateClientCert({
        commonName: 'routing-action',
        validityDays: 365,
        caCertPem,
        caKeyPem,
      });
      const caCert = new x509Lib.X509Certificate(caCertPem);
      const cert = new x509Lib.X509Certificate(result.certPem);
      expect(cert.issuer).toBe(caCert.subject);
    });

    it('cert has clientAuth ExtendedKeyUsage (TLS-client-auth only)', async () => {
      const result = await generateClientCert({
        commonName: 'routing-action',
        validityDays: 365,
        caCertPem,
        caKeyPem,
      });
      const cert = new x509Lib.X509Certificate(result.certPem);
      const ekuExt = cert.getExtension('2.5.29.37'); // extKeyUsage OID
      expect(ekuExt).toBeDefined();
      // The extension value should include the clientAuth OID.
      // Peculiar's ExtendedKeyUsageExtension exposes .usages as string[]
      const usages = (ekuExt as unknown as { usages: readonly string[] }).usages;
      expect(usages).toContain('1.3.6.1.5.5.7.3.2');
    });

    it('does NOT add Subject Alternative Name (client cert, no hostname)', async () => {
      const result = await generateClientCert({
        commonName: 'routing-action',
        validityDays: 365,
        caCertPem,
        caKeyPem,
      });
      const cert = new x509Lib.X509Certificate(result.certPem);
      const san = cert.getExtension('2.5.29.17'); // subjectAltName OID
      expect(san).toBeFalsy();
    });
  });
});
