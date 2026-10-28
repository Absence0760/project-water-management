// The run warnings' stable codes (engine ≥ 1.102.0, issue #611 phase 2, ./warningCodes.ts): each coded
// warning is triggered and its code, its params and its text (exactly the plain warning's) checked.
// Synthetic values only (public repo).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Monthly } from './calendar';
import { accumulationWarnings, type AccumulationWindowInfo, type RainAccumulationInfo } from './accumulation';
import { gapRainWarnings, type GapProductInfo, type GapRainInfo } from './gapRain';
import { mergeSettings } from './prepare';
import { stationChirpsSeriesKey, stationSeriesKey, type ModelInput, type NetworkNode, type ProjectSettings, type RunSummary } from './project';
import type { SeriesCheckKind } from './quality';
import { chirpsCorrectionWarning, keepDryDoubtWarnings, zeroRainWarnings, type ChirpsCorrection, type ZeroRainInfill } from './rain';
import { rainSourcePeriodWarnings, type RainSourceInfo, type RainSourcePeriodInfo } from './rainSourcePeriods';
import { pickObservedKind, runModelWith } from './run';
import { catchmentStationPlan, unitStationRecipe, type StationContext } from './runoff/stationForcing';
import { checkedStationRecord } from './runoff/stationRecord';
import { unitGaugeCheckWarnings } from './runoff/unitGaugeChecks';
import { chirpsChoiceWarnings } from './seriesChoice';
import { isWarningCode, warn, WARNING_CODES, withWarningScope, type CodedWarning, type WarningCode, type WarningScope } from './warningCodes';

/** Every code a test below saw, checked against the catalogue at the end. */
const seen = new Set<string>();

/**
 * The scope of the test running (`scoped`): the codes its helper calls record, as a run's would. A helper called
 * outside any scope records nothing, so each test reads only its own.
 */
let current: WarningScope | null = null;
const scoped = (body: () => void) => () =>
	withWarningScope((s) => {
		current = s;
		try {
			body();
		} finally {
			current = null;
		}
	});

/** The coded warnings among `warnings` (the test's scope's, or `codes`), after checking each one's text is a warning, in order. */
function coded(warnings: readonly string[], codes?: readonly CodedWarning[]): CodedWarning[] {
	const c = codes ? [...codes] : current!.codesOf(warnings);
	let at = 0;
	for (const w of c) {
		at = warnings.indexOf(w.text, at);
		expect(at, w.code).toBeGreaterThanOrEqual(0);
		at++;
		seen.add(w.code);
	}
	return c;
}

/** The one coded warning with this code: its text is exactly one of the plain warnings. */
function one(warnings: readonly string[], code: WarningCode): CodedWarning {
	const hits = coded(warnings).filter((c) => c.code === code);
	expect(hits, code).toHaveLength(1);
	expect(warnings).toContain(hits[0]!.text);
	return hits[0]!;
}

