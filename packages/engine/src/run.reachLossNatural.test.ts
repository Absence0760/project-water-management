// The natural flow net of the natural bed losses (engine ≥ 1.76.0, issue #444,
// docs/model.md §2.6b, engine-audit.md R4): with a reach losing, a Reserve rule
// table's site, the WR2012 check and the calibration's MAR penalty read the
// natural flow routed down the reaches with nothing built or taken, as WR2012's
// naturalised flows are net of WRSM's Bedloss. The same catchment without the
// losses is the positive control. Synthetic catchment: invented numbers only.
import { describe, expect, it } from 'vitest';
import { daysPerMonth, toEpochDay } from './calendar';
import type { ModelInput, ModelOutput, NetworkNode } from './project';
import { Rng } from './random';
import { naturalAtOutlet, runModel } from './run';
import { prepareCalibration } from './calibrate/calibrate';
import { blankEwrRuleTable } from './reserve/rules';
import { defaultWr2012Settings } from './reference/wr2012Settings';

const node = (over: Partial<NetworkNode>): NetworkNode => ({
	id: 'x',
	name: 'x',
	kind: 'farm',
	downstreamNodeId: null,
	sortOrder: 0,
	areaKm2: 0,
	areaHiKm2: 0,
	areaLoKm2: 0,
	flowShareManual: null,
	pctUpstreamToDam: 0,
	pctRunoffToDam: 0,
	damCapacityM3: 0,
	damInitialPct: 0,
	damMinPct: 0,
	divertCapacityM3Day: 0,
	irrigationEfficiency: 1,
	returnFlowFraction: 0,
	damAreaFullM2: 0,
	damAreaExponent: 0.7,
	damSeepagePerDay: 0,
	...over
});

const start = '2010-10-01';
const days = Math.round(3 * 365.25);
const apan = [150, 180, 200, 210, 180, 150, 100, 60, 40, 40, 60, 100];
const LOSS = 0.4;

/**
 * An undeveloped catchment (no crops, no dams): one unit on 40 km² draining to
 * the outlet gauge, its reach losing `frac` of the flow with no cap; a Reserve
 * rule table at the outlet reading its natural curve from the run; a WR2012
 * reference with the calibration penalty on; and an observed record.
 */
function catchment(frac: number): ModelInput {
	const rng = new Rng(7);
	const d0 = toEpochDay(start);
	const rain = Array.from({ length: days }, (_, t) => {
		const m = new Date((d0 + t) * 86_400_000).getUTCMonth() + 1;
		return rng.bool([5, 6, 7, 8, 9].includes(m) ? 0.35 : 0.08) ? Math.round(rng.logFloat(0.5, 40) * 10) / 10 : 0;
	});
	const table = blankEwrRuleTable(null);
	table.source = 'Synthetic Reserve table';
	table.ewr = table.ewr.map((row) => row.map(() => 0.05));
	const mar = 5;
	return {
		settings: {
			runoffModel: 'gr4j',
			apanMm: apan as never,
			gr4j: { x1: 250, x2: 0, x3: 60, x4: 1.5, warmupDays: 365 },
			ewrRules: [table],
			wr2012: {
				...defaultWr2012Settings(),
				reference: {
					quaternary: 'Z99A',
					areaKm2: 40,
					marMm3: mar,
					monthlyMm3: [...daysPerMonth(28.25)].map((d) => (mar * d) / 365.25),
					periodStart: 2010,
					periodEnd: 2013,
					mapMm: null,
					source: 'Synthetic'
				},
				calibrationPenalty: { enabled: true, weight: 1, marLowMm3: null, marHighMm3: null }
			}
		} as ModelInput['settings'],
		model: {
			nodes: [node({ id: 'G', name: 'Outlet gauge', kind: 'gauge' }), node({ id: 'F', name: 'Unit', downstreamNodeId: 'G', areaKm2: 40, reachLossFrac: frac })],
			crops: [],
			cropAreas: [],
			transfers: []
		},
		series: {
			rain_catchment_mm: { startDate: start, values: rain },
			// A varying record (a flat one is flagged and leaves nothing to score); only the calibration problem reads it.
			flow_observed_m3s: { startDate: start, values: rain.map((r, t) => 0.05 + r / 50 + (t % 7) / 100) }
		}
	};
}

