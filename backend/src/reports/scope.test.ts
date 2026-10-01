// What a render session may read (reports/scope.ts): the report route's own
// requests for its one project and run, and nothing else.
import { describe, expect, it } from 'vitest';
import { scopeAllows } from './scope.js';

const P = '11111111-1111-4111-8111-111111111111';
const R = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const scope = { projectId: P, runId: R };

describe('scopeAllows', () => {
	it.each([
		'/auth/me',
		`/projects/${P}`,
		`/projects/${P}/`,
		`/projects/${P}/series`,
		`/projects/${P}/runs/${R}`,
		`/projects/${P}/runs/${R}/series`,
		`/projects/${P}/runs/${R}/day`,
		`/projects/${P}/runs/${R}/signoffs`,
		`/projects/${P}/runs/${R}/publication`,
		`/projects/${P.toUpperCase()}/runs/${R.toUpperCase()}`
	])('allows GET %s (the report page’s reads)', (path) => {
		expect(scopeAllows(scope, 'GET', path)).toBe(true);
	});

	it.each([
		`/projects/${OTHER}`,
		`/projects/${OTHER}/series`,
		`/projects/${P}/runs/${OTHER}`,
		`/projects/${P}/runs/${OTHER}/series`,
		`/projects/${P}/runs`,
		`/projects/${P}/members`,
		// The project's publication list (notes, the whole history): the report reads its run's own place instead.
		`/projects/${P}/publication`,
		`/projects/${P}/runs/${OTHER}/publication`,
		`/projects/${P}/model`,
		`/projects/${P}/series/${OTHER}`,
		`/projects/${P}/export.json`,
		`/projects/${P}/jobs`,
		`/projects/${P}/reports/${OTHER}`,
		// The run's reads the report page doesn't make: the session is not a full read of the run.
		`/projects/${P}/runs/${R}/series/bulk`,
		`/projects/${P}/runs/${R}/export/daily.csv`,
		`/projects/${P}/runs/${R}/export/farms.csv`,
		`/projects/${P}/runs/${R}/export/summary.csv`,
		`/projects/${P}/runs/${R}/reproduce`,
		`/projects/${P}/runs/${R}/allocations`,
		`/projects/${P}/runs/${R}/model-input`,
		`/projects/${P}/runs/${R}/uncertainty`,
		`/projects/${P}/runs/${R}/uncertainty/${OTHER}`,
		`/projects/${P}/runs/${R}/changes-since`,
		`/projects/${P}/runs/${R}/days/2020-01-01`,
		`/projects/${P}/runs/${R}/../${OTHER}`,
		`/projects/${P}/runs/${R}/%2e%2e/${OTHER}`,
		`/projects/${P}//runs/${R}`,
		`/projects/${P}/runs/${R}.json`,
		'/projects',
		'/projects/import',
		'/teams',
		`/compare/${P}`,
		'/auth/me/',
		// The data-subject export: a render session never downloads the person's data.
		'/auth/me/export',
		''
	])('refuses GET %s', (path) => {
		expect(scopeAllows(scope, 'GET', path)).toBe(false);
	});

	it.each(['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'])('refuses %s, even on the allowed paths', (method) => {
		expect(scopeAllows(scope, method, `/projects/${P}`)).toBe(false);
		expect(scopeAllows(scope, method, `/projects/${P}/runs/${R}`)).toBe(false);
		expect(scopeAllows(scope, method, '/auth/me')).toBe(false);
	});
});

