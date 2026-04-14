import 'reflect-metadata';
import * as x509 from '@peculiar/x509';
import { webcrypto } from 'node:crypto';

// Set Node.js WebCrypto as the provider for @peculiar/x509
// webcrypto satisfies the Crypto interface at runtime but TypeScript
// doesn't include DOM types in our Node-only tsconfig.
x509.cryptoProvider.set(webcrypto as any);

export const RSA_ALGORITHM = {
  name: 'RSASSA-PKCS1-v1_5',
  hash: 'SHA-256',
  publicExponent: new Uint8Array([1, 0, 1]),
  modulusLength: 2048,
} as const;

export const CA_CERT_VALIDITY_YEARS = 5;
export const AGENT_CERT_VALIDITY_YEARS = 1;

export { x509 };
export { webcrypto };
