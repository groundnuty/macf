/**
 * Find the repo's CI workflows, for the router caller's `workflow_run`
 * trigger (groundnuty/macf#1479).
 *
 * GitHub does not trigger workflows from check suites created by GitHub
 * Actions, so a caller subscribed only to `check_suite` never hears about
 * Actions CI. `workflow_run` does fire, but only for workflows named in its
 * `workflows:` list, so the generator must know the names. They are read
 * from the repo's own `.github/workflows/` at generation time: the generator
 * always runs against a checkout of the target repo (`repo-init`, and
 * `bootstrap apply` via its scratch checkout), so the files are on disk.
 *
 * A workflow counts as CI when it runs on `push` or a pull-request event.
 * The router's own caller (`agent-router.yml`) is never CI: routing its
 * completion would start another router run.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

const ROUTER_FILE = 'agent-router.yml';
const ROUTER_NAME = 'Agent Router';
const CI_EVENTS = new Set(['push', 'pull_request', 'pull_request_target']);

function triggersOn(on: unknown): boolean {
  if (typeof on === 'string') return CI_EVENTS.has(on);
  if (Array.isArray(on)) return on.some((e) => typeof e === 'string' && CI_EVENTS.has(e));
  if (on !== null && typeof on === 'object') return Object.keys(on).some((e) => CI_EVENTS.has(e));
  return false;
}

/**
 * Names for `workflow_run.workflows`, sorted and de-duplicated. An unnamed
 * workflow is listed by its file path, which is the name GitHub gives it.
 * Unreadable or unparseable files are skipped: a broken workflow cannot be
 * CI. Returns `[]` when the repo has no CI, so the caller emits no block.
 */
export function scanCiWorkflowNames(repoDir: string): readonly string[] {
  const dir = join(repoDir, '.github', 'workflows');
  if (!existsSync(dir)) return [];
  const names = new Set<string>();
  for (const file of readdirSync(dir)) {
    if (!/\.ya?ml$/.test(file) || file === ROUTER_FILE) continue;
    let doc: unknown;
    try {
      doc = parseYaml(readFileSync(join(dir, file), 'utf-8'));
    } catch {
      continue;
    }
    if (doc === null || typeof doc !== 'object') continue;
    const wf = doc as { name?: unknown; on?: unknown };
    if (!triggersOn(wf.on)) continue;
    const name = typeof wf.name === 'string' && wf.name !== '' ? wf.name : `.github/workflows/${file}`;
    if (name === ROUTER_NAME) continue;
    names.add(name);
  }
  return [...names].sort();
}

/**
 * Parse the `--ci-workflows` option. Absent means "scan the repo"; an
 * explicit empty value means "subscribe to no CI workflow".
 */
export function parseCiWorkflowsOption(raw: unknown): readonly string[] | undefined {
  if (raw === undefined) return undefined;
  return String(raw).split(',').map((n) => n.trim()).filter(Boolean);
}
