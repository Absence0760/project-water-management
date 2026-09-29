import { describe, expect, it } from 'vitest';
import { damCapacityOn, metricDelta, toEpochDay, type FarmDelta, type NetworkNode, type InputChange, type RunComparison } from '@water-management/engine';
import { compareDamStorage, damStorageShare, DAYS_PER_YEAR, leadChange, outcomeRows, takeaways } from './summary';
import type { FarmSummary } from '@water-management/engine';

const farm = (node: string, name: string, a: number, b: number): FarmDelta =>
	({ name, nameA: null, nodeIdA: node, nodeIdB: `${node}-b`, fractionSupplied: metricDelta(a, b) }) as unknown as FarmDelta;

/** A baseline-vs-what-if comparison with just the fields the summary reads. */
function cmp(o: {
	ewrShare: [number, number];
	supplied?: [number, number];
	below?: [number, number];
	outflow?: [number, number];
	farms?: FarmDelta[];
	nse?: [number, number] | null;
}): RunComparison {
	return {
		samePeriod: true,
		engineVersionChanged: false,
		farms: o.farms ?? [],
		totals: {
			fractionSupplied: metricDelta(...(o.supplied ?? [0.9, 0.9])),
			farmsBelowTarget: metricDelta(...(o.below ?? [1, 1]))
		},
		catchment: {
			ewrFractionDaysNotMet: metricDelta(...o.ewrShare),
			meanSimulatedOutflowM3Day: metricDelta(...(o.outflow ?? [1000, 1000]))
		},
		calibration: o.nse ? { nse: metricDelta(...o.nse) } : null
	} as unknown as RunComparison;
}

const ctx = (n: number) => ({ samePeriod: Array(n).fill(true), engineChanged: Array(n).fill(false) });

describe('outcomeRows', () => {
	it('gives each outcome the baseline and every what-if, EWR not met as the share of days and no days-a-year restatement of it', () => {
		const rows = outcomeRows([cmp({ ewrShare: [0.13, 0.166] }), cmp({ ewrShare: [0.13, 0.139] })]);
		// Framed as the Summary and River & reserve frame it (issue #162): the share not met, a rise is worse.
		const notMet = rows.find((r) => r.id === 'ewrNotMet')!;
		expect(notMet.label).toBe('EWR not met');
		expect(notMet.spec).toEqual({ format: 'fraction', better: 'lower' });
		expect(notMet.base).toBeCloseTo(0.13);
		expect(notMet.whatIfs.map((m) => m.b)).toEqual([expect.closeTo(0.166), expect.closeTo(0.139)]);
		expect(notMet.whatIfs[0]!.delta).toBeCloseTo(0.036);
		expect(rows.map((r) => r.id)).toEqual(['ewrNotMet', 'supplied', 'deficit', 'farmsBelow', 'outflow', 'natural', 'runoffCoefficient']);
	});

	it('adds rows for the (at most two) farms most changed, matched on the baseline node, and never the calibration NSE', () => {
		const rows = outcomeRows([
			cmp({ ewrShare: [0.1, 0.1], farms: [farm('f1', 'Farm 1', 0.9, 0.7), farm('f2', 'Farm 2', 0.9, 0.895), farm('f3', 'Farm 3', 0.8, 0.75)], nse: [0.6, 0.62] }),
			cmp({ ewrShare: [0.1, 0.1], farms: [farm('f3', 'Farm 3', 0.8, 0.95)] })
		]);
		const farms = rows.filter((r) => r.id.startsWith('farm:'));
		expect(farms.map((r) => r.label)).toEqual(['Farm 1 supplied', 'Farm 3 supplied']);
		// Farm 1 isn't in what-if 2's comparison: unknown there, not zero.
		expect(farms[0]!.whatIfs[1]).toEqual({ a: null, b: null, delta: null });
		expect(farms[1]!.whatIfs[1]!.b).toBe(0.95);
		// A what-if's fit to the real gauge is not an outcome of the what-if: Headline results → Calibration has it.
		expect(rows.some((r) => r.id === 'nse')).toBe(false);
		expect(rows.slice(-3).map((r) => r.id)).toEqual(['outflow', 'natural', 'runoffCoefficient']);
	});
});

