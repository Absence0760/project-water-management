import type { CurtailmentFarm, FarmSummary, RunSummary, SupplyReliability } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import type { RunMeta } from '$lib/api/types';
import { supplyBars } from '$lib/components/overview/supplyBars';
import { SUPPLY_TARGET } from '$lib/components/runs/results';
import { SUPPLY_ANCHORS, supplyAnchor, supplyHref } from './links';
import { cardFacts, daysShort, pickUnit, previousRunOf, shortRanges, supplyNav, supplySummary, supplyTotals, unitCards, weekText, weekWindow, type UnitCard } from './supply';

const farm = (nodeId: string, fraction: number, demand = 100): FarmSummary => ({
	nodeId,
	name: nodeId,
	avgDemandM3Day: demand,
	avgSuppliedM3Day: demand * fraction,
	avgDeficitM3Day: demand * (1 - fraction),
	fractionSupplied: fraction,
	avgEwrShortfallM3Day: 0,
	daysEwrNotMet: 0
});
const summary = (farms: FarmSummary[], extra: Partial<RunSummary> = {}) => ({ farms, ...extra }) as Pick<RunSummary, 'farms' | 'supplyAssurance' | 'curtailment'>;
const meta = (id: string, createdAt: string) => ({ id, createdAt, label: id }) as RunMeta;

describe('links', () => {
	it('builds the page link with the run, window, hydrological unit and anchor', () => {
		expect(supplyHref(null)).toBe('?tab=supply');
		expect(supplyHref('r/1')).toBe('?tab=supply&run=r%2F1');
		expect(supplyHref('r1', { window: 'last7', hash: 'res-curtailment' })).toBe('?tab=supply&run=r1&window=last7#res-curtailment');
		expect(supplyHref('r1', { unit: 'f2' })).toBe('?tab=supply&run=r1&unit=f2');
	});

	it('knows the anchors that moved from Runs & results, and no others', () => {
		for (const a of SUPPLY_ANCHORS) expect(supplyAnchor(a)).toBe(true);
		for (const a of ['res-summary', 'res-notes', 'res-ewr', 'res-units', '']) expect(supplyAnchor(a)).toBe(false);
	});

	it('the On this page menu links every panel, in page order, and nothing else', () => {
		expect(supplyNav(true).flatMap((g) => g.sections.map((s) => s.id))).toEqual([...SUPPLY_ANCHORS]);
		expect(supplyNav(true).map((g) => g.label)).toEqual(['Each hydrological unit', 'Tables for this run']);
		// Other water uses only when the run has demand objects or other water users (the page shows the panel only then).
		expect(supplyNav(false).flatMap((g) => g.sections.map((s) => s.id))).toEqual(SUPPLY_ANCHORS.filter((a) => a !== 'res-users'));
	});
});

describe('previousRunOf', () => {
	const runs = [meta('b', '2026-02-01T00:00:00Z'), meta('c', '2026-03-01T00:00:00Z'), meta('a', '2026-01-01T00:00:00Z')];
	it('is the run made just before, by createdAt, whatever the list order', () => {
		expect(previousRunOf(runs, 'c')?.id).toBe('b');
		expect(previousRunOf(runs, 'b')?.id).toBe('a');
	});
	it('is null for the oldest run, an unknown id or no runs', () => {
		expect(previousRunOf(runs, 'a')).toBeNull();
		expect(previousRunOf(runs, 'x')).toBeNull();
		expect(previousRunOf(null, 'a')).toBeNull();
	});
});

