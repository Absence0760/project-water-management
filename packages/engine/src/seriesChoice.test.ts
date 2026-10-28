// Which CHIRPS series the run read, against the others (engine 1.90.0, issue
// #561; the outlet's and each land unit's own): a run reads the first by name, so a
// short new series can take over a long record; the run says so, naming both.
import { describe, expect, it } from 'vitest';
import { toEpochDay } from './calendar';
import type { DailySeries, ModelInput, NetworkNode } from './project';
import { runModel } from './run';
import { applyScenario } from './scenario';
import { chirpsChoiceWarnings } from './seriesChoice';

/** The outlet's warning alone (the first, when the input names no unit). */
const chirpsChoiceWarning = (...a: Parameters<typeof chirpsChoiceWarnings>) => chirpsChoiceWarnings(...a)[0] ?? null;
import { sameOutput } from './testing/invariants';

const START = toEpochDay('2020-01-01');
const DAYS = 366;
const chirps = (startDate: string, n: number, lead = 0): DailySeries => ({
	startDate,
	values: [...new Array<null>(lead).fill(null), ...Array.from({ length: n }, (_, i) => 1 + (i % 5))]
});

describe('chirpsChoiceWarning', () => {
	it('warns when another series spans more of the run than the one read, naming both and their spans', () => {
		const w = chirpsChoiceWarning(
			{
				series: { rain_chirps_mm: chirps('2020-11-01', 61) },
				seriesChoice: { rain_chirps_mm: { name: 'CHIRPS boundary', others: [{ name: 'Rainfall CHIRPS satelite (mm)', firstDay: '2009-01-01', lastDay: '2025-06-30' }] } }
			},
			START,
			DAYS
		);
		expect(w).toBe(
			'the run read the CHIRPS series “CHIRPS boundary” (1 Nov 2020 to 31 Dec 2020), which spans 61 of its 366 days, but “Rainfall CHIRPS satelite (mm)” (1 Jan 2009 to 30 Jun 2025) spans 366: ' +
				'a run reads the first CHIRPS series by name and uses only that one wherever it reads CHIRPS (the fill of catchment rain’s blank days included). Rename or remove one of them so the run reads the record you mean'
		);
	});

	it('counts only the days a series holds values on, inside the run', () => {
		// Read: blank for its first 300 days, so it spans 66 of the run; the other spans 100 (its days before the run don't count).
		const w = chirpsChoiceWarning(
			{
				series: { rain_chirps_mm: chirps('2020-01-01', 66, 300) },
				seriesChoice: { rain_chirps_mm: { name: 'A', others: [{ name: 'B', firstDay: '2019-01-01', lastDay: '2020-04-09' }] } }
			},
			START,
			DAYS
		);
		expect(w).toContain('“A” (27 Oct 2020 to 31 Dec 2020), which spans 66 of its 366 days, but “B” (1 Jan 2019 to 9 Apr 2020) spans 100:');
	});

	it('names the widest other, and an empty series read as holding no values', () => {
		const w = chirpsChoiceWarning(
			{
				series: { rain_chirps_mm: { startDate: '2020-01-01', values: [null, null] } },
				seriesChoice: {
					rain_chirps_mm: {
						name: 'A',
						others: [
							{ name: 'B', firstDay: '2020-01-01', lastDay: '2020-01-10' },
							{ name: 'C', firstDay: '2020-01-01', lastDay: '2020-06-30' },
							{ name: 'D', firstDay: null, lastDay: null }
						]
					}
				}
			},
			START,
			DAYS
		);
		expect(w).toContain('“A” (no values), which spans 0 of its 366 days, but “C” (1 Jan 2020 to 30 Jun 2020) spans 182:');
	});

	it('reads only real days and readings: an impossible date or a malformed entry is no span, a negative or NaN end is blank, never a throw', () => {
		const series = { rain_chirps_mm: { startDate: '2020-01-01', values: [-1, Number.NaN, 2, 3, -5] } };
		const w = chirpsChoiceWarning(
			{
				series,
				seriesChoice: {
					rain_chirps_mm: {
						name: 'A',
						others: [{ name: 'Bad', firstDay: '2020-02-30', lastDay: '2020-12-31' }, null as never, { firstDay: '2020-01-01' } as never, { name: 'B', firstDay: '2020-01-01', lastDay: '2020-01-05' }]
					}
				}
			},
			START,
			DAYS
		);
		// A spans its readings, 2020-01-03 to 2020-01-04 (2 days); B spans 5; "Bad" counts as no values.
		expect(w).toContain('“A” (3 Jan 2020 to 4 Jan 2020), which spans 2 of its 366 days, but “B” (1 Jan 2020 to 5 Jan 2020) spans 5:');
		expect(chirpsChoiceWarning({ series, seriesChoice: { rain_chirps_mm: { name: 'A', others: [{ name: 'Bad', firstDay: '2020-02-30', lastDay: '2020-12-31' }] } } }, START, DAYS)).toBeNull();
		expect(chirpsChoiceWarning({ series, seriesChoice: { rain_chirps_mm: { name: 'A', others: 'x' as never } } }, START, DAYS)).toBeNull();
	});

	it('says nothing when the series read spans as much as any other (a tie goes to it), or with no others', () => {
		const series = { rain_chirps_mm: chirps('2020-01-01', DAYS) };
		expect(chirpsChoiceWarning({ series, seriesChoice: { rain_chirps_mm: { name: 'A', others: [{ name: 'B', firstDay: '2000-01-01', lastDay: '2030-01-01' }] } } }, START, DAYS)).toBeNull();
		expect(chirpsChoiceWarning({ series, seriesChoice: { rain_chirps_mm: { name: 'A', others: [] } } }, START, DAYS)).toBeNull();
		expect(chirpsChoiceWarning({ series }, START, DAYS)).toBeNull();
		expect(chirpsChoiceWarning({ series, seriesChoice: null }, START, DAYS)).toBeNull();
	});
});

