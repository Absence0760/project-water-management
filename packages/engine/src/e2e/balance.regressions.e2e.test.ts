// Regression tests for the per-unit farm and dam balance bugs the engine end-to-end
// tests found (fixed in engine 1.69.0; errata ER-15, ER-16, ER-17), each asserting
// the behaviour docs/model.md specifies. Invented values.
import { describe, expect, it } from 'vitest';
import type { Borehole, ModelInput, ModelOutput, NetworkNode } from '../project';
import { runModelWith, withVerification } from '../run';

function node(id: string, kind: NetworkNode['kind'], down: string | null, over: Partial<NetworkNode> = {}): NetworkNode {
	return {
		id,
		name: id,
		kind,
		downstreamNodeId: down,
		sortOrder: 0,
		areaKm2: kind === 'farm' ? 1 : 0,
		areaHiKm2: 0,
		areaLoKm2: 0,
		flowShareManual: null,
		pctUpstreamToDam: 1,
		pctRunoffToDam: 1,
		damCapacityM3: 0,
		damInitialPct: 0,
		damMinPct: 0,
		divertCapacityM3Day: 0,
		irrigationEfficiency: 1,
		lossReturnFraction: 0,
		damAreaFullM2: 0,
		damAreaExponent: 0.7,
		damSeepagePerDay: 0,
		...over
	};
}

const APAN = [180, 230, 270, 285, 245, 210, 140, 90, 60, 65, 90, 130];
/** Crop area (crop factor 1) whose January gross demand is `need` m³/day. */
const janArea = (need: number) => (need * 31_000) / 285;

function input(nodes: NetworkNode[], days: number, opts: { need?: number; settings?: ModelInput['settings']; boreholes?: Borehole[] } = {}): ModelInput {
	return {
		settings: { apanMm: APAN as never, effectiveRainFraction: 0, lakeEvapFactor: 0, ewrPragmaticM3PerDay: new Array(12).fill(0) as never, ...(opts.settings ?? {}) },
		model: {
			nodes,
			crops: [{ id: 'c', name: 'Crop', cropFactor: new Array(12).fill(1) }],
			cropAreas: opts.need ? [{ nodeId: 'A', cropId: 'c', areaM2: janArea(opts.need) }] : [],
			transfers: [],
			...(opts.boreholes ? { boreholes: opts.boreholes } : {})
		},
		series: { rain_catchment_mm: { startDate: '2021-01-01', values: new Array(days).fill(0) } }
	};
}
const run = (i: ModelInput, natural: number[]) => withVerification(i, runModelWith(i, () => ({ naturalFlowM3Day: natural })));
const col = (o: ModelOutput, id: string, key: string) => o.series.find((x) => x.nodeId === id && x.key === key)?.values;
const closeAll = (got: number[] | undefined, want: number[], what: string) => {
	expect(got, what).toBeDefined();
	want.forEach((v, t) => expect(got![t], `${what} day ${t}`).toBeCloseTo(v, 6));
};

describe('fixed in 1.69.0: a negative monthly A-pan turns dam evaporation into a gain', () => {
	// model.md §2.7a: E = MIN(k_lake × Apan / days / 1000 × A, …) is a loss, and "the clamps keep storage ≥ 0:
	// evaporation takes at most what is there"; the engine's own self-check requires evaporation ≥ 0. A negative
	// A-pan month is reachable: the backend's settings schema takes any finite number (backend/src/projects/
	// settings.ts:258 `monthly`, used for apanMm at :898), and mergeSettings (packages/engine/src/prepare.ts:514,
	// `monthly`) keeps it. run.ts:1452 then gives a negative evaporation depth and the dam fills from nothing.
	// (A scenario's settings.set already refuses it: scenario/ops.ts:445 range(0, 10 000); the daily A-pan series
	// treats a negative day as missing, evaporation/apanDaily.ts.) Fix: mergeSettings treats a negative month as 0
	// with a warning (as the daily series does), and the backend schema requires 0–10 000 like the scenario check.
	it('evaporation is never negative, a dam with no inflow never rises, and the self-checks pass', () => {
		const apan = [...APAN];
		apan[3] = -285; // January
		const i = input([node('G', 'gauge', null), node('A', 'farm', 'G', { damCapacityM3: 10_000, damInitialPct: 0.5, damAreaFullM2: 5_000 })], 5, { settings: { apanMm: apan as never, lakeEvapFactor: 0.75 } });
		const o = run(i, new Array(5).fill(0));
		for (const e of col(o, 'A', 'dam_evaporation')!) expect(e).toBeGreaterThanOrEqual(0);
		const q = col(o, 'A', 'dam_storage')!;
		for (const v of q) expect(v).toBeLessThanOrEqual(5_000);
		expect(o.summary.verification!.checks.filter((c) => !c.passed)).toEqual([]);
	});
});