describe('dam storage (issue #55 figures)', () => {
	const f = (nodeId: string, damEndM3?: number) => ({ nodeId, ...(damEndM3 === undefined ? {} : { damEndM3 }) }) as unknown as FarmSummary;
	const nodes = [
		{ id: 'big', damCapacityM3: 90_000 },
		{ id: 'small', damCapacityM3: 10_000 },
		{ id: 'none', damCapacityM3: 0 }
	];

	it('weights each dam by its capacity, as the Summary does, and leaves out a farm with no dam', () => {
		// 45 000 + 10 000 of 100 000: 55 %, not the 75 % a plain mean of 50 % and 100 % would give.
		expect(damStorageShare([f('big', 45_000), f('small', 10_000), f('none')], nodes)).toBeCloseTo(0.55);
	});

	it('is unknown (null), never 0, with no dam or on a run saved before the figures', () => {
		expect(damStorageShare([f('none')], nodes)).toBeNull();
		expect(damStorageShare([f('big'), f('small', 10_000)], nodes)).toBeNull();
		expect(damStorageShare(undefined, nodes)).toBeNull();
		expect(damStorageShare([f('big', 1)], undefined)).toBeNull();
	});

	it("reads each side's own capacities, so a raised dam is a share of its new size", () => {
		const side = (end: number, cap: number) => ({ run: { summary: { farms: [f('big', end)] }, inputs: { model: { nodes: [{ id: 'big', damCapacityM3: cap }] } } } });
		const m = compareDamStorage({ a: side(45_000, 90_000), b: side(90_000, 300_000) });
		expect(m.a).toBeCloseTo(0.5);
		expect(m.b).toBeCloseTo(0.3);
		expect(m.delta).toBeCloseTo(-0.2);
		expect(compareDamStorage({ a: side(45_000, 90_000), b: { run: { summary: { farms: [f('big')] }, inputs: { model: { nodes: [{ id: 'big', damCapacityM3: 90_000 }] } } } } })).toEqual({
			a: 0.5,
			b: null,
			delta: null
		});
	});

	it("reads a dam whose capacity changes against its capacity on the summary's last day (issue #67)", () => {
		// Surveyed at 90 000 m³ a year after the run ends, 10 % a year lost to sediment: on 2024-12-31 it held ~99 000 m³.
		const dev = { id: 'big', kind: 'farm', damCapacityM3: 90_000, damSurveyDate: '2025-12-31', damSedimentPctPerYear: 0.1 };
		const onEnd = damCapacityOn(dev as unknown as NetworkNode, toEpochDay('2024-12-31'));
		expect(onEnd).toBeGreaterThan(90_000);
		expect(damStorageShare([f('big', 0.95 * onEnd)], [dev], '2024-12-31')).toBeCloseTo(0.95, 12);
		// Before the fix (and without the date) it read over 100 %.
		expect(damStorageShare([f('big', 0.95 * onEnd)], [dev])!).toBeGreaterThan(1);
		// A dam not yet in service at the end holds nothing and counts no capacity.
		const later = { id: 'small', kind: 'farm', damCapacityM3: 10_000, damInServiceFrom: '2025-06-01' };
		expect(damStorageShare([f('big', 0.95 * onEnd), f('small', 0)], [dev, later], '2024-12-31')).toBeCloseTo(0.95, 12);
		// compareDamStorage finds the day from each run (the day before a forecast).
		const side = (forecast?: string) => ({
			run: { startDate: '2020-01-01', endDate: '2024-12-31', summary: { farms: [f('big', 0.95 * onEnd)], ...(forecast ? { forecast: { from: forecast } } : {}) }, inputs: { model: { nodes: [dev] } } }
		});
		expect(compareDamStorage({ a: side(), b: side() }).a).toBeCloseTo(0.95, 12);
		const beforeForecast = damCapacityOn(dev as unknown as NetworkNode, toEpochDay('2024-11-30'));
		expect(compareDamStorage({ a: side(), b: side('2024-12-01') }).b).toBeCloseTo((0.95 * onEnd) / beforeForecast, 12);
		// Positive control: unchanged dams give exactly the figure they gave before.
		expect(damStorageShare([f('big', 45_000), f('small', 10_000), f('none')], nodes, '2024-12-31')).toBe(damStorageShare([f('big', 45_000), f('small', 10_000), f('none')], nodes));
	});

	it('adds a row before the mean outflow only when a run has dams, shown without a verdict or a takeaway', () => {
		const base = [cmp({ ewrShare: [0.1, 0.1] }), cmp({ ewrShare: [0.1, 0.1] })];
		expect(outcomeRows(base).some((r) => r.id === 'dams')).toBe(false);
		expect(outcomeRows(base, [{ a: null, b: null, delta: null }]).some((r) => r.id === 'dams')).toBe(false);
		const rows = outcomeRows(base, [
			{ a: 0.6, b: 0.48, delta: -0.12 },
			{ a: 0.6, b: 0.63, delta: 0.03 }
		]);
		expect(rows.map((r) => r.id)).toEqual(['ewrNotMet', 'supplied', 'deficit', 'farmsBelow', 'dams', 'outflow', 'natural', 'runoffCoefficient']);
		const dams = rows.find((r) => r.id === 'dams')!;
		expect(dams).toMatchObject({ label: 'Dam storage, end of run', unit: '% of capacity', base: 0.6, spec: { format: 'fraction', better: 'neutral' } });
		expect(takeaways(rows, ['What-if 1', 'What-if 2'], ctx(2)).map((x) => x.text)).toEqual([
			'What-if 1 makes no material change to these outcomes',
			'What-if 2 makes no material change to these outcomes'
		]);
	});
});

