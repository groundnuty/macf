/**
 * Minimal semver comparison shared across packages.
 *
 * Lives in `macf-core` (not `macf/src/cli/version-resolver.ts`, its original
 * home) so both the CLI's tag-resolution AND the channel-server's collision
 * check (groundnuty/macf#424 — version-aware takeover) reuse one implementation
 * instead of duplicating it. `version-resolver.ts` re-exports this for
 * backward compatibility.
 *
 * Scope: `x.y.z` (optional leading `v`) only — sufficient for the 0.2.x line.
 * Pre-release / build-metadata suffixes are not parsed; an unparseable string
 * compares as `0.0.0`.
 */

/**
 * Compare two semver strings (`x.y.z`, optional leading `v`) numerically.
 * Returns negative if a < b, zero if equal, positive if a > b. An unparseable
 * input is treated as `0.0.0` (oldest) — callers that need "missing = oldest"
 * semantics rely on this.
 */
export function compareSemver(a: string, b: string): number {
  const parse = (v: string): [number, number, number] => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(v);
    if (!m) return [0, 0, 0];
    return [Number.parseInt(m[1]!, 10), Number.parseInt(m[2]!, 10), Number.parseInt(m[3]!, 10)];
  };
  const [aMaj, aMin, aPat] = parse(a);
  const [bMaj, bMin, bPat] = parse(b);
  if (aMaj !== bMaj) return aMaj - bMaj;
  if (aMin !== bMin) return aMin - bMin;
  return aPat - bPat;
}
