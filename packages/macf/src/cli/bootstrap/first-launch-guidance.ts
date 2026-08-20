/**
 * First-launch operator guidance for a freshly `fleet deploy`ed / `apply`ed
 * workspace (groundnuty/macf#994).
 *
 * `deploy`/`apply` materialize a workspace and print `cd <destDir> &&
 * ./claude.sh` as the operator's next step — but that step cannot complete
 * unattended. Claude Code's own "Do you trust this folder?" dialog blocks
 * the FIRST launch of any workspace it has not seen before, and — because
 * `macf-prompt-watcher.sh`'s auto-responder (DR-033, macf#645) watches for a
 * bounded window starting at launch, not from whenever the trust dialog
 * happens to get answered — an operator who is not there within that window
 * can also miss the auto-responder's chance to clear the UNRELATED
 * `--dangerously-load-development-channels` confirmation, which then also
 * needs a manual answer. Both are silent to `deploy`/`apply`'s own printed
 * output today; this module names them.
 *
 * **Investigated finding (macf#994): the channels prompt is normally
 * ALREADY auto-cleared, structurally.** `macf init` unconditionally seeds
 * `.claude/.macf/prompt-responses.json` with `PROMPT_RESPONSES_SEED`
 * (`@groundnuty/macf-core`'s `prompt-responses.ts`), which includes a
 * `dev-channels` entry matching exactly the frame this prompt renders
 * (`"I am using this for local development"` — DR-033's own worked
 * example). So on a normally-functioning launch, the operator answers ONLY
 * the trust dialog; the channels confirmation clears itself. The reason it
 * can ALSO need a manual answer is a **timing interaction**, not a second
 * un-auto-answerable prompt: the watcher's deadline is `launch + 90s`
 * (`MACF_PROMPT_WATCH_WINDOW_SECS`), computed once at watcher start — if the
 * trust dialog sits unanswered past that deadline (the common case for an
 * unattended/overnight launch), the watcher process has already exited by
 * the time the channels prompt would appear, and THAT prompt then also
 * needs a human. This module words the channels line conditionally for
 * exactly that reason — never asserting it always appears.
 *
 * **The watcher's own refusal is untouched by this module (macf#994 hard
 * constraint).** `macf-prompt-watcher.sh` hard-refuses (Inv 2) any ceremony
 * entry whose signature contains "trust" — see that script's
 * `REFUSE_SUBSTR` / `@groundnuty/macf-core`'s `PROMPT_REFUSE_SUBSTRINGS` —
 * so the trust dialog is NEVER auto-answered by design, and this module
 * never tries. It only tells a human where to find it.
 *
 * **Investigated per macf#994 requirement 4 — no supported pre-trust
 * mechanism exists.** Checked the installed Claude Code CLI's own `--help`
 * (2.1.226): the only trust-adjacent documented behaviour is that
 * `-p`/`--print` (non-interactive) mode SKIPS the trust dialog entirely —
 * inapplicable here, because `claude.sh` launches an interactive TUI
 * session, not a print-and-exit run, and skipping the dialog is not the
 * same as answering it (a workspace left untrusted would still block on
 * every SUBSEQUENT interactive launch). Neither `claude config` (not a real
 * subcommand on this build) nor `claude project --help` (only `purge`)
 * exposes a trust-preseed flag or config key. This repository has never
 * referenced an internal Claude Code state file (e.g. a
 * `hasTrustDialogAccepted`-shaped key) before this module, and per macf#994
 * this module does not add one — poking an undocumented state file would be
 * exactly the speculative, unsupported mechanism the issue rules out. If
 * Anthropic documents a supported pre-trust mechanism later, this is the
 * place to wire it in.
 *
 * **"Say it once, well" (DR-044 Decision 6).** The explanation
 * ({@link firstLaunchGuidanceHeaderLines}) is agent-INDEPENDENT text, so a
 * caller rendering N deployed agents must print it exactly ONCE for the
 * whole section, not once per agent — "three copies of a paragraph is
 * quieter than one marker plus one footnote" (DR-044). Only
 * {@link firstLaunchAttachLine} is agent-specific and belongs in a per-agent
 * loop.
 */
import { readFileSync } from 'node:fs';
import { agentConfigPath } from '../config.js';

