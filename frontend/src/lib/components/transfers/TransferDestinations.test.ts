// A transfer split between destinations and a maximum or a formula by month
// (engine 1.114.0), on a transfer's card, rendered with Svelte's server
// renderer: each field named for its rule and its row, the running total, and
// a rule stored by engine 1.113.0 with one curve shown in every month.
import { render } from 'svelte/server';
import { describe, expect, it, vi } from 'vitest';
import type { Transfer } from '@water-management/engine';
import TakesByMonth from './TakesByMonth.svelte';
import TransferDestinations from './TransferDestinations.svelte';

// HelpTip links to the glossary under the app's base path.
vi.mock('$app/paths', () => ({ resolve: (p: string) => `/${p}`, asset: (f: string) => `/${f}` }));

const rule = (over: Partial<Transfer> = {}): Transfer => ({
	id: 't',
	fromNodeId: 's',
	toNodeId: 'a',
	months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
	maxRateM3s: 0.25,
	dailyCapM3: null,
	minStoragePct: 0,
	enabled: true,
	priority: 0,
	source: 'river',
	sizing: 'capacity',
	...over
});
const units = [
	{ id: 's', name: 'River farm' },
	{ id: 'a', name: 'Canal farmers' },
	{ id: 'b', name: 'Town' }
];
const name = (id: string | null) => (id === null ? 'Outside the catchment' : (units.find((u) => u.id === id)?.name ?? id));

describe('TransferDestinations', () => {
	const split = (pcts: [number, number]) =>
		rule({
			destinations: [
				{ nodeId: 'a', pct: pcts[0] },
				{ nodeId: 'b', pct: pcts[1] }
			]
		});

	it('names each row’s unit, share and remove for its rule, and totals the shares', () => {
		const html = render(TransferDestinations, { props: { rule: split([0.4, 0.6]), label: 'transfer 2', units, name } }).body;
		for (const label of ['Destination 1 of transfer 2', 'Destination 2 of transfer 2', 'Share of destination 1 of transfer 2, %', 'Remove destination 2 (Town) of transfer 2']) expect(html, label).toContain(`aria-label="${label}"`);
		expect(html).toMatch(/data-testid="split-total"[^>]*>100 %</);
		expect(html).not.toContain('must be 100 %');
		// A river off-take can't send a share out of the catchment; the source is never a destination.
		expect(html).not.toContain('Outside the catchment</option>');
		expect(html).toMatch(/<option value="s" disabled[^>]*>River farm<\/option>/);
		expect(html).toContain('+ Add a destination');
	});

	it('says, live, when the shares don’t add up to 100 %', () => {
		const html = render(TransferDestinations, { props: { rule: split([0.4, 0.5]), label: 'transfer 1', units, name } }).body;
		expect(html).toMatch(/data-testid="split-total"[^>]*aria-live="polite"[^>]*>90 %, must be 100 %</);
	});

	it('offers outside the catchment on a dam rule, and no add past five', () => {
		const five = rule({ source: 'dam', destinations: ['a', 'b', 'c', 'd', 'e'].map((nodeId) => ({ nodeId, pct: 0.2 })) });
		const html = render(TransferDestinations, { props: { rule: five, label: 'transfer 1', units, name } }).body;
		expect(html).toContain('Outside the catchment</option>');
		expect(html).not.toContain('+ Add a destination');
		expect(html).toContain('At most 5 destinations.');
	});
});

describe('TakesByMonth', () => {
	it('shows a rule with one curve (engine 1.113.0) as that formula in every month, each field named for its month', () => {
		const html = render(TakesByMonth, {
			props: { rule: rule({ sizing: 'diversionCurve', diversionCoefficient: 2000, diversionExponent: -0.9, diversionMaxPct: 0.95, diversionFlowUnit: 'm3/s' }), label: 'transfer 3' }
		}).body;
		expect(html).toContain('A formula every month');
		for (const label of ['Takes in Oct, transfer 3', 'Canal capacity of transfer 3 in Oct, m³/s', 'Coefficient a of transfer 3 in Jan', 'Exponent b of transfer 3 in Sep', 'Largest share of transfer 3 in Mar, %'])
			expect(html, label).toContain(`aria-label="${label}"`);
		expect(html).toContain('Apply to every month');
	});

	it('shows a mix: a formula month beside a maximum month, the maximum with its rate alone', () => {
		const c = { coefficient: 50, exponent: 0, maxPct: null };
		const html = render(TakesByMonth, { props: { rule: rule({ sizing: 'diversionCurve', diversionFlowUnit: 'm3/s', monthlyDiversion: [c, ...new Array(11).fill(null)] }), label: 'transfer 1' } }).body;
		expect(html).toContain('A formula in 1 month, a maximum in 11');
		expect(html).toContain('aria-label="Coefficient a of transfer 1 in Oct"');
		expect(html).not.toContain('aria-label="Coefficient a of transfer 1 in Nov"');
		expect(html).toContain('aria-label="Max rate of transfer 1 in Nov, m³/s"');
		expect(html).toContain('up to the rate');
	});
});