describe('this week', () => {
	it('is the run’s last 7 days, as the reporting window’s Last 7 days', () => {
		expect(weekWindow({ startDate: '2022-01-01', endDate: '2022-01-28' })).toMatchObject({ reportStart: '2022-01-22', reportEnd: '2022-01-28', from: 21, to: 27, days: 7 });
		// A run shorter than a week: all of it.
		expect(weekWindow({ startDate: '2022-01-01', endDate: '2022-01-03' })).toMatchObject({ from: 0, to: 2, days: 3 });
		// A forecast run: the 7 days before the forecast, never forecast days read as this week (issue #51).
		expect(weekWindow({ startDate: '2022-01-01', endDate: '2022-01-28', forecastFrom: '2022-01-15' })).toMatchObject({ reportStart: '2022-01-08', reportEnd: '2022-01-14', from: 7, to: 13, days: 7 });
	});
	it('counts the days with a deficit above noise, nulls and float dust not counted', () => {
		const d = [5, 0, 1e-9, null, 2, 3, 0.5, 9];
		expect(daysShort(d, 1, 6)).toBe(3);
		expect(daysShort(d, 0, 100)).toBe(5);
		expect(daysShort(d, -3, 0)).toBe(1);
	});
	it('shades the runs of short days as inclusive date ranges', () => {
		expect(shortRanges({ startDate: '2022-01-01', values: [1, 1, 0, null, 2, 1e-9, 3] })).toEqual([
			{ start: '2022-01-01', end: '2022-01-02' },
			{ start: '2022-01-05', end: '2022-01-05' },
			{ start: '2022-01-07', end: '2022-01-07' }
		]);
		expect(shortRanges({ startDate: '2022-01-01', values: [] })).toEqual([]);
	});
});

describe('unitCards', () => {
	const farms = [farm('ok', 1), farm('worst', 0.4), farm('mid', 0.8), farm('dry', 0, 0), farm('tie-b', 0.8)];
	const ids = new Set(['ok', 'worst', 'mid', 'tie-b']);
	const names = new Map([['worst', 'Worst farm (renamed)'], ['dry', 'Dry today']]);

	it('orders worst supplied first, ties by name, hydrological units without demand last', () => {
		expect(unitCards(summary(farms), ids, names, null).map((c) => c.nodeId)).toEqual(['worst', 'mid', 'tie-b', 'ok', 'dry']);
	});

	it('bands each hydrological unit as the Summary’s Supply by hydrological unit does, so the colours match', () => {
		const cards = unitCards(summary(farms), ids, names, null);
		const bars = new Map(supplyBars(farms, ids).map((b) => [b.nodeId, b.band]));
		for (const c of cards) expect(c.band).toBe(bars.get(c.nodeId));
		expect(cards.find((c) => c.nodeId === 'worst')).toMatchObject({ band: 'low', fraction: 0.4 });
		expect(cards.find((c) => c.nodeId === 'dry')).toMatchObject({ band: 'none', fraction: null });
	});

	it('names a hydrological unit still in the model by today’s name, a removed one by the run’s', () => {
		const cards = unitCards(summary(farms), ids, names, null);
		expect(cards.find((c) => c.nodeId === 'worst')).toMatchObject({ name: 'Worst farm (renamed)', inModel: true });
		expect(cards.find((c) => c.nodeId === 'dry')).toMatchObject({ name: 'dry', inModel: false });
	});

	it('takes the days short from assurance of supply, the cut from the curtailment table and the week from the deficits', () => {
		const rel = [
			{ nodeId: 'worst', kind: 'farm', demandDays: 30, metDays: 12 },
			{ nodeId: 'worst', kind: 'user', demandDays: 99, metDays: 0 }
		] as SupplyReliability[];
		const cut = [
			{ nodeId: 'worst', totalChangeM3Day: -25 },
			{ nodeId: 'mid', totalChangeM3Day: 4 }
		] as CurtailmentFarm[];
		const s = summary(farms, { supplyAssurance: { reliability: rel } as RunSummary['supplyAssurance'], curtailment: { farms: cut } as unknown as RunSummary['curtailment'] });
		const cards = unitCards(s, ids, names, new Map([['worst', 3]]));
		expect(cards.find((c) => c.nodeId === 'worst')).toMatchObject({ daysShort: 18, demandDays: 30, cutM3Day: 25, weekShort: 3 });
		expect(cards.find((c) => c.nodeId === 'mid')).toMatchObject({ daysShort: null, cutM3Day: 0, weekShort: null });
		// An older run without the tables: nothing made up.
		expect(unitCards(summary(farms), ids, names, null).find((c) => c.nodeId === 'worst')).toMatchObject({ daysShort: null, cutM3Day: null });
	});
});

