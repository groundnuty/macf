/**
 * The agent-host leg of `macf bootstrap preflight`. The agent host is where
 * the agents run: this machine (no ssh) or, with `--agent-host`, another one.
 * Are the tools the agents need on the PATH of a non-interactive login shell
 * (the shell cron and `fleet install-cron` use)? Read-only.
 */
import { compareSemver } from '@groundnuty/macf-core';
import type { ExecResult, PreflightCheck, PreflightDeps } from './preflight.js';

const AGENT_HOST_TOOLS = ['node', 'claude', 'tmux', 'crontab', 'gh', 'bash', 'macf'] as const;
/** Every line the probe answers: the tools, plus the gh-token extension the agents mint App tokens with. */
const PROBED = [...AGENT_HOST_TOOLS, 'gh-token'] as const;

const SSH_OPTS = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10'] as const;

/**
 * Minimum versions on the agent host. Claude Code 2.1.277 is the first that reads
 * AGENTS.md, where each agent's job is written; below 2.1.80 claude.sh also drops the
 * channel flags and the agents get no routed notifications.
 */
const AGENT_HOST_MINIMUMS: Readonly<Partial<Record<string, { readonly min: string; readonly fix: string }>>> = {
  node: { min: '22.12.0', fix: 'install Node.js 22.12 or later on the agent host' },
  bash: { min: '4.0.0', fix: 'install Bash 4+ (on macOS: brew install bash) and make sure it comes first on the non-interactive login PATH.' },
  claude: { min: '2.1.277', fix: 'update Claude Code on the agent host (claude update); below 2.1.277 the agent does not read AGENTS.md, where its job is written' },
};

/** One shell script, sent over stdin so no quoting survives the remote login shell. */
const PROBE_SCRIPT = `for t in ${AGENT_HOST_TOOLS.join(' ')}; do
  p=$(bash -lc "command -v $t" 2>/dev/null)
  if [ -n "$p" ]; then
    if [ "$t" = crontab ]; then
      out=$(bash -lc "crontab -l" 2>&1); rc=$?
      if [ $rc -eq 0 ]; then v=present
      elif echo "$out" | grep -qi 'no crontab'; then v=empty
      else v="error: $(echo "$out" | head -n 1)"; fi
    else
      v=$(bash -lc "$t --version 2>&1 | head -n 1")
    fi
    echo "$t|login|$v"
  else
    i=$(bash -ic "command -v $t" 2>/dev/null)
    if [ -n "$i" ]; then echo "$t|interactive|"; else echo "$t|none|"; fi
  fi
done
if bash -lc "gh extension list" 2>/dev/null | grep -qi 'gh-token'; then echo "gh-token|login|installed"; else echo "gh-token|none|"; fi
`;

export type SshFailure = 'host-key' | 'permission' | 'no-route' | 'other';

export function classifySshFailure(stderr: string): SshFailure {
  if (/host key verification failed|remote host identification has changed/i.test(stderr)) return 'host-key';
  if (/permission denied/i.test(stderr)) return 'permission';
  if (/could not resolve hostname|no route to host|timed out|connection refused|network is unreachable/i.test(stderr)) return 'no-route';
  return 'other';
}

function sshFailureCheck(vm: string, r: ExecResult): PreflightCheck {
  const kind = classifySshFailure(r.stderr);
  const first = r.stderr.split('\n').find((l) => l.trim().length > 0)?.trim() ?? 'no message';
  switch (kind) {
    case 'host-key':
      return { id: 'agent-host-ssh', group: 'agent-host', status: 'wrong', detail: `ssh to ${vm}: host key unknown or changed`, fix: `ssh ${vm} once by hand and accept the host key (or ssh-keyscan -H <host> >> ~/.ssh/known_hosts)` };
    case 'permission':
      return { id: 'agent-host-ssh', group: 'agent-host', status: 'wrong', detail: `ssh to ${vm}: permission denied`, fix: 'load your key (ssh-add, and check SSH_AUTH_SOCK) or add an ssh alias with IdentityFile' };
    case 'no-route':
      return { id: 'agent-host-ssh', group: 'agent-host', status: 'wrong', detail: `ssh to ${vm}: no route (${first})`, fix: 'check `tailscale status` and the name or alias' };
    default:
      return { id: 'agent-host-ssh', group: 'agent-host', status: 'wrong', detail: `ssh to ${vm} failed: ${first}`, fix: `run ssh ${vm} true by hand to see the error` };
  }
}

