/**
 * Age-identity crypto-shredding — DR-043 Amendment G's explicit OPT-IN-ONLY
 * addendum to `macf fleet destroy` (groundnuty/macf#867). "Cryptographic
 * erasure": rather than hunting down every copy of `vault.age` that might
 * survive teardown (git history on a fork, a stale local clone, a backup —
 * enumerating them all is not tractable), destroy the ONE thing every copy
 * depends on to ever become plaintext again — the operator's age PRIVATE
 * KEY. Once that identity is gone, every surviving `vault.age` anywhere is
 * permanently ciphertext, with no path back.
 *
 * **"The single action with no recovery whatsoever"** (Amendment G's own
 * words) — this is why {@link realShredAgeIdentity} is NEVER wired into the
 * default `destroy` path unconditionally; a caller must pass BOTH
 * `--shred-age-key` AND `--age-identity <path>` explicitly
 * (`fleet-teardown-destructive.ts`'s `evaluateShredRequest`). Shredding this
 * key ALSO makes `deactivate`/`archive` non-revivable for THIS fleet's App
 * credentials specifically — those rungs' "free revival" property depends
 * on the vault still being decryptable by SOME surviving age identity
 * (DR-043 §D5) — so the UX must say this out loud in the confirmation
 * render, not bury it in a flag's one-line description.
 *
 * **Fail LOUD on a missing path — never silently "succeed."** An earlier
 * revision of this primitive no-op'd (returned normally, no throw) when
 * `identityPath` didn't exist, reasoning it was the idempotent-on-rerun
 * steady state (the same posture `realDeleteVariable`'s `'already-absent'`
 * / `realArchiveRepo`'s idempotent 200 have). That reasoning does NOT
 * transfer here: for a registry variable or a repo's archived bit,
 * "already gone" is unambiguously fine either way. For THIS action,
 * "path not found" is indistinguishable between (a) a prior successful
 * shred (fine) and (b) an operator typo pointing at the wrong file (NOT
 * fine — the real key is untouched somewhere else while the operator now
 * believes their fleet's vault is permanently ciphertext everywhere). In
 * practice (b) is also the ONLY reachable case through `destroy`'s own
 * command flow: `destroy` is terminal — a second invocation against the
 * same fleet refuses at the ownership gate (`absent` → "nothing to tear
 * down") before ever reaching the shred step, so there is no legitimate
 * "re-run after success" path that lands here with an absent file. Given
 * that, and given this is Amendment G's own "single action with no
 * recovery whatsoever," throwing is the conservative, correct default —
 * "report what could not be done, never exit green" applied to the one
 * primitive where "green" would mean "the operator now trusts a claim
 * that is impossible to verify after the fact."
 *
 * **Best-effort, not a forensic guarantee.** A single overwrite-then-unlink
 * does not defeat copy-on-write filesystems, SSD wear-leveling, filesystem
 * snapshots, or any earlier `cp`/backup of the identity file —
 * `check-before-propose.md`-honest about that: shredding the canonical path
 * removes the ordinary, easy-to-forget copy, and is a meaningfully safer
 * default than a plain `rm`, but it is NOT a substitute for full-disk
 * encryption or operator diligence about backups. The doc comment on the
 * CLI flag (`fleet-teardown-destructive.ts`) repeats this caveat so an
 * operator reading `--help` sees it too, not just this source file.
 */
import { accessSync, closeSync, constants as fsConstants, existsSync, fsyncSync, openSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

export type ShredAgeIdentityFn = (identityPath: string) => Promise<void>;

/**
 * Pre-flight readability check — same shape as `vault-read.ts`'s
 * `defaultAssertIdentityReadable`, deliberately duplicated rather than
 * imported (that one is scoped to the vault-decrypt path; this is a
 * SEPARATE call site with a separate, destroy-specific error message).
 * Called by `fleet-teardown-destructive.ts` BEFORE any mutation (registry
 * delete, repo delete) begins, so a bad `--age-identity` path refuses the
 * ENTIRE `destroy` run up front rather than deleting repositories and only
 * THEN discovering the shred can't proceed — see that module's doc for the
 * ordering rationale.
 */
export function assertAgeIdentityReadable(identityPath: string): void {
  try {
    accessSync(identityPath, fsConstants.R_OK);
  } catch {
    throw new Error(
      `age identity key not found or not readable at "${identityPath}" — --shred-age-key requires a valid, ` +
        'existing path via --age-identity. Refusing the ENTIRE destroy run rather than deleting repositories and ' +
        'only then failing the shred (see age-key-shred.ts for why an absent path is never treated as success).',
    );
  }
}

/**
 * Real shred: overwrite the file's existing byte-length with fresh random
 * bytes, fsync, then unlink. Throws if `identityPath` does not exist or
 * isn't readable — see module doc for why this is fail-loud, not
 * idempotent-absorb. Callers MUST run {@link assertAgeIdentityReadable} as
 * a pre-flight check before committing to the rest of a `destroy` run;
 * this function re-checks anyway (defense in depth against a TOCTOU gap
 * between the pre-flight check and this call) rather than trusting the
 * caller unconditionally.
 */
export async function realShredAgeIdentity(identityPath: string): Promise<void> {
  if (!existsSync(identityPath)) {
    throw new Error(
      `age identity not found at "${identityPath}" — nothing was shredded. This path should have been validated ` +
        'pre-flight; seeing this means the file vanished between the pre-flight check and this call, or the ' +
        'pre-flight check was skipped.',
    );
  }
  const size = statSync(identityPath).size;
  const fd = openSync(identityPath, 'r+');
  try {
    writeSync(fd, randomBytes(size), 0);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  unlinkSync(identityPath);
}
