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
 *
 * Return type was `Promise<unknown>` historically — DOM CryptoKey types
 * weren't exposed via @types/node < v25. Since @types/node v25 (#17 /
 * this PR) CryptoKey is resolvable from `globalThis`, so we can return
 * the precise type instead of laundering through `unknown` at each
 * call site.
 */
export async function importPrivateKey(keyPem: string): Promise<CryptoKey> {
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
      // clientAuth EKU (#125, step 1 of DR-004 v2 EKU rollout). Peer
      // certs are the mTLS client when calling peer /health, /notify,
      // /sign — pair them with the server-side /notify EKU check
      // landing in #121 after rotation. New peer certs carry the EKU
      // immediately; existing peers adopt it on `macf certs rotate`.
      new x509.ExtendedKeyUsageExtension([
        '1.3.6.1.5.5.7.3.2',
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
 * Generate a CA-signed client cert with a given CN and validity window.
 * Used for non-peer clients (e.g. the routing Action's mTLS cert, per
 * macf-actions#8 / #119). Unlike generateAgentCert, validity is
 * parameterized in days so operator can pick the policy.
 *
 * Does NOT add SubjectAlternativeName — the routing Action is an
 * mTLS CLIENT, so the server-hostname SAN pattern doesn't apply. Key
 * usage is digital signature only (no key encipherment — we're not
 * doing static-key TLS variants).
 */
export async function generateClientCert(config: {
  readonly commonName: string;
  readonly validityDays: number;
  readonly caCertPem: string;
  readonly caKeyPem: string;
}): Promise<AgentCertResult> {
  const { commonName, validityDays, caCertPem, caKeyPem } = config;

  if (!Number.isInteger(validityDays) || validityDays < 1) {
    throw new AgentCertError(
      `validityDays must be a positive integer (got ${validityDays})`,
    );
  }

  const caCert = new x509.X509Certificate(caCertPem);
  const caKey = await importPrivateKey(caKeyPem);

  const clientKeys = await webcrypto.subtle.generateKey(
    RSA_ALGORITHM,
    true,
    ['sign', 'verify'],
  );

  const notBefore = new Date();
  const notAfter = new Date();
  notAfter.setDate(notAfter.getDate() + validityDays);

  const cert = await x509.X509CertificateGenerator.create({
    serialNumber: randomBytes(8).toString('hex'),
    subject: `CN=${commonName}`,
    issuer: caCert.subject,
    notBefore,
    notAfter,
    signingAlgorithm: RSA_ALGORITHM,
    publicKey: clientKeys.publicKey,
    signingKey: caKey,
    extensions: [
      new x509.KeyUsagesExtension(
        x509.KeyUsageFlags.digitalSignature,
        true,
      ),
      new x509.ExtendedKeyUsageExtension([
        // clientAuth OID — explicit "this cert is for TLS client auth"
        '1.3.6.1.5.5.7.3.2',
      ]),
    ],
  });

  const certPem = cert.toString('pem');
  const exported = await webcrypto.subtle.exportKey('pkcs8', clientKeys.privateKey);
  const keyPem = exportKeyToPem(exported);

  return { certPem, keyPem };
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
 * Extract the CN from a subject string like "CN=code-agent" or
 * "O=foo,CN=code-agent,OU=bar".
 *
 * Returns undefined if the subject contains ZERO or MULTIPLE CN fields.
 * A multi-CN subject ("CN=attacker,CN=victim") is explicitly rejected
 * — signCSR surfaces a specific error so the confused-deputy attack
 * can't slip through the agent-name equality check. See #89.
 *
 * Exported for unit tests.
 */
export function extractCN(subject: string): string | undefined {
  const matches = subject.match(/(?:^|,\s*)CN=([^,]+)/gi);
  if (!matches || matches.length !== 1) return undefined;
  const inner = /CN=([^,]+)/i.exec(matches[0]);
  return inner?.[1]?.trim();
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

  // Verify CN matches agent name. extractCN returns undefined when the
  // subject has zero OR multiple CN fields — surface that specifically
  // so operators see "subject malformed" rather than "CN undefined does
  // not match ..." (see #89).
  const cn = extractCN(csr.subject);
  if (cn === undefined) {
    throw new AgentCertError(
      `CSR subject must contain exactly one CN field (got: "${csr.subject}")`,
    );
  }
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
      // clientAuth EKU — same rationale as generateAgentCert above.
      // CSR-signed peer certs (via /sign endpoint) must also carry
      // the EKU so they work once #121 tightens server-side
      // verification. (#125, step 1 of DR-004 v2 EKU rollout)
      new x509.ExtendedKeyUsageExtension([
        '1.3.6.1.5.5.7.3.2',
      ]),
    ],
  });

  return cert.toString('pem');
}
