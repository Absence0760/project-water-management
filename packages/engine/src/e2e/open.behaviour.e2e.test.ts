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

// ── Item 4 (c) DESIGN QUESTION ──────────────────────────────────────────────
// §2.12a cap: budget(n,s,y) = Σ V(a) × |L(y) ∩ [validFrom, validTo]| ÷ |L(y)|.
// A water year with no allocation of the source in force gets budget 0 by
// that formula, so the capped unit takes no surface water that year (here a
// licence from 1 Oct 2022 leaves 2021/22 at 0 m³ supplied, every day counted
// in limitBound as `volumeDays`), with no warning. Yet the same section says
// "A source with no allocation isn't capped", and on a day no allocation is in
// force the *rate* limit is "none". So "the unit has a licence, just not yet"
// caps at 0, while "the unit has no licence" isn't capped at all.
// Decision (hydrologist/operator, with #90 and engine-audit.md L2): before a
// licence starts, is the unit (i) not abstracting lawfully (budget 0, today),
// (ii) uncapped (existing lawful use, as a unit with no allocation), or
// (iii) capped at the first licence's volume? Whatever is chosen, warn when a
// capped unit has a water year with no allocation in force. Proposed §2.12a
// wording (keeping today's rule): "A water year in which none of a unit's
// allocations of a source is in force has a budget of 0: the unit takes none
// of that source that year, unlike a unit with no allocation of the source at
// all, which is not capped. The run warns, naming the unit and the years."
describe('item 4 (c): cap mode gives a water year with no allocation in force a budget of 0', () => {
	it('a licence from 1 Oct 2022: 2021/22 supplies nothing (budget 0), 2022/23 its 36 500 m³', () => {
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
				allocations: [{ id: 'L1', nodeId: 'F', waterSource: 'surface', volumeM3PerYear: 36_500, validFrom: '2022-10-01' }]
			},
			series: { rain_catchment_mm: { startDate: '2021-10-01', values: new Array(days).fill(0) } }
		};
		const out = runModelWith(input, () => ({ naturalFlowM3Day: new Array(days).fill(5000) }));
		const supplied = get(out, 'F', 'supplied');
		expect(sum(supplied, 0, 365)).toBe(0);
		expect(sum(supplied, 365, 730)).toBeCloseTo(36_500, 6);
		expect(get(out, 'F', 'allocation_room_surface')[0]).toBe(0);
		const src = out.summary.allocations!.nodes[0]!.sources[0]!;
		expect(src.capReached).toContainEqual({ waterYear: 2021, budgetM3: 0, usedM3: 0 });
		expect(src.limitBound).toContainEqual({ waterYear: 2021, days: 365, volumeDays: 365, rateDays: 0, monthsDays: 0 });
		// Today no warning says the year had no allocation in force.
		expect(out.summary.warnings.filter((w) => /in force|no allocation/i.test(w))).toEqual([]);
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

// ── Item 11 (b), decided (engine ≥ 1.70.0, Q31 in #90, issue #393) ──────────
// Up to 1.69.0 blank days counted like zeros towards an accumulation, so a
// 150-day logger outage (blank) ended by a 30 mm reading CHIRPS missed was an
// accumulation: its last 92 days got 30 mm in all instead of ~350 mm of
// CHIRPS fill. §2.4d now: a blank stretch counts only up to
// ACC_MAX_BLANK_DAYS (7); a longer one is an outage that ends the run. A
// ≥ 20 mm reading straight after an outage that passes the CHIRPS tests over
// it is set aside as missing: CHIRPS × factor fills its day like the
// outage's, it stays out of the CHIRPS fit, and the run warns.
//
// By hand: catchment = CHIRPS on every day but the outage and the reading,
// so every CHIRPS factor is exactly 1 and every filled day reads CHIRPS.
// CHIRPS is 0 on the reading day, so the set-aside reading's day gets 0 mm.
describe('item 11 (b): a ≥ 20 mm reading after a long blank outage is set aside, not spread (§2.4d, engine ≥ 1.70.0)', () => {
	const start = '2015-10-01';
	const days = 1461;
	const d0 = toEpochDay(start);
	const month = (t: number) => Number(fromEpochDay(d0 + t).slice(5, 7));
	const wet = (t: number) => month(t) >= 10 || month(t) <= 3;
	const read = toEpochDay('2018-03-01') - d0;
	// CHIRPS: wet-season rain, dry on the reading day and the days either side.
	const chirps = Array.from({ length: days }, (_, t) => (t >= read - 1 && t <= read + 1 ? 0 : wet(t) ? 3 + (t % 3) : 0.5));
	const series = (reading: number) => ({
		rain_catchment_mm: { startDate: start, values: Array.from({ length: days }, (_, t) => (t >= read - 150 && t < read ? null : t === read ? reading : chirps[t]!)) },
		rain_chirps_mm: { startDate: start, values: chirps }
	});
	const runWith = (reading: number, settings: Record<string, unknown> = {}) => runModel(gr4j(series(reading), settings));
	/** CHIRPS over the days the catchment reads (the fit's shared days), mm. */
	const outageFree = () => sum(chirps, 0, days) - sum(chirps, read - 150, read + 1);

	it('positive control: a 19 mm reading (below 20 mm) is no candidate; the outage is CHIRPS-filled and the reading stays on its day', () => {
		const out = runWith(19);
		expect(out.summary.rainAccumulation?.windows ?? []).toEqual([]);
		const used = get(out, null, 'rain_used');
		// The 19 mm on a CHIRPS-dry day stays in the fit, so the factors move off 1 (the pooled
		// one is (2 675 + 19) / 2 675); each outage day reads CHIRPS × its month's factor.
		const corr = out.summary.chirpsCorrection!;
		expect(corr.pooled!.factor).toBeCloseTo((outageFree() + 19) / outageFree(), 12);
		for (let t = read - 150; t < read; t++) expect(used[t]).toBeCloseTo(chirps[t]! * corr.months[month(t) - 1]!.factor!, 12);
		expect(used[read]).toBe(19);
		expect(out.summary.chirpsCorrection!.fallbackDays).toBe(150);
	});

	it('a 30 mm reading: set aside, its day filled from CHIRPS (0 mm here), the outage CHIRPS-filled, out of the fit, warned', () => {
		const out = runWith(30);
		const w = out.summary.rainAccumulation!.windows;
		expect(w).toHaveLength(1);
		expect(w[0]).toMatchObject({ start: '2018-03-01', end: '2018-03-01', status: 'setAside', source: 'detected', outageDays: 150, runDays: 150, readingMm: 30, totalMm: 30, daysInRun: 1, usedMm: 0 });
		const used = get(out, null, 'rain_used');
		// No day of the outage holds a share of the 30 mm: each reads its own CHIRPS (factor 1).
		// The reading is out of the fit, so every factor is exactly 1 (catchment = CHIRPS on every other day).
		for (const m of out.summary.chirpsCorrection!.months) expect(m.factor).toBe(1);
		for (let t = read - 150; t < read; t++) expect(used[t]).toBeCloseTo(chirps[t]!, 12);
		expect(used[read]).toBe(0);
		expect(get(out, null, 'rain_source')[read]).toBe(2);
		expect(out.summary.chirpsCorrection!.fallbackDays).toBe(151);
		expect(out.summary.chirpsCorrection!.accumulationDaysLeftOut).toBe(1);
		// Nothing was spread, so there is no spread column.
		expect(ser(out, null, 'rain_catchment_spread')).toBeUndefined();
		expect(out.summary.rainAccumulation!).toMatchObject({ spreadWindows: 0, spreadDays: 0, spreadMm: 0 });
		const warn = out.summary.warnings.find((x) => x.includes('after an outage set aside as missing'));
		expect(warn).toContain('2018-03-01 (30 mm read after a 150-day outage; 0 mm used instead)');
		// The stored series is unchanged.
		expect(series(30).rain_catchment_mm.values[read]).toBe(30);
	});

	it('keepReadings keeps it as one day\'s rain (and in the fit); asRecorded leaves it on its day and warns of a possible double count', () => {
		const kept = runWith(30, { zeroRainRuns: { mode: 'missing', keepDry: [], missing: [], keepReadings: [{ start: '2018-03-01', end: '2018-03-01', reason: 'invented: logger back, storm confirmed' }] } });
		expect(kept.summary.rainAccumulation!.windows[0]!.status).toBe('kept');
		expect(get(kept, null, 'rain_used')[read]).toBe(30);
		expect(kept.summary.chirpsCorrection!.accumulationDaysLeftOut ?? 0).toBe(0);
		const rec = runWith(30, { zeroRainRuns: { mode: 'missing', keepDry: [], missing: [], accumulationMode: 'asRecorded' } });
		expect(rec.summary.rainAccumulation!.windows[0]!.status).toBe('asRecorded');
		expect(get(rec, null, 'rain_used')[read]).toBe(30);
		expect(rec.summary.warnings.find((x) => x.includes('run as recorded'))).toContain('may be counted twice (2018-03-01)');
	});

	it('listing the outage as missing changes nothing: the outage was blank and CHIRPS-filled already, and the reading is judged on its own day', () => {
		const listed = runWith(30, { zeroRainRuns: { mode: 'missing', keepDry: [], missing: [{ start: fromEpochDay(d0 + read - 150), end: fromEpochDay(d0 + read - 1), reason: 'invented: logger outage' }] } });
		const plain = runWith(30);
		expect(listed.summary.rainAccumulation!.windows.map((w) => w.status)).toEqual(['setAside']);
		expect(get(listed, null, 'rain_used')).toEqual(get(plain, null, 'rain_used'));
	});
});
