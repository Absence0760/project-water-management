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
//   GET /projects/<project>/runs/<run>         the run
//   GET /projects/<project>/runs/<run>/series  one of its series
//   GET /projects/<project>/runs/<run>/day     the self-checks' day trace
//   GET /projects/<project>/runs/<run>/signoffs  the sign-off section
//
// Every other method, project, run or route answers 403: another project,
// the run list, members, teams, compare, any write, and the run's other
// reads the report doesn't make (its CSV exports, the workbook's bulk series,
// reproduction, allocation comparison, model input, ensembles, changes
// since). A new read the report
// page starts making is added to RUN_READS, and to the render-session sweep
// in render-session.security.db.test.ts, on purpose. RLS still applies
// underneath: the session is the requesting user's, so it can never see more
// than they can.
export interface RenderScope {
	projectId: string;
	runId: string;
}

const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
/** The run's sub-resources the report page reads (frontend/src/routes/projects/[id]/report/+page.svelte). */
const RUN_READS = ['series', 'day', 'signoffs'];
const PROJECT_READ = new RegExp(`^/projects/(${UUID})(?:/series|/runs/(${UUID})(?:/(?:${RUN_READS.join('|')}))?)?/?$`);

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
