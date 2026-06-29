#!/usr/bin/env bash
#
# bootstrap-exchange-manifest.sh — exchange a GitHub App-manifest `code` for the
# created App's credentials (DR-035 §3 — the one genuinely GUI-only step).
#
# The skill drives the manifest flow in the operator's Chrome (submit the
# manifest form → click "Create GitHub App" → GitHub redirects to the manifest
# `redirect_url` carrying a temporary `?code=<...>`). The skill reads that `code`
# from the post-redirect URL via the chrome-devtools MCP, then calls THIS script
# to redeem it. No callback server is needed — the redirect URL is read directly.
#
# Per GitHub: POST /app-manifests/{code}/conversions returns the App's id,
# client_id, client_secret, webhook_secret, and the PRIVATE KEY (pem) — so the
# key is captured straight into the vault, never manually downloaded (DR-035 §5).
#
# Usage:
#   bootstrap-exchange-manifest.sh <code> [--out <file>]
#
#   <code>      the temporary manifest code from the redirect URL (REQUIRED)
#   --out FILE  also write the normalized JSON to FILE (0600). Default: stdout.
#
# Output (stdout, and --out): normalized JSON with the fields the vault needs:
#   { app_id, name, slug, client_id, client_secret, webhook_secret, pem }
#
# Fails LOUD (exit non-zero, message on stderr) on a missing code or any non-2xx
# from the conversions endpoint — the key never silently goes missing.
#
# Refs: DR-035 §3/§5; GitHub "Creating a GitHub App from a manifest".
set -euo pipefail

CODE=""
OUT=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --out) OUT="${2:-}"; shift 2 ;;
    --out=*) OUT="${1#*=}"; shift ;;
    -*) echo "FATAL: unknown flag: $1" >&2; exit 2 ;;
    *)
      if [[ -z "$CODE" ]]; then CODE="$1"; shift
      else echo "FATAL: unexpected extra argument: $1" >&2; exit 2; fi
      ;;
  esac
done

if [[ -z "$CODE" ]]; then
  cat >&2 <<'ERR'
FATAL: no manifest code given.

Usage: bootstrap-exchange-manifest.sh <code> [--out <file>]

The <code> is the temporary value in the post-"Create GitHub App" redirect URL,
e.g. https://example.com/redirect?code=abc123  →  abc123. Read it from the
browser via the chrome-devtools MCP (evaluate_script: () => window.location.href).
ERR
  exit 2
fi

if ! command -v gh >/dev/null 2>&1; then
  echo "FATAL: gh CLI not found on PATH." >&2
  exit 1
fi

# gh api exits non-zero on HTTP >= 400 and prints the error to stderr; capture
# both so we can fail loud with the GitHub error body attached.
err_file="$(mktemp)"
trap 'rm -f "$err_file"' EXIT
if ! resp="$(gh api --method POST "/app-manifests/${CODE}/conversions" 2>"$err_file")"; then
  echo "FATAL: App manifest exchange failed for code '${CODE}'." >&2
  echo "  A manifest code is single-use and short-lived (~1h) — if it was already" >&2
  echo "  redeemed or expired, re-run the manifest flow to mint a fresh code." >&2
  echo "  GitHub said:" >&2
  sed 's/^/    /' "$err_file" >&2
  exit 1
fi

# Normalize to exactly the fields the vault consumes. `// ""` keeps a missing
# field as an empty STRING (never collapses the object — a `// empty` value would
# make jq emit nothing for the whole object when any field is absent). `.id` comes
# back as a JSON number, so stringify it for consistent downstream substitution.
# Drop -e: invalid JSON makes jq exit non-zero (caught below); a valid-but-thin
# response yields empty fields that the explicit app_id/pem guards then catch.
normalized="$(jq '{
  app_id: (.id // "" | tostring),
  name: (.name // ""),
  slug: (.slug // ""),
  client_id: (.client_id // ""),
  client_secret: (.client_secret // ""),
  webhook_secret: (.webhook_secret // ""),
  pem: (.pem // "")
}' <<<"$resp")" || {
  echo "FATAL: conversions response did not parse as the expected JSON shape." >&2
  echo "  Raw response:" >&2
  sed 's/^/    /' <<<"$resp" >&2
  exit 1
}

# Assert the load-bearing fields are present — a 2xx with an empty app_id or pem
# would silently produce a useless vault entry (result-invariant, Pattern A).
app_id="$(jq -r '.app_id' <<<"$normalized")"
pem="$(jq -r '.pem' <<<"$normalized")"
if [[ -z "$app_id" || "$app_id" == "null" ]]; then
  echo "FATAL: exchange succeeded but returned no app_id." >&2
  exit 1
fi
if [[ -z "$pem" || "$pem" == "null" ]]; then
  echo "FATAL: exchange succeeded but returned no private key (pem)." >&2
  exit 1
fi

if [[ -n "$OUT" ]]; then
  ( umask 077; printf '%s\n' "$normalized" >"$OUT" )
  echo "Wrote App credentials to $OUT (0600)." >&2
fi
printf '%s\n' "$normalized"
