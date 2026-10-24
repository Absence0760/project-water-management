// Which CHIRPS series the run read, against the others (engine 1.90.0, issue
// #561): a run reads the first by name, so a short new series can take over a
// long record; the run says so, naming both.
import { describe, expect, it } from 'vitest';
import { toEpochDay } from './calendar';
import type { DailySeries, ModelInput, NetworkNode } from './project';
import { runModel } from './run';
import { applyScenario } from './scenario';
import { chirpsChoiceWarning } from './seriesChoice';
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
			'the run read the CHIRPS series “CHIRPS boundary” (2020-11-01 to 2020-12-31), which spans 61 of its 366 days, but “Rainfall CHIRPS satelite (mm)” (2009-01-01 to 2025-06-30) spans 366: ' +
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
		expect(w).toContain('“A” (2020-10-27 to 2020-12-31), which spans 66 of its 366 days, but “B” (2019-01-01 to 2020-04-09) spans 100:');
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
		expect(w).toContain('“A” (no values), which spans 0 of its 366 days, but “C” (2020-01-01 to 2020-06-30) spans 182:');
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
		expect(w).toContain('“A” (2020-01-03 to 2020-01-04), which spans 2 of its 366 days, but “B” (2020-01-01 to 2020-01-05) spans 5:');
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
		expect(warned(told)[0]).toContain('“CHIRPS boundary” (2020-11-01 to 2020-12-31), which spans 61 of its 366 days, but “Rainfall CHIRPS”');
		const strip = (o: ReturnType<typeof runModel>) => ({ ...o, summary: { ...o.summary, warnings: o.summary.warnings.filter((w) => !w.startsWith('the run read the CHIRPS series')) } });
		expect(sameOutput(strip(plain), strip(told))).toBe(true);
	});

	it('a scenario run on that input reads the same series, and warns as its base run does', () => {
		const { input } = applyScenario({ ...base, seriesChoice: choice }, [{ op: 'node.set', nodeId: 'A', field: 'areaKm2', value: 40 } as never]);
		expect(input.seriesChoice).toEqual(choice);
		expect(warned(runModel(input))).toHaveLength(1);
		expect(applyScenario(base, []).input.seriesChoice).toBeUndefined();
	});
});
