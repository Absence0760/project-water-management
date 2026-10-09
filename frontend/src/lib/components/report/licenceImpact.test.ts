import { licenceImpactByYearClass, toEpochDay, type DailySeries, type EvidenceLicenceImpact, type RunSeries } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import type { RunCompareResponse } from '$lib/api/types';
import { OUTLET_SITE } from '$lib/components/outcomes/matrix';
import { loadImpactSeries, type ImpactSeries } from './impactSeries';
import { buildLicenceImpactBoard, evidenceBoard, VERDICT_LABEL } from './licenceImpact';

// Nine invented water years from 1 October 2000, natural totals 900 … 8100 m³
// (terciles: 2000–02 dry, 2003–05 normal, 2006–08 wet).
const START = '2000-10-01';
const wyDays = (wy: number) => toEpochDay(`${wy + 1}-10-01`) - toEpochDay(`${wy}-10-01`);
const total = (wy: number) => (wy - 1999) * 900;

function account(years: number, use: number) {
	const rows = Array.from({ length: years }, (_, i) => {
		const wy = 2000 + i;
		return {
			waterYear: wy,
			days: wyDays(wy),
			naturalFlowM3: total(wy),
			consumptiveIrrigationM3: use,
			otherUseM3: 0,
			outflowM3: total(wy) - use,
			rainOnDamsM3: 0,
			groundwaterM3: 0,
			transfersM3: 0,
			landCoverM3: 0,
			unallocatedM3: 0,
			damEvaporationM3: 0,
			streamDepletionM3: 0,
			storageChangeM3: 0,
			residualM3: 0
		};
	});
	return { supplyAssurance: { waterAccount: { areaKm2: null, years: rows, total: { ...rows[0], waterYear: null } } } };
}

function side(label: string, use: number, years = 9): RunCompareResponse['a'] {
	return { project: { id: 'p1', name: 'Invented valley' }, run: { id: label, label, startDate: START, summary: account(years, use) } } as unknown as RunCompareResponse['a'];
}

function daily(years: number, f: (wy: number, d: number) => number): DailySeries {
	const values: number[] = [];
	for (let i = 0; i < years; i++) for (let d = 0; d < wyDays(2000 + i); d++) values.push(f(2000 + i, d));
	return { startDate: START, values };
}

const natural = (years = 9) => daily(years, (wy) => total(wy) / wyDays(wy));
const short = (years: number, below: (wy: number) => number) => daily(years, (wy, d) => (d < below(wy) ? -1 : 0));

function series(bgBelow: (wy: number) => number, appBelow: (wy: number) => number, years = 9): ImpactSeries {
	return { background: { natural: natural(years), ewrShortfall: short(years, bgBelow) }, application: { ewrShortfall: short(years, appBelow) } };
}

