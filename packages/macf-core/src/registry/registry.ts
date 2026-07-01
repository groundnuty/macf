import { AgentInfoSchema, agentInfoEquals } from './types.js';
import { toVariableSegment } from './variable-name.js';
import type { AgentInfo, Registry, RegisterResult, DeregisterResult, HeartbeatResult, GitHubVariablesClient } from './types.js';

/**
 * Post-write read-back retry budget for the GitHub-Variables backend
 * (groundnuty/macf#702). The Variables API's PATCH/GET pair is NOT
 * linearizable — a GET issued immediately after a successful PATCH can
 * momentarily still serve the pre-write value (read-after-write lag). This
 * bounds how long `registerConditional` waits for the read-back to catch up
 * with a write it already knows succeeded (the PATCH/POST itself did not
 * error) before falling back to trusting the write outright (see
 * `registerConditional` below — the devops 8h-outage fix).
 */
const READBACK_RETRY_ATTEMPTS = 2;
const READBACK_RETRY_DELAY_MS = 250;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Creates a Registry backed by a GitHubVariablesClient.
 * All three backends (org, profile, repo) share this implementation —
 * the only difference is the URL path prefix baked into the client.
 */
export function createRegistry(
  client: GitHubVariablesClient,
  project: string,
): Registry {
  // GitHub Actions variable names only accept [A-Z0-9_]. Hyphens in the
  // project or agent name become underscores; names are uppercased.
  const prefix = `${toVariableSegment(project)}_AGENT_`;

  function variableName(agentName: string): string {
    return `${prefix}${toVariableSegment(agentName)}`;
  }

  // Shared read+parse used by both `get` and the conditional register's
  // compare/read-back. Returns null for absent, malformed, or
  // schema-invalid values (same lenient contract `get` has always had).
  async function readAgent(name: string): Promise<AgentInfo | null> {
    const value = await client.readVariable(variableName(name));
    if (value === null) return null;

    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      return null;
    }

    const result = AgentInfoSchema.safeParse(parsed);
    if (!result.success) return null;
    return result.data;
  }

  return {
    async register(name: string, info: AgentInfo): Promise<void> {
      const value = JSON.stringify(info);
      await client.writeVariable(variableName(name), value);
    },

    // CAS register (groundnuty/macf#439; over-register semantics per
    // groundnuty/macf#702). The GitHub Actions Variables API has no native
    // conditional write (no If-Match / ETag on PATCH/POST), so this is a
    // best-effort narrowing, NOT a hard CAS:
    //   1. pre-write compare — re-read the slot; if it no longer matches
    //      `expected`, a concurrent writer already changed it BEFORE we ever
    //      wrote → this is the one case a stale/unchanged `expected` can't
    //      explain, so it's the real "current is a genuinely different
    //      registration" signal → `ok:false, reason:'lost-to-newer'`. This
    //      collapses the wide TOCTOU window (which spans the ~5s collision
    //      health-ping) down to the read→write gap.
    //   2. write — the compare passed (this INCLUDES the over-register case:
    //      `expected` is itself a stale/dead entry the collision check
    //      decided to take over, and the pre-write re-read still shows it
    //      unchanged). Per groundnuty/macf#702, reaching this point already
    //      means "claim" — the write is issued unconditionally.
    //   3. post-write read-back — a best-effort CONFIRMATION, not a
    //      precondition for success. If the first read-back doesn't yet show
    //      our own `info.instance_id`, retry up to READBACK_RETRY_ATTEMPTS
    //      times (READBACK_RETRY_DELAY_MS apart) to absorb the Variables
    //      API's read-after-write lag. Two outcomes after retries:
    //        - the read-back still reads as `expected` (unchanged) or as
    //          `null`/corrupt → the write itself never errored, so we trust
    //          it: `ok:true, reason:'claimed'`. This is the groundnuty/macf#702
    //          fix — the devops bug was exactly this branch previously
    //          returning `ok:false` (a lagging read-back of the stale entry
    //          was mistaken for "someone else won").
    //        - the read-back shows a DIFFERENT registration (neither `info`
    //          nor `expected`) → a real concurrent writer landed inside the
    //          residual window → `ok:false, reason:'lost-to-newer'`. The
    //          caller (server.ts) classifies that `current` as newer-live
    //          (yield) vs stale (retry the takeover) — this layer only
    //          reports the conflict.
    //
    // What (3) does and does NOT cover (#447/#702 review lineage): retrying
    // the read-back only helps when the LAG resolves within the retry
    // budget. The residual — a genuinely concurrent second writer landing
    // between our write and our final read-back — is symmetric to the
    // pre-#702 analysis: on THIS backend `ok:true` means "we own the slot
    // for now, best-effort," not "exclusively, at return." (The local
    // backend IS exclusive-at-return: lock-atomic, no read-back needed.) The
    // residual is bounded in practice by the ~5s health-ping window + the
    // #424 version-takeover predicate (an equal/older racer aborts at the
    // collision check, before reaching here); closing it hard needs a real
    // CAS primitive the API doesn't offer.
    //
    // Corrupt-slot caveat: `readAgent` returns null for a malformed / schema-
    // invalid value. On the read-back that's treated as an unconfirmed (not
    // failed) read — retried, then trusted per the rule above. On the
    // pre-write compare with `expected===null`, a corrupt-but-present slot
    // also reads null → compare passes → we overwrite it — acceptable (a
    // corrupt slot is already unusable) and bounded by schema-validity.
    async registerConditional(
      name: string,
      info: AgentInfo,
      expected: AgentInfo | null,
    ): Promise<RegisterResult> {
      const current = await readAgent(name);
      if (!agentInfoEquals(current, expected)) {
        // A concurrent writer already changed the slot BEFORE we wrote
        // anything — this is unambiguously a real conflict, not a read-lag
        // artifact (we haven't written yet, so there's nothing of ours for
        // a lagging read to be behind).
        return { ok: false, reason: 'lost-to-newer', current };
      }

      await client.writeVariable(variableName(name), JSON.stringify(info));

      for (let attempt = 0; ; attempt += 1) {
        const readback = await readAgent(name);

        if (readback !== null && readback.instance_id === info.instance_id) {
          // Confirmed: the read-back sees our own write.
          return { ok: true, reason: 'claimed', current: info };
        }

        if (readback !== null && !agentInfoEquals(readback, expected)) {
          // The read-back shows a registration that is neither ours nor the
          // pre-write `expected` value — a genuinely different writer landed
          // in the residual window. Real conflict, not a lag artifact.
          return { ok: false, reason: 'lost-to-newer', current: readback };
        }

        // readback is either null (still-propagating / corrupt-but-fail-safe)
        // or still shows `expected` unchanged (the write we just issued
        // hasn't propagated to this read yet) — read-after-write lag, not a
        // lost race. Retry a bounded number of times to absorb the lag.
        if (attempt >= READBACK_RETRY_ATTEMPTS) {
          // Exhausted the retry budget without seeing OUR write, but we also
          // never saw anyone else's write either — the PATCH/POST itself
          // succeeded (no throw), so trust it (groundnuty/macf#702: a
          // stale/unconfirmed read-back must never masquerade as a lost
          // race). This is the devops-outage fix: `current == expected`
          // (unchanged, including a stale entry) always claims.
          return { ok: true, reason: 'claimed', current: info };
        }

        await sleep(READBACK_RETRY_DELAY_MS);
      }
    },

    // Instance-id-guarded deregister (DR-031, groundnuty/macf#553 root-cause).
    // The graceful-shutdown handler calls this so the registry stays accurate-
    // by-construction: the slot is deleted ONLY when it is still ours.
    //
    // The load-bearing guard (inverse-of-#553): read the slot's current
    // instance_id and delete ONLY IF it equals `expectedInstanceId`. If a newer
    // instance took over the slot (groundnuty/macf#424) while we ran, the slot
    // now carries the newer instance_id → we return 'not-ours' and DO NOT delete
    // — deleting would strand a live newer peer (the inverse of the #553 stale-
    // entry bug). A corrupt/unparseable slot reads as null via `readAgent` →
    // 'absent' → also left intact (we can't prove it's ours, so we don't delete).
    //
    // Atomicity (best-effort, same posture as registerConditional): the GitHub
    // Actions Variables API has NO native If-Match / conditional-delete, so the
    // read→delete pair is not a hard CAS. We narrow the window to a single API
    // round-trip by reading immediately before the delete. The dominant
    // #424-takeover case is fully covered regardless of the window, because the
    // newer instance writes its instance_id at ITS startup — well before our
    // SIGTERM — so our read already observes the changed instance_id and skips.
    // The only residual is a truly-concurrent takeover landing inside that one
    // round-trip; that is the identical best-effort residual #439 documents for
    // the conditional write, and closing it hard needs a CAS primitive the API
    // doesn't offer. (The local backend IS exclusive — see local-client.ts.)
    //
    // NEVER throws: any read/delete failure returns reason:'error' so a graceful
    // shutdown can log + proceed rather than crash on a registry hiccup.
    async deregisterConditional(
      name: string,
      expectedInstanceId: string,
    ): Promise<DeregisterResult> {
      try {
        const current = await readAgent(name);
        if (current === null) {
          return { deregistered: false, reason: 'absent' };
        }
        if (current.instance_id !== expectedInstanceId) {
          return { deregistered: false, reason: 'not-ours' };
        }
        await client.deleteVariable(variableName(name));
        return { deregistered: true, reason: 'deleted' };
      } catch {
        return { deregistered: false, reason: 'error' };
      }
    },

    // Instance-id-guarded heartbeat (DR-031, groundnuty/macf#568). The live
    // instance periodically re-stamps `last_heartbeat` on its OWN slot so a
    // reader can TTL-judge an aged-out entry dead — the backstop for the
    // UNGRACEFUL death (kill -9 / OOM / power loss) the graceful-deregister (#586)
    // shutdown handler never runs for.
    //
    // Guard (identical shape to deregisterConditional): read the slot's current
    // instance_id and re-stamp ONLY IF it equals `expectedInstanceId`. If a newer
    // instance took over (groundnuty/macf#424) the slot carries a different
    // instance_id → 'not-ours', left untouched (re-stamping would clobber the live
    // newer peer's registration / mask its own heartbeat). A corrupt/unparseable
    // slot reads as null via `readAgent` → 'absent' → also left intact.
    //
    // Atomicity (best-effort, same posture as registerConditional/#439): the
    // GitHub Actions Variables API has NO native If-Match / conditional-write, so
    // the read→write pair is not a hard CAS — narrowed to one round-trip by
    // reading immediately before the write. The dominant #424-takeover case is
    // fully covered (the newer instance wrote its instance_id at ITS startup, well
    // before any of our heartbeat ticks). The only residual is a truly-concurrent
    // takeover landing inside that one round-trip — the identical residual #439
    // documents for the conditional write. (The local backend IS exclusive.)
    //
    // NEVER throws: any read/write failure returns reason:'error' so the periodic
    // caller logs + the next interval retries rather than the server crashing.
    async heartbeatConditional(
      name: string,
      expectedInstanceId: string,
      now: string,
    ): Promise<HeartbeatResult> {
      try {
        const current = await readAgent(name);
        if (current === null) {
          return { beat: false, reason: 'absent' };
        }
        if (current.instance_id !== expectedInstanceId) {
          return { beat: false, reason: 'not-ours' };
        }
        // Preserve every other field; only `last_heartbeat` advances.
        await client.writeVariable(
          variableName(name),
          JSON.stringify({ ...current, last_heartbeat: now }),
        );
        return { beat: true, reason: 'beat' };
      } catch {
        return { beat: false, reason: 'error' };
      }
    },

    async get(name: string): Promise<AgentInfo | null> {
      return readAgent(name);
    },

    async list(
      filterPrefix: string,
    ): Promise<ReadonlyArray<{ readonly name: string; readonly info: AgentInfo }>> {
      const allVars = await client.listVariables();
      // Sanitize filter side with the same transform used at write time so
      // a filterPrefix like 'cv-' matches stored 'CV_ARCHITECT'.
      const fullPrefix = `${prefix}${filterPrefix ? toVariableSegment(filterPrefix) : ''}`;
      const results: Array<{ name: string; info: AgentInfo }> = [];

      for (const v of allVars) {
        if (!v.name.startsWith(fullPrefix)) continue;

        let parsed: unknown;
        try {
          parsed = JSON.parse(v.value);
        } catch {
          continue;
        }

        const result = AgentInfoSchema.safeParse(parsed);
        if (!result.success) continue;

        const agentName = v.name.slice(prefix.length);
        results.push({ name: agentName, info: result.data });
      }

      return results;
    },

    async remove(name: string): Promise<void> {
      await client.deleteVariable(variableName(name));
    },
  };
}
