// Open questions from round 1 of the engine end-to-end tests that are NOT
// bugs: (b) DOCUMENTED, model.md or engine-audit.md already describes and
// justifies the behaviour, or (c) DESIGN QUESTION, the docs are silent or
// ambiguous and a hydrologist or the operator has to decide. Each test pins
// TODAY's behaviour; its comment cites the doc (b) or states the decision
// needed (c), with proposed doc wording. If a decision changes the behaviour,
// change the test with it. Invented catchments and values only.
import { describe, expect, it } from 'vitest';
import { bootstrapIntervals } from '../calibrate/bootstrap';
import { fromEpochDay, toEpochDay } from '../calendar';
import type { DemandObject, ModelInput, ModelOutput, NetworkNode, RunSeries } from '../project';
import { runModel, runModelWith } from '../run';

const flat = (v: number) => new Array(12).fill(v);
const APAN = [150, 180, 200, 210, 180, 150, 100, 60, 40, 40, 60, 100];
function node(id: string, over: Partial<NetworkNode> = {}): NetworkNode {
	return {
		id,
		name: `Unit ${id}`,
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
		lossReturnFraction: 0,
		damAreaFullM2: 0,
		damAreaExponent: 0.7,
		damSeepagePerDay: 0,
		...over
	};
}
/** One 10 km² unit draining to a gauge, GR4J, no warm-up. */
const gr4j = (series: ModelInput['series'], settings: Record<string, unknown> = {}): ModelInput => ({
	settings: { runoffModel: 'gr4j', apanMm: APAN, gr4j: { warmupDays: 0 }, ...settings } as unknown as ModelInput['settings'],
	model: { nodes: [node('G', { kind: 'gauge' }), node('F', { downstreamNodeId: 'G', areaKm2: 10 })], crops: [], cropAreas: [], transfers: [] },
	series
});
const ser = (out: { series: RunSeries[] }, nodeId: string | null, key: string): number[] | undefined => {
	const s = out.series.find((x) => x.nodeId === nodeId && x.key === key);
	return s ? Array.from(s.values) : undefined;
};
const get = (out: { series: RunSeries[] }, nodeId: string | null, key: string): number[] => {
	const s = ser(out, nodeId, key);
	if (!s) throw new Error(`no series ${nodeId}/${key}`);
	return s;
};
const sum = (a: number[], from: number, to: number) => a.slice(from, to).reduce((x, y) => x + y, 0);

// ── Item 1, decided (engine ≥ 1.69.0) ───────────────────────────────────────
// §2.4b settles a NEGATIVE CATCHMENT reading: "still a reading" (it blocks the
// fallback and runs as 0 mm). A negative CHIRPS value is not: CHIRPS has no
// negative rain, and −9999 is the product's own no-data value (the feed drops
// it; a CSV upload or direct input doesn't). Until 1.69.0 it counted as a
// value on a catchment gap (blocked the forecast, showed × the factor in
// rain_final, source 2) while the CHIRPS factor fit and the accumulation check
// read it as missing. Now prepare.ts reads it as missing in one place, as a
// negative flow has been since 1.16.0, so the day falls through to the forecast.
describe('item 1: a negative CHIRPS value on a catchment-rain gap is missing (engine ≥ 1.69.0, §2.4b)', () => {
	it('the day falls through to the forecast (source 4); the series checks still warn', () => {
		const start = '2018-10-01';
		const days = 730;
		const gap = 405; // 2019-11-10, inside a 10-day catchment gap
		const catchment = Array.from({ length: days }, (_, t) => (t >= 400 && t < 410 ? null : 2 + (t % 4)));
		const chirps = Array.from({ length: days }, (_, t) => (t === gap ? -9999 : 1.5 + (t % 4) * 0.8));
		const out = runModel(
			gr4j({
				rain_catchment_mm: { startDate: start, values: catchment },
				rain_chirps_mm: { startDate: start, values: chirps },
				rain_forecast_mm: { startDate: start, values: new Array(days).fill(7) }
			})
		);
		expect(get(out, null, 'rain_final')[gap]).toBe(7);
		expect(get(out, null, 'rain_source')[gap]).toBe(4);
		expect(get(out, null, 'rain_used')[gap]).toBe(7);
		// Positive control: the next gap day with a real CHIRPS value is filled from it, not the forecast.
		const factor = get(out, null, 'chirps_factor')[gap + 1]!;
		expect(get(out, null, 'rain_source')[gap + 1]).toBe(2);
		expect(get(out, null, 'rain_final')[gap + 1]).toBeCloseTo(chirps[gap + 1]! * factor, 9);
		expect(out.summary.chirpsCorrection!.fallbackDays).toBe(9);
		expect(out.summary.warnings.some((w) => w.includes('Rainfall (CHIRPS): 1 negative value'))).toBe(true);
	});
});