describe('fixed in 1.69.0: a release rule acts on days the dam does not exist (not in service yet, or silted empty)', () => {
	// model.md §2.7g: "With no capacity (before the in-service date, or once sediment has filled it) the unit has
	// no dam: nothing enters or stays in it … and what is routed to it passes on, as on a unit without a dam"
	// (§2.7h repeats it: "a farm with no dam today (capacity 0: … one not in service yet or filled with
	// sediment)"). A unit without a dam has no release (§2.7a item 3; resolveRelease returns null for capacity 0).
	// But network/simulate.ts:1315 applies `node.release` whatever the day's capacity, so on those days a fixed or
	// pass-inflow "release" takes the water routed to the absent dam before irrigation: the farm is supplied less
	// than the same unit without a dam. The transfer room (simulate.ts:993) also counts the fixed release
	// on such a day. Fix: release only when the day's capacity `cap` > 0 (both places).
	for (const [why, dev] of [
		['not in service until after the run', { damInServiceFrom: '2030-01-01' }],
		['silted empty before the run', { damSurveyDate: '2010-01-01', damSedimentPctPerYear: 0.2 }]
	] as const) {
		for (const rule of ['fixed', 'passInflow'] as const) {
			it(`${rule}, dam ${why}: the day runs as on a unit without a dam`, () => {
				const days = 3;
				const dated = run(
					input([node('G', 'gauge', null), node('A', 'farm', 'G', { damCapacityM3: 5_000, damReleaseRule: rule, damReleaseM3Day: new Array(12).fill(1000), ...dev })], days, { need: 1500 }),
					new Array(days).fill(2000)
				);
				const none = run(input([node('G', 'gauge', null), node('A', 'farm', 'G')], days, { need: 1500 }), new Array(days).fill(2000));
				expect(col(dated, 'A', 'dam_capacity')).toEqual([0, 0, 0]);
				closeAll(col(dated, 'A', 'supplied'), col(none, 'A', 'supplied')!, 'supplied');
				closeAll(col(dated, 'A', 'outflow'), col(none, 'A', 'outflow')!, 'outflow');
				for (const x of col(dated, 'A', 'dam_release') ?? []) expect(x).toBe(0);
			});
		}
	}
});

describe('fixed in 1.69.0: a dam-target borehole pumps nothing on days the dam does not exist', () => {
	// model.md §2.7d: "On a node without a dam, … a dam-target one pumps direct". §2.7g: before the in-service
	// date (or once silted) "the unit has no dam … as on a unit without a dam". network/boreholes.ts boreholeOf
	// (hasDam = the entered capacity > 0, line 85) keeps the unit's `toDam` for the whole run, and
	// groundwaterDay (boreholes.ts:216–218) then gives it a head of cap − avail ≤ 0 on a day with no capacity, so it
	// pumps 0: a farm whose borehole feeds a dam built later gets no groundwater at all until then, while the same
	// farm with no dam gets it direct. Fix: in groundwaterDay treat a unit as direct when today's `cap` is 0
	// (and the checks' replay in verify/checks.ts to match).
	for (const mode of ['primary', 'supplemental', 'emergency'] as const) {
		it(`${mode}: pumps straight to the crop before the dam is in service, as with no dam`, () => {
			const days = 4;
			const bh: Borehole[] = [{ id: 'b', nodeId: 'A', name: 'Borehole 1', capacityM3Day: 300, annualCapM3: null, mode, emergencyBelowPct: 0.5, target: 'dam', depletionFactor: 0 }];
			const o = run(input([node('G', 'gauge', null), node('A', 'farm', 'G', { damCapacityM3: 5_000, damInServiceFrom: '2021-01-03' })], days, { need: 1000, boreholes: bh }), new Array(days).fill(0));
			closeAll(col(o, 'A', 'dam_capacity'), [0, 0, 5000, 5000], 'capacity');
			// Days 0–1: no dam, so direct (300 of the 1000 demand); days 2–3: into the dam and drawn the same day.
			closeAll(col(o, 'A', 'supplied'), [300, 300, 300, 300], 'supplied');
			closeAll(col(o, 'A', 'groundwater_used')!.slice(0, 2), [300, 300], 'direct before the dam');
		});
	}
});

describe('fixed in 1.69.0: the self-check charges dam-target boreholes their pumping, never less (code review, round 2)', () => {
	// verify/checks.ts transferDrawBound replays each borehole's volume so far this water year. The run stores only
	// the dam-target units' total pumped into the dam, so the check charges it to each of them: with two dam-target
	// units of different modes it once gave it to the first in list order, under-counting the other, whose annual
	// room then read too large on a later day with no dam, so the bound on the transfer draw came out too low.
	// Here: two dam-target units (primary and supplemental, each with an annual cap) feed a dam that silts empty
	// mid-run while a transfer draws on it; every self-check must pass, either listing.
	for (const order of ['primary first', 'supplemental first'] as const) {
		it(`${order}: the run passes its self-checks`, () => {
			const days = 40;
			const bh: Borehole[] = [
				{ id: 'p', nodeId: 'A', name: 'Primary', capacityM3Day: 400, annualCapM3: 6_000, mode: 'primary', emergencyBelowPct: 0.5, target: 'dam', depletionFactor: 0 },
				{ id: 's', nodeId: 'A', name: 'Supplemental', capacityM3Day: 300, annualCapM3: 5_000, mode: 'supplemental', emergencyBelowPct: 0.5, target: 'dam', depletionFactor: 0 }
			];
			if (order === 'supplemental first') bh.reverse();
			const i = input(
				[
					node('G', 'gauge', null),
					node('B', 'farm', 'G', { damCapacityM3: 20_000, damInitialPct: 0.1 }),
					// Surveyed 5 years before the run at 0.2 a year (+ a few days): full of sediment by 2021-01-20.
					node('A', 'farm', 'B', { damCapacityM3: 8_000, damInitialPct: 0.5, damSurveyDate: '2016-01-20', damSedimentPctPerYear: 0.2 })
				],
				days,
				{ need: 800, boreholes: bh }
			);
			i.model.transfers = [{ id: 't', fromNodeId: 'A', toNodeId: 'B', months: [1, 2], maxRateM3s: 0.01, dailyCapM3: null, minStoragePct: 0, enabled: true, priority: 0 }];
			const o = run(i, new Array(days).fill(200));
			const cap = col(o, 'A', 'dam_capacity')!;
			expect(cap[0]!).toBeGreaterThan(0);
			expect(cap[days - 1]).toBe(0);
			expect(o.summary.verification!.checks.filter((c) => !c.passed)).toEqual([]);
		});
	}
});