const site = (o: ModelOutput) => {
	const s = o.summary.ewrAssurance?.[0];
	if (!s) throw new Error(`no rule-table site: ${JSON.stringify(o.summary.warnings)}`);
	return s;
};
const total = (v: readonly (number | null)[]) => v.reduce<number>((s, x) => s + (x ?? 0), 0);

describe('naturalAtOutlet', () => {
	// A (share 0.5, losing half its flow) and B (share 0.3) drain to the outlet O; 0.2 of the catchment is in no unit.
	const plan = {
		nodes: [
			{ kind: 'farm' as const, share: 0.5, reachLoss: { frac: 0.5, maxM3Day: Infinity } },
			{ kind: 'farm' as const, share: 0.3 },
			{ kind: 'gauge' as const, share: 0 }
		],
		order: Int32Array.from([0, 1, 2]),
		upstream: [Int32Array.from([]), Int32Array.from([]), Int32Array.from([0, 1])]
	} as unknown as Parameters<typeof naturalAtOutlet>[0];

	it('routes each unit’s share down, net of its reach, plus the part no unit holds (worked by hand)', () => {
		// 1000: A 500 loses 250, B 300, the rest 200: 250 + 300 + 200 = 750. 0 stays 0.
		expect([...naturalAtOutlet(plan, 2, [1000, 0, 40])!]).toEqual([750, 0, 30]);
	});

	it('is null with no losing reach (the caller keeps the runoff model’s flow) or no outlet', () => {
		const lossless = { ...plan, nodes: plan.nodes.map((n) => ({ ...n, reachLoss: undefined })) };
		expect(naturalAtOutlet(lossless, 2, [1000])).toBeNull();
		expect(naturalAtOutlet(plan, -1, [1000])).toBeNull();
	});
});

describe('the natural flow net of the natural bed losses (engine 1.76.0)', () => {
	const off = runModel(catchment(0));
	const on = runModel(catchment(LOSS));

	it('a Reserve rule table reads its site’s natural flow net of the losses: undeveloped, it is the flow at the site', () => {
		// Positive control: without losses the natural MAR is the unit's runoff.
		expect(site(off).ewrPctNmar!.naturalMarMcm).toBeGreaterThan(0);
		// With a 40 % loss and no cap, the natural flow reaching the outlet is 60 % of the runoff, day by day.
		expect(site(on).ewrPctNmar!.naturalMarMcm / site(off).ewrPctNmar!.naturalMarMcm).toBeCloseTo(1 - LOSS, 12);
		// Undeveloped, the outflow is that natural flow, so the site reads the same volume as natural and actual.
		const outflow = on.series.find((s) => s.nodeId === null && s.key === 'outflow') ?? on.series.find((s) => s.nodeId === 'G' && s.key === 'outflow')!;
		const runoff = off.series.find((s) => s.nodeId === 'F' && s.key === 'runoff')!;
		expect(total(outflow.values) / total(runoff.values)).toBeCloseTo(1 - LOSS, 12);
	});

	it('the WR2012 check compares the natural flow at the outlet net of the losses; the catchment’s natural flow series stays the runoff model’s', () => {
		const a = off.summary.wr2012!.whole.simulatedMarMm3;
		const b = on.summary.wr2012!.whole.simulatedMarMm3;
		expect(a).toBeGreaterThan(0);
		expect(b / a).toBeCloseTo(1 - LOSS, 12);
		const nat = (o: ModelOutput) => o.series.find((s) => s.nodeId === null && s.key === 'natural_flow')!.values;
		expect(nat(on)).toEqual(nat(off));
	});

	it('the calibration’s MAR penalty reads the same flow, so a fit with both on counts a loss once', () => {
		const flow = new Float64Array(days).fill(86_400);
		const a = prepareCalibration(catchment(0)).marPenalty!;
		const b = prepareCalibration(catchment(LOSS)).marPenalty!;
		expect(b.simulatedMar(flow) / a.simulatedMar(flow)).toBeCloseTo(1 - LOSS, 12);
		expect(b.targetMarMm3).toBe(a.targetMarMm3);
		// The penalty is the band's distance from what the losses leave, not from the runoff.
		expect(b.penalty(flow)).not.toBe(a.penalty(flow));
	});

	it('says the pragmatic EWR is passed down whole, only when bed losses are on', () => {
		const said = (o: ModelOutput) => o.summary.warnings.some((w) => w.startsWith('bed losses are on: a Reserve rule table reads its site’s natural flow net of them'));
		expect(said(on)).toBe(true);
		expect(said(off)).toBe(false);
	});
});
