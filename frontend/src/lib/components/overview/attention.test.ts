import { describe, expect, it } from 'vitest';
import type { FarmSummary, NetworkNode, ProjectModel, RunSummary, SeriesMeta } from '@water-management/engine';
import type { RunMeta } from '$lib/api/types';
import { fmtPct } from '$lib/format/number';
import { LOW_SUPPLY } from '$lib/components/network/supplyColour';
import { SUPPLY_TARGET } from '$lib/components/runs/results';
import { attention, nameList, runHref, type AttentionInput } from './attention';

const node = (id: string, kind: NetworkNode['kind'] = 'farm', name = id): NetworkNode =>
	({ id, name, kind, downstreamNodeId: kind === 'gauge' ? null : 'g' }) as NetworkNode;

const model = (over: Partial<ProjectModel> = {}): ProjectModel => ({
	nodes: [node('f1', 'farm', 'Upper'), node('f2', 'farm', 'Lower'), node('g', 'gauge', 'Gauge')],
	crops: [{ id: 'c', name: 'Citrus', cropFactor: Array(12).fill(0.7) }],
	cropAreas: [
		{ nodeId: 'f1', cropId: 'c', areaM2: 100_000 },
		{ nodeId: 'f2', cropId: 'c', areaM2: 50_000 }
	],
	transfers: [],
	...over
});

const run: RunMeta = {
	id: 'r/1',
	label: 'Baseline',
	engineVersion: '0.30.0',
	startDate: '2026-06-01',
	endDate: '2026-09-20',
	createdAt: '2026-09-20T10:00:00Z',
	createdBy: null,
	legacy: false
};

const farm = (name: string, fraction: number): FarmSummary => ({
	nodeId: name,
	name,
	avgDemandM3Day: 100,
	avgSuppliedM3Day: 100 * fraction,
	avgDeficitM3Day: 100 * (1 - fraction),
	fractionSupplied: fraction,
	avgEwrShortfallM3Day: 0,
	daysEwrNotMet: 0
});

const summary = (farms: FarmSummary[], warnings: string[] = []): RunSummary => ({ farms, warnings }) as unknown as RunSummary;

// Rain up to the day the run ends, updated before it: current for the run.
const rain = (startDate: string, length: number, over: Partial<SeriesMeta & { updatedAt: string }> = {}) =>
	({ id: `s-${startDate}`, kind: 'rain_catchment_mm', name: 'Catchment rain', unit: 'mm', startDate, length, ...over }) as SeriesMeta;

const base = (over: Partial<AttentionInput> = {}): AttentionInput => ({
	model: model(),
	series: [rain('2026-06-01', 112)], // ends 2026-09-20
	latest: run,
	summary: summary([farm('Upper', 1), farm('Lower', 1)]),
	today: '2026-09-23',
	...over
});

const target = fmtPct(SUPPLY_TARGET, 0);