describe('pickUnit', () => {
	const cards = unitCards(summary([farm('a', 1), farm('b', 0.5)]), new Set(['a', 'b']), new Map(), null);
	it('is the hydrological unit the URL names, else the worst supplied', () => {
		expect(pickUnit(cards, 'a')?.nodeId).toBe('a');
		expect(pickUnit(cards, null)?.nodeId).toBe('b');
		expect(pickUnit(cards, 'gone')?.nodeId).toBe('b');
		expect(pickUnit([], 'a')).toBeNull();
	});
});

describe('supplyTotals', () => {
	const farms = [farm('a', 1), farm('b', 0.5), farm('c', SUPPLY_TARGET - 0.001)];
	const s = summary(farms, { curtailment: { farms: [{ nodeId: 'b', totalChangeM3Day: -1 }] } as unknown as RunSummary['curtailment'] });
	it('counts the hydrological units below the target (as the Summary), and short this week, and adds up the shortfall', () => {
		const cards = unitCards(s, new Set(), new Map(), new Map([['b', 2], ['a', 0]]));
		const t = supplyTotals(s, cards, true);
		expect(t).toMatchObject({ units: 3, below: 2, weekShort: 1 });
		expect(t.shortfallM3Day).toBeCloseTo(50 + 100 * (1 - (SUPPLY_TARGET - 0.001)));
		expect(t.shortfallMm3a).toBeCloseTo((t.shortfallM3Day * 365.25) / 1e6);
	});
	it('leaves this week unknown until the deficits are in', () => {
		const t = supplyTotals(summary(farms), unitCards(summary(farms), new Set(), new Map(), null), false);
		expect(t.weekShort).toBeNull();
	});
});

describe('words', () => {
	it('writes the header line from what is known', () => {
		expect(supplySummary({ units: 14, weekShort: 3 }, 14, 'run “Baseline”, ran today')).toBe('14 hydrological units · 3 short this week · run “Baseline”, ran today');
		expect(supplySummary({ units: 1, weekShort: null }, 1, null)).toBe('1 hydrological unit');
		expect(supplySummary(null, 4, null)).toBe('4 hydrological units');
		// The week is the run's last one: "this week" only while that is current (issue #162).
		expect(supplySummary({ units: 14, weekShort: 3 }, 14, null, { end: '2026-09-25', age: 3 })).toBe('14 hydrological units · 3 short this week');
		expect(supplySummary({ units: 14, weekShort: 3 }, 14, null, { end: '2024-12-31', age: 637 })).toBe('14 hydrological units · 3 short in the week to 31 Dec 2024');
		expect(weekText({ end: '2024-12-31', age: 637 })).toBe('in the week to 31 Dec 2024');
		expect(weekText(null)).toBe('this week');
	});
	it('gives a card its lines, leaving out what the run can’t say', () => {
		const base: UnitCard = { nodeId: 'a', name: 'A', band: 'low', fraction: 0.5, demandM3Day: 100, deficitM3Day: 50, daysShort: 10, demandDays: 30, cutM3Day: 12, weekShort: 2, inModel: true };
		expect(cardFacts(base, 7)).toEqual([
			'Short 50 m³/day on average (0.018 Mm³/a)',
			'10 of 30 demand days short in the reporting window',
			'Short on 2 of the last 7 days',
			'Curtailment: cut 12 m³/day'
		]);
		expect(cardFacts({ ...base, deficitM3Day: 0, daysShort: null, weekShort: 0, cutM3Day: 0 }, 7)).toEqual(['No shortfall on average']);
		expect(cardFacts(base, 7, { end: '2024-12-31', age: 637 })).toContain('Short on 2 of the 7 days to 31 Dec 2024');
		expect(cardFacts({ ...base, fraction: null, band: 'none' }, 7)).toEqual([]);
	});
});
