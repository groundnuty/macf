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
 * PR #130) CryptoKey is resolvable from `globalThis`, so we return
 * the precise type instead of laundering through `unknown` at each
 * call site.
 *
 * Rejects input that contains zero or multiple BEGIN/END marker pairs
 * (e.g. two keys accidentally concatenated) — ultrareview finding H4.
 * Without this shape check, `webcrypto.subtle.importKey` would be
 * handed a concatenated base64 blob and throw a generic DataError,
 * which propagates upstream with no hint that the input file itself
 * was malformed.
 */
export async function importPrivateKey(keyPem: string): Promise<CryptoKey> {
  const beginMatches = keyPem.match(/-----BEGIN PRIVATE KEY-----/g);
  const endMatches = keyPem.match(/-----END PRIVATE KEY-----/g);
  if (!beginMatches || beginMatches.length !== 1) {
    throw new AgentCertError(
      `Malformed private key PEM: expected exactly one BEGIN marker, got ${beginMatches?.length ?? 0}`,
    );
  }
  if (!endMatches || endMatches.length !== 1) {
    throw new AgentCertError(
      `Malformed private key PEM: expected exactly one END marker, got ${endMatches?.length ?? 0}`,
    );
  }

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
 * Shared peer-cert builder used by both generateAgentCert (new peer
 * certs via `macf certs init`) and signCSR (CSR-signed peer certs
 * via `/sign`). Produces the DR-004-compliant extension set:
 *
 *   - KeyUsage: digitalSignature | keyEncipherment (mTLS client+server use)
 *   - SubjectAlternativeName: 127.0.0.1 / localhost (per DR-004; SAN
 *       across Tailscale hosts is a known follow-up per `phase2 backlog`)
 *   - ExtendedKeyUsage: clientAuth (#125, DR-004 v2 EKU rollout)
 *
 * Extracted per ultrareview finding A10 — both callers previously
 * duplicated this ~25-line extension list. When DR-004 extensions
 * evolve (e.g. serverAuth EKU, per-host SAN), a single edit here
 * affects both paths instead of two in lockstep.
 */
async function buildPeerCert(opts: {
  readonly subject: string;
  readonly caCertPem: string;
  readonly caKeyPem: string;
  // Accept either a plain WebCrypto CryptoKey (from generateAgentCert)
  // or x509.PublicKey (from a parsed CSR's .publicKey) — the peculiar
  // x509 generator internally accepts both via its overloaded type.
  readonly publicKey: CryptoKey | x509.PublicKey;
}): Promise<string> {
  const caCert = new x509.X509Certificate(opts.caCertPem);
  const caKey = await importPrivateKey(opts.caKeyPem);

  const notBefore = new Date();
  const notAfter = new Date();
  notAfter.setFullYear(notAfter.getFullYear() + AGENT_CERT_VALIDITY_YEARS);

  const cert = await x509.X509CertificateGenerator.create({
    serialNumber: randomBytes(8).toString('hex'),
    subject: opts.subject,
    issuer: caCert.subject,
    notBefore,
    notAfter,
    signingAlgorithm: RSA_ALGORITHM,
    publicKey: opts.publicKey,
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
      new x509.ExtendedKeyUsageExtension([
        // clientAuth OID (#125) — per DR-004 v2 EKU rollout. Enforced
        // server-side at /health + /notify + /sign per #121.
        '1.3.6.1.5.5.7.3.2',
      ]),
    ],
  });

  return cert.toString('pem');
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

  const agentKeys = await webcrypto.subtle.generateKey(
    RSA_ALGORITHM,
    true,
    ['sign', 'verify'],
  );

  const certPem = await buildPeerCert({
    subject: `CN=${agentName}`,
    caCertPem,
    caKeyPem,
    publicKey: agentKeys.publicKey,
  });
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

  return buildPeerCert({
    subject: csr.subject,
    caCertPem,
    caKeyPem,
    publicKey: csr.publicKey,
  });
}
