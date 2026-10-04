// The default run window (engine 0.45.0, issue #54): with simulationStart /
// End unset, the run covers the days with rain, not a rain series padded
// with blanks to a longer flow record, and says what it left out.
import { describe, expect, it } from 'vitest';
import { fromEpochDay, toEpochDay } from './calendar';
import { prepareRun } from './prepare';
import type { DailySeries, ModelInput, ModelOutput, NetworkNode, ProjectSettings } from './project';
import { runModel } from './run';
import { sameOutput } from './testing/invariants';

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

// Invented rain that never reads 0, so no zero run is flagged: 0.5 to 8.5 mm.
const rainOn = (i: number) => Math.round((4.5 + 4 * Math.sin(i / 7)) * 10) / 10;
const rain = (n: number, from = 0) => Array.from({ length: n }, (_, i) => rainOn(from + i));
const flow = (n: number) => Array.from({ length: n }, (_, i) => 0.2 + (i % 11) / 20);
const days = (a: string, b: string) => toEpochDay(b) - toEpochDay(a);

function input(series: Partial<Record<string, DailySeries>>, over: Partial<ProjectSettings> = {}): ModelInput {
	return {
		settings: { apanMm: [150, 180, 220, 230, 190, 160, 110, 80, 60, 60, 80, 110], ...over },
		model: {
			nodes: [node('A', { areaKm2: 50, downstreamNodeId: 'G' }), node('G', { kind: 'gauge', areaKm2: 0 })],
			crops: [],
			cropAreas: [],
			transfers: []
		},
		series: series as ModelInput['series']
	};
}

const windowWarnings = (out: ModelOutput) => out.summary.warnings.filter((w) => w.startsWith('the run covers the rain record'));
/** Everything but the warnings, which name the window only when it was the default. */
const sameRun = (a: ModelOutput, b: ModelOutput) =>
	sameOutput({ ...a, summary: { ...a.summary, warnings: [] } }, { ...b, summary: { ...b.summary, warnings: [] } });

