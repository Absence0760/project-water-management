// The drought badge's markup on the project list and the team page (issue #620, docs/ui.md § Project list),
// rendered with Svelte's server renderer: the words carry the class, the tooltip and a screen reader get the
// value and the months, and a run without an index says so; no run, no badge. droughtTag's own cases are in
// portfolio.test.ts; e2e/tests/projects.spec.ts pins it in the browser.
import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import type { PortfolioProject } from '#lib/api/types.js';
import DroughtTag from './DroughtTag.svelte';
import { withoutComments } from '../__fixtures__/withoutComments';

type P = Pick<PortfolioProject, 'drought' | 'source'>;
const html = (p: P) => withoutComments(render(DroughtTag, { props: { p } }).body);

const dry: P = { source: 'run', drought: { month: '2026-08', driest: { kind: 'spei', scale: 12, value: -1.6249, class: 'severely-dry', from: '2025-09' } } };

describe('DroughtTag', () => {
	it('names the class and the index, coloured by its tone, with the value and months for the tooltip and a screen reader', () => {
		const h = html(dry);
		expect(h).toContain('data-testid="drought-tag"');
		expect(h).toContain('data-tone="dry"');
		expect(h).toMatch(/class="badge drought tone-dry[^"]*"/);
		expect(h).toContain('Severely dry · SPEI-12');
		const title = 'Severely dry: SPEI-12 −1.62 over Sep 2025 – Aug 2026, the driest index for the run’s last whole month';
		expect(h).toContain(`title="${title}"`);
		expect(h).toContain(`<span class="visually-hidden">. ${title}</span>`);
	});

	it('a wet month reads wet', () => {
		const h = html({ source: 'published', drought: { month: '2026-08', driest: { kind: 'spi', scale: 3, value: 1.2, class: 'moderately-wet', from: '2026-06' } } });
		expect(h).toContain('data-tone="wet"');
		expect(h).toContain('Moderately wet · SPI-3');
	});

	it('a run with no index, or from before the badge, shows a muted dash that says why', () => {
		const old = html({ source: 'run', drought: null });
		expect(old).toContain('data-tone="none"');
		expect(old).toContain('Drought –');
		expect(old).toContain('title="No drought index for this run"');
		expect(old).not.toContain('badge');
		const short = html({ source: 'run', drought: { month: '2026-08', driest: null, gap: 'short-record' } });
		expect(short).toContain('title="No drought index for this run: a fit needs at least 20 years of rain in each calendar month"');
	});

	it('draws nothing for a project with no run', () => {
		expect(html({ source: null, drought: null }).trim()).toBe('');
	});
});