/**
 * `macf-prompt-watcher.sh`'s default startup window in seconds (macf#645) —
 * the wall-clock budget its `dev-channels` auto-responder entry has to catch
 * the channels confirmation before it gives up and exits. Mirrors that
 * script's `MACF_PROMPT_WATCH_WINDOW_SECS` default. Used here only to word
 * an operator-facing HINT ("if more than ~90s pass..."); an operator who
 * customized the env var still sees the guidance, just with the stock
 * number — acceptable for a first-launch hint, not a functional gate.
 */
export const DEV_CHANNELS_WATCH_WINDOW_SECS = 90;

/**
 * `<project>@<routing-label>` — coordination.md's canonical tmux session
 * name (macf#678) for a just-deployed workspace. `project` is the fleet
 * name (constant across every agent in one run; the caller already knows it
 * from the manifest, so it is never re-derived here). The LABEL is read
 * from the deployed workspace's REAL on-disk `macf-agent.json`
 * (`routing_label ?? agent_name`, the exact precedence
 * `restart-self.ts::resolveSession` already uses) rather than the
 * manifest's declared `role` — deliberately: today's `fleet.yaml` schema has
 * no per-agent `agent_name`/`routing_label` override (see
 * `fleet-manifest.ts`'s module doc — `role` is the ONLY per-agent identity
 * field it accepts), so a fleet-deployed agent's `agent_name` and
 * `routing_label` happen to coincide with `role` today. But the config on
 * disk is still the ground truth a hand-edit or a future manifest field
 * could diverge from (the science-agent shape catalogued in the top-level
 * CLAUDE.md: `agent_name=macf-science-agent`, `routing_label=science-agent`)
 * — reading it directly, instead of re-deriving from `role`, is what keeps
 * this function correct either way.
 *
 * **Never throws (macf#994: "must never crash the completion render").**
 * Reads the JSON directly (not `config.ts::readAgentConfig`) deliberately:
 * that function full-schema-validates + writes a scary stderr warning on
 * ANY drift (including the benign "no versions section" case this module's
 * own tests hit) — noise this best-effort HINT has no business producing.
 * A missing file, malformed JSON, an unreadable file (EACCES / a
 * read-after-existsSync race), or a shape that isn't a plain object with
 * string fields all fall through to the `role` fallback silently.
 */
export function firstLaunchSessionName(project: string, destDir: string, role: string): string {
  const label = readRoutingLabelOrAgentName(destDir) ?? role;
  return `${project}@${label}`;
}

function readRoutingLabelOrAgentName(destDir: string): string | undefined {
  try {
    const raw: unknown = JSON.parse(readFileSync(agentConfigPath(destDir), 'utf-8'));
    if (raw === null || typeof raw !== 'object') return undefined;
    const config = raw as Record<string, unknown>;
    if (typeof config['routing_label'] === 'string') return config['routing_label'];
    if (typeof config['agent_name'] === 'string') return config['agent_name'];
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * The macf#994 explanation of BOTH first-launch prompts — printed exactly
 * ONCE per completion render, before any per-agent {@link
 * firstLaunchAttachLine}s (DR-044 Decision 6; see module doc). Never
 * answers either prompt — see module doc.
 */
export function firstLaunchGuidanceHeaderLines(): readonly string[] {
  return [
    `  First launch of a workspace needs Claude Code's own "Do you trust this folder?" dialog answered by hand — ` +
      `once per workspace, never automatically (macf-prompt-watcher deliberately refuses to answer it). If more ` +
      `than ~${String(DEV_CHANNELS_WATCH_WINDOW_SECS)}s pass before you get there, a one-time "Loading development ` +
      `channels" confirmation may ALSO need a manual answer (select the local-development option) — its own ` +
      `auto-responder's watch window can elapse while the trust dialog sits unanswered. Attach to answer either ` +
      `(detach again with Ctrl-b d; once per workspace, not per relaunch):`,
  ];
}

/** The ONE agent-specific line macf#994 adds per deployed agent — the exact command to reach that agent's prompts. */
export function firstLaunchAttachLine(project: string, destDir: string, role: string): string {
  return `    tmux attach -t ${firstLaunchSessionName(project, destDir, role)}`;
}