describe('buildLicenceImpactBoard', () => {
	it('lays out a column per class: the waterfall, the days below and the verdict, the baseline named', () => {
		const v = buildLicenceImpactBoard({
			data: { a: side('Baseline', 100), b: side('More orchard', 160) },
			series: series((wy) => (wy <= 2002 ? 5 : 0), (wy) => (wy <= 2002 ? 9 : 0)),
			method: 'auto'
		});
		if (v.status !== 'ok') throw new Error(v.reason);
		expect(v.metric).toBe('daysBelowEwr');
		expect(v.belowLabel).toBe('Days below the pragmatic EWR at the outlet');
		expect(v.background).toBe('“Baseline”');
		expect(v.nYears).toBe(9);
		expect(v.columns.map((c) => [c.label, c.nYears, c.verdict])).toEqual([
			['Dry', 3, 'moreBelow'],
			['Normal', 3, 'noChange'],
			['Wet', 3, 'noChange']
		]);
		const dry = v.columns[0]!;
		expect(dry.waterfall!.map((s) => [s.label, s.text])).toEqual([
			['Natural flow', '1 800 m³'],
			['Existing use in the baseline “Baseline”', '−100 m³'],
			['Proposed use (this run − baseline)', '−60 m³'],
			['Other: dams, storage, groundwater, land cover', '0 m³'],
			['Flow left at the outlet', '1 640 m³']
		]);
		expect(dry.below).toEqual({ background: 15, application: 27, change: '+12', units: 1095 });
		expect(dry.verdictLabel).toBe('More days below the EWR');
		expect(dry.text).toBe('The pragmatic EWR was not met on 12 more days over 3 dry years (15 in the baseline “Baseline”, 27 in this run).');
		expect(v.existingNote).toMatch(/^Existing use is the use in the baseline “Baseline” as that run modelled it/);
		expect(v.existingNote).toMatch(/For existing authorised use, compare with a baseline run at every holder’s full registered volume/);
		expect(v.notes).toEqual(['Neither run has a Reserve rule table at the outlet, so the board counts days below the pragmatic EWR.']);
	});

	it('names the runs’ daily EWR when it came from the DRM tables (engine ≥ 1.77.0), and each run’s when they differ', () => {
		const drm = (r: RunCompareResponse['a'], method: 'tab' | 'percentile') =>
			({ ...r, run: { ...r.run, summary: { ...r.run.summary, catchment: { ...r.run.summary.catchment, outletEwr: { method } } } } }) as RunCompareResponse['a'];
		const s = series((wy) => (wy <= 2002 ? 5 : 0), (wy) => (wy <= 2002 ? 9 : 0));
		const both = buildLicenceImpactBoard({ data: { a: drm(side('Baseline', 100), 'tab'), b: drm(side('More orchard', 160), 'tab') }, series: s, method: 'auto' });
		if (both.status !== 'ok') throw new Error(both.reason);
		expect(both.belowLabel).toBe('Days below the daily EWR from the DRM TAB file at the outlet');
		expect(both.columns[0]!.text).toMatch(/^The daily EWR from the DRM TAB file was not met on 12 more days/);
		expect(both.notes).toEqual(['Neither run has a Reserve rule table at the outlet, so the board counts days below the daily EWR from the DRM TAB file.']);
		const mixed = buildLicenceImpactBoard({ data: { a: side('Baseline', 100), b: drm(side('More orchard', 160), 'percentile') }, series: s, method: 'auto' });
		if (mixed.status !== 'ok') throw new Error(mixed.reason);
		expect(mixed.belowLabel).toBe('Days below each run’s daily EWR at the outlet');
	});

	it('names the compared run as the caller asks (the evidence report’s “the application”), with the same numbers', () => {
		const input = { data: { a: side('Baseline', 100), b: side('More orchard', 160) }, series: series((wy) => (wy <= 2002 ? 5 : 0), (wy) => (wy <= 2002 ? 9 : 0)), method: 'auto' as const };
		const v = buildLicenceImpactBoard({ ...input, applicationName: 'the application' });
		const control = buildLicenceImpactBoard(input);
		if (v.status !== 'ok' || control.status !== 'ok') throw new Error('unavailable');
		expect(v.application).toBe('the application');
		expect(control.application).toBe('this run');
		expect(v.columns[0]!.waterfall![2]!.label).toBe('Proposed use (the application − baseline)');
		expect(v.columns[0]!.text).toBe('The pragmatic EWR was not met on 12 more days over 3 dry years (15 in the baseline “Baseline”, 27 in the application).');
		expect(v.columns.map((c) => c.below)).toEqual(control.columns.map((c) => c.below));
		// Only the run and the start day are read: the evidence report passes no project.
		const bare = buildLicenceImpactBoard({ ...input, data: { a: { run: input.data.a.run }, b: { run: input.data.b.run } } });
		expect(bare.status).toBe('ok');
	});

	it('calls the baseline’s use existing authorised use when it is a full-allocation run, and says so when only one run is', () => {
		const full = (r: RunCompareResponse['a']) => ({ ...r, run: { ...r.run, summary: { ...r.run.summary, allocations: { mode: 'fullAllocation', tolerance: 0.1, used: 2, notMatched: 0, nodes: [] } } } }) as RunCompareResponse['a'];
		const board = (a: RunCompareResponse['a'], b: RunCompareResponse['a']) => {
			const v = buildLicenceImpactBoard({ data: { a, b }, series: series(() => 15, () => 15), method: 'auto' });
			if (v.status !== 'ok') throw new Error(v.reason);
			return v;
		};
		const both = board(full(side('Baseline', 100)), full(side('B', 160)));
		expect(both.columns[0]!.waterfall![1]!.label).toBe('Existing authorised use in the baseline “Baseline”');
		expect(both.existingNote).toMatch(/^Existing authorised use is the use in the baseline “Baseline”, a full-allocation run/);
		expect(both.notes.filter((n) => /full registered volume/.test(n))).toEqual([]);
		// Only the baseline: labelled authorised, and the mixed pair said.
		const onlyBase = board(full(side('Baseline', 100)), side('B', 160));
		expect(onlyBase.columns[0]!.waterfall![1]!.label).toBe('Existing authorised use in the baseline “Baseline”');
		expect(onlyBase.notes).toContainEqual(expect.stringMatching(/^The baseline runs every holder at their full registered volume, but this run doesn’t/));
		// Only the application: plain existing use, and the mixed pair said (positive control on the label above).
		const onlyApp = board(side('Baseline', 100), full(side('B', 160)));
		expect(onlyApp.columns[0]!.waterfall![1]!.label).toBe('Existing use in the baseline “Baseline”');
		expect(onlyApp.notes).toContainEqual(expect.stringMatching(/^This run holds every holder at their full registered volume, but the baseline doesn’t/));
	});

	it('shows "Not enough years" cells without numbers', () => {
		const v = buildLicenceImpactBoard({ data: { a: side('Baseline', 100, 2), b: side('B', 100, 2) }, series: series(() => 0, () => 0, 2), method: 'auto' });
		if (v.status !== 'ok') throw new Error(v.reason);
		for (const c of v.columns) {
			expect(c.enoughYears).toBe(false);
			expect(c.waterfall).toBeNull();
			expect(c.below).toBeNull();
			expect(c.verdictLabel).toBe('Not enough years');
		}
	});

	it('says why when the board cannot be built', () => {
		const data = { a: side('Baseline', 100), b: side('B', 100) };
		const noNatural = buildLicenceImpactBoard({ data, series: { ...series(() => 0, () => 0), background: { natural: null, ewrShortfall: null } }, method: 'auto' });
		expect(noNatural).toEqual({ status: 'unavailable', reason: 'The baseline has no natural flow series, so its water years cannot be classed.' });
		const old = { ...data, b: { ...data.b, run: { ...data.b.run, summary: {} } } } as typeof data;
		const noAccount = buildLicenceImpactBoard({ data: old, series: series(() => 0, () => 0), method: 'auto' });
		expect(noAccount.status === 'unavailable' && noAccount.reason).toMatch(/before the engine kept a water account \(engine 0\.32\.0\)/);
		const noShort = buildLicenceImpactBoard({ data, series: { ...series(() => 0, () => 0), application: { ewrShortfall: null } }, method: 'auto' });
		expect(noShort.status === 'unavailable' && noShort.reason).toMatch(/no EWR shortfall series/);
	});

	it('reads the outlet, with a note, when a run has no Reserve results at the chosen gauge', () => {
		const v = buildLicenceImpactBoard({
			data: { a: side('Baseline', 100), b: side('B', 100) },
			series: series(() => 0, () => 0),
			method: 'terciles',
			site: { id: 'g1', label: 'Gauge: Upper', where: 'gauge Upper' }
		});
		if (v.status !== 'ok') throw new Error(v.reason);
		expect(v.notes[0]).toBe('The baseline or this run has no Reserve results at gauge Upper, so the board reads the outlet.');
		expect(v.belowLabel).toBe('Days below the pragmatic EWR at the outlet');
	});

	it('counts a forecast run’s record only: its forecast days change nothing (issue #51)', () => {
		// The application is a forecast run whose last water year (2008, wet) ran on forecast rain.
		const forecast = (s: RunCompareResponse['a']) => ({ ...s, run: { ...s.run, summary: { ...s.run.summary, forecast: { from: '2008-10-01' } } } }) as RunCompareResponse['a'];
		const board = (appBelow: (wy: number) => number) =>
			buildLicenceImpactBoard({ data: { a: side('Baseline', 100), b: forecast(side('Forecast', 160)) }, series: series((wy) => (wy <= 2002 ? 5 : 0), appBelow), method: 'auto' });
		const quiet = board((wy) => (wy <= 2002 ? 9 : 0));
		const loud = board((wy) => (wy <= 2002 ? 9 : wy === 2008 ? 365 : 0));
		if (quiet.status !== 'ok' || loud.status !== 'ok') throw new Error('unavailable');
		expect(loud.columns.map((c) => c.below)).toEqual(quiet.columns.map((c) => c.below));
		// Positive control: the same days in an ordinary run are counted.
		const ordinary = buildLicenceImpactBoard({
			data: { a: side('Baseline', 100), b: side('Ordinary', 160) },
			series: series((wy) => (wy <= 2002 ? 5 : 0), (wy) => (wy <= 2002 ? 9 : wy === 2008 ? 365 : 0)),
			method: 'auto'
		});
		if (ordinary.status !== 'ok') throw new Error(ordinary.reason);
		expect(ordinary.columns.find((c) => c.label === 'Wet')).toMatchObject({ nYears: 3, below: { application: 365, change: '+365' } });
		// The forecast year isn't one of the record's: the wet class has two years, too few to judge.
		expect(quiet.columns.find((c) => c.label === 'Wet')).toMatchObject({ nYears: 2, below: null });
	});

	it('has a verdict label for every verdict of both metrics', () => {
		for (const m of Object.values(VERDICT_LABEL)) expect(Object.keys(m).sort()).toEqual(['fewerBelow', 'moreBelow', 'noChange', 'notEnoughYears']);
		expect(OUTLET_SITE.id).toBeNull();
	});
});

