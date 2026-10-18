/**
 * Does an App's installation already cover a repo? Reads `GET /installation/repositories`
 * (paginated) with that App's own installation token. Used to pick an App that can create
 * labels on a work repo; a token that cannot be minted or a read that fails answers `false`.
 */
import { generateToken, proxyAwareFetch } from '@groundnuty/macf-core';
import type { TokenSource } from '@groundnuty/macf-core';

export type InstallationCoversRepo = (source: TokenSource, repo: string) => Promise<boolean>;

const MAX_PAGES = 50;

export const realInstallationCoversRepo: InstallationCoversRepo = async (source, repo) => {
  let token: string;
  try {
    token = await generateToken(source, { forceMint: true });
  } catch {
    return false;
  }
  const want = repo.toLowerCase();
  for (let page = 1; page <= MAX_PAGES; page++) {
    let res: Response;
    try {
      res = await proxyAwareFetch(`https://api.github.com/installation/repositories?per_page=100&page=${page}`, {
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': '2022-11-28',
        },
      });
    } catch {
      return false;
    }
    if (!res.ok) return false;
    const body = (await res.json()) as { repositories?: readonly { full_name?: string }[] };
    const repos = body.repositories ?? [];
    if (repos.some((r) => r.full_name?.toLowerCase() === want)) return true;
    if (repos.length < 100) return false;
  }
  return false;
};