// ── Item 4, decided (engine ≥ 1.70.0, #90 Q24, provisional) ────────────────
// §2.12a cap: a water year in which none of a unit's allocations of a source
// is in force isn't capped for that source, as a unit with no allocation of
// it isn't (before 1.70.0 the budget formula gave such a year 0, so the unit
// took nothing, with no warning). One run warning names the unit, the source
// and the years. The full set of cases is in caps.licenceDates.e2e.test.ts.
describe('item 4, decided: cap mode leaves a water year with no allocation in force uncapped (engine ≥ 1.70.0)', () => {
	it('a licence of 18 250 m³ from 1 Oct 2022: 2021/22 takes its whole 36 500 m³ demand, 2022/23 its 18 250 m³', () => {
		const days = 730;
		const town: DemandObject = {
			id: 'town-F',
			nodeId: 'F',
			name: 'Town at F',
			category: 'municipal',
			sizing: 'monthly',
			monthlyM3Day: flat(100),
			count: null,
			litresPerUnitDay: null,
			lossPct: 0,
			monthlyFactor: null,
			returnPct: 0,
			priority: 'first',
			destination: 'internal',
			enabled: true,
			note: ''
		};
		const input: ModelInput = {
			settings: { ewrPragmaticM3PerDay: flat(0), apanMm: flat(0), allocationMode: 'cap' } as unknown as ModelInput['settings'],
			model: {
				nodes: [node('G', { kind: 'gauge', sortOrder: 99 }), node('F', { downstreamNodeId: 'G', areaKm2: 1, damCapacityM3: 1e6, damInitialPct: 1 })],
				crops: [],
				cropAreas: [],
				transfers: [],
				demandObjects: [town],
				allocations: [{ id: 'L1', nodeId: 'F', waterSource: 'surface', volumeM3PerYear: 18_250, validFrom: '2022-10-01' }]
			},
			series: { rain_catchment_mm: { startDate: '2021-10-01', values: new Array(days).fill(0) } }
		};
		const out = runModelWith(input, () => ({ naturalFlowM3Day: new Array(days).fill(5000) }));
		const supplied = get(out, 'F', 'supplied');
		// 2021/22: 365 days × 100 m³, uncapped (the dam holds 1e6 m³); 2022/23: the licence's 18 250 m³.
		expect(sum(supplied, 0, 365)).toBeCloseTo(36_500, 6);
		expect(sum(supplied, 365, 730)).toBeCloseTo(18_250, 6);
		expect(get(out, 'F', 'allocation_room_surface')[0]).toBeNaN();
		expect(get(out, 'F', 'allocation_room_surface')[365]).toBeCloseTo(18_250, 9);
		const src = out.summary.allocations!.nodes[0]!.sources[0]!;
		expect(src.capReached).toEqual([{ waterYear: 2022, budgetM3: 18_250, usedM3: expect.closeTo(18_250, 6) }]);
		expect(src.limitBound!.map((y) => y.waterYear)).toEqual([2022]);
		expect(out.summary.warnings.filter((w) => /is in force/.test(w))).toEqual([
			`allocation cap: none of a unit's licences of a source is in force in some water years, so its use of that source isn't capped there, as for a unit with no licence of it (check the licence dates): "Unit F" surface water in water year 2021`
		]);
	});
});