describe('scopeAllows, for an impact report (082)', () => {
	const BP = '44444444-4444-4444-8444-444444444444';
	const BR = '55555555-5555-4555-8555-555555555555';
	const impact = { ...scope, against: { projectId: BP, runId: BR } };
	const q = (s: string) => new URLSearchParams(s);
	const pair = `a=${BP}:${BR}&b=${P}:${R}`;

	it('allows exactly the one comparison, baseline first (positive control), and still the report’s own reads', () => {
		expect(scopeAllows(impact, 'GET', '/compare/runs', q(pair))).toBe(true);
		expect(scopeAllows(impact, 'GET', '/compare/runs', q(`b=${P}:${R}&a=${BP.toUpperCase()}:${BR}`))).toBe(true);
		expect(scopeAllows(impact, 'GET', `/projects/${P}/runs/${R}`)).toBe(true);
	});

	it.each([
		['swapped', `a=${P}:${R}&b=${BP}:${BR}`],
		['another baseline', `a=${BP}:${OTHER}&b=${P}:${R}`],
		['another run', `a=${BP}:${BR}&b=${P}:${OTHER}`],
		['a second a', `${pair}&a=${BP}:${OTHER}`],
		['an extra parameter', `${pair}&x=1`],
		['only a', `a=${BP}:${BR}`],
		['nothing', '']
	])('refuses the comparison: %s', (_, query) => {
		expect(scopeAllows(impact, 'GET', '/compare/runs', q(query))).toBe(false);
	});

	it('allows the board’s two baseline series by key (positive control), and no other read of the baseline’s series', () => {
		const series = `/projects/${BP}/runs/${BR}/series`;
		expect(scopeAllows(impact, 'GET', series, q('key=natural_flow'))).toBe(true);
		expect(scopeAllows(impact, 'GET', series, q('key=ewr_shortfall'))).toBe(true);
		expect(scopeAllows(impact, 'GET', `/projects/${BP.toUpperCase()}/runs/${BR.toUpperCase()}/series`, q('key=natural_flow'))).toBe(true);
		for (const query of ['key=simulated_outflow', 'key=supplied', 'key=natural_flow&nodeId=x', 'key=natural_flow&key=ewr_shortfall', '', 'nodeId=x']) {
			expect(scopeAllows(impact, 'GET', series, q(query))).toBe(false);
		}
		expect(scopeAllows(impact, 'GET', `/projects/${BP}/runs/${BR}/day`, q('key=natural_flow'))).toBe(false);
		expect(scopeAllows(impact, 'GET', `/projects/${BP}/runs/${OTHER}/series`, q('key=natural_flow'))).toBe(false);
		expect(scopeAllows(impact, 'GET', `/projects/${BP}/series`, q('key=natural_flow'))).toBe(false);
		expect(scopeAllows(impact, 'POST', series, q('key=natural_flow'))).toBe(false);
		// A plain report's session has no baseline to read.
		expect(scopeAllows(scope, 'GET', series, q('key=natural_flow'))).toBe(false);
	});

	it('never reads the baseline’s project or run directly, and a plain report never compares', () => {
		expect(scopeAllows(impact, 'GET', `/projects/${BP}`)).toBe(false);
		expect(scopeAllows(impact, 'GET', `/projects/${BP}/runs/${BR}`)).toBe(false);
		expect(scopeAllows(impact, 'POST', '/compare/runs', q(pair))).toBe(false);
		expect(scopeAllows(impact, 'GET', '/compare/runs/', q(pair))).toBe(false);
		expect(scopeAllows(scope, 'GET', '/compare/runs', q(pair))).toBe(false);
	});
});

