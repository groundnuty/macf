/**
 * Generate self-signed test certificates for mTLS testing.
 * Used by integration and HTTPS tests.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export interface TestCerts {
  readonly dir: string;
  readonly caCert: string;
  readonly caKey: string;
  readonly agentCert: string;
  readonly agentKey: string;
  readonly untrustedCert: string;
  readonly untrustedKey: string;
}

export function generateTestCerts(): TestCerts {
  const dir = join(tmpdir(), `macf-test-certs-${Date.now()}`);
  mkdirSync(dir, { recursive: true });

  const caCert = join(dir, 'ca-cert.pem');
  const caKey = join(dir, 'ca-key.pem');
  const agentCert = join(dir, 'agent-cert.pem');
  const agentKey = join(dir, 'agent-key.pem');
  const agentCsr = join(dir, 'agent.csr');
  const agentExt = join(dir, 'agent-ext.cnf');
  const untrustedCert = join(dir, 'untrusted-cert.pem');
  const untrustedKey = join(dir, 'untrusted-key.pem');

  // Generate CA key and self-signed cert
  execFileSync('openssl', [
    'genrsa', '-out', caKey, '2048',
  ], { stdio: 'pipe' });
  execFileSync('openssl', [
    'req', '-x509', '-new', '-key', caKey, '-out', caCert,
    '-days', '1', '-subj', '/CN=test-ca',
  ], { stdio: 'pipe' });

  // Write SAN extension file for agent cert (needed for 127.0.0.1)
  writeFileSync(agentExt, [
    'subjectAltName=IP:127.0.0.1,DNS:localhost',
  ].join('\n'));

  // Generate agent key and CSR, sign with CA + SAN
  execFileSync('openssl', [
    'genrsa', '-out', agentKey, '2048',
  ], { stdio: 'pipe' });
  execFileSync('openssl', [
    'req', '-new', '-key', agentKey, '-out', agentCsr,
    '-subj', '/CN=code-agent',
  ], { stdio: 'pipe' });
  execFileSync('openssl', [
    'x509', '-req', '-in', agentCsr, '-CA', caCert, '-CAkey', caKey,
    '-CAcreateserial', '-out', agentCert, '-days', '1',
    '-extfile', agentExt,
  ], { stdio: 'pipe' });

  // Generate untrusted cert (self-signed, not from our CA)
  execFileSync('openssl', [
    'genrsa', '-out', untrustedKey, '2048',
  ], { stdio: 'pipe' });
  execFileSync('openssl', [
    'req', '-x509', '-new', '-key', untrustedKey, '-out', untrustedCert,
    '-days', '1', '-subj', '/CN=untrusted',
  ], { stdio: 'pipe' });

  return { dir, caCert, caKey, agentCert, agentKey, untrustedCert, untrustedKey };
}

export function cleanupTestCerts(certs: TestCerts): void {
  if (existsSync(certs.dir)) {
    rmSync(certs.dir, { recursive: true, force: true });
  }
}