describe('takeaways', () => {
	it('says what each material change does, in words', () => {
		const rows = outcomeRows([
			cmp({ ewrShare: [0.13, 0.13 + 13 / DAYS_PER_YEAR], supplied: [0.92, 0.89], below: [1, 2], outflow: [1000, 900] }),
			cmp({ ewrShare: [0.13, 0.13 - 2 / DAYS_PER_YEAR], supplied: [0.92, 0.925], below: [1, 0] })
		]);
		expect(takeaways(rows, ['What-if 1', 'What-if 2'], ctx(2))).toEqual([
			{ tone: 'worse', text: 'What-if 1 puts the river below the EWR on 13 more days a year' },
			{ tone: 'worse', text: "What-if 1 supplies 3.0 pp less of the hydrological units' demand" },
			{ tone: 'worse', text: 'What-if 1 leaves 1 more hydrological unit below 95% supplied' },
			{ tone: 'neutral', text: 'What-if 1 lowers the mean outflow by 10%' },
			{ tone: 'better', text: 'What-if 2 puts the river below the EWR on 2 fewer days a year' },
			{ tone: 'better', text: 'What-if 2 brings 1 hydrological unit up to 95% supplied' }
		]);
	});

	it('stays quiet about noise, and says so when nothing is material', () => {
		const rows = outcomeRows([cmp({ ewrShare: [0.13, 0.13 + 0.4 / DAYS_PER_YEAR], supplied: [0.92, 0.915], outflow: [1000, 980] })]);
		expect(takeaways(rows, ['What-if 1'], ctx(1))).toEqual([{ tone: 'neutral', text: 'What-if 1 makes no material change to these outcomes' }]);
	});

	it('compares two what-ifs that both add days below the EWR, and names a farm that moves a lot', () => {
		const rows = outcomeRows([
			cmp({ ewrShare: [0.1, 0.1 + 13 / DAYS_PER_YEAR], farms: [farm('f4', 'Farm 4', 0.93, 0.81)] }),
			cmp({ ewrShare: [0.1, 0.1 + 3 / DAYS_PER_YEAR], farms: [farm('f4', 'Farm 4', 0.93, 0.94)] })
		]);
		const t = takeaways(rows, ['What-if 1', 'What-if 2'], ctx(2)).map((x) => x.text);
		expect(t).toContain('Under What-if 1, Farm 4 gets −12 pp of its demand');
		expect(t.at(-1)).toBe('What-if 2 costs the EWR less than What-if 1: 3 against 13 more days a year below it');
		expect(t.some((x) => x.startsWith('Under What-if 2'))).toBe(false);
	});

	it('warns when a what-if ran over other dates or another engine', () => {
		const rows = outcomeRows([cmp({ ewrShare: [0.1, 0.1] })]);
		const t = takeaways(rows, ['What-if 1'], { samePeriod: [false], engineChanged: [true] }).map((x) => x.text);
		expect(t).toContain('What-if 1 covers other dates than the baseline, so part of its change comes from the period');
		expect(t).toContain('What-if 1 ran on another engine version, so part of its change may come from the model itself');
	});
});

describe('leadChange', () => {
	const c = (area: InputChange['area'], text: string): InputChange => ({ area, kind: 'changed', subject: text, text });
	it('leads with the model (network, crops, transfers, settings) before the series it ran on', () => {
		expect(leadChange([c('series', 'Rain extended'), c('crops', 'Apples 40 → 70 ha'), c('network', 'Dam 600 → 750')])?.text).toBe('Dam 600 → 750');
		expect(leadChange([c('series', 'Rain extended'), c('settings', 'Pan coefficient 0.8 → 0.7')])?.text).toBe('Pan coefficient 0.8 → 0.7');
		expect(leadChange([c('series', 'Rain extended')])?.text).toBe('Rain extended');
		expect(leadChange([])).toBeNull();
	});
});