describe('the catalogue', () => {
	it('names a settings panel (or the Data page) and a group for every code', () => {
		const panels = new Set(['set-period', 'set-rain', 'set-quality', 'set-share', 'set-unit-rain', 'set-record', 'set-flow', 'set-fit']);
		for (const [code, info] of Object.entries(WARNING_CODES)) {
			expect(info.setting === null || panels.has(info.setting), code).toBe(true);
			expect(['note', 'check'], code).toContain(info.group);
			expect(code).toMatch(/^(data|rain|calibration|map)\.[a-zA-Z.]+$/);
		}
		expect(isWarningCode('rain.none')).toBe(true);
		expect(isWarningCode('toString')).toBe(false);
		expect(isWarningCode(3)).toBe(false);
	});

	it('has a code for every data-check kind, which run.ts codes as data.<kind>', () => {
		const kinds: SeriesCheckKind[] = ['negative', 'outlier', 'flatline', 'zerorun', 'lowvschirps', 'doublemass'];
		for (const k of kinds) expect(isWarningCode(`data.${k}`), k).toBe(true);
	});

	it('every code is used by the engine, and every code the engine uses is in the catalogue', () => {
		const files: string[] = [];
		const walk = (dir: string) => {
			for (const f of readdirSync(dir)) {
				const p = join(dir, f);
				if (statSync(p).isDirectory()) walk(p);
				else if (p.endsWith('.ts') && !p.endsWith('.test.ts') && !p.endsWith('warningCodes.ts')) files.push(p);
			}
		};
		walk(import.meta.dirname);
		const src = files.map((f) => readFileSync(f, 'utf8')).join('\n');
		const used = new Set([...src.matchAll(/warn\(\s*'([^']+)'/g)].map((m) => m[1]!));
		for (const code of used) expect(isWarningCode(code), code).toBe(true);
		// The data checks are coded through one template (`data.${c.check}`).
		expect(src).toContain('warn(`data.${c.check}`');
		for (const code of Object.keys(WARNING_CODES)) if (!code.startsWith('data.') || code === 'data.flowAgreement') expect(used.has(code), code).toBe(true);
	});
});

describe('warn and the run’s scope', () => {
	it('returns the text unchanged and reads back the code, in the warnings’ order; an uncoded text is left out', () => {
		const out = withWarningScope((scope) => {
			const a = warn('rain.none', {}, 'synthetic warning A');
			const b = warn('calibration.noObserved', { n: 1 }, 'synthetic warning B');
			const b2 = warn('calibration.noObserved', { n: 1 }, 'synthetic warning B');
			expect([a, b2]).toEqual(['synthetic warning A', 'synthetic warning B']);
			return scope.codesOf([b, 'not coded', a, b, b]);
		});
		// B was coded twice, so two of its three copies are; the third is a copy pushed uncoded.
		expect(out).toEqual([
			{ code: 'calibration.noObserved', params: { n: 1 }, text: 'synthetic warning B' },
			{ code: 'rain.none', params: {}, text: 'synthetic warning A' },
			{ code: 'calibration.noObserved', params: { n: 1 }, text: 'synthetic warning B' }
		]);
	});

	it('is run-scoped: a later run’s uncoded copy stays uncoded, params are each run’s own, and nested runs keep theirs', () => {
		const text = 'synthetic warning shared';
		const first = withWarningScope((scope) => scope.codesOf([warn('rain.missingDays', { days: 1 }, text)]));
		expect(first).toEqual([{ code: 'rain.missingDays', params: { days: 1 }, text }]);
		// The same text pushed uncoded in a later run is not coded by the earlier run's record.
		expect(withWarningScope((scope) => scope.codesOf([text]))).toEqual([]);
		// Outside any scope warn records nothing, so no later scope sees it.
		warn('rain.missingDays', { days: 9 }, text);
		expect(withWarningScope((scope) => scope.codesOf([text]))).toEqual([]);
		// A run nested in another records into its own scope; the outer one's params stay its own.
		const outer = withWarningScope((scope) => {
			const w = warn('rain.missingDays', { days: 2 }, text);
			const inner = withWarningScope((s2) => s2.codesOf([warn('rain.missingDays', { days: 3 }, text)]));
			expect(inner).toEqual([{ code: 'rain.missingDays', params: { days: 3 }, text }]);
			return scope.codesOf([w]);
		});
		expect(outer).toEqual([{ code: 'rain.missingDays', params: { days: 2 }, text }]);
		// A scope closes when its body throws, too.
		expect(() => withWarningScope(() => { throw new Error('boom'); })).toThrow('boom');
		expect(withWarningScope((scope) => scope.codesOf([text]))).toEqual([]);
	});

	it('two runs of one input give the same codes, whatever ran before', () => {
		const input = { settings: { simulationStart: '2020-01-01', simulationEnd: '2020-01-10' }, model: { nodes: [], crops: [], cropAreas: [], transfers: [] }, series: {} } as unknown as ModelInput;
		const a = runModelWith(input, () => ({ naturalFlowM3Day: new Array(10).fill(0) })).summary.warningCodes;
		withWarningScope(() => warn('rain.none', { stale: 1 }, 'no rainfall series: natural flow is only what drains from the stores the warm-up filled, and demand is not reduced by rain'));
		const b = runModelWith(input, () => ({ naturalFlowM3Day: new Array(10).fill(0) })).summary.warningCodes;
		expect(b).toEqual(a);
		expect(a!.find((c) => c.code === 'rain.none')!.params).toEqual({});
	});
});

describe('catchment rain: zero runs, kept-dry doubts and accumulations', () => {
	it(
		'codes each zero-run warning with its figures',
		scoped(() => {
			const z = {
				mode: 'missing',
				periods: [{ start: '2019-06-01', end: '2019-08-15', source: 'flagged', reason: null, days: 76, recordedMm: 0, filledMm: 40 }],
				keptDry: [{ start: '2018-06-01', end: '2018-06-30', days: 30, reason: 'invented' }],
				asRecordedDays: 12,
				fillAboveChirpsMm: 2,
				chirpsDryDays: 5,
				days: 76,
				recordedMm: 0,
				filledMm: 40.4,
				unfilledDays: 3
			} as unknown as ZeroRainInfill;
			const w = zeroRainWarnings(z);
			expect(w).toHaveLength(4);
			expect(one(w, 'rain.zeroRun.missing').params).toEqual({ days: 76, periods: 1, filledMm: 40, recordedMm: 0, unfilledDays: 3 });
			expect(one(w, 'rain.zeroRun.keptDry').params).toEqual({ days: 30, periods: 1 });
			expect(one(w, 'rain.zeroRun.chirpsDry').params).toEqual({ days: 5, fillAboveChirpsMm: 2 });
			expect(one(w, 'rain.zeroRun.asRecorded').params).toEqual({ days: 12 });
			expect(coded(w).map((c) => c.text)).toEqual(w);
		})
	);

	it(
		'codes a doubtful kept-dry stretch',
		scoped(() => {
			const c = { mode: 'monthly', doubtfulKeepDry: [{ start: '2018-06-01', end: '2018-06-30', days: 30, chirpsMm: 88.4, limitMm: 50, waterYears: [2017] }] } as unknown as ChirpsCorrection;
			const w = keepDryDoubtWarnings(c);
			expect(one(w, 'rain.keepDry.doubtful').params).toEqual({ start: '2018-06-01', end: '2018-06-30', days: 30, chirpsMm: 88, limitMm: 50 });
		})
	);

	it(
		'codes each accumulation status',
		scoped(() => {
			const win = (status: AccumulationWindowInfo['status'], over: Partial<AccumulationWindowInfo> = {}) =>
				({ start: '2017-06-05', end: '2017-06-26', source: 'detected', status, daysInRun: 21, totalMm: 60, readingMm: 60, usedMm: 60, outageDays: null, keptReason: 'invented', reason: 'invented', ...over }) as unknown as AccumulationWindowInfo;
			const info = {
				windows: [win('spread'), win('noChirps'), win('setAside', { outageDays: 9 }), win('kept'), win('asRecorded'), win('noReading', { source: 'listed' })],
				skipped: ['a listed window skipped (uncoded)'],
				spreadWindows: 1,
				spreadDays: 21,
				spreadMm: 60
			} as unknown as RainAccumulationInfo;
			const w = accumulationWarnings(info, [info.windows[4]!]);
			expect(one(w, 'rain.accumulation.spread').params).toEqual({ windows: 1, days: 21 });
			expect(one(w, 'rain.accumulation.noChirps').params).toEqual({ windows: 1 });
			expect(one(w, 'rain.accumulation.setAside').params).toEqual({ readings: 1 });
			expect(one(w, 'rain.accumulation.kept').params).toEqual({ windows: 1 });
			expect(one(w, 'rain.accumulation.asRecorded').params).toEqual({ windows: 1, doubleCounted: 1 });
			expect(one(w, 'rain.accumulation.noReading').params).toEqual({ windows: 1 });
			// The skipped line stays uncoded: it is a settings problem, not a rain check.
			expect(coded(w)).toHaveLength(6);
			expect(w).toHaveLength(7);
		})
	);
});

describe('CHIRPS and the gap-filling products', () => {
	it(
		'codes CHIRPS standing in raw (no factor fitted)',
		scoped(() => {
			const c = { mode: 'monthly', fallbackDays: 40, correctedDays: 0, minDays: 90, minMm: 50, months: [], fitPeriod: null, doubtfulKeepDry: [], excludedWaterYears: [] } as unknown as ChirpsCorrection;
			const w = chirpsCorrectionWarning(c)!;
			expect(w).toMatch(/^CHIRPS rain stands in for blank catchment rain on 40 days and is not bias-corrected/);
			expect(one([w], 'rain.chirps.uncorrected').params).toEqual({ days: 40 });
		})
	);

	it(
		'codes each gap-product warning with its product',
		scoped(() => {
			const product = (over: Partial<GapProductInfo>): GapProductInfo =>
				({ key: 'k', product: 'era5l', version: null, label: 'ERA5-Land', present: true, correction: null, doubleMass: null, days: 20, rawMm: 30, mm: 33, ...over }) as GapProductInfo;
			const corrected = { correctedDays: 20, fitWindow: { from: '2010-10-01', to: '2020-09-30' }, months: Array.from({ length: 12 }, (_, i) => ({ month: i + 1, factor: 1.1, source: 'own', clamped: false })), quantileMap: null } as unknown as ChirpsCorrection;
			const dm = { breaks: [{ afterWaterYear: 2012 }], segments: [{ fromWaterYear: 2005, toWaterYear: 2012, slope: 1.1 }, { fromWaterYear: 2013, toWaterYear: 2020, slope: 0.8 }] };
			const info = {
				product: 'era5l',
				imergLate: true,
				chirpsDays: 0,
				tailFrom: null,
				segments: [],
				products: [product({ present: false, days: 0 }), product({ product: 'imerg_late', label: 'IMERG Late V07', present: false, days: 0 }), product({}), product({ correction: corrected, doubleMass: dm as never })]
			} as unknown as GapRainInfo;
			const w = gapRainWarnings(info);
			const absent = coded(w).filter((c) => c.code === 'rain.gapProduct.absent');
			expect(absent.map((c) => c.params)).toEqual([{ product: 'era5l' }, { product: 'imerg_late' }]);
			expect(one(w, 'rain.gapProduct.doubleMassBreak').params).toEqual({ product: 'era5l', breaks: 1 });
			expect(one(w, 'rain.gapProduct.uncorrected').params).toEqual({ product: 'era5l', days: 20 });
			expect(one(w, 'rain.gapProduct.corrected').params).toEqual({ product: 'era5l', days: 20 });
			expect(coded(w).map((c) => c.text)).toEqual(w);
		})
	);

	it(
		'codes a rain-source period, leaving its intensity check uncoded',
		scoped(() => {
			const p = { start: '2010-10-01', end: '2012-09-30', series: 'rain_catchment_alt_mm', reason: 'invented', seriesPresent: false, runDays: 731, fallback: 'chirps', factors: [] } as unknown as RainSourcePeriodInfo;
			const w = rainSourcePeriodWarnings({ periods: [p] } as RainSourceInfo);
			expect(one(w, 'rain.sourcePeriod').params).toEqual({ start: '2010-10-01', end: '2012-09-30', series: 'rain_catchment_alt_mm', runDays: 731 });
		})
	);

	it(
		'codes a shadowed CHIRPS series, at the outlet and at a unit',
		scoped(() => {
			const chirps = (startDate: string, n: number) => ({ startDate, values: Array.from({ length: n }, (_, i) => 1 + (i % 5)) });
			const start = Date.UTC(2020, 0, 1) / 86_400_000;
			const w = chirpsChoiceWarnings(
				{
					model: { nodes: [{ id: 'u1', name: 'Lower' }] } as never,
					settings: { unitRain: { mode: 'perUnit' } } as never,
					series: { rain_chirps_mm: chirps('2020-11-01', 61), 'rain_chirps_mm@u1': chirps('2020-12-02', 30) },
					seriesChoice: {
						rain_chirps_mm: { name: 'A', others: [{ name: 'B', firstDay: '2009-01-01', lastDay: '2025-06-30' }] },
						unitChirps: { u1: { name: 'C', others: [{ name: 'D', firstDay: '2020-01-01', lastDay: '2020-12-31' }] } }
					}
				},
				start,
				366
			);
			expect(coded(w).map((c) => [c.code, c.params])).toEqual([
				['rain.chirpsShadowed', { where: 'catchment' }],
				['rain.chirpsShadowed', { where: 'unit', unit: 'u1', name: 'Lower' }]
			]);
		})
	);
});

describe('rain stations and unit gauges', () => {
	const START = '2015-01-01';
	const D0 = Date.UTC(2015, 0, 1) / 86_400_000;
	const DAYS = Date.UTC(2021, 0, 1) / 86_400_000 - D0;
	const monthOf = (i: number) => new Date((D0 + i) * 86_400_000).getUTCMonth() + 1;
	const rainOf = (): (number | null)[] => Array.from({ length: DAYS }, (_, i) => (monthOf(i) >= 4 && monthOf(i) <= 9 ? 0.3 : 1.5) * (i % 13 === 0 ? 30 : i % 4 === 0 ? 2 : 0));
	const at = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / 86_400_000 - D0;
	const withZeroRun = (v: (number | null)[]) => v.map((x, i) => (i >= at('2016-11-01') && i <= at('2017-02-28') ? 0 : x));
	const settingsWith = (raw: Record<string, unknown>, rainStations: ProjectSettings['rainStations'] = null): ProjectSettings => ({ ...mergeSettings(raw, []), rainStations });
	const seriesOf = (values: (number | null)[]) => ({ [stationSeriesKey('S1')]: { startDate: START, values } }) as unknown as ModelInput['series'];

	it(
		'codes a station’s zero runs, set aside or run as recorded',
		scoped(() => {
			const set = checkedStationRecord(settingsWith({}), seriesOf(withZeroRun(rainOf())), 'S1', { name: 'Hill' })!;
			expect(one(set.warnings, 'rain.station.zeroRun.missing').params).toEqual({ station: 'S1', days: expect.any(Number) });
			const zr = mergeSettings({}, []).zeroRainRuns;
			const kept = checkedStationRecord(settingsWith({ zeroRainRuns: { ...zr, mode: 'asRecorded' } }), seriesOf(withZeroRun(rainOf())), 'S1', { name: 'Hill' })!;
			expect(one(kept.warnings, 'rain.station.zeroRun.asRecorded').params.station).toBe('S1');
		})
	);

	it(
		'codes a station’s accumulations, spread or run as recorded',
		scoped(() => {
			const gauge = rainOf();
			const cell = rainOf().map((v) => (v === null ? null : v * 0.7));
			const b0 = at('2017-05-10');
			for (let i = b0; i <= at('2017-05-14'); i++) gauge[i] = null;
			gauge[at('2017-05-15')] = 60;
			gauge[b0 - 1] = 0;
			for (let i = b0 - 1; i <= at('2017-05-16'); i++) cell[i] = i >= b0 && i <= b0 + 3 ? 15 : 0;
			const series = { [stationSeriesKey('S1')]: { startDate: START, values: gauge }, [stationChirpsSeriesKey('S1')]: { startDate: START, values: cell }, rain_chirps_mm: { startDate: START, values: cell } } as unknown as ModelInput['series'];
			const spread = checkedStationRecord(settingsWith({}), series, 'S1')!;
			expect(one(spread.warnings, 'rain.station.accumulation.spread').params).toEqual({ station: 'S1', windows: 1, days: 6, mm: 60 });
			const zr = mergeSettings({}, []).zeroRainRuns;
			const asRec = checkedStationRecord(settingsWith({ zeroRainRuns: { ...zr, accumulationMode: 'asRecorded' } }), series, 'S1')!;
			expect(one(asRec.warnings, 'rain.station.accumulation.asRecorded').params).toEqual({ station: 'S1', windows: 1 });
		})
	);

	it(
		'codes a station’s reading after a blank outage, set aside',
		scoped(() => {
			const gauge = rainOf();
			const cell = rainOf().map((v) => (v === null ? null : v * 0.7));
			const b0 = at('2018-01-05');
			const read = b0 + 10;
			gauge[b0 - 1] = 5;
			for (let i = b0; i < read; i++) [gauge[i], cell[i]] = [null, i === read - 1 ? 0 : 4];
			[gauge[read], cell[read], gauge[read + 1], cell[read + 1]] = [60, 0, 5, 0];
			const series = { [stationSeriesKey('S1')]: { startDate: START, values: gauge }, [stationChirpsSeriesKey('S1')]: { startDate: START, values: cell }, rain_chirps_mm: { startDate: START, values: cell } } as unknown as ModelInput['series'];
			const r = checkedStationRecord(settingsWith({}), series, 'S1')!;
			expect(one(r.warnings, 'rain.station.accumulation.setAside').params).toEqual({ station: 'S1', readings: 1 });
		})
	);

	it(
		'codes a station’s unreliable periods, and one that isn’t two dates',
		scoped(() => {
			const stored = rainOf().map((v) => v! + 1);
			const s = settingsWith({}, { unreliable: { S1: [['2018-03-01', '2018-03-10'], ['2018-03-10', '2018-03-01']] } } as never);
			const r = checkedStationRecord(s, seriesOf(stored), 'S1', { name: 'Hill' })!;
			expect(one(r.warnings, 'rain.station.unreliable').params).toEqual({ station: 'S1', days: 10 });
			expect(one(r.warnings, 'rain.station.unreliableInvalid').params).toEqual({ station: 'S1' });
		})
	);

	it(
		'codes a station with no record, for the catchment and for a unit',
		scoped(() => {
			const ctx = { settings: { rainStations: { catchment: { stationId: 'S9' } } }, record: () => null, name: (id: string) => id } as unknown as StationContext;
			const warnings: string[] = [];
			expect(catchmentStationPlan(ctx, warnings)).toBeNull();
			expect(unitStationRecipe(ctx, { id: 'u1', name: 'Upper' } as NetworkNode, { stationId: 'S9' } as never, warnings)).toBeNull();
			expect(coded(warnings).map((c) => c.params)).toEqual([
				{ station: 'S9', where: 'catchment' },
				{ station: 'S9', where: 'unit', unit: 'u1' }
			]);
			expect(coded(warnings).every((c) => c.code === 'rain.station.noRecord')).toBe(true);
		})
	);

	it(
		'codes each of a unit gauge’s checks, naming the unit',
		scoped(() => {
			const w = unitGaugeCheckWarnings('Upper', { values: [], zeroRunDays: 30, zeroRunAsRecordedDays: 4, spreadWindows: 1, spreadDays: 6, spreadMm: 60.2, setAside: 2, asRecorded: 1, unreliableDays: 3 });
			expect(coded(w).map((c) => [c.code, c.params])).toEqual([
				['rain.unitGauge.zeroRun.missing', { unit: 'Upper', days: 30 }],
				['rain.unitGauge.zeroRun.asRecorded', { unit: 'Upper', days: 4 }],
				['rain.unitGauge.accumulation.spread', { unit: 'Upper', windows: 1, days: 6, mm: 60 }],
				['rain.unitGauge.accumulation.setAside', { unit: 'Upper', readings: 2 }],
				['rain.unitGauge.accumulation.asRecorded', { unit: 'Upper', windows: 1 }],
				['rain.unitGauge.unreliable', { unit: 'Upper', days: 3 }]
			]);
		})
	);
});

describe('a run’s summary.warningCodes', () => {
	const zeros = new Array(12).fill(0) as unknown as Monthly;
	const node = (id: string, over: Partial<NetworkNode> = {}): NetworkNode =>
		({ id, name: id, kind: 'farm', downstreamNodeId: null, sortOrder: 0, areaKm2: 1, pctUpstreamToDam: 0, pctRunoffToDam: 0, damCapacityM3: 0, damInitialPct: 0, damMinPct: 0, divertCapacityM3Day: 0, irrigationEfficiency: 1, returnFlowFraction: 0, damAreaFullM2: 0, damAreaExponent: 0.7, damSeepagePerDay: 0, ...over }) as NetworkNode;
	const DAYS = 730;
	const START = '2018-10-01';
	const ser = (values: (number | null)[]) => ({ startDate: START, values });
	const flow = (i: number) => 1 + ((i * 7) % 11) / 10;
	const run = (settings: Partial<ProjectSettings>, series: ModelInput['series'], nodes = [node('o')]): RunSummary =>
		runModelWith({ settings: { ewrPragmaticM3PerDay: zeros, ...settings }, model: { nodes, crops: [], cropAreas: [], transfers: [] }, series }, () => ({ naturalFlowM3Day: new Array(DAYS).fill(86_400) })).summary;
	const rain = Array.from({ length: DAYS }, (_, i) => (i % 5 === 0 ? 4 + (i % 3) : 0));

	/** Every coded warning is a warning, in order, and its code is in the catalogue. */
	const codesOf = (s: RunSummary) => {
		expect(s.warningCodes).toBeDefined();
		return coded(s.warnings, s.warningCodes);
	};

	it('codes missing rain days and a run with no observed flow', () => {
		const s = run({}, { rain_catchment_mm: ser(rain.map((v, i) => (i >= 100 && i < 110 ? null : v))) });
		expect(codesOf(s).find((c) => c.code === 'rain.missingDays')!.params).toEqual({ days: 10, runDays: DAYS, periods: 1 });
		expect(codesOf(s).some((c) => c.code === 'calibration.noObserved')).toBe(true);
	});

	it('codes a run with no rain series', () => {
		expect(codesOf(run({ simulationStart: START, simulationEnd: '2020-09-29' }, {})).some((c) => c.code === 'rain.none')).toBe(true);
	});

	it('codes the data checks by kind, one per check, with the series and its days', () => {
		const observed: (number | null)[] = Array.from({ length: DAYS }, (_, i) => flow(i));
		observed[50] = -999;
		observed[400] = 1e6;
		const flatRain = rain.map((v, i) => (i >= 200 && i < 240 ? 7 : v));
		const s = run({}, { rain_catchment_mm: ser(flatRain), flow_observed_m3s: ser(observed) });
		const checks = s.dataQuality!.seriesChecks!;
		const data = codesOf(s).filter((c) => c.code.startsWith('data.') && c.code !== 'data.flowAgreement');
		expect(data.map((c) => [c.code, c.params, c.text])).toEqual(checks.map((c) => [`data.${c.check}`, { series: c.seriesKind, days: c.days }, c.text]));
		expect(data.map((c) => c.code)).toEqual(expect.arrayContaining(['data.negative', 'data.outlier', 'data.flatline']));
	});

	it('codes the default gauge pick and two flow records that disagree', () => {
		const gauge = Array.from({ length: DAYS }, (_, i) => flow(i));
		const s = run({}, { rain_catchment_mm: ser(rain), flow_observed_m3s: ser(gauge), flow_logger_m3s: ser(gauge.map((v) => v * 0.3)) });
		const c = codesOf(s);
		expect(c.some((x) => x.code === 'calibration.defaultGaugePick')).toBe(true);
		expect(c.find((x) => x.code === 'data.flowAgreement')!.params).toEqual({ years: s.dataQuality!.observedAgreement!.flaggedYears.length });
	});

	it('codes the calibration record’s problems', () => {
		const observed = Array.from({ length: DAYS }, (_, i) => flow(i));
		const base = { rain_catchment_mm: ser(rain), flow_observed_m3s: ser(observed) };
		const codes = (s: RunSummary) => codesOf(s).map((c) => c.code);
		expect(codes(run({ calibrationFlowKind: 'flow_logger_m3s' }, base))).toContain('calibration.flowKindMissing');
		expect(codes(run({ calibrationExclusions: [{ start: '2018-01-01', end: '2021-12-31', reason: 'invented' }] }, base))).toContain('calibration.allExcluded');
		const early = { ...base, flow_observed_m3s: ser(observed.map((v, i) => (i < 400 ? v : null))) };
		expect(codes(run({ calibrationStart: '2020-01-01', calibrationEnd: '2020-06-30' }, early))).toContain('calibration.noValuesInWindow');
		expect(codes(run({}, { ...base, flow_observed_m3s: { startDate: '2010-01-01', values: [1, 2, 3] } }))).toContain('calibration.noValuesInPeriod');
		const reversed = run({ calibrationStart: '2020-06-30', calibrationEnd: '2020-01-01' }, base);
		expect(codesOf(reversed).find((c) => c.code === 'calibration.windowReversed')!.params).toEqual({ start: '2020-06-30', end: '2020-01-01' });
		expect(codes(run({ calibrationSiteNodeId: 'gone' }, base))).toContain('calibration.site.unusable');
		const nodes = [node('a', { downstreamNodeId: 'g' }), node('g', { kind: 'gauge', name: 'Bare gauge', downstreamNodeId: 'o', areaKm2: 0 }), node('o')];
		const bare = codesOf(run({ calibrationSiteNodeId: 'g' }, base, nodes)).find((c) => c.code === 'calibration.site.noRecord');
		expect(bare!.params).toEqual({ site: 'g', name: 'Bare gauge' });
	});

	it(
		'pickObservedKind codes its two warnings',
		scoped(() => {
		const series = { flow_observed_m3s: ser([1]), flow_logger_m3s: ser([1]) } as ModelInput['series'];
		const w: string[] = [];
		pickObservedKind(null, series, w);
		pickObservedKind('flow_logger_m3s', { flow_observed_m3s: ser([1]) } as ModelInput['series'], w);
		expect(coded(w).map((c) => [c.code, c.params])).toEqual([
			['calibration.defaultGaugePick', {}],
			['calibration.flowKindMissing', { kind: 'flow_logger_m3s' }]
		]);
		})
	);
});

/** Codes asserted in the test file named, each beside the test of its warning's text, where the fixture already is. Every other code must be seen above. */
const ELSEWHERE: Partial<Record<WarningCode, string>> = {
	'rain.chirps.corrected': 'rain.quantileMap.test.ts',
	'rain.chirps.quantileMapFallback': 'rain.quantileMap.test.ts',
	'rain.chirps.doubleMassBreak': 'doublemass.test.ts',
	'rain.unit.catchmentFallback': 'runoff/stationForcing.test.ts',
	'calibration.zone.notList': 'calibrate/zones.test.ts',
	'calibration.zone.noGauge': 'calibrate/zones.test.ts',
	'calibration.zone.duplicate': 'calibrate/zones.test.ts',
	'calibration.zone.badParams': 'calibrate/zones.test.ts',
	'calibration.zone.needsPerUnit': 'calibrate/zones.test.ts',
	'calibration.zone.unusable': 'calibrate/zones.test.ts',
	'calibration.zone.unfitted': 'calibrate/zones.test.ts',
	'calibration.zone.siteOnlyElsewhere': 'calibrate/zones.test.ts',
	'map.areaFromEarlierOutline': 'mapAreas.test.ts'
};

describe('coverage', () => {
	it('every code is triggered here or asserted in the named test file', () => {
		for (const [code, file] of Object.entries(ELSEWHERE)) expect(readFileSync(join(import.meta.dirname, file!), 'utf8'), code).toContain(`'${code}'`);
		// A data check is coded by one template for every kind (run.ts `data.${c.check}`, checked in the catalogue's tests
		// and on a run above), so a kind the fixture doesn't raise (zero runs, low vs CHIRPS, double-mass) is covered too.
		const template = (c: string) => c.startsWith('data.') && c !== 'data.flowAgreement';
		const missing = Object.keys(WARNING_CODES).filter((c) => !seen.has(c) && !template(c) && !(c in ELSEWHERE));
		expect(missing).toEqual([]);
	});
});
