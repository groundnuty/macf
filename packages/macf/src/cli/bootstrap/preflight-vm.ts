/**
 * The VM leg of `macf bootstrap preflight`: can we ssh in without a prompt,
 * and are the tools the agents need on the PATH of a non-interactive login
 * shell (the shell cron and `fleet install-cron` use)? Read-only.
 */
import type { ExecResult, PreflightCheck, PreflightDeps } from './preflight.js';

const VM_TOOLS = ['node', 'claude', 'tmux', 'gh', 'macf'] as const;

const SSH_OPTS = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10'] as const;

/** One shell script, sent over stdin so no quoting survives the remote login shell. */
const PROBE_SCRIPT = `for t in ${VM_TOOLS.join(' ')}; do
  p=$(bash -lc "command -v $t" 2>/dev/null)
  if [ -n "$p" ]; then
    v=$(bash -lc "$t --version 2>&1 | head -n 1")
    echo "$t|login|$v"
  else
    i=$(bash -ic "command -v $t" 2>/dev/null)
    if [ -n "$i" ]; then echo "$t|interactive|"; else echo "$t|none|"; fi
  fi
done
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
      return { id: 'vm-ssh', group: 'vm', status: 'wrong', detail: `ssh to ${vm}: host key unknown or changed`, fix: `ssh ${vm} once by hand and accept the host key (or ssh-keyscan -H <host> >> ~/.ssh/known_hosts)` };
    case 'permission':
      return { id: 'vm-ssh', group: 'vm', status: 'wrong', detail: `ssh to ${vm}: permission denied`, fix: 'load your key (ssh-add, and check SSH_AUTH_SOCK) or add an ssh alias with IdentityFile' };
    case 'no-route':
      return { id: 'vm-ssh', group: 'vm', status: 'wrong', detail: `ssh to ${vm}: no route (${first})`, fix: 'check `tailscale status` and the name or alias' };
    default:
      return { id: 'vm-ssh', group: 'vm', status: 'wrong', detail: `ssh to ${vm} failed: ${first}`, fix: `run ssh ${vm} true by hand to see the error` };
  }
}

function toolCheck(tool: string, mode: string, version: string): PreflightCheck {
  const id = `vm-${tool}`;
  if (mode === 'login') {
    return { id, group: 'vm', status: 'ok', detail: `${tool} on the VM (non-interactive login PATH): ${version || 'version unknown'}` };
  }
  if (mode === 'interactive') {
    return {
      id, group: 'vm', status: 'wrong',
      detail: `${tool} is on the VM's PATH only in an interactive shell, so cron cannot find it`,
      fix: `add its directory to PATH in ~/.profile on the VM (not only ~/.bashrc)`,
    };
  }
  return { id, group: 'vm', status: 'missing', detail: `${tool} is not on the VM`, fix: `install ${tool} on the VM` };
}

function parseProbe(stdout: string): readonly PreflightCheck[] {
  const seen = new Map<string, { mode: string; version: string }>();
  for (const line of stdout.split('\n')) {
    const [tool, mode, ...rest] = line.split('|');
    if (tool !== undefined && mode !== undefined && (VM_TOOLS as readonly string[]).includes(tool)) {
      seen.set(tool, { mode, version: rest.join('|').trim() });
    }
  }
  return VM_TOOLS.map((tool) => {
    const s = seen.get(tool);
    if (s === undefined) return { id: `vm-${tool}`, group: 'vm' as const, status: 'unknown' as const, detail: `no answer for ${tool} from the VM probe` };
    return toolCheck(tool, s.mode, s.version);
  });
}

export async function vmChecks(deps: PreflightDeps, vm: string | undefined): Promise<readonly PreflightCheck[]> {
  if (vm === undefined) return [];
  const ping = await deps.exec('ssh', [...SSH_OPTS, vm, 'true'], { timeoutMs: 20000 });
  if (ping.spawnFailed === true) {
    return [{ id: 'vm-ssh', group: 'vm', status: 'missing', detail: 'ssh is not on PATH', fix: 'install an ssh client' }];
  }
  if (ping.code !== 0) return [sshFailureCheck(vm, ping)];
  const probe = await deps.exec('ssh', [...SSH_OPTS, vm, 'sh', '-s'], { timeoutMs: 60000, input: PROBE_SCRIPT });
  if (probe.code !== 0) {
    return [{ id: 'vm-ssh', group: 'vm', status: 'ok', detail: `ssh to ${vm} works` }, { id: 'vm-tools', group: 'vm', status: 'unknown', detail: 'the VM tool probe failed', fix: `run ssh ${vm} 'bash -lc "command -v macf"' by hand` }];
  }
  return [{ id: 'vm-ssh', group: 'vm', status: 'ok', detail: `ssh to ${vm} works` }, ...parseProbe(probe.stdout)];
}
