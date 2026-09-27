import { describe, expect, it } from 'vitest';
import { metricDelta, type FarmDelta, type InputChange, type RunComparison } from '@water-management/engine';
import { DAYS_PER_YEAR, leadChange, outcomeRows, takeaways } from './summary';

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
	it('gives each outcome the baseline and every what-if, with reserve met and days a year derived from the share of days', () => {
		const rows = outcomeRows([cmp({ ewrShare: [0.13, 0.166] }), cmp({ ewrShare: [0.13, 0.139] })]);
		const met = rows.find((r) => r.id === 'reserveMet')!;
		expect(met.base).toBeCloseTo(0.87);
		expect(met.whatIfs.map((m) => m.b)).toEqual([expect.closeTo(0.834), expect.closeTo(0.861)]);
		expect(met.whatIfs[0]!.delta).toBeCloseTo(-0.036);
		const days = rows.find((r) => r.id === 'reserveDays')!;
		expect(days.base).toBeCloseTo(0.13 * DAYS_PER_YEAR);
		expect(days.whatIfs[0]!.delta).toBeCloseTo(0.036 * DAYS_PER_YEAR);
		expect(rows.map((r) => r.id)).toEqual(['reserveMet', 'reserveDays', 'supplied', 'farmsBelow', 'outflow']);
	});

	it('adds rows for the (at most two) farms most changed, matched on the baseline node, and NSE only with calibration', () => {
		const rows = outcomeRows([
			cmp({ ewrShare: [0.1, 0.1], farms: [farm('f1', 'Farm 1', 0.9, 0.7), farm('f2', 'Farm 2', 0.9, 0.895), farm('f3', 'Farm 3', 0.8, 0.75)], nse: [0.6, 0.62] }),
			cmp({ ewrShare: [0.1, 0.1], farms: [farm('f3', 'Farm 3', 0.8, 0.95)] })
		]);
		const farms = rows.filter((r) => r.id.startsWith('farm:'));
		expect(farms.map((r) => r.label)).toEqual(['Farm 1 supplied', 'Farm 3 supplied']);
		// Farm 1 isn't in what-if 2's comparison: unknown there, not zero.
		expect(farms[0]!.whatIfs[1]).toEqual({ a: null, b: null, delta: null });
		expect(farms[1]!.whatIfs[1]!.b).toBe(0.95);
		expect(rows.at(-1)!.id).toBe('nse');
	});
});

describe('takeaways', () => {
	it('says what each material change does, in words', () => {
		const rows = outcomeRows([
			cmp({ ewrShare: [0.13, 0.13 + 13 / DAYS_PER_YEAR], supplied: [0.92, 0.89], below: [1, 2], outflow: [1000, 900] }),
			cmp({ ewrShare: [0.13, 0.13 - 2 / DAYS_PER_YEAR], supplied: [0.92, 0.925], below: [1, 0] })
		]);
		expect(takeaways(rows, ['What-if 1', 'What-if 2'], ctx(2))).toEqual([
			{ tone: 'worse', text: 'What-if 1 costs the reserve 13 more days a year' },
			{ tone: 'worse', text: "What-if 1 supplies 3.0 pp less of the units' demand" },
			{ tone: 'worse', text: 'What-if 1 leaves 1 more unit below 95% supplied' },
			{ tone: 'neutral', text: 'What-if 1 lowers the mean outflow by 10%' },
			{ tone: 'better', text: 'What-if 2 gives the reserve back 2 days a year' },
			{ tone: 'better', text: 'What-if 2 brings 1 unit up to 95% supplied' }
		]);
	});

	it('stays quiet about noise, and says so when nothing is material', () => {
		const rows = outcomeRows([cmp({ ewrShare: [0.13, 0.13 + 0.4 / DAYS_PER_YEAR], supplied: [0.92, 0.915], outflow: [1000, 980] })]);
		expect(takeaways(rows, ['What-if 1'], ctx(1))).toEqual([{ tone: 'neutral', text: 'What-if 1 makes no material change to these outcomes' }]);
	});

	it('compares two what-ifs that both cost the reserve, and names a farm that moves a lot', () => {
		const rows = outcomeRows([
			cmp({ ewrShare: [0.1, 0.1 + 13 / DAYS_PER_YEAR], farms: [farm('f4', 'Farm 4', 0.93, 0.81)] }),
			cmp({ ewrShare: [0.1, 0.1 + 3 / DAYS_PER_YEAR], farms: [farm('f4', 'Farm 4', 0.93, 0.94)] })
		]);
		const t = takeaways(rows, ['What-if 1', 'What-if 2'], ctx(2)).map((x) => x.text);
		expect(t).toContain('Under What-if 1, Farm 4 gets −12 pp of its demand');
		expect(t.at(-1)).toBe('What-if 2 costs the reserve less than What-if 1: 3 against 13 more days a year');
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
		expect(leadChange([c('series', 'Rain extended'), c('crops', 'Apples 40 → 70 ha'), c('network', 'Dam 600 → 720')])?.text).toBe('Dam 600 → 720');
		expect(leadChange([c('series', 'Rain extended'), c('settings', 'Pan coefficient 0.8 → 0.7')])?.text).toBe('Pan coefficient 0.8 → 0.7');
		expect(leadChange([c('series', 'Rain extended')])?.text).toBe('Rain extended');
		expect(leadChange([])).toBeNull();
	});
});
