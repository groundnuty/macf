/**
 * Does an installed router caller pass the secrets the router can actually
 * consume? A reusable workflow sees ONLY the secrets its caller passes, so a
 * repo can hold every secret the router needs and still route nothing.
 *
 * The router consumes either the single composed bundle (all six values) or,
 * when no bundle exists, the individual secrets — of which the Tailscale pair
 * is exempt on a self-hosted runner. So the consumable subset is: the four
 * always-required names, plus the Tailscale pair unless the fleet declares a
 * self-hosted runner.
 *
 * Pure — no I/O. Presence-only: a secret VALUE is never read.
 */

import {
  ALL_ROUTING_SECRET_NAMES,
  ROUTING_BUNDLE_SECRET_NAME,
  TS_OAUTH_CLIENT_ID_SECRET_NAME,
  TS_OAUTH_SECRET_SECRET_NAME,
} from './apply-routing-secrets.js';

export interface CallerSecrets {
  /** `secrets: inherit` — passes everything (same-org callers only). */
  readonly inherit: boolean;
  /** Names listed under the router call's `secrets:` block. */
  readonly names: readonly string[];
}

/**
 * Extract what the first reusable-router call in `content` passes under
 * `secrets:`. Indentation-based, like `extractCallerWithKeys`. `undefined`
 * when no router `uses:` line exists. A call with no `secrets:` key yields
 * `{ inherit: false, names: [] }` — a real reading, not "unknown".
 */
export function extractCallerSecrets(content: string): CallerSecrets | undefined {
  const lines = content.split('\n');
  const usesIdx = lines.findIndex((l) => /^\s*uses:\s*groundnuty\/macf-actions\/\.github\/workflows\/agent-router\.yml@\S+\s*$/.test(l));
  if (usesIdx === -1) return undefined;
  const base = (lines[usesIdx] ?? '').length - (lines[usesIdx] ?? '').trimStart().length;
  for (let i = usesIdx + 1; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const t = line.trim();
    if (t.length === 0 || t.startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    if (indent < base) break;
    if (indent > base) continue;
    if (/^secrets:\s*inherit\s*(#.*)?$/.test(t)) return { inherit: true, names: [] };
    if (!/^secrets:\s*$/.test(t)) continue;
    const names: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const l2 = lines[j] ?? '';
      const t2 = l2.trim();
      if (t2.length === 0 || t2.startsWith('#')) continue;
      if (l2.length - l2.trimStart().length <= indent) break;
      const m = /^([A-Za-z_][A-Za-z0-9_]*):/.exec(t2);
      if (m?.[1] !== undefined) names.push(m[1]);
    }
    return { inherit: false, names };
  }
  return { inherit: false, names: [] };
}

export type CallerRoutingFormVerdict =
  | { readonly status: 'complete' }
  | { readonly status: 'unknown'; readonly reason: string }
  | {
      readonly status: 'incomplete';
      /** Needed secret names absent from the repo's Actions secrets. */
      readonly missingFromRepo: readonly string[];
      /** Names the caller does not pass (so the router cannot see them even when the repo holds them). */
      readonly notPassedByCaller: readonly string[];
      /** True when re-generating the caller would close the gap — i.e. the caller omits a name the repo holds. */
      readonly callerRewriteFixes: boolean;
    };

export type RepoSecretsInput =
  | { readonly status: 'confirmed'; readonly names: ReadonlySet<string> }
  | { readonly status: 'unknown'; readonly reason: string }
  | undefined;

export function routerNeededSecretNames(selfHostedRunner: boolean): readonly string[] {
  return ALL_ROUTING_SECRET_NAMES.filter(
    (n) => !(selfHostedRunner && (n === TS_OAUTH_CLIENT_ID_SECRET_NAME || n === TS_OAUTH_SECRET_SECRET_NAME)),
  );
}

export function evaluateCallerRoutingForm(
  caller: CallerSecrets | undefined,
  repoSecrets: RepoSecretsInput,
  selfHostedRunner: boolean,
  orgSecrets?: RepoSecretsInput,
): CallerRoutingFormVerdict {
  if (caller === undefined) return { status: 'unknown', reason: 'the installed router caller could not be read' };
  if (repoSecrets === undefined || repoSecrets.status === 'unknown') {
    return { status: 'unknown', reason: repoSecrets?.reason ?? 'the repo secret names could not be read' };
  }
  // `secrets: inherit` passes everything the repo holds — nothing the caller
  // can be faulted for; only repo-side absence remains.
  const passes = (n: string): boolean => caller.inherit || caller.names.includes(n);
  // Org-level secrets visible to the repo resolve in `${{ secrets.X }}` too.
  const orgKnown = orgSecrets?.status === 'confirmed';
  const have: ReadonlySet<string> = orgKnown ? new Set([...repoSecrets.names, ...orgSecrets.names]) : repoSecrets.names;
  const bundleUsable = have.has(ROUTING_BUNDLE_SECRET_NAME) && passes(ROUTING_BUNDLE_SECRET_NAME);
  const needed = routerNeededSecretNames(selfHostedRunner);
  const individualUsable = needed.every((n) => have.has(n) && passes(n));
  if (bundleUsable || individualUsable) return { status: 'complete' };
  const missingFromRepo = needed.filter((n) => !have.has(n));
  const notPassedByCaller = needed.filter((n) => !passes(n));
  const callerRewriteFixes = [ROUTING_BUNDLE_SECRET_NAME, ...needed].some((n) => have.has(n) && !passes(n));
  // A name absent from the repo may still exist at org level; when that read
  // failed, a gap only that could explain is unknown — never "missing".
  if (!orgKnown && !callerRewriteFixes && missingFromRepo.length > 0) {
    return { status: 'unknown', reason: `the org-level secrets visible to the repo could not be read (${orgSecrets?.status === 'unknown' ? orgSecrets.reason : 'no read attempted'}), so ${missingFromRepo.join(', ')} may exist there` };
  }
  return { status: 'incomplete', missingFromRepo, notPassedByCaller, callerRewriteFixes };
}
