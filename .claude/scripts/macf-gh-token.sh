#!/usr/bin/env bash
# Generate a fresh GitHub App installation token and emit it on stdout.
#
# Designed to fail LOUD — not fall back silently to `gh auth login` as the
# user, which is what happens with the naive `$(gh token generate | jq)`
# pattern when `gh token generate` fails (pipefail unset by default, so
# jq's success masks gh's failure and GH_TOKEN ends up as "null").
#
# Callers should use `TOKEN=$(./.claude/scripts/macf-gh-token.sh ...) || exit 1`
# or similar — on any failure this script writes the error reason to stderr
# and exits non-zero, and prints NOTHING to stdout.
#
# Usage:
#   macf-gh-token.sh --app-id <id> --install-id <id> --key <path> [--hostname <host>]
#
# On success: the installation token (starts with `ghs_`) is printed on
# stdout with a trailing newline.
# On failure: error goes to stderr, exit status is non-zero, stdout is empty.

set -euo pipefail

usage() {
  cat <<USAGE >&2
Usage: $0 --app-id <id> --install-id <id> --key <path> [--hostname <host>]

Required:
  --app-id <id>        GitHub App ID
  --install-id <id>    GitHub App installation ID
  --key <path>         Path to the App private key (.pem)

Optional:
  --hostname <host>    GitHub Enterprise hostname (default: api.github.com)

On success the installation token (ghs_*) is printed to stdout.
On failure, error details go to stderr and exit is non-zero.
USAGE
}

app_id=""
install_id=""
key_path=""
hostname=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --app-id)     app_id="${2:?--app-id requires value}";     shift 2 ;;
    --install-id) install_id="${2:?--install-id requires value}"; shift 2 ;;
    --key)        key_path="${2:?--key requires value}";      shift 2 ;;
    --hostname)   hostname="${2:?--hostname requires value}"; shift 2 ;;
    -h|--help)    usage; exit 0 ;;
    *)            echo "Error: unknown argument: $1" >&2; usage; exit 2 ;;
  esac
done

missing=()
[ -z "$app_id" ]     && missing+=(--app-id)
[ -z "$install_id" ] && missing+=(--install-id)
[ -z "$key_path" ]   && missing+=(--key)
if [ "${#missing[@]}" -gt 0 ]; then
  echo "Error: missing required flag(s): ${missing[*]}" >&2
  usage
  exit 2
fi

if [ ! -f "$key_path" ]; then
  echo "Error: key file not found: $key_path" >&2
  echo "Hint: check that KEY_PATH in .claude/settings.local.json points at a valid .pem file." >&2
  exit 1
fi

# Capture stderr so we can grep for known failure patterns and add
# diagnostic hints, but keep it available to re-emit to the user.
err_file="$(mktemp -t macf-gh-token-err.XXXXXX)"
trap 'rm -f "$err_file"' EXIT

gh_args=(gh token generate
  --app-id "$app_id"
  --installation-id "$install_id"
  --key "$key_path"
  --token-only
)
[ -n "$hostname" ] && gh_args+=(--hostname "$hostname")

# Intentionally NOT piping through `jq` — --token-only gives us the bare
# token, so we don't need to parse JSON, and we avoid the `$(gh | jq)`
# exit-status-masking trap that started this whole issue.
if ! token="$("${gh_args[@]}" 2>"$err_file")"; then
  echo "Error: gh token generate failed." >&2
  if [ -s "$err_file" ]; then
    echo "--- gh token generate stderr ---" >&2
    cat "$err_file" >&2
    echo "--------------------------------" >&2
  fi

  # Hint the most common causes we've observed.
  if grep -qi "JWT could not be decoded\|JWT" "$err_file" 2>/dev/null; then
    echo "" >&2
    echo "Hint: 'JWT could not be decoded' typically indicates **clock drift** on this host." >&2
    echo "  Check:  timedatectl status        (expect: System clock synchronized: yes)" >&2
    echo "          chronyc tracking          (expect: Leap status: Normal, small offset)" >&2
  elif grep -qi "unable to read key" "$err_file" 2>/dev/null; then
    echo "" >&2
    echo "Hint: key file unreadable. Verify file permissions (should be user-readable)." >&2
  elif grep -qi "unable to parse key\|PEM.*RSA" "$err_file" 2>/dev/null; then
    echo "" >&2
    echo "Hint: key file is not a valid PEM RSA key, or it does not match the App's registered key." >&2
    echo "  Compare your local key fingerprint to the App settings page on GitHub:" >&2
    echo "    openssl rsa -in \"$key_path\" -pubout -outform DER 2>/dev/null | openssl dgst -sha256" >&2
    echo "    (then check GitHub → App settings → Private keys → SHA256 fingerprint)" >&2
  elif grep -qi "404\|Not Found" "$err_file" 2>/dev/null; then
    echo "" >&2
    echo "Hint: App or installation not found. Verify --app-id and --install-id." >&2
  fi
  exit 1
fi

# Sanity-check the result. Installation tokens start with ghs_. Anything
# else (ghp_ user PAT, gho_ OAuth, empty string) would be a footgun.
token_prefix="${token:0:4}"
if [ -z "$token" ]; then
  echo "Error: gh token generate succeeded but returned an empty token." >&2
  exit 1
fi
if [ "$token_prefix" != "ghs_" ]; then
  echo "Error: generated token has prefix '${token_prefix}' — expected 'ghs_' (installation token)." >&2
  echo "  Refusing to emit a non-installation token to avoid mis-attribution." >&2
  exit 1
fi

printf '%s\n' "$token"