describe('evidenceBoard (evidence-5: the engine’s numbers from the document)', () => {
	const data = { a: side('Baseline', 100), b: side('More orchard', 160) };
	const sr = series((wy) => (wy <= 2002 ? 5 : 0), (wy) => (wy <= 2002 ? 9 : 0));
	const asRun = (key: string, s: DailySeries): RunSeries => ({ nodeId: null, key, label: key, unit: 'm³/day', values: s.values as number[] });
	const impact = licenceImpactByYearClass({
		background: { startDate: START, summary: data.a.run.summary, series: [asRun('natural_flow', sr.background.natural!), asRun('ewr_shortfall', sr.background.ewrShortfall!)] },
		application: { startDate: START, summary: data.b.run.summary, series: [asRun('ewr_shortfall', sr.application.ewrShortfall!)] },
		yearClassMethod: 'auto'
	});
	const li = (over: Partial<EvidenceLicenceImpact> = {}): EvidenceLicenceImpact => ({
		yearClassMethod: 'auto',
		requestedSite: null,
		site: null,
		siteFellBack: false,
		result: { status: 'ok', impact },
		...over
	});

	it('words the frozen numbers exactly as the impact report words the same runs', () => {
		expect(evidenceBoard(li(), data)).toEqual(buildLicenceImpactBoard({ data, series: sr, method: 'auto', applicationName: 'the application' }));
	});

	it('names the gauge it reads, and says so when the chosen gauge fell back to the outlet', () => {
		const at = evidenceBoard(li({ requestedSite: { nodeId: 'g', name: 'Upper' }, site: { nodeId: 'g', name: 'Upper' }, result: { status: 'ok', impact: { ...impact, metric: 'reserveMonthsMet' } } }), data);
		expect(at.status === 'ok' && at.belowLabel).toBe('Months below the Reserve (the rule table at gauge Upper)');
		const back = evidenceBoard(li({ requestedSite: { nodeId: 'g', name: 'Upper' }, siteFellBack: true }), data);
		expect(back.status === 'ok' && back.notes[0]).toBe('The baseline or the application has no Reserve results at gauge Upper, so the board reads the outlet.');
	});

	it('says why a board is missing', () => {
		const why = (reason: 'notBuilt' | 'noNaturalFlow' | 'noWaterAccount' | 'noEwrShortfall' | 'failed', detail: string | null = null) =>
			evidenceBoard(li({ result: { status: 'unavailable', reason, detail } }), data);
		expect(why('noNaturalFlow')).toEqual({ status: 'unavailable', reason: 'The baseline has no natural flow series, so its water years cannot be classed.' });
		expect(why('noWaterAccount')).toMatchObject({ reason: expect.stringMatching(/engine 0\.32\.0/) });
		expect(why('noEwrShortfall')).toMatchObject({ reason: expect.stringMatching(/no EWR shortfall series/) });
		expect(why('notBuilt')).toMatchObject({ reason: expect.stringMatching(/built without licence impact/) });
		expect(why('failed', 'boom')).toEqual({ status: 'unavailable', reason: 'The board could not be built: boom' });
	});
});

describe('loadImpactSeries', () => {
	it('fetches the baseline natural flow and both shortfalls, a failed one as null', async () => {
		const asked: string[] = [];
		const s = await loadImpactSeries(
			async (p, r, k) => {
				asked.push(`${p}:${r}:${k}`);
				if (r === 'b' && k === 'ewr_shortfall') throw new Error('404');
				return { startDate: START, values: [1] };
			},
			{ projectId: 'p0', runId: 'a' },
			{ projectId: 'p1', runId: 'b' }
		);
		expect(asked.sort()).toEqual(['p0:a:ewr_shortfall', 'p0:a:natural_flow', 'p1:b:ewr_shortfall']);
		expect(s.background.natural).toEqual({ startDate: START, values: [1] });
		expect(s.application.ewrShortfall).toBeNull();
	});
});