// ── Item 7 (c) DESIGN QUESTION ──────────────────────────────────────────────
// §2.10i "Outputs": "Each filled record gets two run series beside it"
// (`observed_flow_fill`, `observed_flow_filled`). The engine writes them when
// the fill filled any day of the WHOLE stored record (prepare.ts:458 `any:
// f.summary.interpolatedDays + f.summary.donorDays > 0`), while the run
// warning and RunSummary.flowGapFill count the run window only
// (fillSummaryInWindow). So a run whose window holds no filled day carries an
// all-zero code column and an all-blank values column beside a summary saying
// 0 days filled. Harmless (nothing reads a 0 code as infilled), but the
// columns imply the run filled something.
// Decision (operator, UI/export): should the columns follow the window? Recommended
// yes: prepare.ts:458 `any: summary.interpolatedDays + summary.donorDays > 0`
// (the window summary computed two lines above). Proposed §2.10i wording:
// "Each record the fill filled on at least one of the run's days gets two
// run series beside it".
describe('item 7 (c): the gap-fill columns are written even when no filled day is in the run window', () => {
	const start = '2015-10-01';
	const days = 1096;
	const series: ModelInput['series'] = {
		rain_catchment_mm: { startDate: start, values: Array.from({ length: days }, (_, t) => 2 + (t % 5)) },
		// A 3-day interior gap in January 2016, well before the 2017/18 window.
		flow_observed_m3s: { startDate: start, values: Array.from({ length: days }, (_, t) => (t >= 100 && t < 103 ? null : 1 + 0.5 * Math.sin(t / 30))) }
	};
	const fill = { flowGapFill: { flow_observed_m3s: { interpolateMaxDays: 5, donor: null, donorMaxDays: 60, donorMinOverlapDays: 365 }, flow_logger_m3s: null } };

	it('positive control: over the whole record the 3 gap days are filled and flagged', () => {
		const out = runModel(gr4j(series, fill));
		expect(get(out, null, 'observed_flow_fill').filter((c) => c === 1)).toHaveLength(3);
		expect(out.summary.flowGapFill![0]!.interpolatedDays).toBe(3);
	});

	it('a 2017/18 window: no filled day in it, yet both columns are written (all 0 / all blank)', () => {
		const out: ModelOutput = runModel(gr4j(series, { ...fill, simulationStart: '2017-10-01', simulationEnd: '2018-09-30' }));
		expect(out.days).toBe(365);
		expect(out.summary.flowGapFill![0]!.interpolatedDays).toBe(0);
		expect(get(out, null, 'observed_flow_fill').every((c) => c === 0)).toBe(true);
		expect(get(out, null, 'observed_flow_filled').every((v) => Number.isNaN(v))).toBe(true);
	});
});

// ── Item 10 (c) DESIGN QUESTION (doc wording) ───────────────────────────────
// §2.10b "Score intervals": "A score whose resamples can't be scored half the
// time or more gets a null interval", i.e. null when unscorable ≥ R/2, so
// scorable ≤ R/2. The code (calibrate/bootstrap.ts:214 `if (count < resamples
// / 2) return null`) and its own docstring ("null when fewer than half of the
// resamples can be scored") give an interval at exactly half. They differ only
// when exactly R/2 = 500 of 1 000 resamples are unscorable. Pinned with 2
// resamples: one unscorable, one scorable → an interval today.
// Decision: which boundary is meant. Recommended: keep the code (and its
// docstring) and fix the doc: "A score that can be scored in fewer than half
// of the resamples gets a null interval."
describe('item 10 (c): the bootstrap gives an interval when exactly half the resamples can be scored', () => {
	// Three water years, each flat at its own level: a resample drawing one year three times has no variance (unscorable).
	const o: number[] = [];
	const s: number[] = [];
	const g: number[] = [];
	for (let y = 0; y < 3; y++)
		for (let d = 0; d < 40; d++) {
			o.push(1 + y);
			s.push(1 + y + 0.1 * (d % 2));
			g.push(y);
		}

	it('seed 11: the first resample is unscorable; with two resamples (1 of 2 scorable) the interval is given', () => {
		expect(bootstrapIntervals(o, s, g, { resamples: 1, seed: 11 })!.kgePrime).toBeNull();
		const two = bootstrapIntervals(o, s, g, { resamples: 2, seed: 11 })!;
		expect(two.kgePrime).not.toBeNull();
		// One scored value: the interval is that value at both ends.
		expect(two.kgePrime!.lo).toBe(two.kgePrime!.hi);
	});
});

