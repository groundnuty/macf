/**
 * The operator inputs `bootstrap apply` takes, as preflight resolves them: the same flag, per-fleet
 * file, per-scope file, environment chain, through apply's own `resolveOperatorInput`. A value is
 * never printed from here.
 */
import { TS_OAUTH_CLIENT_ID_ENV_VAR, TS_OAUTH_SECRET_ENV_VAR } from './apply-routing-secrets.js';
import { RUNNER_TOKEN_ENV_VAR } from './apply-routing.js';
import { resolveOperatorInput, type OperatorInputResolution } from './operator-secrets-file.js';

type Values = Readonly<Record<string, string>>;

/** The file tiers and flag values preflight was given. */
export interface OperatorInputs {
  readonly fleet?: Values;
  readonly scope?: Values;
  readonly runnerToken?: string;
  readonly tsOauthClientId?: string;
  readonly tsOauthSecret?: string;
}

/** Resolves one key the way apply does: flag, per-fleet file, per-scope file, environment. */
export function resolvePreflightInput(env: Readonly<Record<string, string | undefined>>, inputs: OperatorInputs | undefined, key: string): OperatorInputResolution {
  const flag = key === RUNNER_TOKEN_ENV_VAR ? inputs?.runnerToken : key === TS_OAUTH_CLIENT_ID_ENV_VAR ? inputs?.tsOauthClientId : key === TS_OAUTH_SECRET_ENV_VAR ? inputs?.tsOauthSecret : undefined;
  return resolveOperatorInput(key, flag, inputs?.fleet, inputs?.scope, env);
}

/**
 * The input-carrying options of `bootstrap apply` that preflight does not take, each with why. Every
 * other input-carrying apply option must exist on preflight under the same name; a test enforces it.
 */
export const PREFLIGHT_NOT_NEEDED_APPLY_OPTIONS: readonly { readonly flag: string; readonly reason: string }[] = [
  { flag: '--dry-run', reason: 'changes what apply does, not what a check reads' },
  { flag: '--yes', reason: 'skips the approval prompt, which preflight never shows' },
  { flag: '--no-deploy', reason: 'skips the deploy phase; preflight checks the agent host only when --agent-host is given' },
];
