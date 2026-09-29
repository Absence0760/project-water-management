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
// An impact report's session (082: `?against=<baseline project>:<run>`) makes
// one more read, and only with exactly this pair, baseline first:
//
//   GET /compare/runs?a=<baseline project>:<baseline run>&b=<project>:<run>
//
// and, for the section's licence-impact board (issue #53 R7,
// report/impactSeries.ts), two of the baseline run's catchment series, by key
// and nothing else:
//
//   GET /projects/<baseline project>/runs/<baseline run>/series?key=natural_flow
//   GET /projects/<baseline project>/runs/<baseline run>/series?key=ewr_shortfall
//
// It never reads the baseline's project, the run itself, its other series or
// any node's series.
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
	/** An impact report's baseline (possibly another project's run); absent for the plain report. */
	against?: { projectId: string; runId: string };
}

const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
/** The run's sub-resources the report page reads (frontend/src/routes/projects/[id]/report/+page.svelte). */
const RUN_READS = ['series', 'day', 'signoffs'];
const PROJECT_READ = new RegExp(`^/projects/(${UUID})(?:/series|/runs/(${UUID})(?:/(?:${RUN_READS.join('|')}))?)?/?$`);

/** The impact section's one comparison: exactly `a` (the baseline) and `b` (the run), once each, nothing else. */
function compareAllowed(scope: RenderScope, query: URLSearchParams): boolean {
	if (!scope.against) return false;
	const keys = [...query.keys()];
	if (keys.length !== 2 || query.getAll('a').length !== 1 || query.getAll('b').length !== 1) return false;
	const ref = (p: string, r: string) => `${p}:${r}`.toLowerCase();
	return query.get('a')!.toLowerCase() === ref(scope.against.projectId, scope.against.runId) && query.get('b')!.toLowerCase() === ref(scope.projectId, scope.runId);
}

/** The baseline's catchment series the licence-impact board reads (report/impactSeries.ts). */
const AGAINST_SERIES_KEYS: readonly string[] = ['natural_flow', 'ewr_shortfall'];

/** An impact report's read of one of the baseline's AGAINST_SERIES_KEYS: `key` alone, no node. */
function againstSeriesAllowed(scope: RenderScope, path: string, query: URLSearchParams): boolean {
	if (!scope.against) return false;
	if (path.toLowerCase() !== `/projects/${scope.against.projectId}/runs/${scope.against.runId}/series`.toLowerCase()) return false;
	const keys = [...query.keys()];
	return keys.length === 1 && keys[0] === 'key' && AGAINST_SERIES_KEYS.includes(query.get('key')!);
}

/** Whether a render session scoped to `scope` may make this request (`query`: its search parameters). */
export function scopeAllows(scope: RenderScope, method: string, path: string, query: URLSearchParams = new URLSearchParams()): boolean {
	if (method !== 'GET') return false;
	if (path === '/auth/me') return true;
	if (path === '/compare/runs') return compareAllowed(scope, query);
	// Encoded characters or empty / dot segments are never in a path the report makes.
	if (/%|\/\/|\/\.{1,2}(\/|$)/.test(path)) return false;
	const m = PROJECT_READ.exec(path);
	if (!m) return false;
	if (againstSeriesAllowed(scope, path, query)) return true;
	if (m[1]!.toLowerCase() !== scope.projectId.toLowerCase()) return false;
	if (m[2] !== undefined) return m[2].toLowerCase() === scope.runId.toLowerCase();
	return true;
}
