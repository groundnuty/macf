import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Generate a GitHub App installation token.
 * Falls back to GH_TOKEN env var if available.
 */
export async function generateToken(): Promise<string> {
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

  const { stdout } = await execFileAsync('gh', [
    'token', 'generate',
    '--app-id', appId,
    '--installation-id', installId,
    '--key', keyPath,
  ], { encoding: 'utf-8' });

  const parsed: { token: string } = JSON.parse(stdout);
  return parsed.token;
}