function crontabCheck(id: string, mode: string, state: string): PreflightCheck {
  if (mode !== 'login') return toolCheck('crontab', mode, state, true);
  if (state.startsWith('error')) {
    return { id, group: 'agent-host', status: 'wrong', detail: `crontab is installed but \`crontab -l\` fails (${state})`, fix: 'allow crontab for this user (on macOS: give the terminal Full Disk Access)' };
  }
  const note = state === 'empty' ? 'no crontab yet (an empty crontab makes `crontab -l` exit 1; that is fine)' : 'crontab readable';
  return { id, group: 'agent-host', status: 'ok', detail: `crontab on the agent host: ${note}` };
}

function toolCheck(tool: string, mode: string, version: string, skipCron = false): PreflightCheck {
  const id = `agent-host-${tool}`;
  if (tool === 'crontab' && !skipCron) return crontabCheck(id, mode, version);
  if (mode === 'login') {
    const floor = AGENT_HOST_MINIMUMS[tool];
    if (floor !== undefined) {
      const have = /(\d+\.\d+\.\d+)/.exec(version)?.[1];
      if (have === undefined) {
        return { id, group: 'agent-host', status: 'unknown', detail: `could not read the ${tool} version on the agent host ("${version}"); it needs ${floor.min} or later` };
      }
      if (compareSemver(have, floor.min) < 0) {
        return { id, group: 'agent-host', status: 'wrong', detail: `${tool} ${have} on the agent host is older than ${floor.min}`, fix: floor.fix };
      }
    }
    return { id, group: 'agent-host', status: 'ok', detail: `${tool} on the agent host (non-interactive login PATH): ${version || 'version unknown'}` };
  }
  if (mode === 'interactive') {
    return {
      id, group: 'agent-host', status: 'wrong',
      detail: `${tool} is on the agent host's PATH only in an interactive shell, so cron cannot find it`,
      fix: `add its directory to PATH in ~/.profile on the agent host (not only ~/.bashrc)`,
    };
  }
  if (tool === 'gh-token') {
    return { id, group: 'agent-host', status: 'missing', detail: 'the gh-token extension is not installed on the agent host (the agents mint their App tokens with it)', fix: 'gh extension install Link-/gh-token (on the agent host)' };
  }
  return { id, group: 'agent-host', status: 'missing', detail: `${tool} is not on the agent host`, fix: `install ${tool} on the agent host` };
}

function parseProbe(stdout: string): readonly PreflightCheck[] {
  const seen = new Map<string, { mode: string; version: string }>();
  for (const line of stdout.split('\n')) {
    const [tool, mode, ...rest] = line.split('|');
    if (tool !== undefined && mode !== undefined && (PROBED as readonly string[]).includes(tool)) {
      seen.set(tool, { mode, version: rest.join('|').trim() });
    }
  }
  return PROBED.map((tool) => {
    const s = seen.get(tool);
    if (s === undefined) return { id: `agent-host-${tool}`, group: 'agent-host' as const, status: 'unknown' as const, detail: `no answer for ${tool} from the agent-host probe` };
    return toolCheck(tool, s.mode, s.version);
  });
}

export async function agentHostChecks(deps: PreflightDeps, agentHost: string | undefined): Promise<readonly PreflightCheck[]> {
  if (agentHost === undefined) {
    const probe = await deps.exec('sh', ['-s'], { timeoutMs: 60000, input: PROBE_SCRIPT });
    const head: PreflightCheck = { id: 'agent-host', group: 'agent-host', status: 'ok', detail: 'agents run on this machine' };
    if (probe.code !== 0) return [head, probeFailed('run `bash -lc "command -v macf"` by hand')];
    return [head, ...parseProbe(probe.stdout)];
  }
  const head: PreflightCheck = { id: 'agent-host', group: 'agent-host', status: 'ok', detail: `agents run on ${agentHost}` };
  const ping = await deps.exec('ssh', [...SSH_OPTS, agentHost, 'true'], { timeoutMs: 20000 });
  if (ping.spawnFailed === true) {
    return [head, { id: 'agent-host-ssh', group: 'agent-host', status: 'missing', detail: 'ssh is not on PATH', fix: 'install an ssh client' }];
  }
  if (ping.code !== 0) return [head, sshFailureCheck(agentHost, ping)];
  const ssh: PreflightCheck = { id: 'agent-host-ssh', group: 'agent-host', status: 'ok', detail: `ssh to ${agentHost} works` };
  const probe = await deps.exec('ssh', [...SSH_OPTS, agentHost, 'sh', '-s'], { timeoutMs: 60000, input: PROBE_SCRIPT });
  if (probe.code !== 0) return [head, ssh, probeFailed(`run ssh ${agentHost} 'bash -lc "command -v macf"' by hand`)];
  return [head, ssh, ...parseProbe(probe.stdout)];
}

function probeFailed(fix: string): PreflightCheck {
  return { id: 'agent-host-tools', group: 'agent-host', status: 'unknown', detail: 'the agent-host tool probe failed', fix };
}
