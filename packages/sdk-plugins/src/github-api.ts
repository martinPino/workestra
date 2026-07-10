/**
 * GitHub API mínima: lista los REPOSITORIOS accesibles por el token para poblar el desplegable «Repositorio»
 * del nodo conector (en vez de que el usuario escriba `owner/repo` a mano). Puro, con `fetch` inyectable →
 * testeable. Se llama con el token OAuth del conector GitHub conectado (scope `repo`).
 */
export interface GithubRepo {
  /** `owner/repo` (full_name): es el valor que guarda el nodo y que se inserta en la ruta `/repos/{id}/…`. */
  id: string;
  name: string;
}

type Fetchish = (url: string, init?: { headers?: Record<string, string> }) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;

/**
 * Devuelve los repos donde el usuario es owner/colaborador/miembro de org, ordenados por actualización reciente
 * (los más útiles primero). GitHub EXIGE un `User-Agent` o responde 403. En error de red/HTTP devuelve `[]`
 * (el conector cae al campo de texto manual, igual que Slack/Sentry).
 */
export async function listGithubRepos(opts: { token: string; fetchFn?: Fetchish }): Promise<{ repos: GithubRepo[] }> {
  const fetchFn = opts.fetchFn ?? (globalThis.fetch as unknown as Fetchish);
  const url = 'https://api.github.com/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member';
  const res = await fetchFn(url, {
    headers: {
      authorization: `Bearer ${opts.token}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'Workestra',
    },
  });
  if (!res.ok) return { repos: [] };
  const data = (await res.json().catch(() => [])) as Array<{ full_name?: string }>;
  if (!Array.isArray(data)) return { repos: [] };
  const repos = data
    .filter((r): r is { full_name: string } => !!r && !!r.full_name)
    .map((r) => ({ id: r.full_name, name: r.full_name }));
  return { repos };
}
