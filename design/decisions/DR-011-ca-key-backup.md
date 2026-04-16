# DR-011: CA Key Backup via Encrypted Variable

**Status:** Accepted
**Date:** 2026-03-28
**Revised:** 2026-04-16 (v2 wire format — PBKDF2 iter count 10k → 600k per OWASP 2023; JSON envelope with explicit version field)

## Context

The CA key is critical — if lost, no new certs can be issued, and existing certs can't be rotated. It lives on one machine. If that machine dies, the system collapses.

## Decision

Store the CA key encrypted with a user passphrase as a GitHub variable (readable, unlike secrets).

## Wire Format

Two versions of the on-wire format exist. `decryptCAKey` reads both; `encryptCAKey` writes v2 going forward.

### v2 (current, 2026-04-16+)

Registry variable value is a JSON envelope:

```json
{
  "v": 2,
  "iter": 600000,
  "payload": "<base64 of OpenSSL Salted__ blob>"
}
```

The `payload` field is the same `Salted__` + salt + AES-256-CBC ciphertext base64 produced by `openssl enc -aes-256-cbc -pbkdf2`. The envelope makes the iteration count explicit and self-documenting, and provides a forward-compatible version field for future crypto revisions without re-breaking the wire format.

### v1 (legacy, pre-2026-04-16)

Registry variable value is the raw base64 `Salted__` blob (no JSON envelope). Iteration count is implicitly 10000 (OpenSSL 3.0/3.1 default at the time).

`decryptCAKey` detects v1 vs v2 by JSON shape: if the decoded value parses as JSON with a `v` field, it's v2; otherwise it's v1.

## How It Works

### Backup (during `macf certs init`)

`encryptCAKey` computes:

1. 8 random bytes salt
2. PBKDF2-SHA256(passphrase, salt, **600000 iters**, 48 bytes) → 32-byte key + 16-byte IV
3. AES-256-CBC encrypt the CA key PEM with PKCS7 padding
4. Prepend `Salted__` + salt → base64 → this is the `payload`
5. Wrap as `{"v": 2, "iter": 600000, "payload": "<base64>"}`
6. Write envelope as `{PROJECT}_CA_KEY_ENCRYPTED` registry variable

### Recovery via `macf certs recover` (automatic)

`macf certs recover` handles both v1 and v2 automatically — dispatches on JSON-envelope presence, uses the iter count from the envelope (v2) or the legacy 10k default (v1). Users never interact with the version distinction.

### Recovery via OpenSSL CLI (manual, disaster-recovery path)

The whole point of this DR is that operators can recover the key without MACF itself, given only `gh` + `openssl` + the passphrase.

**v2 (current):**

```bash
gh api {registry}/actions/variables/{PROJECT}_CA_KEY_ENCRYPTED --jq '.value' | \
  jq -r .payload | \
  base64 -d | \
  openssl enc -aes-256-cbc -pbkdf2 -md sha256 -iter 600000 -d -out ca-key.pem
# Prompts for passphrase
```

If `jq` isn't available, substitute `python3` for the `.payload` extraction:

```bash
gh api {registry}/actions/variables/{PROJECT}_CA_KEY_ENCRYPTED --jq '.value' | \
  python3 -c 'import json,sys; print(json.loads(sys.stdin.read())["payload"])' | \
  base64 -d | \
  openssl enc -aes-256-cbc -pbkdf2 -md sha256 -iter 600000 -d -out ca-key.pem
```

**v1 (legacy backups only, pre-2026-04-16):**

```bash
gh api {registry}/actions/variables/{PROJECT}_CA_KEY_ENCRYPTED --jq '.value' | \
  base64 -d | \
  openssl enc -aes-256-cbc -pbkdf2 -md sha256 -iter 10000 -d -out ca-key.pem
```

No `jq` unwrap step for v1 because the value is not JSON-wrapped.

## Migration (v1 → v2)

`macf update` auto-migrates legacy v1 backups to v2:

1. Read `{PROJECT}_CA_KEY_ENCRYPTED` from the registry
2. Detect format: JSON envelope (v2) or raw base64 (v1)
3. If v1, emit:
   ```
   Migrating CA key encryption: v1/iter=10000 → v2/iter=600000 for project {PROJECT}.
   This is a one-time passphrase prompt for this project; subsequent `macf update`
   runs in this or any other workspace for the same project won't re-prompt.
   Enter CA key passphrase:
   ```

   The migration is per-project (per-registry-variable), not per-workspace —
   multi-workspace projects (e.g. multiple agents sharing one project registry)
   see a single prompt on whichever workspace runs `macf update` first.