function node(id: string, over: Partial<NetworkNode> = {}): NetworkNode {
	return {
		id,
		name: id,
		kind: 'farm',
		downstreamNodeId: null,
		sortOrder: 0,
		areaKm2: 1,
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
	};
}

describe('chirpsChoiceWarnings at each land unit', () => {
	const model = { nodes: [{ id: 'u2', name: 'Upper' }, { id: 'u1', name: 'Lower' }] } as unknown as ModelInput['model'];
	const pick = (name: string, firstDay: string) => ({ name, others: [{ name: 'Unit record', firstDay, lastDay: '2020-12-31' }] });

	const perUnit = { unitRain: { mode: 'perUnit' } } as never;
	it('under per-unit rain, warns for each modelled unit whose own CHIRPS another series of that unit outspans, naming the unit, after the outlet and in the model’s order', () => {
		const input = {
			model,
			settings: perUnit,
			series: { rain_chirps_mm: chirps('2020-01-01', DAYS), 'rain_chirps_mm@u1': chirps('2020-12-02', 30), 'rain_chirps_mm@u2': chirps('2020-12-02', 30) },
			seriesChoice: {
				rain_chirps_mm: { name: 'Outlet', others: [{ name: 'Short', firstDay: '2020-01-01', lastDay: '2020-01-10' }] },
				unitChirps: { u1: pick('CHIRPS v3 (rnl) Lower', '2020-01-01'), u2: pick('CHIRPS v3 (rnl) Upper', '2020-12-15'), gone: pick('Old', '2020-01-01') }
			}
		};
		// The outlet's record spans the run: no warning. Upper's other spans less than its own: none. Lower's spans more.
		// A unit the model doesn't have (a scenario removed it) is about nothing the run read: none.
		expect(chirpsChoiceWarnings(input, START, DAYS)).toEqual([
			'for the unit “Lower”, the run read the CHIRPS series “CHIRPS v3 (rnl) Lower” (2 Dec 2020 to 31 Dec 2020), which spans 30 of its 366 days, but “Unit record” (1 Jan 2020 to 31 Dec 2020) spans 366: ' +
				'a run reads a unit’s first CHIRPS series by name and uses only that one for the unit’s own rain. Rename or remove one of them so the run reads the record you mean'
		]);
		// Without per-unit rain the run reads no unit’s own CHIRPS: no unit warning (the outlet's still would be).
		expect(chirpsChoiceWarnings({ ...input, settings: {} }, START, DAYS)).toEqual([]);
		expect(chirpsChoiceWarnings({ ...input, settings: { unitRain: { mode: 'off' } } as never }, START, DAYS)).toEqual([]);
	});

	it('ignores a malformed unit map or entry, never throwing', () => {
		const series = { 'rain_chirps_mm@u1': chirps('2020-01-01', 2) };
		expect(chirpsChoiceWarnings({ model, settings: perUnit, series, seriesChoice: { unitChirps: 'x' as never } }, START, DAYS)).toEqual([]);
		expect(chirpsChoiceWarnings({ model, settings: perUnit, series, seriesChoice: { unitChirps: { u1: null as never, u2: { name: 3 } as never } } }, START, DAYS)).toEqual([]);
	});
});

