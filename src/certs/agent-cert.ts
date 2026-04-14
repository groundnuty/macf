import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import {
  x509, webcrypto, RSA_ALGORITHM, AGENT_CERT_VALIDITY_YEARS,
} from './crypto-provider.js';
import { MacfError } from '../errors.js';

export class AgentCertError extends MacfError {
  constructor(message: string) {
    super('AGENT_CERT_ERROR', message);
    this.name = 'AgentCertError';
  }
}

export interface AgentCertResult {
  readonly certPem: string;
  readonly keyPem: string;
}

function exportKeyToPem(exported: ArrayBuffer): string {
  const b64 = Buffer.from(exported).toString('base64');
  const lines = b64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN PRIVATE KEY-----\n${lines.join('\n')}\n-----END PRIVATE KEY-----\n`;
}

/**
 * Import a PEM private key into a WebCrypto CryptoKey for signing.
 */
// Returns a WebCrypto CryptoKey; typed as unknown since DOM types aren't in tsconfig
export async function importPrivateKey(keyPem: string): Promise<unknown> {
  const stripped = keyPem
    .replace(/-----BEGIN PRIVATE KEY-----/g, '')
    .replace(/-----END PRIVATE KEY-----/g, '')
    .replace(/\s/g, '');
  const der = Buffer.from(stripped, 'base64');

  return webcrypto.subtle.importKey(
    'pkcs8',
    der,
    RSA_ALGORITHM,
    false,
    ['sign'],
  );
}

/**
 * Generate agent certificate signed by the CA.
 * Used when the CA key is available locally.
 */
export async function generateAgentCert(config: {
  readonly agentName: string;
  readonly caCertPem: string;
  readonly caKeyPem: string;
  readonly certPath?: string;
  readonly keyPath?: string;
}): Promise<AgentCertResult> {
  const { agentName, caCertPem, caKeyPem, certPath, keyPath } = config;

  const caCert = new x509.X509Certificate(caCertPem);
  const caKey = await importPrivateKey(caKeyPem);

  const agentKeys = await webcrypto.subtle.generateKey(
    RSA_ALGORITHM,
    true,
    ['sign', 'verify'],
  );

  const notBefore = new Date();
  const notAfter = new Date();
  notAfter.setFullYear(notAfter.getFullYear() + AGENT_CERT_VALIDITY_YEARS);

  const cert = await x509.X509CertificateGenerator.create({
    serialNumber: randomBytes(8).toString('hex'),
    subject: `CN=${agentName}`,
    issuer: caCert.subject,
    notBefore,
    notAfter,
    signingAlgorithm: RSA_ALGORITHM,
    publicKey: agentKeys.publicKey,
    signingKey: caKey,
    extensions: [
      new x509.KeyUsagesExtension(
        x509.KeyUsageFlags.digitalSignature | x509.KeyUsageFlags.keyEncipherment,
        true,
      ),
      new x509.SubjectAlternativeNameExtension([
        { type: 'ip', value: '127.0.0.1' },
        { type: 'dns', value: 'localhost' },
      ]),
    ],
  });

  const certPem = cert.toString('pem');
  const exported = await webcrypto.subtle.exportKey('pkcs8', agentKeys.privateKey);
  const agentKeyPem = exportKeyToPem(exported);

  if (certPath) writeFileSync(certPath, certPem, { mode: 0o644 });
  if (keyPath) writeFileSync(keyPath, agentKeyPem, { mode: 0o600 });

  return { certPem, keyPem: agentKeyPem };
}

/**
 * Generate a CSR (Certificate Signing Request) for an agent.
 * Used when requesting remote signing via /sign endpoint.
 */
export async function generateCSR(agentName: string): Promise<{
  readonly csrPem: string;
  readonly keyPem: string;
}> {
  const keys = await webcrypto.subtle.generateKey(
    RSA_ALGORITHM,
    true,
    ['sign', 'verify'],
  );

  const csr = await x509.Pkcs10CertificateRequestGenerator.create({
    name: `CN=${agentName}`,
    keys,
    signingAlgorithm: RSA_ALGORITHM,
  });

  const exported = await webcrypto.subtle.exportKey('pkcs8', keys.privateKey);

  return {
    csrPem: csr.toString('pem'),
    keyPem: exportKeyToPem(exported),
  };
}

/**
 * Extract the CN from a subject string like "CN=code-agent".
 */
function extractCN(subject: string): string | undefined {
  const match = /CN=([^,]+)/i.exec(subject);
  return match?.[1]?.trim();
}

/**
 * Sign a CSR using the CA key. Validates CN match and CSR signature (proof-of-possession).
 */
export async function signCSR(config: {
  readonly csrPem: string;
  readonly agentName: string;
  readonly caCertPem: string;
  readonly caKeyPem: string;
}): Promise<string> {
  const { csrPem, agentName, caCertPem, caKeyPem } = config;

  const csr = new x509.Pkcs10CertificateRequest(csrPem);
  const caCert = new x509.X509Certificate(caCertPem);
  const caKey = await importPrivateKey(caKeyPem);

  // Verify CSR signature (proof-of-possession — requester controls the private key)
  const csrValid = await csr.verify();
  if (!csrValid) {
    throw new AgentCertError('CSR signature verification failed');
  }

  // Verify CN matches agent name
  const cn = extractCN(csr.subject);
  if (cn !== agentName) {
    throw new AgentCertError(
      `CSR CN "${cn}" does not match agent name "${agentName}"`,
    );
  }

  const notBefore = new Date();
  const notAfter = new Date();
  notAfter.setFullYear(notAfter.getFullYear() + AGENT_CERT_VALIDITY_YEARS);

  const cert = await x509.X509CertificateGenerator.create({
    serialNumber: randomBytes(8).toString('hex'),
    subject: csr.subject,
    issuer: caCert.subject,
    notBefore,
    notAfter,
    signingAlgorithm: RSA_ALGORITHM,
    publicKey: csr.publicKey,
    signingKey: caKey,
    extensions: [
      new x509.KeyUsagesExtension(
        x509.KeyUsageFlags.digitalSignature | x509.KeyUsageFlags.keyEncipherment,
        true,
      ),
      new x509.SubjectAlternativeNameExtension([
        { type: 'ip', value: '127.0.0.1' },
        { type: 'dns', value: 'localhost' },
      ]),
    ],
  });

  return cert.toString('pem');
}