describe('the default run window follows the rain (engine 0.45.0, issue #54)', () => {
	// Flow from 2000; the rain column padded with blanks until 2003, as a
	// workbook with a long gauge record and a short rain record imports.
	const pad = days('2000-01-01', '2003-01-01');
	const total = days('2000-01-01', '2005-12-31') + 1;
	const padded = {
		rain_catchment_mm: { startDate: '2000-01-01', values: [...new Array<null>(pad).fill(null), ...rain(total - pad, pad)] },
		flow_observed_m3s: { startDate: '2000-01-01', values: flow(total) }
	};

	it('starts on the first day with rain, and warns how many days of flow it leaves out', () => {
		const prep = prepareRun(input(padded));
		expect(prep.startDate).toBe('2003-01-01');
		expect(fromEpochDay(prep.end)).toBe('2005-12-31');
		const out = runModel(input(padded));
		expect([out.startDate, out.endDate, out.days]).toEqual(['2003-01-01', '2005-12-31', total - pad]);
		expect(windowWarnings(out)).toEqual([
			`the run covers the rain record, 2003-01-01 to 2005-12-31, and leaves out ${pad} days of observed flow before it (no rain there): set Settings → simulation start to include them`
		]);
		// No day of the run lacks rain any more (the W2 count is gone).
		expect(out.summary.warnings.some((w) => /no rainfall value/.test(w))).toBe(false);
	});

	it('is the run an explicit window over the rain record gives, to the bit', () => {
		const pinned = runModel(input(padded, { simulationStart: '2003-01-01', simulationEnd: '2005-12-31' }));
		const auto = runModel(input(padded));
		expect(sameRun(auto, pinned)).toBe(true);
		// Pinned by hand, the window is the modeller's choice: no warning.
		expect(windowWarnings(pinned)).toEqual([]);
	});

	it('an explicit start still wins, and may reach back over days without rain', () => {
		const out = runModel(input(padded, { simulationStart: '2000-01-01' }));
		expect([out.startDate, out.days]).toEqual(['2000-01-01', total]);
		expect(windowWarnings(out)).toEqual([]);
		expect(out.summary.warnings.some((w) => w.startsWith(`${pad} of ${total} days have no rainfall value`))).toBe(true);
	});

	it('trims blank days at the end too, and names the setting for the end', () => {
		const tail = 30;
		const series = {
			rain_catchment_mm: { startDate: '2003-01-01', values: [...rain(400), ...new Array<null>(tail).fill(null)] },
			flow_observed_m3s: { startDate: '2003-01-01', values: flow(400 + tail) }
		};
		const out = runModel(input(series));
		expect([out.startDate, out.days]).toEqual(['2003-01-01', 400]);
		expect(windowWarnings(out)).toEqual([
			`the run covers the rain record, 2003-01-01 to ${fromEpochDay(toEpochDay('2003-01-01') + 399)}, and leaves out ${tail} days of observed flow after it (no rain there): set Settings → simulation end to include them`
		]);
		// An explicit start leaves the end to the default, and only the end is trimmed.
		const started = runModel(input(series, { simulationStart: '2003-01-01' }));
		expect(started.days).toBe(400);
		expect(windowWarnings(started)).toHaveLength(1);
	});

	it('counts CHIRPS where it fills: the run starts with CHIRPS, not the catchment gauge', () => {
		const chirpsFrom = days('2000-01-01', '2002-01-01');
		const out = runModel(
			input({ ...padded, rain_chirps_mm: { startDate: '2002-01-01', values: rain(total - chirpsFrom, chirpsFrom) } }, { chirpsBiasCorrection: 'none' })
		);
		expect(out.startDate).toBe('2002-01-01');
		expect(windowWarnings(out)[0]).toContain(`leaves out ${chirpsFrom} days of observed flow before it`);
	});

	it('warns when flow before the rain series was never in the run, though the window is unchanged', () => {
		const late = {
			rain_catchment_mm: { startDate: '2003-01-01', values: rain(total - pad, pad) },
			flow_observed_m3s: { startDate: '2000-01-01', values: flow(total) },
			evap_apan_mm: { startDate: '2002-12-31', values: [5, 5] }
		};
		const out = runModel(input(late));
		expect(out.startDate).toBe('2003-01-01');
		expect(windowWarnings(out)).toEqual([
			`the run covers the rain record, 2003-01-01 to 2005-12-31, and leaves out ${pad} days of observed flow, 1 day of daily A-pan evaporation before it (no rain there): set Settings → simulation start to include them`
		]);
		// Without the A-pan day it is the same run the padded record gives.
		const { evap_apan_mm: _, ...noEvap } = late;
		expect(sameRun(runModel(input(noEvap)), runModel(input(padded)))).toBe(true);
	});

	it('with no rain value at all, keeps the whole series span as before', () => {
		const dry = { rain_catchment_mm: { startDate: '2003-01-01', values: new Array<null>(60).fill(null) }, flow_observed_m3s: { startDate: '2003-01-01', values: flow(60) } };
		const out = runModel(input(dry));
		expect([out.startDate, out.days]).toEqual(['2003-01-01', 60]);
		expect(windowWarnings(out)).toEqual([]);
		expect(out.summary.warnings.some((w) => w.startsWith('60 of 60 days have no rainfall value'))).toBe(true);
	});

	it('rain over the whole record: the same run as the window written out, and no warning', () => {
		const full = { rain_catchment_mm: { startDate: '2003-01-01', values: rain(500) }, flow_observed_m3s: { startDate: '2003-01-01', values: flow(500) } };
		const auto = runModel(input(full));
		const pinned = runModel(input(full, { simulationStart: '2003-01-01', simulationEnd: fromEpochDay(toEpochDay('2003-01-01') + 499) }));
		expect(sameOutput(auto, pinned)).toBe(true);
		expect(windowWarnings(auto)).toEqual([]);
	});

	it('a recorded zero run set aside at the end of the record does not move the window (it runs as 0 mm)', () => {
		const values = [...rain(365), ...new Array<number>(200).fill(0)];
		const series = { rain_catchment_mm: { startDate: '2003-01-01', values } };
		const prep = prepareRun(input(series));
		expect(prep.zeroRain?.mask.some((m) => m === 1)).toBe(true);
		expect(prep.days).toBe(values.length);
	});
});
