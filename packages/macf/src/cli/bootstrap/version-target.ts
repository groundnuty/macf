/**
 * DR-043 Amendment L (groundnuty/macf#1045) — the fleet-upgrade TARGET
 * resolution rule, shared between `macf fleet upgrade` (standalone CLI,
 * `commands/fleet-upgrade.ts`) and `macf bootstrap apply`'s version-reconcile
 * phase (`bootstrap/apply-version.ts`). Pure — no I/O beyond the injected
 * `fetchLatest`.
 *
 * **The rule, precisely (Amendment L2):**
 *
 * 1. An explicit `--target` always wins — it is an out-of-manifest override,
 *    regardless of whether a manifest was given at all.
 * 2. Otherwise, when a manifest WAS given (`ManifestVersionInput.given`) and
 *    it declares `versions.macf`, THAT is the target — `versions:` is
 *    AUTHORITATIVE (L2.3). `fetchLatest` is never called on this path — the
 *    load-bearing assertion (L3): a manifest whose target still depends on
 *    npm's CURRENT `dist-tag` is not a manifest (the `:latest` anti-pattern
 *    this amendment closes).
 * 3. Otherwise, when a manifest WAS given but declares NO `versions:` at
 *    all, that is "no opinion" (L2.4) — NOT a silent fall-through to
 *    npm-latest. `fetchLatest` is never called on this path either.
 * 4. Only when NO manifest was given at all (the standalone `macf fleet
 *    upgrade` direct-verb call, no `-f/--file` — L2.5) does npm-latest
 *    remain the default target — this is the ONLY reachable `fetchLatest`
 *    path, preserving `fleet upgrade`'s pre-existing standalone behaviour
 *    byte-for-byte.
 *
 * `resolveTargetVersion` is pure w.r.t. `fetchLatest` (never mutates,
 * timer-free) — the seam Amendment L3 names as costless to assert against:
 * a test can inject a `fetchLatest` that THROWS if called and prove the
 * network path was structurally never entered, not merely that the right
 * target happened to win (`assert-the-wrong-path.md`).
 */

/**
 * Whether a fleet manifest (`-f/--file <fleet.yaml>`) was given at all, and
 * if so, its declared `versions.macf` (`undefined` when the manifest omits
 * `versions:` entirely — see {@link resolveTargetVersion}'s L2.4 branch).
 * `given: false` carries no `macf` field — there is no manifest to have
 * declared one.
 */
export type ManifestVersionInput =
  | { readonly given: false }
  | { readonly given: true; readonly macf: string | undefined };

/** `NO_MANIFEST` — the standalone-CLI default when `-f/--file` was never passed. Exported so callers don't hand-roll `{ given: false }` at every call site. */
export const NO_MANIFEST_VERSION: ManifestVersionInput = { given: false };

export type TargetResolution =
  | { readonly kind: 'resolved'; readonly target: string }
  /** DR-043 Amendment L2.4 — a manifest was given but declared no `versions:`; NOT an error, nothing to reconcile. */
  | { readonly kind: 'no-opinion'; readonly message: string }
  | { readonly kind: 'error'; readonly message: string };

/**
 * Choose the target version per Amendment L2's ordering above. `explicit` is
 * `--target` (leading `v` stripped); `manifestVersion` is the manifest's
 * declared state (or "no manifest given" — see {@link ManifestVersionInput});
 * `fetchLatest` is the npm-latest resolver, invoked ONLY on the L2.5
 * no-manifest-at-all path.
 */
export async function resolveTargetVersion(
  explicit: string | undefined,
  manifestVersion: ManifestVersionInput,
  fetchLatest: () => Promise<string | null>,
): Promise<TargetResolution> {
  if (explicit && explicit.trim().length > 0) {
    return { kind: 'resolved', target: explicit.trim().replace(/^v/, '') };
  }
  if (manifestVersion.given) {
    // L2.3 — versions: is AUTHORITATIVE when present. Never touches
    // `fetchLatest` — the assertion Amendment L3 names as load-bearing.
    if (manifestVersion.macf !== undefined && manifestVersion.macf.trim().length > 0) {
      return { kind: 'resolved', target: manifestVersion.macf.trim().replace(/^v/, '') };
    }
    // L2.4 — absent versions: means "no opinion", NOT "latest". Also never
    // touches `fetchLatest` — reaching for npm to fill an unstated field is
    // exactly the well-meaning default this amendment forbids.
    return {
      kind: 'no-opinion',
      message:
        'the manifest declares no versions.macf — nothing to reconcile (absent means ' +
        '"no opinion", not "latest"). Pass --target to roll explicitly, or declare versions.macf in fleet.yaml.',
    };
  }
  // L2.5 — no manifest given at all (standalone direct-verb usage): the ONLY
  // reachable fetchLatest path, preserving pre-Amendment-L behaviour.
  const latest = await fetchLatest();
  if (!latest) {
    return { kind: 'error', message: 'could not resolve npm-latest target — pass --target <version>' };
  }
  return { kind: 'resolved', target: latest };
}
