// Where a navigation goes, in the words of the leave guard's question
// ("Leave and go to All projects?", leaveGuard.ts): the sidebar's names for
// the app's pages, and a workspace section's own label within a project
// ("the Network page").
import { TAB_LABELS, type TabId } from '$lib/workspace/tabs';

// The workspace page's friendlier ?tab= spellings (routes/projects/[id]/+page.svelte TAB_ALIASES) that matter here.
const TAB_ALIASES: Record<string, TabId> = { summary: 'overview', data: 'series', results: 'runs', reserve: 'river', details: 'project' };

/** The destination's name, as the question words it ("All projects", "the Network page"). */
export function destinationName(from: URL, to: URL, base = ''): string {
	const path = to.pathname.startsWith(base) ? to.pathname.slice(base.length) || '/' : to.pathname;
	const project = /^\/projects\/([^/]+)\/?$/.exec(path);
	if (project) {
		const fromProject = /^\/projects\/([^/]+)\/?$/.exec(from.pathname.slice(base.length));
		if (fromProject?.[1] !== project[1]) return 'another project';
		const raw = to.searchParams.get('tab') ?? '';
		const id = (TAB_ALIASES[raw] ?? raw) as TabId;
		const label = TAB_LABELS[id] ?? TAB_LABELS.overview;
		const scenarioChange = id === 'scenarios' && from.searchParams.get('tab') === 'scenarios';
		return scenarioChange ? 'another scenario' : `the ${label} page`;
	}
	if (path === '/') return 'All projects';
	if (path === '/teams' || path === '/teams/') return 'Teams';
	if (path.startsWith('/teams/')) return 'the team’s page';
	if (path.startsWith('/help')) return 'Help';
	if (path.startsWith('/account')) return 'your account';
	if (path.startsWith('/compare')) return 'Compare runs';
	if (path.startsWith('/login')) return 'the sign-in page';
	if (path.startsWith('/farm')) return 'the farm view';
	return 'another page';
}
