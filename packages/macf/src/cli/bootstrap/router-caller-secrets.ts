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
  const indentOf = (l: string): number => l.length - l.trimStart().length;
  const base = indentOf(lines[usesIdx] ?? '');
  // YAML mapping order is not significant: the job's `secrets:` key may sit
  // before or after `uses:`. Bound the job mapping by the first line with a
  // smaller indent in each direction, then look at every sibling key.
  let start = usesIdx;
  for (let i = usesIdx - 1; i >= 0; i--) {
    const l = lines[i] ?? '';
    const t = l.trim();
    if (t.length === 0 || t.startsWith('#')) continue;
    if (indentOf(l) < base) break;
    start = i;
  }
  let end = usesIdx;
  for (let i = usesIdx + 1; i < lines.length; i++) {
    const l = lines[i] ?? '';
    const t = l.trim();
    if (t.length === 0 || t.startsWith('#')) continue;
    if (indentOf(l) < base) break;
    end = i;
  }
  for (let i = start; i <= end; i++) {
    const line = lines[i] ?? '';
    const t = line.trim();
    if (t.length === 0 || t.startsWith('#') || indentOf(line) !== base) continue;
    if (/^secrets:\s*inherit\s*(#.*)?$/.test(t)) return { inherit: true, names: [] };
    if (!/^secrets:\s*$/.test(t)) continue;
    const names: string[] = [];
    for (let j = i + 1; j <= end; j++) {
      const l2 = lines[j] ?? '';
      const t2 = l2.trim();
      if (t2.length === 0 || t2.startsWith('#')) continue;
      if (indentOf(l2) <= base) break;
      const m = /^([A-Za-z_][A-Za-z0-9_]*):/.exec(t2);
      if (m?.[1] !== undefined) names.push(m[1]);
    }
    return { inherit: false, names };
  }
  return { inherit: false, names: [] };
}

/**
 * The account that owns the reusable router workflow (`groundnuty/macf-actions`).
 * GitHub propagates `secrets: inherit` only between repos of one organisation
 * or enterprise, so a caller owned by anyone else passes nothing with it —
 * the same fact `repo-init.ts` documents where it generates explicit names.
 */
export const ROUTER_REPO_OWNER = 'groundnuty';

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
      /** The caller uses `secrets: inherit` from an owner other than the router's, so it passes nothing. */
      readonly inheritCrossesOwner?: boolean;
      /** Needed names listed at org level that this private repo cannot receive (free plan) — only a repo secret or a self-hosted route fixes them. */
      readonly orgWithheld?: readonly string[];
    };

export type RepoSecretsInput =
  | { readonly status: 'confirmed'; readonly names: ReadonlySet<string>; readonly withheld?: ReadonlySet<string> }
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
  callerOwner?: string,
): CallerRoutingFormVerdict {
  if (caller === undefined) return { status: 'unknown', reason: 'the installed router caller could not be read' };
  if (repoSecrets === undefined || repoSecrets.status === 'unknown') {
    return { status: 'unknown', reason: repoSecrets?.reason ?? 'the repo secret names could not be read' };
  }
  // `secrets: inherit` passes everything the repo holds — but only when the
  // caller shares an organisation with the router's repo. Across owners it
  // passes nothing, so the caller is at fault and a rewrite to explicit names fixes it.
  const inheritCrossesOwner = caller.inherit && callerOwner !== undefined && callerOwner.toLowerCase() !== ROUTER_REPO_OWNER;
  const passes = (n: string): boolean => (caller.inherit && !inheritCrossesOwner) || caller.names.includes(n);
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
  const withheld = orgSecrets?.status === 'confirmed' ? orgSecrets.withheld : undefined;
  const orgWithheld = withheld === undefined ? [] : needed.filter((n) => withheld.has(n) && !repoSecrets.names.has(n));
  return {
    status: 'incomplete', missingFromRepo, notPassedByCaller, callerRewriteFixes,
    ...(inheritCrossesOwner ? { inheritCrossesOwner: true } : {}),
    ...(orgWithheld.length > 0 ? { orgWithheld } : {}),
  };
}