describe('scopeAllows, for an evidence pack (119_pack_render)', () => {
	const K = '44444444-4444-4444-8444-444444444444';
	const pack = { projectId: P, packId: K };

	it.each(['/auth/me', `/projects/${P}/packs/${K}`, `/projects/${P}/packs/${K}/`, `/projects/${P}/packs/${K}/signoffs`, `/projects/${P.toUpperCase()}/packs/${K.toUpperCase()}`])(
		'allows GET %s (the pack page’s reads)',
		(path) => {
			expect(scopeAllows(pack, 'GET', path)).toBe(true);
		}
	);

	it.each([
		// The pack's own writes and its PDF download.
		`/projects/${P}/packs/${K}/pdf`,
		`/projects/${P}/packs/${K}/issue`,
		// Another pack of the project, the list, or the same pack under another project.
		`/projects/${P}/packs/${OTHER}`,
		`/projects/${P}/packs/${OTHER}/signoffs`,
		`/projects/${P}/packs`,
		`/projects/${OTHER}/packs/${K}`,
		// Nothing of the project or its runs: the manifest holds the whole report.
		`/projects/${P}`,
		`/projects/${P}/series`,
		`/projects/${P}/runs/${R}`,
		`/projects/${P}/runs/${R}/signoffs`,
		'/compare/runs',
		// Encoded or dot segments.
		`/projects/${P}/packs/${K}/%2e%2e/${OTHER}`,
		`/projects/${P}/packs/${OTHER}/../${K}`,
		`/projects/${P}//packs/${K}`
	])('refuses GET %s', (path) => {
		expect(scopeAllows(pack, 'GET', path)).toBe(false);
	});

	it('refuses every write, and any query on its reads', () => {
		for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) expect(scopeAllows(pack, method, `/projects/${P}/packs/${K}`), method).toBe(false);
		expect(scopeAllows(pack, 'GET', `/projects/${P}/packs/${K}`, new URLSearchParams('x=1'))).toBe(false);
		// Positive control: the same read with no query.
		expect(scopeAllows(pack, 'GET', `/projects/${P}/packs/${K}`, new URLSearchParams())).toBe(true);
	});

	it('a report session never reads a pack', () => {
		expect(scopeAllows(scope, 'GET', `/projects/${P}/packs/${K}`)).toBe(false);
		expect(scopeAllows(scope, 'GET', `/projects/${P}/packs/${K}/signoffs`)).toBe(false);
	});
});

describe("scopeAllows, for an applicant's copy of a pack (165_applicant_copy)", () => {
	const K = '44444444-4444-4444-8444-444444444444';
	const S = '55555555-5555-4555-8555-555555555555';
	const copy = { projectId: P, packId: K, scenarioId: S };

	it.each(['/auth/me', `/projects/${P}/scenarios/${S}/packs/${K}`, `/projects/${P}/scenarios/${S}/packs/${K}/`, `/projects/${P.toUpperCase()}/scenarios/${S.toUpperCase()}/packs/${K}`])(
		'allows GET %s (the applicant pack page’s one read)',
		(path) => {
			expect(scopeAllows(copy, 'GET', path)).toBe(true);
		}
	);

	it.each([
		// The editor's pack page and its sign-offs: the assessors' copy, which names every unit.
		`/projects/${P}/packs/${K}`,
		`/projects/${P}/packs/${K}/signoffs`,
		// Its own download and request, the application, its other packs, another application's or another project's.
		`/projects/${P}/scenarios/${S}/packs/${K}/pdf`,
		`/projects/${P}/scenarios/${S}/packs`,
		`/projects/${P}/scenarios/${S}`,
		`/projects/${P}/scenarios/${OTHER}/packs/${K}`,
		`/projects/${P}/scenarios/${S}/packs/${OTHER}`,
		`/projects/${OTHER}/scenarios/${S}/packs/${K}`,
		`/projects/${P}`,
		`/projects/${P}/scenarios/${S}/packs/${K}/%2e%2e/${OTHER}`,
		`/projects/${P}//scenarios/${S}/packs/${K}`
	])('refuses GET %s', (path) => {
		expect(scopeAllows(copy, 'GET', path)).toBe(false);
	});

	it('refuses every other method and any query; a pack session never reads the applicant page', () => {
		for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) expect(scopeAllows(copy, method, `/projects/${P}/scenarios/${S}/packs/${K}`), method).toBe(false);
		expect(scopeAllows(copy, 'GET', `/projects/${P}/scenarios/${S}/packs/${K}`, new URLSearchParams('x=1'))).toBe(false);
		expect(scopeAllows({ projectId: P, packId: K }, 'GET', `/projects/${P}/scenarios/${S}/packs/${K}`)).toBe(false);
	});
});
