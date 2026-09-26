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
		`/projects/${P}/runs/${R}/series/bulk`,
		`/projects/${P}/runs/${R}/days/2020-01-01`,
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
		`/projects/${P}/model`,
		`/projects/${P}/series/${OTHER}`,
		`/projects/${P}/export.json`,
		`/projects/${P}/jobs`,
		`/projects/${P}/reports/${OTHER}`,
		`/projects/${P}/runs/${R}/../${OTHER}`,
		`/projects/${P}/runs/${R}/%2e%2e/${OTHER}`,
		`/projects/${P}//runs/${R}`,
		`/projects/${P}/runs/${R}.json`,
		'/projects',
		'/projects/import',
		'/teams',
		`/compare/${P}`,
		'/auth/me/',
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
