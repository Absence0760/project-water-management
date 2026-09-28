import { describe, expect, it } from 'vitest';
import { metricDelta, type FarmDelta, type FarmSummary } from '@water-management/engine';
import { farmFeatureMetrics, fmtMetric, formatDelta, nextSort, sortFarms } from './delta';

describe('formatDelta', () => {
	it('signs and arrows volumes with a real minus sign and thousands separators', () => {
		expect(formatDelta(metricDelta(1000, 2234.4), { format: 'volume', better: 'higher' })).toEqual({
			text: '+1\u202f234',
			arrow: '▲',
			tone: 'better',
			label: 'up 1\u202f234, better'
		});
		expect(formatDelta(metricDelta(2000, 800), { format: 'volume', better: 'higher' })).toMatchObject({
			text: '−1\u202f200',
			arrow: '▼',
			tone: 'worse',
			label: 'down 1\u202f200, worse'
		});
	});

	it('uses the metric direction to decide better/worse', () => {
		expect(formatDelta(metricDelta(100, 80), { format: 'volume', better: 'lower' }).tone).toBe('better');
		expect(formatDelta(metricDelta(100, 120), { format: 'days', better: 'lower' }).tone).toBe('worse');
		expect(formatDelta(metricDelta(100, 120), { format: 'volume', better: 'neutral' })).toMatchObject({ tone: 'neutral', label: 'up 20' });
	});

	it('treats closer-to-zero as better for bias-like metrics', () => {
		expect(formatDelta(metricDelta(-12, -5), { format: 'percent', better: 'zero' })).toMatchObject({ text: '+7.0 pp', tone: 'better' });
		expect(formatDelta(metricDelta(3, -8), { format: 'percent', better: 'zero' }).tone).toBe('worse');
	});

	it('treats closer-to-one as better for a frequency bias', () => {
		// Legacy fails the EWR 3× as often as the river, GR4J 0.9×: better.
		expect(formatDelta(metricDelta(3, 0.9), { format: 'ratio', better: 'one', digits: 2 })).toMatchObject({ text: '−2.10', tone: 'better' });
		expect(formatDelta(metricDelta(1.05, 0.5), { format: 'ratio', better: 'one', digits: 2 }).tone).toBe('worse');
		expect(formatDelta(metricDelta(0.5, 1.5), { format: 'ratio', better: 'one', digits: 2 }).tone).toBe('neutral');
		expect(formatDelta(metricDelta(null, 1), { format: 'ratio', better: 'one' }).tone).toBe('neutral');
	});

	it('shows fractions as percentage points', () => {
		expect(formatDelta(metricDelta(0.9, 0.98), { format: 'fraction', better: 'higher' }).text).toBe('+8.0 pp');
	});

	it('shows a change that rounds to zero as "0" with no arrow', () => {
		expect(formatDelta(metricDelta(100, 100.3), { format: 'volume', better: 'higher' })).toEqual({
			text: '0',
			arrow: '',
			tone: 'neutral',
			label: 'no change'
		});
		expect(formatDelta(metricDelta(0.5, 0.50001), { format: 'fraction', better: 'higher' }).text).toBe('0 pp');
	});

	it('shows "–" when either side is missing', () => {
		expect(formatDelta(metricDelta(null, 3), { format: 'ratio', better: 'higher' })).toMatchObject({ text: '–', arrow: '', tone: 'neutral' });
	});
});

describe('fmtMetric', () => {
	it('formats by kind', () => {
		expect(fmtMetric(0.953, { format: 'fraction', better: 'higher' })).toBe('95.3%');
		expect(fmtMetric(12.34, { format: 'percent', better: 'zero' })).toBe('12.3%');
		expect(fmtMetric(0.12345, { format: 'ratio', better: 'higher' })).toBe('0.123');
		expect(fmtMetric(1234567.8, { format: 'volume', better: 'neutral' })).toBe('1\u202f234\u202f568');
		expect(fmtMetric(null, { format: 'volume', better: 'neutral' })).toBe('–');
	});
});