// ── Item 11 (b) DOCUMENTED ──────────────────────────────────────────────────
// §2.4d Detection: "Blank days count like zeros: the total covers a
// tagged-missing day just as well"; window = the run, at most its last 92
// days (ACC_MAX_RUN_DAYS) plus the reading day; Treatment: the window's
// recorded total T is spread over it, and "A detected window can read far
// less than CHIRPS over it … the run keeps the gauge's total rather than
// guess a correction". The way out is documented too: "A detection is
// dropped when its window touches a period listed as missing".
// So a 150-day logger outage (blank) ended by a 30 mm reading CHIRPS missed
// is an accumulation: its last 92 days get 30 mm in all instead of the
// ~350 mm the CHIRPS fallback would give them. Documented, but the doc frames
// it as a manual gauge left unread; for an automatic logger a blank is no
// data, not an unread catch.
// Proposed §2.4d addition: "A long outage of blank days ended by a reading of
// 20 mm or more is treated the same way: the window's days get only the
// reading's total instead of the CHIRPS fallback, which can remove most of a
// season's rain. List an automatic logger's outages under
// `zeroRainRuns.missing` so they stay CHIRPS-filled." Question for the
// hydrologist (with the §2.4d provisional decision): should blank days count
// towards ACC_MIN_RUN_DAYS beyond a short span (e.g. a week), or only zeros?
describe('item 11 (b): a ≥ 20 mm reading after a long blank outage is spread back over 92 days (§2.4d)', () => {
	const start = '2015-10-01';
	const days = 1461;
	const d0 = toEpochDay(start);
	const month = (t: number) => Number(fromEpochDay(d0 + t).slice(5, 7));
	const wet = (t: number) => month(t) >= 10 || month(t) <= 3;
	const read = toEpochDay('2018-03-01') - d0;
	// CHIRPS: wet-season rain, dry on the reading day and the days either side.
	const chirps = Array.from({ length: days }, (_, t) => (t >= read - 1 && t <= read + 1 ? 0 : wet(t) ? 3 + (t % 3) : 0.5));
	const runWith = (reading: number) =>
		runModel(
			gr4j({
				rain_catchment_mm: { startDate: start, values: Array.from({ length: days }, (_, t) => (t >= read - 150 && t < read ? null : t === read ? reading : chirps[t]!)) },
				rain_chirps_mm: { startDate: start, values: chirps }
			})
		);

	it('positive control: a 19 mm reading (below 20 mm) leaves the outage CHIRPS-filled', () => {
		const out = runWith(19);
		expect(out.summary.rainAccumulation?.windows ?? []).toEqual([]);
		expect(sum(get(out, null, 'rain_used'), read - 92, read + 1)).toBeGreaterThan(350);
	});

	it('a 30 mm reading: detected, the last 92 outage days + the reading day hold 30 mm in all', () => {
		const out = runWith(30);
		const w = out.summary.rainAccumulation!.windows;
		expect(w).toHaveLength(1);
		expect([w[0]!.start, w[0]!.end]).toEqual(['2017-11-29', '2018-03-01']);
		expect(sum(get(out, null, 'rain_used'), read - 92, read + 1)).toBeCloseTo(30, 9);
		// The outage's earlier 58 days stay CHIRPS-filled.
		expect(out.summary.chirpsCorrection!.fallbackDays).toBe(58);
	});
});