describe('attention', () => {
	it('is empty for a healthy project (the panel hides)', () => {
		expect(attention(base())).toEqual([]);
	});

	it('names the worst-supplied farm and links to the run', () => {
		const one = attention(base({ summary: summary([farm('Upper', 1), farm('Lower', 0.6)]) }));
		expect(one).toEqual([
			{
				id: 'short-farms',
				title: `1 of 2 units below ${target}`,
				tone: 'danger',
				text: `Lower got 60% of its demand in the latest run, below the ${target} target.`,
				action: 'See the unit results',
				href: '?tab=supply&run=r%2F1&unit=Lower'
			}
		]);
		const two = attention(base({ summary: summary([farm('Upper', 0.9), farm('Lower', 0.5), farm('Mid', 1)]) }));
		expect(two[0]!.text).toBe(`Lower got 50% of its demand in the latest run, the least of the 2 units below ${target} (of 3).`);
		expect(two[0]!.title).toBe(`2 of 3 units below ${target}`);
	});

	it('colours the short-farms card red when the worst farm is in the lowest supply band, amber above it', () => {
		expect(attention(base({ summary: summary([farm('Upper', LOW_SUPPLY - 0.01)]) }))[0]!.tone).toBe('danger');
		expect(attention(base({ summary: summary([farm('Upper', LOW_SUPPLY)]) }))[0]!.tone).toBe('warning');
	});

	it("adds the short farm's planted areas when it is still a farm in the model", () => {
		const f = (nodeId: string, fraction: number) => ({ ...farm(nodeId, fraction), name: nodeId === 'f2' ? 'Lower' : 'Upper' });
		const [item] = attention(base({ summary: summary([f('f1', 1), f('f2', 0.6)]) }));
		expect(item).toMatchObject({ id: 'short-farms', href: '?tab=supply&run=r%2F1&unit=f2', also: { action: 'Its planted areas', href: '?farm=f2' } });
		// Removed from the model since the run: no link to a farm that isn't there.
		const gone = attention(base({ model: model({ nodes: [node('f1', 'farm', 'Upper'), node('g', 'gauge')] }), summary: summary([f('f1', 1), f('f2', 0.6)]) }));
		expect(gone[0]!.also).toBeUndefined();
	});

	it('uses the supply target, not a fixed figure: a farm just under it is flagged, one at it is not', () => {
		expect(attention(base({ summary: summary([farm('Upper', SUPPLY_TARGET)]) }))).toEqual([]);
		expect(attention(base({ summary: summary([farm('Upper', SUPPLY_TARGET - 0.001)]) }))[0]?.id).toBe('short-farms');
	});

	it('flags the latest run’s warnings', () => {
		expect(attention(base({ summary: summary([farm('Upper', 1)], ['monthly PE is not a number']) }))).toEqual([
			{
				id: 'run-warnings',
				title: 'The latest run has 1 warning',
				tone: 'warning',
				text: 'Monthly PE is not a number',
				action: 'Read it',
				href: runHref('r/1')
			}
		]);
		expect(attention(base({ summary: summary([farm('Upper', 1)], ['a', 'b']) }))[0]).toMatchObject({
			title: 'The latest run has 2 warnings',
			text: 'A (and 1 more)',
			action: 'Read them'
		});
	});

	it('waits for the run summary before the run items, and has none without a run', () => {
		expect(attention(base({ summary: null }))).toEqual([]);
		expect(attention(base({ latest: null, summary: summary([farm('Upper', 0.1)], ['w']) }))).toEqual([]);
	});

	it('flags rainfall the latest run hasn’t used', () => {
		const items = attention(base({ series: [rain('2026-06-01', 114)] })); // ends 2026-09-22, past the run's end
		expect(items.map((i) => i.id)).toEqual(['new-data']);
		expect(items[0]).toMatchObject({
			title: 'New rainfall the run hasn’t used',
			tone: 'info',
			text: '1 rainfall series has data the latest run hasn’t used.',
			href: '?tab=runs'
		});
	});

	it('flags stale input data with its end date and age', () => {
		const items = attention(base({ latest: null, summary: null, series: [rain('2021-10-01', 120)] })); // ends 2022-01-28
		expect(items).toEqual([
			{
				id: 'stale-data',
				title: 'Recorded rain ends 4 years ago',
				tone: 'warning',
				text: 'The newest recorded rain ends 28 Jan 2022 (4 years ago), more than 7 days ago.',
				action: 'Add data',
				href: '?tab=series'
			}
		]);
		// 7 days old is still fresh; 8 is not.
		expect(attention(base({ latest: null, series: [rain('2026-09-16', 1)] }))).toEqual([]);
		expect(attention(base({ latest: null, series: [rain('2026-09-15', 1)] }))[0]?.id).toBe('stale-data');
	});

	it('waits for the series list, and says nothing about data when there is none (the checklist does)', () => {
		expect(attention(base({ series: null }))).toEqual([]);
		expect(attention(base({ series: [] }))).toEqual([]);
	});

	it('names farms with no planted area once something is planted', () => {
		const m = model({ cropAreas: [{ nodeId: 'f1', cropId: 'c', areaM2: 100_000 }, { nodeId: 'f2', cropId: 'c', areaM2: 0 }] });
		expect(attention(base({ model: m }))).toEqual([
			{
				id: 'unplanted',
				title: '1 unit with no planted area',
				tone: 'info',
				text: 'Lower has no planted area, so it draws no irrigation water.',
				action: 'Set its planted areas',
				href: '?farm=f2'
			}
		]);
		const more = model({
			nodes: [...model().nodes, node('f3', 'farm', 'A'), node('f4', 'farm', 'B'), node('f5', 'farm', '')],
			cropAreas: [{ nodeId: 'f1', cropId: 'c', areaM2: 1 }]
		});
		expect(attention(base({ model: more }))[0]).toMatchObject({
			title: '4 units with no planted area',
			text: 'Lower, A, B and 1 more have no planted area, so they draw no irrigation water.',
			action: 'Set crop areas',
			href: '?tab=crops'
		});
		// Nothing planted at all: the setup checklist's crops step covers it.
		expect(attention(base({ model: model({ cropAreas: [] }) }))).toEqual([]);
	});

	it('orders run items first, then data, then the model', () => {
		const m = model({ cropAreas: [{ nodeId: 'f1', cropId: 'c', areaM2: 1 }] });
		const items = attention({
			model: m,
			series: [rain('2021-10-01', 200, { updatedAt: '2026-09-21T00:00:00Z' })],
			latest: run,
			summary: summary([farm('Upper', 0.5)], ['w']),
			today: '2026-09-23'
		});
		expect(items.map((i) => i.id)).toEqual(['short-farms', 'run-warnings', 'new-data', 'stale-data', 'unplanted']);
	});
});

describe('nameList', () => {
	it('joins names in plain English', () => {
		expect(nameList([])).toBe('');
		expect(nameList(['A'])).toBe('A');
		expect(nameList(['A', 'B'])).toBe('A and B');
		expect(nameList(['A', 'B', 'C'])).toBe('A, B and C');
		expect(nameList(['A', 'B', 'C', 'D', 'E'])).toBe('A, B, C and 2 more');
	});
});