describe('farm table sorting', () => {
	const row = (name: string, supplied: number | null): FarmDelta => {
		const m = metricDelta(0, supplied);
		return {
			name,
			nameA: null,
			nodeIdA: name,
			nodeIdB: name,
			demandM3Day: m,
			suppliedM3Day: m,
			deficitM3Day: m,
			fractionSupplied: m,
			ewrShortfallM3Day: m,
			daysEwrNotMet: m
		};
	};
	const rows = [row('Farm 10', 5), row('farm 2', null), row('Farm 1', -20), row('Bergwater', 30)];

	it('sorts names naturally and case-insensitively', () => {
		expect(sortFarms(rows, 'name', 'asc').map((r) => r.name)).toEqual(['Bergwater', 'Farm 1', 'farm 2', 'Farm 10']);
		expect(sortFarms(rows, 'name', 'desc').map((r) => r.name)).toEqual(['Farm 10', 'farm 2', 'Farm 1', 'Bergwater']);
	});

	it('sorts by signed delta with unknown deltas last in both directions', () => {
		expect(sortFarms(rows, 'suppliedM3Day', 'desc').map((r) => r.name)).toEqual(['Bergwater', 'Farm 10', 'Farm 1', 'farm 2']);
		expect(sortFarms(rows, 'suppliedM3Day', 'asc').map((r) => r.name)).toEqual(['Farm 1', 'Farm 10', 'Bergwater', 'farm 2']);
	});

	it('does not mutate its input', () => {
		const before = rows.map((r) => r.name);
		sortFarms(rows, 'name', 'asc');
		expect(rows.map((r) => r.name)).toEqual(before);
	});

	it('toggles direction on the same column; a new metric column starts descending', () => {
		expect(nextSort({ key: 'name', dir: 'asc' }, 'name')).toEqual({ key: 'name', dir: 'desc' });
		expect(nextSort({ key: 'name', dir: 'asc' }, 'deficitM3Day')).toEqual({ key: 'deficitM3Day', dir: 'desc' });
		expect(nextSort({ key: 'deficitM3Day', dir: 'desc' }, 'name')).toEqual({ key: 'name', dir: 'asc' });
	});
});

describe('farm feature metrics (issue #54)', () => {
	const summary = (nodeId: string, extra: Partial<FarmSummary> = {}): FarmSummary => ({
		nodeId,
		name: nodeId,
		avgDemandM3Day: 1000,
		avgSuppliedM3Day: 800,
		avgDeficitM3Day: 200,
		fractionSupplied: 0.8,
		avgEwrShortfallM3Day: 0,
		daysEwrNotMet: 0,
		...extra
	});
	const rows = [
		{ nodeIdA: 'f1', nodeIdB: 'f1' },
		{ nodeIdA: 'f2', nodeIdB: 'f2' }
	];

	it('shows river pumping the scenario added as 0 in the base, not hidden', () => {
		const { columns, cells } = farmFeatureMetrics(rows, [summary('f1'), summary('f2')], [summary('f1', { avgRiverAbstractionM3Day: 450 }), summary('f2')]);
		expect(columns.map((c) => c.key)).toEqual(['avgRiverAbstractionM3Day']);
		expect(cells.get('f1')!.avgRiverAbstractionM3Day).toEqual({ m: { a: 0, b: 450, delta: 450 }, noneA: true, noneB: false });
		// A farm with no pump in either run reads 0 against 0.
		expect(cells.get('f2')!.avgRiverAbstractionM3Day).toEqual({ m: { a: 0, b: 0, delta: 0 }, noneA: true, noneB: true });
	});

	it('adds no column when no matched farm has the feature in either run', () => {
		expect(farmFeatureMetrics(rows, [summary('f1'), summary('f2')], [summary('f1'), summary('f2')]).columns).toEqual([]);
	});

	it('ignores a farm only one run has, and leaves a farm with no summary unknown', () => {
		// f9 has boreholes but is in B only: it is under "Only in run B", not a column.
		const only = farmFeatureMetrics(rows, [summary('f1'), summary('f2')], [summary('f1'), summary('f2'), summary('f9', { avgGroundwaterM3Day: 10 })]);
		expect(only.columns).toEqual([]);
		// f2's summary is missing from A: no cells for it rather than a made-up 0.
		const gap = farmFeatureMetrics(rows, [summary('f1')], [summary('f1', { avgGroundwaterM3Day: 30 }), summary('f2', { avgGroundwaterM3Day: 5 })]);
		expect(gap.columns.map((c) => c.key)).toEqual(['avgGroundwaterM3Day']);
		expect(gap.cells.get('f1')!.avgGroundwaterM3Day!.m).toEqual({ a: 0, b: 30, delta: 30 });
		expect(gap.cells.get('f2')).toEqual({});
	});

	it('keeps both values when both runs have the feature', () => {
		const { cells } = farmFeatureMetrics(
			rows.slice(0, 1),
			[summary('f1', { avgGroundwaterM3Day: 40, avgBaseflowDepletionM3Day: 12 })],
			[summary('f1', { avgGroundwaterM3Day: 25, avgBaseflowDepletionM3Day: 9 })]
		);
		expect(cells.get('f1')).toEqual({
			avgGroundwaterM3Day: { m: { a: 40, b: 25, delta: -15 }, noneA: false, noneB: false },
			avgBaseflowDepletionM3Day: { m: { a: 12, b: 9, delta: -3 }, noneA: false, noneB: false }
		});
	});
});
