import { AgentInfoSchema, agentInfoEquals } from './types.js';
import { toVariableSegment } from './variable-name.js';
import type { AgentInfo, Registry, RegisterResult, DeregisterResult, GitHubVariablesClient } from './types.js';

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

    // CAS register (groundnuty/macf#439). The GitHub Actions Variables API has
    // no native conditional write (no If-Match / ETag on PATCH/POST), so this
    // is a best-effort narrowing, NOT a hard CAS:
    //   1. pre-write compare — re-read the slot; if it no longer matches
    //      `expected`, a concurrent writer already changed it → abort the
    //      write (ok:false). This collapses the wide TOCTOU window (which
    //      spans the ~5s collision health-ping) down to the read→write gap.
    //   2. post-write read-back verify — after writing, re-read; if the slot
    //      isn't ours, a racer wrote BEFORE our read-back → ok:false.
    //
    // What (2) does and does NOT cover (#447 review, science-agent): it catches
    // only the interleaving where the racer's write lands before our read-back.
    // The symmetric order — A-write → A-readback(ok) → B-write → B-readback(ok)
    // — leaves BOTH returning ok:true (the slot ends up holding B; A's ok:true
    // is stale). So on THIS backend `ok:true` means "we own the slot for now,"
    // not "exclusively, at return" — eventually-reconciled, not a hard CAS.
    // (The local backend IS exclusive-at-return: lock-atomic, no read-back
    // needed.) The residual is bounded in practice by the ~5s health-ping
    // window + the #424 version-takeover predicate (an equal/older racer aborts
    // at the collision check, before reaching here); closing it hard needs a
    // real CAS primitive the API doesn't offer.
    //
    // Corrupt-slot caveat: `readAgent` returns null for a malformed / schema-
    // invalid value. On the read-back that's fail-safe (→ harmless ok:false).
    // On the pre-write compare with `expected===null`, a corrupt-but-present
    // slot also reads null → compare passes → we overwrite it — acceptable (a
    // corrupt slot is already unusable) and bounded by schema-validity.
    async registerConditional(
      name: string,
      info: AgentInfo,
      expected: AgentInfo | null,
    ): Promise<RegisterResult> {
      const current = await readAgent(name);
      if (!agentInfoEquals(current, expected)) {
        return { ok: false, current };
      }

      await client.writeVariable(variableName(name), JSON.stringify(info));

      const readback = await readAgent(name);
      if (readback === null || readback.instance_id !== info.instance_id) {
        return { ok: false, current: readback };
      }
      return { ok: true, current: info };
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
