# P3: Certificate Management

**Goal:** Automated mTLS certificate lifecycle — CA creation, agent cert signing, challenge-response auth, encrypted backup.

**Depends on:** P1 (HTTPS/mTLS), P2 (registry for challenge variables)
**Design decisions:** DR-004, DR-010, DR-011

---

## Deliverables

1. **CA initialization** — generate CA key + cert, upload cert to registry variable, encrypt key and upload as backup
2. **Agent cert generation** — generate key + CSR, sign with local CA key
3. **`/sign` endpoint** — remote cert signing with challenge-response auth
4. **CA recovery** — download encrypted CA key from registry, decrypt with passphrase
5. **Cert rotation** — regenerate agent cert with same CA

## `/sign` Endpoint (added to P1's HTTPS server)

#### POST /sign — Step 1: Request

```json
{ "csr": "-----BEGIN CERTIFICATE REQUEST-----...", "agent_name": "new-agent", "project": "macf" }
```

Response:
```json
{ "challenge_id": "abc123", "instruction": "Write MACF_CHALLENGE_new_agent = 'abc123' to org variables" }
```

#### POST /sign — Step 2: Verify

```json
{ "csr": "...", "agent_name": "new-agent", "challenge_done": true }
```

Signing agent reads `MACF_CHALLENGE_new_agent` from registry, verifies match, deletes challenge variable, signs CSR, returns cert:

```json
{ "cert": "-----BEGIN CERTIFICATE-----..." }
```

## CA Key Backup

```bash
# Encrypt and upload:
openssl enc -aes-256-cbc -pbkdf2 -in ~/.macf/ca-key.pem | base64 → MACF_CA_KEY_ENCRYPTED variable

# Recovery:
download variable → base64 decode → openssl decrypt (prompts for passphrase) → ~/.macf/ca-key.pem
```

## Tests

- CA init: generates valid CA cert + key
- Agent cert: signed by CA, valid CN
- Challenge-response: full flow with mock registry
- Encrypted backup: round-trip encrypt → upload → download → decrypt
- `/sign` rejects without valid challenge
- `/sign` deletes challenge after use (one-time)