4. Prompt for passphrase, decrypt at v1/10k, re-encrypt at v2/600k
5. Write the new JSON envelope back to the registry

The migration is one-time per workspace and idempotent — re-running `macf update` on an already-v2 workspace is a no-op. Workspaces that never run `macf update` keep their v1 blob and their `decryptCAKey` path continues to work via the v1 read-compat branch.

## Iter Count Rationale

- OWASP 2023 recommends **≥600,000 iterations** for PBKDF2-SHA256
- OpenSSL 3.2+ defaults to 600,000 iterations for `openssl enc -pbkdf2`
- Pre-revision MACF used 10,000 (matching OpenSSL 3.0/3.1 defaults in 2026-03); 60× below 2023 guidance
- Bumping to 600k raises the brute-force cost floor for the "leaked envelope + weak passphrase" attack path, matching 2023 hardening norms

The registry variable itself requires repo-write access to read, so this is not a plaintext-exposure fix; it's a defense-in-depth hardening for the case where the encrypted blob leaks AND the passphrase is weaker than recommended.

## Options Considered (from original 2026-03-28 decision)

| Option | Survives VM loss | Readable | Security |
|---|---|---|---|
| CA key on one machine only | No | N/A | Simple but fragile |
| CA key on 2+ machines | Yes | N/A | More copies to protect |
| GitHub Secret (write-only) | Yes but can't read back | No | Usable only by Actions |
| **GitHub Variable (encrypted)** | **Yes, readable** | **Yes (but encrypted)** | **Passphrase in user's head** |
| Cloud KMS (AWS/GCP) | Yes | Via API | External dependency |

GitHub Variables are readable (unlike Secrets). The encryption makes the stored value useless without the passphrase. The passphrase lives in the user's head or password manager — not on GitHub, not on any machine.

## Wire Format Revision Alternatives Considered (2026-04-16)

When bumping iter count, three paths were evaluated:

1. **Try-600k-then-10k fallback in `decryptCAKey`.** Minimal code change, OpenSSL CLI interop unchanged. Rejected — hot-path overhead (two PBKDF2 derivations on every wrong passphrase), weak timing signal, and no forcing function for migration (eternal legacy debt: every v1 workspace keeps its 10k encryption forever unless manually rotated).
2. **Iter marker prepended inside the `Salted__` envelope** (custom 4-byte prefix before the ciphertext). Rejected — breaks OpenSSL CLI interop, which is the core value proposition of this DR. Operators doing manual `openssl enc -d` would need to strip custom header bytes, making the disaster-recovery path hostile.
3. **Versioned JSON envelope + `macf update` auto-migrate** (chosen). Deterministic iter lookup with no try-both overhead. Preserves OpenSSL CLI interop modulo a `jq -r .payload` unwrap step (discoverable from this doc; `python3` fallback for `jq`-less environments). The `macf update` migration provides a forcing function so legacy workspaces self-upgrade when they take any normal update action, rather than stuck at 10k forever.

See issue #112 for the full discussion including eternal-debt analysis and ergonomic-cost weighing.

## Storage Layout

```
Registry variables:
  {PROJECT}_CA_CERT          = "-----BEGIN CERTIFICATE-----..." (plain, public)
  {PROJECT}_CA_KEY_ENCRYPTED = '{"v":2,"iter":600000,"payload":"<base64>"}' (v2, current)
                             | "<raw base64 Salted__ blob>"                  (v1, legacy read-compat)
```

## Future Work

- **Non-interactive migration** for CI/scripted workflows: `macf certs migrate-iter --passphrase-file=<path>`. File as a follow-up if operator demand surfaces; narrow surface, interactive-only is fine for v1 of the migration.
- **Periodic iter-count review** every 2 years (aligning with OWASP cadence). Revisit and bump again if recommendations have moved. The JSON envelope's `v` field makes future revisions forward-compatible without another wire-format break.

## Revision History

- **2026-03-28 (v1)** — Initial decision: AES-256-CBC + PBKDF2-SHA256 10k iters, OpenSSL-compatible raw base64 blob.
- **2026-04-16 (v2)** — Bumped to PBKDF2-SHA256 600k iters (OWASP 2023 alignment). Wire format versioned via JSON envelope to enable forward-compatibility and `macf update` auto-migration. Issue #112.
