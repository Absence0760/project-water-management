// The diversion curve's fields on a river off-take's card (engine 1.113.0), rendered with Svelte's server
// renderer: each field named for its rule, the unit and basis picks, and the preview table once the curve is
// complete (a prompt until then).
import { render } from 'svelte/server';
import { describe, expect, it, vi } from 'vitest';
import type { Transfer } from '@water-management/engine';
import DiversionCurveFields from './DiversionCurveFields.svelte';

// HelpTip links to the glossary under the app's base path.
vi.mock('$app/paths', () => ({ resolve: (p: string) => `/${p}`, asset: (f: string) => `/${f}` }));

const rule = (over: Partial<Transfer> = {}): Transfer => ({
	id: 't',
	fromNodeId: 'a',
	toNodeId: 'b',
	months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
	maxRateM3s: 0.25,
	dailyCapM3: null,
	minStoragePct: 0,
	enabled: true,
	priority: 0,
	source: 'river',
	sizing: 'diversionCurve',
	diversionCoefficient: 2000,
	diversionExponent: -0.9,
	diversionMaxPct: 0.95,
	diversionFlowUnit: 'm3/s',
	...over
});

describe('DiversionCurveFields', () => {
	it('names each field for its rule and shows what it diverts at a few flows, and which limit binds', () => {
		const html = render(DiversionCurveFields, { props: { rule: rule(), label: 'transfer 2' } }).body;
		// Each month's a, b and largest share are in the month table (TakesByMonth, engine 1.114.0); the unit and basis are here.
		for (const name of ['x in, flow unit of transfer 2', 'x is, the flow the curve of transfer 2 reads'])
			expect(html, name).toContain(`aria-label="${name}"`);
		expect(html).toContain('data-testid="diversion-preview"');
		expect(html).toMatch(/the canal takes\s+up to 0\.25 m³\/s/);
		// The header names the flow unit picked; matched whatever scoped class the component's CSS gives the cell.
		expect(html).toMatch(/<th scope="col"(?: class="[^"]*")?>River, m³\/s<\/th>/);
		expect(html).toContain('the canal’s capacity');
		expect(html).toContain('the largest share');
		expect(html).not.toContain('data-testid="diversion-preview-empty"');
	});

	it('previews each formula of a rule by month, naming its months, and what each destination of a split gets', () => {
		const m = (coefficient: number) => ({ coefficient, exponent: -0.9, maxPct: 0.95 });
		const html = render(DiversionCurveFields, {
			props: {
				rule: rule({
					diversionCoefficient: null,
					diversionExponent: null,
					diversionMaxPct: null,
					monthlyDiversion: [m(2000), m(2000), m(2000), m(1000), m(1000), m(1000), null, null, null, null, null, null],
					lossPct: 0.1,
					toNodeId: 'b',
					destinations: [
						{ nodeId: 'b', pct: 0.4 },
						{ nodeId: 'c', pct: 0.6 }
					]
				}),
				label: 'transfer 1',
				name: (id: string | null) => (id === 'b' ? 'Canal farmers' : 'Town')
			}
		}).body;
		expect(html.match(/data-testid="diversion-preview"/g)).toHaveLength(2);
		expect(html).toContain('(Oct–Dec)');
		expect(html).toContain('(Jan–Mar)');
		expect(html).toContain('then after its losses split between its destinations');
		expect(html).toMatch(/<th scope="col"(?: class="[^"]*")?>To Canal farmers \(40%\), m³\/s<\/th>/);
		expect(html).toMatch(/<th scope="col"(?: class="[^"]*")?>To Town \(60%\), m³\/s<\/th>/);
	});

	it('says the preview reads the river itself when x is the natural flow', () => {
		const html = render(DiversionCurveFields, { props: { rule: rule({ diversionFlowBasis: 'natural' }), label: 'transfer 1' } }).body;
		expect(html).toContain('with x the river itself (the natural flow is at least this)');
	});

	it('asks for the curve while it is incomplete, with the unit to choose', () => {
		const html = render(DiversionCurveFields, { props: { rule: rule({ diversionFlowUnit: null }), label: 'transfer 1' } }).body;
		expect(html).toContain('data-testid="diversion-preview-empty"');
		expect(html).toContain('— choose —');
		expect(html).not.toContain('data-testid="diversion-preview"');
	});
});
