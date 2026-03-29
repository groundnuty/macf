# DR-011: CA Key Backup via Encrypted Variable

**Status:** Accepted
**Date:** 2026-03-28

## Context

The CA key is critical — if lost, no new certs can be issued, and existing certs can't be rotated. It lives on one machine. If that machine dies, the system collapses.

## Decision

Store the CA key encrypted with a user passphrase as a GitHub variable (readable, unlike secrets).

## How It Works

```bash
# Backup (during macf certs init):
openssl enc -aes-256-cbc -pbkdf2 -in ~/.macf/ca-key.pem | base64 | \
  gh api {registry}/actions/variables -X POST \
    -f name={PROJECT}_CA_KEY_ENCRYPTED -f value="$(cat -)"

# Recovery (on any machine):
gh api {registry}/actions/variables/{PROJECT}_CA_KEY_ENCRYPTED --jq '.value' | \
  base64 -d | openssl enc -aes-256-cbc -pbkdf2 -d -out ~/.macf/ca-key.pem
# Prompts for passphrase
```

## Options Considered

| Option | Survives VM loss | Readable | Security |
|---|---|---|---|
| CA key on one machine only | No | N/A | Simple but fragile |
| CA key on 2+ machines | Yes | N/A | More copies to protect |
| GitHub Secret (write-only) | Yes but can't read back | No | Usable only by Actions |
| **GitHub Variable (encrypted)** | **Yes, readable** | **Yes (but encrypted)** | **Passphrase in user's head** |
| Cloud KMS (AWS/GCP) | Yes | Via API | External dependency |

## Rationale

GitHub Variables are readable (unlike Secrets). The encryption makes the stored value useless without the passphrase. The passphrase lives in the user's head or password manager — not on GitHub, not on any machine.

Recovery: `macf certs recover` → downloads encrypted blob → prompts for passphrase → writes CA key to disk.

## Storage Layout

```
Registry variables:
  {PROJECT}_CA_CERT          = "-----BEGIN CERTIFICATE-----..." (plain, public)
  {PROJECT}_CA_KEY_ENCRYPTED = "<base64 of AES-256-CBC encrypted PEM>" (encrypted)
```