describe('a run with seriesChoice', () => {
	const base: ModelInput = {
		settings: { apanMm: [150, 180, 220, 230, 190, 160, 110, 80, 60, 60, 80, 110], simulationStart: '2020-01-01', simulationEnd: '2020-12-31' },
		model: { nodes: [node('A', { areaKm2: 50, downstreamNodeId: 'G' }), node('G', { kind: 'gauge', areaKm2: 0 })], crops: [], cropAreas: [], transfers: [] },
		series: {
			rain_catchment_mm: { startDate: '2020-01-01', values: Array.from({ length: DAYS }, (_, i) => (i % 3 === 0 ? null : 2)) },
			rain_chirps_mm: chirps('2020-11-01', 61)
		}
	};
	const choice = { rain_chirps_mm: { name: 'CHIRPS boundary', others: [{ name: 'Rainfall CHIRPS', firstDay: '2009-01-01', lastDay: '2025-06-30' }] } };
	const warned = (o: ReturnType<typeof runModel>) => o.summary.warnings.filter((w) => w.startsWith('the run read the CHIRPS series'));

	it('adds the warning, and changes nothing else the run computes', () => {
		const plain = runModel(base);
		const told = runModel({ ...base, seriesChoice: choice });
		expect(warned(plain)).toEqual([]);
		expect(warned(told)).toHaveLength(1);
		expect(warned(told)[0]).toContain('“CHIRPS boundary” (1 Nov 2020 to 31 Dec 2020), which spans 61 of its 366 days, but “Rainfall CHIRPS”');
		const isChoice = (w: string) => w.startsWith('the run read the CHIRPS series');
		const strip = (o: ReturnType<typeof runModel>) => ({
			...o,
			summary: { ...o.summary, warnings: o.summary.warnings.filter((w) => !isChoice(w)), warningCodes: o.summary.warningCodes?.filter((c) => !isChoice(c.text)) }
		});
		expect(sameOutput(strip(plain), strip(told))).toBe(true);
	});

	it('a scenario run on that input reads the same series, and warns as its base run does', () => {
		const { input } = applyScenario({ ...base, seriesChoice: choice }, [{ op: 'node.set', nodeId: 'A', field: 'areaKm2', value: 40 } as never]);
		expect(input.seriesChoice).toEqual(choice);
		expect(warned(runModel(input))).toHaveLength(1);
		expect(applyScenario(base, []).input.seriesChoice).toBeUndefined();
	});
});
