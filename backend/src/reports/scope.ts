// What a render session may do (docs/security.md § Render tokens).
//
// The headless report renderer signs in with a single-use render token
// (POST /auth/render-session) and gets a session scoped to ONE project and
// ONE run. It may make exactly the reads the printable report route makes
// (frontend/src/routes/projects/[id]/report/+page.svelte), and nothing else:
//
//   GET /auth/me                               the layout's session check
//   GET /projects/<project>                    the project
//   GET /projects/<project>/series             the input series' coverage
//   GET /projects/<project>/runs/<run>[/…]     the run and anything under it (its series,
//                                              days, uncertainty, model input): all of that
//                                              one run, read as the requester under RLS
//
// Every other method, project, run or route (another project, the run list,
// members, exports, teams, compare, any write) answers 403. RLS still applies
// underneath: the session is the requesting user's, so it can never see more
// than they can.
export interface RenderScope {
	projectId: string;
	runId: string;
}

const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const PROJECT_READ = new RegExp(`^/projects/(${UUID})(?:/series|/runs/(${UUID})(?:/[A-Za-z0-9_/-]*)?)?/?$`);

/** Whether a render session scoped to `scope` may make this request. */
export function scopeAllows(scope: RenderScope, method: string, path: string): boolean {
	if (method !== 'GET') return false;
	if (path === '/auth/me') return true;
	// Encoded characters or empty / dot segments are never in a path the report makes.
	if (/%|\/\/|\/\.{1,2}(\/|$)/.test(path)) return false;
	const m = PROJECT_READ.exec(path);
	if (!m) return false;
	if (m[1]!.toLowerCase() !== scope.projectId.toLowerCase()) return false;
	if (m[2] !== undefined) return m[2].toLowerCase() === scope.runId.toLowerCase();
	return true;
}
