import { execFileSync } from 'node:child_process';

/**
 * Generate a GitHub App installation token using gh CLI.
 * Falls back to GH_TOKEN env var if gh token generate is unavailable.
 */
export function generateToken(): string {
  // Prefer existing GH_TOKEN from environment
  const envToken = process.env['GH_TOKEN'];
  if (envToken) return envToken;

  const appId = process.env['APP_ID'];
  const installId = process.env['INSTALL_ID'];
  const keyPath = process.env['KEY_PATH'];

  if (!appId || !installId || !keyPath) {
    throw new Error(
      'No GH_TOKEN and missing APP_ID/INSTALL_ID/KEY_PATH for token generation',
    );
  }

  const output = execFileSync('gh', [
    'token', 'generate',
    '--app-id', appId,
    '--installation-id', installId,
    '--key', keyPath,
  ], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });

  const parsed: { token: string } = JSON.parse(output);
  return parsed.token;
}
