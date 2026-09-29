// The example catchments (`pnpm seed:examples`) as they are seeded, held to
// the current project schema and the current engine so they can't drift out
// of date silently: each one parses as a project document (the import path),
// has every model field the engine now reads, runs with every self-check
// passing, and warns only about what it was built to show. Together they must
// showcase the engine's features (docs/run-locally.md § Example catchments).
import {
	forecastSplit,
	fitRecordStatus,
	resolveFitRecord,
	runModelChecked,
	upgradeLegacyModel,
	type ModelOutput
} from '@water-management/engine';
import { checkForecastPrefix, withForecastTail } from '@water-management/engine/testing';
import { beforeAll, describe, expect, it } from 'vitest';
import { modelProblems } from '../../src/model/validate.js';
import { ProjectFile } from '../../src/projects/document.js';
import { buildExamples, inputOf, type ExampleProject } from './catchments.js';

/**
 * Every run warning an example is built to produce, by name. A warning not
 * listed here is a failure (a stale field resolved with a warning, a missing
 * series, …), and so is a listed one that no longer appears.
 */
const EXPECTED_WARNINGS: Record<string, RegExp[]> = {
	'Example · Kleinberg (winter rainfall)': [
		/^CHIRPS rain bias-corrected on \d+ days where catchment rain is blank/,
		/^Catchment rain treated as missing on 90 days: 2019-06-01 to 2019-08-15 \(76 days, flagged zero run\); 2021-07-05 to 2021-07-18 \(14 days, listed: /,
		/^Rainfall \(catchment\): 1 run of zero rain .*2019-06-01 to 2019-08-15/,
		// Three weeks read in one go (B4); the gauge's own dry days before them join the window.
		/^Catchment rain accumulations spread over the days they cover: 1 window, \d+ run days: 2017-0[56]-\d\d to 2017-06-26 /,
		// The drowned weir's flat top in the excluded water year.
		/^Observed flow: 1 flat stretch of more days than a slow recession holds one value at the record.s resolution .*\(2014-/
	],
	'Example · Droëvlei (water-stressed)': [
		/^Observed flow records disagree .*2020\/21/,
		// The plausibility check (engine 0.25.0): the fitted GR4J falls more than 10 % short of the invented weir record in one year.
		/^Natural flow below observed \+ abstraction in 1 of 14 water years \(2015\/16\)/
	],
	'Example · Sandspruit (summer rainfall, larger network)': [
		/^WR2012 check: the run has no complete water year inside the reference period/,
		/^Simulated natural flow is 1\d % below the WR2012 naturalised MAR for X99Z .*Note the difference/,
		// The plausibility check (engine 0.25.0): the fitted GR4J falls more than 10 % short of the invented weir record in two years.
		/^Natural flow below observed \+ abstraction in 2 of 14 water years \(2014\/15, 2015\/16\)/,
		// Its forecast feed runs 10 days past the recorded rain (engine 0.28.0 names those days).
		/^10 days \(2025-01-01 to 2025-01-10\) of this run use forecast rain, not recorded rain/
	]
};

let examples: ExampleProject[];
const runs = new Map<string, ModelOutput>();
const byName = (name: string) => examples.find((e) => e.name.includes(name))!;
const runOf = (name: string) => runs.get(byName(name).name)!;

beforeAll(() => {
	examples = buildExamples();
	for (const ex of examples) runs.set(ex.name, runModelChecked(inputOf(ex)));
}, 120_000);

describe('example catchments: current schema', () => {
	it('builds the three examples, deterministically', () => {
		expect(examples.map((e) => e.name)).toEqual(Object.keys(EXPECTED_WARNINGS));
		const again = buildExamples({ fit: false });
		expect(again.map((e) => e.model)).toEqual(examples.map((e) => e.model));
		expect(again.map((e) => e.series)).toEqual(examples.map((e) => e.series));
	});

	it('each parses as a project document, as `pnpm seed:examples` imports it', () => {
		for (const ex of examples) {
			const parsed = ProjectFile.safeParse(ex);
			expect(parsed.error?.issues ?? [], ex.name).toEqual([]);
			expect(modelProblems(ex.model), ex.name).toEqual([]);
		}
	});

	it('each node and transfer carries every field the engine reads (nothing for the legacy upgrade to fill)', () => {
		for (const ex of examples) expect(upgradeLegacyModel(ex.model), ex.name).toEqual(ex.model);
	});
});

describe('example catchments: clean runs on the current engine', () => {
	for (const name of Object.keys(EXPECTED_WARNINGS)) {
		it(`${name}: every self-check passes, and it warns only about what it shows`, () => {
			const out = runs.get(name)!;
			expect(out.summary.verification?.passed, JSON.stringify(out.summary.verification?.checks.filter((c) => !c.passed))).toBe(true);
			const expected = EXPECTED_WARNINGS[name]!;
			const unexpected = out.summary.warnings.filter((w) => !expected.some((re) => re.test(w)));
			expect(unexpected).toEqual([]);
			for (const re of expected) expect(out.summary.warnings.some((w) => re.test(w)), `${re} missing`).toBe(true);
		});
	}
});

describe('example catchments: showcase the current features', () => {
	it('every dam has a known surface area, so dam evaporation and rain on the dam are not estimated (N2)', () => {
		for (const ex of examples) {
			for (const n of ex.model.nodes.filter((n) => n.damCapacityM3 > 0)) expect(n.damAreaFullM2, `${ex.name} ${n.name}`).toBeGreaterThan(0);
			const total = runs.get(ex.name)!.summary.waterBalance!.total;
			expect(total.damEvaporationM3).toBeGreaterThan(0);
			expect(total.rainOnDamsM3).toBeGreaterThan(0);
		}
		expect(examples.some((ex) => ex.model.nodes.some((n) => n.damSeepagePerDay > 0))).toBe(true);
	});

	it('farms irrigate with different systems (N1) and the losses partly return', () => {
		const efficiencies = new Set(examples.flatMap((ex) => ex.model.nodes.filter((n) => n.kind === 'farm').map((n) => n.irrigationEfficiency)));
		expect(efficiencies.size).toBeGreaterThanOrEqual(4);
		for (const ex of examples) expect(runs.get(ex.name)!.summary.waterBalance!.total.returnFlowM3, ex.name).toBeGreaterThan(0);
	});

	it('transfers run by priority, share a dam at equal priority, honour a daily cap and move water (N4, Q18)', () => {
		const transfers = examples.flatMap((ex) => ex.model.transfers);
		expect(new Set(transfers.map((t) => t.priority)).size).toBeGreaterThan(1);
		expect(transfers.some((t) => t.dailyCapM3 !== null)).toBe(true);
		const sandspruit = byName('Sandspruit').model.transfers;
		const grootdraai = sandspruit.filter((t) => t.fromNodeId === sandspruit[0]!.fromNodeId);
		expect(grootdraai.length).toBe(2);
		expect(grootdraai[0]!.priority).toBe(grootdraai[1]!.priority);
		for (const name of ['Kleinberg', 'Sandspruit']) {
			const moved = runOf(name).series.filter((s) => s.key === 'transfer').reduce((a, s) => a + s.values.reduce((b, v) => b + Math.abs(v), 0), 0);
			expect(moved, name).toBeGreaterThan(0);
		}
	});

	it('Kleinberg: CHIRPS fills a blank, a flagged zero run and a listed period, bias-corrected (B1, CR-20)', () => {
		const s = runOf('Kleinberg').summary;
		expect(s.chirpsCorrection?.correctedDays).toBeGreaterThan(0);
		expect(s.zeroRainInfill?.periods.map((p) => p.source)).toEqual(['flagged', 'listed']);
		expect(s.zeroRainInfill?.unfilledDays).toBe(0);
	});

	it('Kleinberg: the three weeks read in one go are detected as an accumulation and spread back by CHIRPS (B4)', () => {
		const a = runOf('Kleinberg').summary.rainAccumulation!;
		const w = a.windows.find((x) => x.end === '2017-06-26');
		expect(w).toMatchObject({ source: 'detected', status: 'spread' });
		expect(w!.usedMm).toBeCloseTo(w!.totalMm, 6);
		expect(a.spreadDays).toBeGreaterThanOrEqual(22);
	});

	it('Kleinberg: an excluded water year and a stored GR4J fit that describes the settings', () => {
		const ex = byName('Kleinberg');
		expect(runOf('Kleinberg').summary.calibration?.excludedDays).toBeGreaterThan(300);
		const fit = resolveFitRecord(ex.settings as Parameters<typeof resolveFitRecord>[0])!;
		expect(fit.model).toBe('gr4j');
		expect(fit.splitSample).not.toBeNull();
		expect(fit.differential).not.toBeNull();
		expect(fit.fit.scores.kgePrime!).toBeGreaterThan(fit.before.scores.kgePrime!);
		expect(ex.settings.gr4j).toMatchObject(fit.params);
		expect(fitRecordStatus(ex.settings, fit)).toEqual({
			editedParams: [],
			otherModel: false,
			windowChanged: false,
			exclusionsChanged: false,
			qualityFlagsChanged: false,
			flowKindChanged: false,
			forcingChanged: false,
			chirpsSourceChanged: false,
			apanDailyChanged: false,
			chirpsFactorsChanged: false,
			observedOriginChanged: false,
			flowFillChanged: false,
			rulesChanged: false,
			draftRules: false
		});
	});

	it('Droëvlei: a logger that drifted is flagged against the gauge, and the report covers a window', () => {
		const s = runOf('Droëvlei').summary;
		expect(s.dataQuality?.observedAgreement?.years.filter((y) => y.flagged).map((y) => y.waterYear)).toEqual([2020]);
		expect(s.calibration?.flowKind).toBe('flow_observed_m3s');
		expect([s.curtailment?.reportStart, s.curtailment?.reportEnd]).toEqual(['2020-10-01', '2024-09-30']);
		expect(s.farms.every((f) => f.fractionSupplied < 0.5)).toBe(true);
	});

	it('Sandspruit: a calibration window, a reference gauge, a forecast past the record and a WR2012 check', () => {
		const ex = byName('Sandspruit');
		const out = runOf('Sandspruit');
		expect([out.summary.calibration?.windowStart, out.summary.calibration?.windowEnd]).toEqual(['2011-10-01', '2021-09-30']);
		expect(ex.series.map((s) => s.kind)).toEqual(expect.arrayContaining(['flow_reference_m3s', 'rain_forecast_mm']));
		expect(out.endDate).toBe('2025-01-10');
		expect(out.summary.wr2012?.quaternary).toBe('X99Z');
	});

	it('forecast mode keeps each example\'s history to the bit (WP-2.12 prefix stability)', () => {
		// Sandspruit's own 10-day forecast tail; the other two get a synthetic one.
		expect(forecastSplit(inputOf(byName('Sandspruit')))).toMatchObject({ forecastFrom: '2025-01-01', lastObserved: '2024-12-31' });
		for (const ex of examples) {
			const input = ex.name.includes('Sandspruit') ? inputOf(ex) : withForecastTail(inputOf(ex), 1);
			expect(forecastSplit(input).forecastFrom, ex.name).not.toBeNull();
			expect(checkForecastPrefix(input), ex.name).toBeNull();
		}
	}, 120_000);
});
