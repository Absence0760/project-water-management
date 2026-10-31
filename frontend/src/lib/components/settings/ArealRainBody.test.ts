// The areal rainfall correction's body (ArealRainBody.svelte), rendered with Svelte's server renderer: the "from a
// MAP" helper (ArealMapHelper.svelte) is offered to an editor, closed, with nothing worked out until the rain is
// read, and never to a viewer. The helper's sums are arealFromMap.test.ts's.
import { render } from 'svelte/server';
import { describe, expect, it, vi } from 'vitest';
import type { ProjectSettings } from '@water-management/engine';
import ArealRainBody from './ArealRainBody.svelte';

vi.mock('$app/paths', () => ({ resolve: (p: string) => `/${p}`, asset: (f: string) => `/${f}` }));
vi.mock('$app/state', () => ({ page: { url: new URL('http://localhost/') } }));
vi.mock('$app/env/public', () => ({ PUBLIC_API_URL: 'http://localhost:3001' }));

const value = { factors: new Array(12).fill(1.2), method: 'map', source: 'invented' } as unknown as ProjectSettings['arealRain'];
const settings = () => ({}) as ProjectSettings;

describe('ArealRainBody', () => {
	it('offers an editor the MAP helper, closed, with Use waiting for the rain', () => {
		const html = render(ArealRainBody, { props: { value, projectId: 'p1', settings } }).body;
		expect(html).toContain('data-testid="areal-map-helper"');
		expect(html).toMatch(/<details class="fold[^"]*" data-testid="areal-map-helper"(?![^>]*open)/);
		expect(html).toContain('Work it out from a MAP:');
		expect(html).not.toContain('data-testid="areal-map-result"');
		expect(html.match(/<button[^>]*data-testid="areal-map-apply"[^>]*>/)?.[0]).toContain('disabled');
		expect(html).toContain('Work the factor out first.');
	});

	it('leaves it out read-only, and without the project to read the rain from', () => {
		expect(render(ArealRainBody, { props: { value, projectId: 'p1', settings, readonly: true } }).body).not.toContain('areal-map-helper');
		expect(render(ArealRainBody, { props: { value } }).body).not.toContain('areal-map-helper');
	});
});
