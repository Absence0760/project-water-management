import { assessSite, EQUITABLE_SHARE_FOOTNOTE, FARM_COLUMNS, plausibilityChecks, type RunSummary, type RunVerification, type WaterBalance, type WaterBalanceRow, wr2012FitStatsFromMonthly } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import {
	chirpsFactorLines,
	curtailmentLines,
	ewrAssuranceLines,
	otherUserLines,
	landCoverLines,
	groundwaterAnnualLines,
	ewrSiteLines,
	zeroRainLines,
	rainSourceCsvLines,
	accumulationLines,
	doubleMassLines,
	plausibilityLines,
	columnGuideLines,
	evidenceLines,
	nodeColumnHeader,
	seriesKeyOrder,
	summaryCsvLines,
	verificationLines,
	waterBalanceLines,
	wr2012Lines
} from './run-tables.js';

const meta = {
	projectName: 'Demo',
	runLabel: 'Baseline',
	engineVersion: '0.2.0',
	startDate: '2000-01-01',
	endDate: '2000-12-31',
	createdAt: '2026-01-01T00:00:00.000Z'
};

const summary: RunSummary = {
	farms: [
		{
			nodeId: 'n1',
			name: 'Farm, upper',
			avgCropRequirementM3Day: 90,
			avgDemandM3Day: 100,
			avgSuppliedM3Day: 80,
			avgDeficitM3Day: 20,
			fractionSupplied: 0.8,
			avgEwrShortfallM3Day: -5,
			daysEwrNotMet: 3
		}
	],
	catchment: { meanNaturalFlowM3Day: 1000, meanSimulatedOutflowM3Day: 900, ewrDaysNotMet: 4, ewrFractionDaysNotMet: 0.01 },
	calibration: { days: 300, nse: 0.5, pbias: -3, rmseM3s: 0.2, meanObservedM3s: 1, meanSimulatedM3s: 0.97 },
	warnings: ['flow shares sum to 0.99']
};

describe('series column order', () => {
	it('follows the engine order and puts unknown keys last, alphabetically', () => {
		const keys = ['zeta', 'ewr', 'outflow', 'demand', 'alpha', 'dam_storage', 'supplied'];
		expect(keys.sort(seriesKeyOrder('node'))).toEqual(['demand', 'supplied', 'dam_storage', 'outflow', 'ewr', 'alpha', 'zeta']);
		// Farm columns follow the FarmTemplate letters, intermediate columns in between.
		const farm = ['deficit', 'balance_residual', 'return_flow', 'outflow', 'interim_storage', 'upstream_to_dam', 'demand', 'crop_requirement', 'gross_demand'];
		expect(farm.sort(seriesKeyOrder('node'))).toEqual(['gross_demand', 'crop_requirement', 'demand', 'upstream_to_dam', 'interim_storage', 'return_flow', 'outflow', 'balance_residual', 'deficit']);
		const cat = ['rain_chirps_corrected', 'is_summer', 'rain_used', 'ewr', 'rain_chirps', 'rain_final', 'natural_flow'];
		// Final rainfall, then CHIRPS as uploaded and corrected, right after rain used.
		expect(cat.sort(seriesKeyOrder('catchment'))).toEqual(['natural_flow', 'ewr', 'rain_used', 'rain_final', 'rain_chirps', 'rain_chirps_corrected', 'is_summer']);
	});
});

describe('summary sheet', () => {
	it('writes run details, farms, catchment, calibration and warnings as blocks', () => {
		const lines = [...summaryCsvLines(meta, summary)];
		expect(lines.slice(0, 2)).toEqual(['Project,Demo', 'Run,Baseline']);
		const farmHeader = lines.findIndex((l) => l.startsWith('Farm,'));
		expect(lines[farmHeader]).toContain('Average crop water requirement (m³/day),Average abstraction demand (m³/day)');
		expect(lines[farmHeader]).toContain('Demand supplied (%)');
		// The fixture is a run before engine 0.27.0: no flow share, so that cell is empty.
		expect(lines[farmHeader]).toMatch(/^Farm,Flow share \(%\),Average crop water requirement/);
		expect(lines[farmHeader + 1]).toBe('"Farm, upper",,90,100,80,20,80,-5,3');
		expect(lines).toContain('Mean natural flow (m³/day),1000');
		expect(lines).toContain('NSE,0.5');
		expect(lines).toContain('Days EWR not met at the outflow gauge (%),1');
		expect(lines.at(-1)).toBe('flow shares sum to 0.99');
		// blocks are separated by empty records (run, self-checks, farms, catchment, curtailment,
		// EWR sites, Reserve compliance, water balance, assurance of supply, stress classes, water account,
		// CHIRPS factors, rain treated as missing, rain-source periods, multi-day accumulations,
		// double-mass check, plausibility checks, calibration, WR2012 check, column guide, warnings)
		expect(lines.filter((l) => l === '').length).toBe(20);
		expect(lines[farmHeader]).toContain('Average EWR charge (m³/day charged),Days charged for the EWR');
	});

	it('writes fractions as percentages without binary noise', () => {
		const s = structuredClone(summary);
		s.farms[0]!.fractionSupplied = 0.07;
		s.catchment.ewrFractionDaysNotMet = 1 / 3;
		const lines = [...summaryCsvLines(meta, s)];
		expect(lines.find((l) => l.startsWith('"Farm, upper"'))).toBe('"Farm, upper",,90,100,80,20,7,-5,3');
		expect(lines).toContain('Days EWR not met at the outflow gauge (%),33.3333333333');
	});

	it('writes the flow share (engine ≥ 0.27.0) as a percentage next to the farm name', () => {
		const s = structuredClone(summary);
		s.farms[0]!.flowShare = 0.07;
		const lines = [...summaryCsvLines(meta, s)];
		expect(lines.find((l) => l.startsWith('"Farm, upper"'))).toBe('"Farm, upper",7,90,100,80,20,80,-5,3');
		s.farms[0]!.flowShare = 0;
		expect([...summaryCsvLines(meta, s)].find((l) => l.startsWith('"Farm, upper"'))).toBe('"Farm, upper",0,90,100,80,20,80,-5,3');
	});

	it('keeps fields the engine adds later and says when calibration is missing', () => {
		const s = structuredClone(summary) as unknown as Record<string, any>;
		s.farms[0].targetM3Day = 70;
		s.farms[0].nested = { skip: true };
		s.calibration = null;
		s.catchment.kge = 0.4;
		s.warnings = [];
		const lines = [...summaryCsvLines(meta, s as unknown as RunSummary)];
		const header = lines.find((l) => l.startsWith('Farm,'))!;
		expect(header.endsWith(',targetM3Day')).toBe(true);
		expect(header).not.toContain('nested');
		expect(lines.find((l) => l.startsWith('"Farm, upper"'))!.endsWith(',3,70')).toBe(true);
		expect(lines).toContain('kge,0.4');
		expect(lines.some((l) => l.includes('calibration not computed'))).toBe(true);
		expect(lines).not.toContain('Warnings');
	});

	it('names the runoff model and gives each dam its capacity beside its storage figures (hydrologist review, #17)', () => {
		const s = structuredClone(summary);
		Object.assign(s.farms[0]!, { damEndM3: 400, damAgoM3: 500, damLowM3: 100, damLowDate: '2000-08-01', damDaysAtMin: 4 });
		const lines = [...summaryCsvLines({ ...meta, runoffModel: 'gr4j', damCapacityM3: { n1: 1000 } }, s)];
		expect(lines.slice(3, 5)).toEqual(['Engine version,0.2.0', 'Runoff model,gr4j']);
		const header = lines.find((l) => l.startsWith('Farm,'))!;
		expect(
			header.endsWith(
				',Days charged for the EWR,Dam capacity (m³),Dam storage on the last day (m³),Dam storage 30 days before the last day (m³),' +
					'Lowest dam storage in the last 365 days (m³),Date of the lowest dam storage,Days at or below the minimum operating level in the last 365 days'
			)
		).toBe(true);
		expect(lines.find((l) => l.startsWith('"Farm, upper"'))!.endsWith(',3,1000,400,500,100,2000-08-01,4')).toBe(true);
		// Without capacities (an older caller), no column rather than an empty one.
		expect([...summaryCsvLines(meta, summary)].find((l) => l.startsWith('Farm,'))).not.toContain('Dam capacity');
	});

	it('labels every calibration score with its unit and lists the exclusions and annual volumes (hydrologist review, #17)', () => {
		const s = structuredClone(summary);
		s.catchment.runoffCoefficient = 0.12;
		Object.assign(s.calibration!, {
			kge: 0.8,
			kgeR: 0.9,
			kgeAlpha: 1.05,
			kgeBeta: 0.95,
			r2: 0.81,
			logNse: 0.7,
			logEpsilonM3s: 0.01,
			volumeErrorPct: 3,
			windowStart: '2000-01-01',
			windowEnd: '2000-12-31',
			firstObservedDate: '2000-01-02',
			lastObservedDate: '2000-12-30',
			excludedDays: 10,
			exclusions: [{ start: '2000-03-01', end: '2000-03-10', reason: 'weir drowned' }],
			annualVolumes: [{ waterYear: 1999, days: 270, daysInWindow: 274, observedMm3: 2.5, simulatedMm3: 2.75, diffPct: 10 }]
		});
		const lines = [...summaryCsvLines(meta, s)];
		expect(lines).toContain('"Runoff coefficient (natural flow ÷ rain, as depths over the catchment)",0.12');
		for (const l of [
			'KGE (Kling–Gupta efficiency),0.8',
			'KGE r (correlation),0.9',
			'r²,0.81',
			'log-NSE ε (m³/s),0.01',
			'"Volume error (%, + = model too wet)",3',
			'Calibration window start,2000-01-01',
			'Observed days left out by the calibration exclusions,10'
		])
			expect(lines).toContain(l);
		// No score is left under its raw engine key.
		const cal = lines.indexOf('Calibration (outflow gauge vs observed)');
		const next = lines.indexOf('', cal);
		expect(lines.slice(cal, next).filter((l) => /^[a-z][A-Za-z0-9]*,/.test(l))).toEqual([]);
		const ex = lines.indexOf('Calibration exclusions (days not scored)');
		expect(lines.slice(ex + 1, ex + 3)).toEqual(['From,To,Reason', '2000-03-01,2000-03-10,weir drowned']);
		const av = lines.findIndex((l) => l.startsWith('"Annual volumes on the observed days'));
		expect(lines.slice(av + 1, av + 3)).toEqual([
			'Water year,Days observed,Days in the window,Observed (Mm³),Simulated (Mm³),Simulated − observed (%)',
			'1999/00,270,274,2.5,2.75,10'
		]);
	});

	it('writes the WR2012 five-statistic table (CR-28), and says why when there is none; never under a raw key', () => {
		const s = structuredClone(summary);
		const stats = wr2012FitStatsFromMonthly([
			{ waterYear: 2001, observed: Array(12).fill(1), simulated: Array(12).fill(1.1) },
			{ waterYear: 2002, observed: Array(12).fill(2), simulated: Array(12).fill(2.2) }
		]);
		s.calibration!.wr2012Fit = stats;
		const lines = [...summaryCsvLines(meta, s)];
		const at = lines.findIndex((l) => l.startsWith('"WR2012 statistics on monthly flows'));
		expect(at).toBeGreaterThan(lines.indexOf('Calibration (outflow gauge vs observed)'));
		expect(lines[at + 1]).toBe('Water years,2001/02 2002/03,Years in the log statistics,2');
		expect(lines[at + 2]).toMatch(/^Bands,"?indicative, to be confirmed/);
		const mar = lines[at + 4]!.split(',');
		expect(mar[0]).toBe('MAR (Mm³/a)');
		expect(Number(mar[1])).toBeCloseTo(18, 9);
		expect(Number(mar[2])).toBeCloseTo(19.8, 9);
		expect(Number(mar[3])).toBeCloseTo(10, 9);
		expect(mar.slice(4)).toEqual(['4', 'no']);
		expect(lines.some((l) => l.startsWith('wr2012Fit,'))).toBe(false);
		s.calibration!.wr2012Fit = null;
		const none = [...summaryCsvLines(meta, s)];
		const n = none.findIndex((l) => l.startsWith('"WR2012 statistics on monthly flows'));
		expect(none[n + 1]).toMatch(/^"?Not computed: no water year has all 12 months observed/);
		expect(none.some((l) => l.startsWith('wr2012Fit,'))).toBe(false);
	});

	it('writes the outlet EWR test, observed vs simulated, with the catchment (issue #4)', () => {
		const scores = { days: 100, bothBelow: 40, falseAlarm: 5, miss: 10, bothAbove: 45, hitRate: 0.8, falseAlarmRatio: 1 / 9, frequencyBias: 0.9, modelFractionBelow: 0.45, observedFractionBelow: 0.5 };
		const s = structuredClone(summary);
		s.catchment.ewrAgreement = { days: 100, excludedDays: 3, firstObservedDate: '2000-01-01', lastObservedDate: '2000-12-31', overall: scores, byMonth: [], byWaterYear: [{ ...scores, waterYear: 1999 }] };
		const lines = [...summaryCsvLines(meta, s)];
		const at = lines.findIndex((l) => l.startsWith('"Outlet EWR test'));
		expect(at).toBeGreaterThan(lines.indexOf('Catchment'));
		expect(lines[at + 2]).toMatch(/^Water year,Days counted,Both below the EWR,/);
		expect(lines[at + 3]).toBe('Whole record,100,40,5,10,45,80,11.1111111111,0.9,45,50');
		expect(lines[at + 4]!.startsWith('1999/00,100,')).toBe(true);
	});
});

describe('curtailment and EWR site blocks (Q17, engine 0.17.0)', () => {
	const farm = {
		nodeId: 'n1',
		name: 'Farm, upper',
		demandM3Day: 100,
		suppliedM3Day: 80,
		deficitM3Day: -20,
		fractionSupplied: 0.8,
		targetM3Day: 80,
		reduceGainM3Day: 0,
		reduceGainLs: 0,
		targetFraction: 0.8,
		ewrShortfallM3Day: -30,
		totalChangeM3Day: -30,
		totalChangeLs: -30 / 86.4,
		volumeLeftM3Day: 50,
		fractionOfDemandLeft: 0.5,
		ewrChargeIrrigationM3Day: -12,
		ewrChargeStorageM3Day: -18,
		ewrSupplyCutM3Day: -16,
		ewrSupplyCutLs: -16 / 86.4,
		ewrBindingSiteId: 'g1'
	};
	const c: NonNullable<RunSummary['curtailment']> = {
		reportStart: '2000-01-01',
		reportEnd: '2000-12-31',
		days: 366,
		equitableFraction: 0.8,
		farms: [farm],
		ewrAttribution: 'netImpactProRata',
		ewrSites: [
			{ nodeId: 'o', name: 'Outlet', isOutlet: true, farmCount: 1, daysNotMet: 10, shortfallM3Day: -40, chargedM3Day: -30, naturalM3Day: -10 },
			{ nodeId: 'g1', name: 'Weir', isOutlet: false, farmCount: 1, daysNotMet: 4, shortfallM3Day: -30, chargedM3Day: -30, naturalM3Day: 0 }
		],
		totals: { demandM3Day: 100, suppliedM3Day: 80, deficitM3Day: -20, targetM3Day: 80, reduceGainM3Day: 0, reduceGainLs: 0, ewrShortfallM3Day: -30, ewrChargeIrrigationM3Day: -12, ewrChargeStorageM3Day: -18, ewrSupplyCutM3Day: -16, totalChangeM3Day: -30, volumeLeftM3Day: 50 }
	};

	it('names the attribution rule and writes the charge split, supply cut and binding site unrounded', () => {
		const lines = [...curtailmentLines(c)];
		expect(lines[0]).toBe('Curtailment targets');
		expect(lines).toContain('EWR attribution,"net impact pro rata (Q17), sites: outlet + gauges (2)"');
		const header = lines.find((l) => l.startsWith('Farm,'))!.split(',');
		const row = lines.find((l) => l.startsWith('"Farm, upper"'))!.replace('"Farm, upper"', 'F').split(',');
		const at = (h: string) => row[header.indexOf(h)];
		// Issue #45: the charge and its parts are volumes charged, positive like the farm summary's; the cut stays a (negative) change.
		expect(at('EWR charge [R] (m³/day charged; workbook R × −1)')).toBe('30');
		expect(at('EWR charge met by irrigating less (m³/day charged)')).toBe('12');
		expect(at('EWR charge met by storing less / passing inflow (m³/day charged)')).toBe('18');
		expect(at('Supply cut for the EWR (m³/day)')).toBe('-16');
		expect(Number(at('Supply cut for the EWR (l/s)'))).toBeCloseTo(-16 / 86.4, 12);
		expect(at('EWR site setting the charge')).toBe('Weir');
		expect(lines.find((l) => l.startsWith('Total,'))!.split(',')).toHaveLength(header.length);
	});

	it('Q13: keeps demand left unrounded and adds demand_pct_note and the cut beyond the equitable share', () => {
		const rows = [
			{ ...farm, name: 'None', demandM3Day: 0, fractionOfDemandLeft: null, ewrCutBeyondShareM3Day: 0 },
			{ ...farm, name: 'Tiny', demandM3Day: 0.4, fractionOfDemandLeft: 0.123456789, ewrCutBeyondShareM3Day: 0 },
			{ ...farm, name: 'Big', demandM3Day: 100, fractionOfDemandLeft: 0.004, ewrCutBeyondShareM3Day: 12.5 }
		];
		const lines = [...curtailmentLines({ ...c, farms: rows })];
		const header = lines.find((l) => l.startsWith('Farm,'))!.split(',');
		const cell = (name: string, h: string) => lines.find((l) => l.startsWith(`${name},`))!.split(',')[header.indexOf(h)];
		expect(['None', 'Tiny', 'Big'].map((n) => cell(n, 'demand_pct_note'))).toEqual(['no_demand', 'below_floor', '']);
		expect(['None', 'Tiny', 'Big'].map((n) => cell(n, 'Demand left [V] (%)'))).toEqual(['', '12.3456789', '0.4']);
		expect(cell('Big', 'EWR cut beyond equitable share (m³/day)')).toBe('12.5');
	});

	it('WP-1.35: lists the land-cover reduction per class with mm/yr over the condensed area', () => {
		const lines = [...landCoverLines({ lowFlowThresholdM3Day: 120, reductionM3Day: 50, fractionOfNatural: 0.029, byClass: [{ coverClass: 'invasive', condensedKm2: 1.5, reductionM3Day: 50, mmPerYear: 12.175 }] })];
		expect(lines[0]).toBe('Land-cover streamflow reductions (invasive plants and forestry)');
		expect(lines).toContain('Share of natural flow (%),2.9');
		expect(lines.at(-1)).toBe('invasive,1.5,50,12.175');
	});

	it('WP-3.9: lists groundwater use per farm and water year against the caps and the GN 538 volume, then per borehole', () => {
		const lines = [
			...groundwaterAnnualLines([
				{
					nodeId: 'a',
					name: 'Farm A',
					kind: 'farm',
					waterYear: 2003,
					label: '2003/04',
					days: 366,
					abstractionM3: 42_000,
					toDamM3: 2000,
					streamDepletionM3: 8000,
					annualCapM3: null,
					gaLimitM3: 40_000,
					boreholes: [
						{ id: null, name: 'Combined boreholes', abstractionM3: 30_000, annualCapM3: null, capReached: false },
						{ id: 'b1', name: 'BH1', abstractionM3: 12_000, annualCapM3: 12_000, capReached: true }
					]
				},
				// Engine ≥ 1.12.0: the property's own volume and the most pumped in any 12 months.
				{
					nodeId: 'a',
					name: 'Farm A',
					kind: 'farm',
					waterYear: 2004,
					label: '2004/05',
					days: 365,
					abstractionM3: 2000,
					toDamM3: 0,
					streamDepletionM3: 0,
					annualCapM3: null,
					gaLimitM3: 2700,
					gaBasis: 'property',
					rolling12MaxM3: 30_500,
					boreholes: []
				}
			])
		];
		expect(lines[0]).toMatch(/^"Groundwater abstraction by water year/);
		expect(lines[1]).toBe(
			'Farm or user,Water year,Days,Pumped (m³),Into the dam (m³),Stream depletion (m³),Annual caps (m³),GN 538 volume (m³/a),GN 538 volume from,Most pumped in any 12 months (m³)'
		);
		// An older run: the ceiling, no 12-month figure.
		expect(lines).toContain('Farm A,2003/04,366,42000,2000,8000,,40000,ceiling only,');
		expect(lines).toContain('Farm A,2004/05,365,2000,0,0,,2700,property area × rate,30500');
		expect(lines).toContain('Farm A,2003/04,Combined boreholes,30000,,');
		expect(lines.at(-1)).toBe('Farm A,2003/04,BH1,12000,12000,yes');
	});

	it('WP-1.33: lists other water users and whether each is curtailed', () => {
		const users = [{ nodeId: 'u', name: 'Town', priority: 'senior' as const, avgDemandM3Day: 100, avgSuppliedM3Day: 90, avgDeficitM3Day: 10, fractionSupplied: 0.9, avgReturnedM3Day: 45, avgEwrChargeM3Day: 5, daysEwrNotMet: 3 }];
		const otherUsers = [
			{ nodeId: 'u', name: 'Town', priority: 'senior' as const, demandM3Day: 100, suppliedM3Day: 90, deficitM3Day: -10, fractionSupplied: 0.9, returnedM3Day: 45, ewrChargeM3Day: -5, curtailed: false, supplyCutM3Day: 0, supplyCutLs: 0, uncurtailedChargeM3Day: -5 }
		];
		const lines = [...otherUserLines({ users, curtailment: { ...c, otherUsers } } as unknown as RunSummary)];
		expect(lines[0]).toBe('Other water users (whole run)');
		expect(lines).toContain('Town,senior,100,90,10,90,45,5,3');
		expect(lines).toContain('Town,senior,100,90,45,5,no (senior),0,0,5');
		expect(lines.at(-1)).toMatch(/senior user is not curtailed/);
	});

	it('Q11: labels the equitable share as a fairness benchmark, never a gain, and carries the fixed footnote', () => {
		const lines = [...curtailmentLines(c)];
		expect(lines.some((l) => l.startsWith('Equitable share of supply (fairness benchmark) [K total] (%),'))).toBe(true);
		const header = lines.find((l) => l.startsWith('Farm,'))!;
		expect(header).toContain('Equitable share volume [M] (m³/day)');
		expect(header).toContain('Above (−) / below (+) equitable share [N] (m³/day)');
		expect(lines.join('\n')).not.toMatch(/gain/i);
		expect(lines.at(-1)).toBe(`"${EQUITABLE_SHARE_FOOTNOTE}"`);
		expect(EQUITABLE_SHARE_FOOTNOTE.endsWith('Not an allocation or licence condition.')).toBe(true);
	});

	it('lists every EWR site; charged + natural = shortfall', () => {
		const lines = [...ewrSiteLines(c)];
		expect(lines.slice(2)).toEqual(['Outlet,yes,1,10,40,30,10', 'Weir,no,1,4,30,30,0']);
	});

	it('says what an older run did', () => {
		const { ewrSites: _s, ewrAttribution: _a, ...old } = c;
		expect([...ewrSiteLines(old)][1]).toMatch(/before engine 0\.17\.0/);
		expect([...curtailmentLines(old)]).toContain('EWR attribution,run made before engine 0.17.0: incremental shortfall (workbook AB)');
		expect([...curtailmentLines(undefined)][1]).toMatch(/before engine 0\.3\.0/);
	});
});

describe('catchment rain treated as missing block (CR-20)', () => {
	const period = { start: '2003-05-01', end: '2003-08-28', source: 'flagged' as const, reason: null, days: 120, recordedMm: 0, filledMm: 310.5, unfilledDays: 0 };
	const z = {
		mode: 'missing' as const,
		periods: [period, { ...period, start: '2004-01-01', end: '2004-01-31', source: 'listed' as const, reason: 'logger fault', days: 31, recordedMm: 90, filledMm: 12 }],
		keptDry: [{ start: '2005-06-01', end: '2005-07-31', reason: 'real drought', days: 61 }],
		asRecordedDays: 0,
		days: 151,
		recordedMm: 90,
		filledMm: 322.5,
		unfilledDays: 0
	};

	it('lists each period set aside, the total, and the runs kept dry', () => {
		expect([...zeroRainLines(z)]).toEqual([
			'Catchment rain treated as missing',
			'Flagged zero runs,treated as missing',
			'Start,End,Source,Reason,Days set aside,Catchment rain recorded (mm),Rain used instead (mm),Days with nothing to fill them',
			'2003-05-01,2003-08-28,flagged zero run,,120,0,310.5,0',
			'2004-01-01,2004-01-31,listed in settings,logger fault,31,90,12,0',
			'Total,,,,151,90,322.5,0',
			'Kept as recorded (dry),2005-06-01,2005-07-31,real drought,61'
		]);
	});

	it('says why nothing was set aside', () => {
		expect([...zeroRainLines({ ...z, mode: 'asRecorded', periods: [], keptDry: [], asRecordedDays: 120, days: 0 })]).toEqual([
			'Catchment rain treated as missing',
			'Flagged zero runs,run as recorded (dry)',
			'Days of flagged runs run as recorded,120',
			'No days set aside'
		]);
		expect([...zeroRainLines(null)][1]).toBe('No catchment rain series');
		expect([...zeroRainLines(undefined)][1]).toMatch(/before engine 0\.15\.0/);
	});
});

describe('rain-source block (engine ≥ 0.30.0)', () => {
	const period = {
		start: '2012-10-01',
		end: '2019-09-30',
		series: 'rain_catchment_alt_mm' as const,
		reason: 'automatic station, gauges closed',
		factorMode: 'fixed' as const,
		factors: [1.1, 1.1, 1.2, 1.2, 1.2, 1.3, 1.3, 1.3, 1.2, 1.2, 1.1, 1.1],
		provenance: { source: 'hydrologist', fittedFrom: '2012-10-01', fittedTo: '2015-09-30', method: 'overlap ratio' },
		fit: null,
		fallback: 'chirps' as const,
		gaugeInChirps: false,
		seriesPresent: true,
		seriesProvenance: { product: 'SASSCAL AWS', version: '1' },
		runDays: 2556,
		seriesDays: 2500,
		seriesRawMm: 5000,
		seriesMm: 6000,
		chirpsDays: 50,
		reanalysisDays: 0,
		forecastDays: 0,
		noneDays: 6
	};

	it('lists each period with its reason, where its days came from, its factors and its fallback', () => {
		expect([...rainSourceCsvLines({ periods: [period] })]).toEqual([
			'Rain-source periods',
			'Start,End,Series,Reason,Run days,From the series,From CHIRPS,From reanalysis,From forecast,No value,Series rain (mm),Rain used from it (mm),Factors,Gaps from',
			'2012-10-01,2019-09-30,alternative catchment gauge (SASSCAL AWS v1),"automatic station, gauges closed",2556,2500,50,0,0,6,5000,6000,"fixed, from hydrologist, fitted on 2012-10-01 to 2015-09-30 by overlap ratio",CHIRPS × the CHIRPS fit-period factors',
			'Factor per month,Oct,Nov,Dec,Jan,Feb,Mar,Apr,May,Jun,Jul,Aug,Sep',
			'2012-10-01 to 2019-09-30,1.2,1.1,1.1,1.1,1.1,1.2,1.2,1.2,1.3,1.3,1.3,1.2'
		]);
		expect([...summaryCsvLines(meta, { ...summary, rainSource: { periods: [period] } })]).toContain('Factor per month,Oct,Nov,Dec,Jan,Feb,Mar,Apr,May,Jun,Jul,Aug,Sep');
	});

	it('says when there are none, or the run predates them', () => {
		expect([...rainSourceCsvLines(null)][1]).toBe('None: the catchment series throughout');
		expect([...rainSourceCsvLines(undefined)][1]).toMatch(/before engine 0\.30\.0/);
	});
});

describe('double-mass block (engine ≥ 0.18.0)', () => {
	const year = (wy: number, ratio: number, cum: number) => ({
		waterYear: wy, days: 365, catchmentMm: 100 * ratio, chirpsMm: 100, ratio, cumChirpsMm: cum * 100, cumCatchmentMm: cum * 150, residualPct: -2.5
	});
	const dm = {
		years: [year(2001, 1.5, 1), year(2002, 1.5, 2)],
		skippedYears: [2000],
		wholeSlope: 1.5,
		segments: [
			{ fromWaterYear: 2001, toWaterYear: 2010, years: 10, days: 3650, slope: 1.5 },
			{ fromWaterYear: 2011, toWaterYear: 2016, years: 6, days: 2190, slope: 2.1 }
		],
		breaks: [{ afterWaterYear: 2010, slopeBefore: 1.5, slopeAfter: 2.1, change: 0.4, pettittP: 0.01, bicGain: 9 }]
	};

	it('lists the slope, segments, breaks and each judged year with units', () => {
		expect([...doubleMassLines(dm)]).toEqual([
			'Double-mass check: catchment rain vs CHIRPS',
			'Whole-record slope: catchment / CHIRPS (×),1.5',
			'Segment from water year,to water year,Years,Shared days,Slope (×)',
			'2001,2010,10,3650,1.5',
			'2011,2016,6,2190,2.1',
			'Break after water year,Slope before (×),Slope after (×),Change (%),Pettitt p,BIC gain',
			'2010,1.5,2.1,40,0.01,9',
			'Water year,Shared days,Catchment rain (mm),CHIRPS (mm),Ratio (×),Cumulative catchment (mm),Cumulative CHIRPS (mm),Residual (%)',
			'2001,365,150,100,1.5,150,100,-2.5',
			'2002,365,150,100,1.5,300,200,-2.5',
			'Water years too short to judge,2000'
		]);
	});

	it('says why there is no check, and is part of the summary sheet', () => {
		expect([...doubleMassLines({ ...dm, breaks: [] })]).toContain('No break found');
		expect([...doubleMassLines(null)][1]).toMatch(/^Not checked: needs catchment rain and CHIRPS with at least 10 water years of 300\+ shared days/);
		expect([...doubleMassLines(undefined)][1]).toMatch(/before engine 0\.18\.0/);
		const lines = [...summaryCsvLines(meta, { ...summary, dataQuality: { observedAgreement: null, doubleMass: dm } })];
		expect(lines).toContain('Double-mass check: catchment rain vs CHIRPS');
		expect(lines).toContain('2010,1.5,2.1,40,0.01,9');
		expect([...summaryCsvLines(meta, summary)]).toContain('Run made before engine 0.18.0: no double-mass check');
	});
});

describe('CHIRPS bias factors block', () => {
	const month = (m: number, factor: number | null, source: 'month' | 'pooled' | null) => ({
		month: m, days: 100, catchmentMm: 200, chirpsMm: 100, ownFactor: factor, factor, source, clamped: false, fallbackDays: m === 7 ? 31 : 0
	});
	const corr = {
		mode: 'monthly' as const, minDays: 90, minMm: 50, clampMin: 0.25, clampMax: 4,
		pooled: { days: 1200, catchmentMm: 2400, chirpsMm: 1200, ownFactor: 2, factor: 2, clamped: false },
		excludedWaterYears: [1999],
		months: Array.from({ length: 12 }, (_, i) => (i === 0 ? month(1, 2, 'pooled') : month(i + 1, 1 + (i + 1) / 10, 'month'))),
		fallbackDays: 31, correctedDays: 31, fallbackRawMm: 10, fallbackCorrectedMm: 17
	};

	it('lists the 12 factors in water-year order with their source, then the pooled factor', () => {
		const lines = [...chirpsFactorLines(corr)];
		expect(lines[0]).toBe('CHIRPS bias correction');
		expect(lines[1]!.startsWith('Month,Factor applied,Source')).toBe(true);
		expect(lines.slice(2, 14).map((l) => l.split(',')[0])).toEqual(['Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep']);
		expect(lines[2]).toBe('Oct,2,own month,2,no,100,200,100,0');
		expect(lines[5]).toBe('Jan,2,pooled (all months),2,no,100,200,100,0');
		expect(lines[11]!.split(',')[8]).toBe('31'); // Jul: days CHIRPS filled in
		expect(lines[14]!.startsWith('Pooled,2,all months together')).toBe(true);
		expect(lines[15]).toBe('Water years left out of the fit,1999');
		expect(lines).toHaveLength(16); // a run before engine 0.18.0 says no more
	});

	it('says why years and days were left out of the fit (engine ≥ 0.18.0)', () => {
		const lines = [
			...chirpsFactorLines({
				...corr,
				excludedWaterYears: [1994, 1997],
				lowVsChirpsYears: [1994],
				doubtfulKeepDry: [{ start: '1997-12-20', end: '1998-02-02', days: 45, chirpsMm: 120, limitMm: 150, waterYears: [1997] }],
				flaggedDaysLeftOut: 63,
				missingDaysLeftOut: 5,
				keptDryDaysInFit: 20
			})
		];
		expect(lines.slice(15)).toEqual([
			'Water years left out of the fit,1994 1997',
			'of which far below CHIRPS,1994',
			'of which a kept-dry run CHIRPS contradicts,1997,1997-12-20 to 1998-02-02,45,CHIRPS on the kept-dry days (mm),120,limit (mm),150',
			'Days of flagged zero runs left out (treated as missing),63',
			'Days listed as missing left out,5',
			'Kept-dry days kept in the fit,20'
		]);
	});

	it('adds the fit period, its reference window and each listed range’s factors (engine ≥ 0.29.0)', () => {
		const seg = (from: number, fillFrom: number | null, fillTo: number | null, reason: string) => ({
			fromWaterYear: from, toWaterYear: from + 9, reason, fillFrom, fillTo, fitWindow: { fromWaterYear: from, toWaterYear: from + 8 },
			pooled: corr.pooled, months: corr.months, fallbackDays: 31, correctedDays: 31, fallbackRawMm: 10, fallbackCorrectedMm: 17
		});
		const all = [...chirpsFactorLines({ ...corr, fitPeriod: { period: 'all', ranges: [], segments: [] }, fitWindow: { fromWaterYear: 1990, toWaterYear: 2014 } })];
		expect(all.slice(16)).toEqual(['Fit period,whole record', 'Fitted on water years,1990,2014']);
		const ranges = [{ fromWaterYear: 1990, toWaterYear: 1999, reason: 'old network' }, { fromWaterYear: 2005, toWaterYear: 2014, reason: 'new network' }];
		const lines = [
			...chirpsFactorLines({
				...corr,
				outsideRangeDaysLeftOut: 1826,
				fitWindow: { fromWaterYear: 1990, toWaterYear: 2013 },
				fitPeriod: { period: 'ranges', ranges, segments: [seg(1990, null, 2001, 'old network'), seg(2005, 2002, null, 'new network')] }
			})
		];
		expect(lines[16]).toBe('Fit period,listed water years: 1990/91–1999/00 (old network); 2005/06–2014/15 (new network)');
		expect(lines[17]).toBe('All ranges together: fitted on water years,1990,2013');
		expect(lines[18]).toMatch(/^A range month too thin/);
		expect(lines[19]).toBe('Shared days outside the listed fit ranges left out of every fit,1826');
		expect(lines[20]).toBe('Fit range,1990,1999,reason,old network,fitted on water years,1990,1998,fills water years,record start,2001');
		expect(lines[21]!.startsWith('Month,Factor applied,Source')).toBe(true);
		expect(lines[22]).toBe('Oct,2,own month,2,no,100,200,100,0');
		expect(lines[34]!.startsWith('Pooled,2,all months together')).toBe(true);
		expect(lines[35]).toBe('Fit range,2005,2014,reason,new network,fitted on water years,2005,2013,fills water years,2002,record end');
		expect(lines).toHaveLength(50);
	});

	it('says why there are no factors', () => {
		expect([...chirpsFactorLines({ ...corr, mode: 'none' })][1]).toMatch(/used as uploaded/);
		expect([...chirpsFactorLines(null)][1]).toMatch(/No CHIRPS series/);
		expect([...chirpsFactorLines(undefined)][1]).toMatch(/before engine 0\.7\.0/);
	});

	it('is part of the summary sheet', () => {
		expect([...summaryCsvLines(meta, { ...summary, chirpsCorrection: corr })]).toContain('CHIRPS bias correction');
	});
});

describe('node daily column headers', () => {
	it('put the FarmTemplate letter between the label and the unit', () => {
		expect(nodeColumnHeader('supplied', 'Irrigation supplied', 'm³/day', 'farm')).toBe('Irrigation supplied [G] (m³/day)');
		expect(nodeColumnHeader('ewr_shortfall_incremental', 'EWR shortfall caused here', 'm³/day', 'farm')).toBe('EWR shortfall caused here [AB] (m³/day)');
		// Gauges have their own letters; columns without one keep the plain header.
		expect(nodeColumnHeader('inflow_upstream', 'Inflow from upstream', 'm³/day', 'gauge')).toBe('Inflow from upstream [G] (m³/day)');
		expect(nodeColumnHeader('gross_demand', 'Gross demand', 'm³/day', 'farm')).toBe('Gross demand (m³/day)');
		expect(nodeColumnHeader('something_new', 'Something', null, 'farm')).toBe('Something');
	});
});

describe('self-checks block', () => {
	const v: RunVerification = {
		passed: false,
		checks: [
			{ id: 'balance', label: 'Every farm balances', passed: true, detail: null },
			{ id: 'transfers', label: 'Transfers within limits', passed: false, detail: '"Farm, upper" on 2001-01-02: sent 5 > limit 4' }
		],
		maxResidual: { valueM3Day: 1.5e-10, nodeId: 'n1', name: 'Farm, upper', date: '2001-03-04' }
	};

	it('lists every check with its result and the first problem', () => {
		const lines = [...verificationLines(v)];
		expect(lines[0]).toBe('Self-checks');
		expect(lines).toContain('All passed,NO');
		expect(lines).toContain('Every farm balances,passed,');
		expect(lines).toContain('Transfers within limits,FAILED,"""Farm, upper"" on 2001-01-02: sent 5 > limit 4"');
		expect(lines.at(-1)).toBe('Largest daily balance check [V] (m³/day),1.5e-10,"Farm, upper on 2001-03-04"');
	});

	it('says an old run has none', () => {
		expect([...verificationLines(undefined)][1]).toMatch(/before engine 0\.12\.0/);
	});
});

describe('water balance block', () => {
	const row = (waterYear: number | null, over: Partial<WaterBalanceRow> = {}): WaterBalanceRow => ({
		waterYear,
		days: 365,
		rainMm: 500,
		naturalFlowMm: 50,
		runoffCoefficient: 0.1,
		runoff: null,
		naturalFlowM3: 1e6,
		farmRunoffM3: 1e6,
		openingStorageM3: 10,
		demandM3: 300,
		suppliedM3: 200,
		returnFlowM3: 20,
		consumptiveUseM3: 180,
		transfersM3: 0,
		spillM3: 5,
		outflowM3: 999_830,
		closingStorageM3: 0,
		residualM3: 0,
		...over
	});
	const wb: WaterBalance = { areaKm2: 20, years: [row(1999), row(2000)], total: row(null, { days: 730 }) };

	it('writes one row per water year and one for the run, labelled 1999/00', () => {
		const lines = [...waterBalanceLines(wb)];
		const header = lines.findIndex((l) => l.startsWith('Water year,'));
		expect(lines[header]).toContain('Residual (m³)');
		expect(lines.slice(header + 1).map((l) => l.split(',')[0])).toEqual(['1999/00', '2000/01', 'Whole run']);
		// A run without runoff-model stores (a stored legacy run, engine < 1.0.0): those cells are empty.
		expect(lines[header + 1]!.split(',').slice(1, 9)).toEqual(['365', '500', '50', '0.1', '', '', '', '']);
	});

	it('adds the dam seepage lost and release columns only when a run has them (WP-3.5)', () => {
		const header = (w: WaterBalance) => [...waterBalanceLines(w)].find((l) => l.startsWith('Water year,'))!;
		expect(header(wb)).not.toContain('seepage lost');
		const withDams: WaterBalance = { ...wb, total: row(null, { damSeepageLostM3: 12, damReleaseM3: 3000 }) };
		expect(header(withDams)).toContain('Dam seepage lost from the catchment (m³),Released below dams (part of outflow) (m³)');
		expect([...waterBalanceLines(withDams)].at(-1)).toContain(',12,3000,');
	});

	it('names in its equation only the terms the run has, each of them a column (storage set included)', () => {
		expect([...waterBalanceLines(wb)][1]).toBe(
			'Start storage + farm runoff + transfers + rain on dams = consumptive use + dam evaporation + outflow + end storage + residual; the residual should be 0'
		);
		const full: WaterBalance = { ...wb, total: row(null, { groundwaterM3: 7, storageSetM3: -2, otherUseM3: 3, streamDepletionM3: 1, damSeepageLostM3: 12 }) };
		const lines = [...waterBalanceLines(full)];
		expect(lines[1]).toBe(
			'Start storage + farm runoff + transfers + rain on dams + groundwater pumped + storage set = consumptive use + dam evaporation + other users’ use + stream depletion + seepage lost + outflow + end storage + residual; the residual should be 0'
		);
		expect(lines.find((l) => l.startsWith('Water year,'))).toContain('Storage set into (+) / out of (−) the dams by a storage reset (m³)');
	});

	it('says an old run has none', () => {
		expect([...waterBalanceLines(undefined)][1]).toMatch(/before engine 0\.12\.0/);
	});
});

describe('farm column guide', () => {
	it('gives every farm daily column its letter and formula', () => {
		const lines = [...columnGuideLines()];
		expect(lines[1]).toBe('Column,Series,Formula');
		expect(lines).toHaveLength(2 + FARM_COLUMNS.length);
		expect(lines).toContain('V,balance_residual,"(H + I + J + rain on dam + GW + GWd) − (G − T) − evaporation − (Q[t] − Q[t−1]) − U − Dep − seepage lost; 0 up to float noise (GW, GWd and Dep only with boreholes)"');
	});
});

describe('run notes and the WR2012 block', () => {
	const report = (level: 'ok' | 'query' | 'unusable', overlap = true): NonNullable<RunSummary['wr2012']> => ({
		quaternary: 'X11A',
		source: 'WR2012, synthetic',
		referencePeriod: { start: 1920, end: 2009 },
		compared: 'natural_flow',
		scaling: {
			rule: 'area',
			requested: 'areaRain',
			factor: 0.25,
			areaFactor: 0.25,
			rainFactor: null,
			modelAreaKm2: 10,
			referenceAreaKm2: 40,
			modelMapMm: null,
			referenceMapMm: 700
		},
		referenceMarMm3: 8,
		scaledMarMm3: 2,
		overlap: overlap ? { years: [2001, 2002, 2003], simulatedMarMm3: 2.6, ratio: 1.3 } : null,
		whole: { days: 1461, simulatedMarMm3: 2.5, ratio: 1.25 },
		monthlyBasis: overlap ? 'overlap' : 'whole',
		months: [10, 11, 12, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((month) => ({
			month,
			simulatedMm3: 0.2,
			referenceMm3: month === 7 ? 0 : 0.16,
			ratio: month === 7 ? null : 1.25,
			lowFlow: [6, 7, 8].includes(month)
		})),
		lowFlowMonths: [6, 7, 8],
		lowFlowSource: 'simulated',
		lowFlowRatio: 0.9,
		patternCorrelation: 0.95,
		flag: {
			level,
			basis: overlap ? 'overlap' : 'whole',
			deviationPct: 30,
			thresholds: { notePct: 10, queryPct: 25, queryWetterPct: 15, unusablePct: 50 },
			text: level === 'ok' ? null : 'The simulated MAR is 30 % above the scaled WR2012 MAR: query.'
		}
	});

	it('puts the run notes (and who last changed them) in the run details, empty when there are none', () => {
		const noted = { ...meta, notes: 'Irrigated tributary, not in the model', notesUpdatedAt: '2026-09-24T10:00:00.000Z', notesUpdatedBy: 'Ann' };
		const withNotes = [...summaryCsvLines(noted, summary)];
		expect(withNotes).toContain('Run notes,"Irrigated tributary, not in the model"');
		expect(withNotes).toContain('Notes last changed,2026-09-24T10:00:00.000Z,Ann');
		const without = [...summaryCsvLines(meta, summary)];
		expect(without).toContain('Run notes,');
		expect(without.some((l) => l.startsWith('Notes last changed'))).toBe(false);
		// A note is user text: a leading formula character is neutralised.
		expect([...summaryCsvLines({ ...meta, notes: '=1+1' }, summary)]).toContain("Run notes,'=1+1");
	});

	it('says when the run has no WR2012 check', () => {
		expect([...wr2012Lines(undefined, '')]).toEqual([
			'WR2012 check: simulated natural flow vs WR2012 naturalised flow',
			'Not checked: no WR2012 reference in the settings the run used'
		]);
	});

	it('writes the reference, scaling, MAR ratios, monthly table and flag', () => {
		const lines = [...wr2012Lines(report('query'), 'explained')];
		expect(lines).toContain('Quaternary,X11A');
		expect(lines).toContain('Reference period (water years),1920/21,2009/10');
		expect(lines).toContain('Scaling,area ratio (area and rainfall ratio asked for; its data is missing)');
		expect(lines).toContain('Scaling factor,0.25');
		expect(lines).toContain('Rainfall factor,,Modelled MAP (mm),,Quaternary MAP (mm),700');
		expect(lines).toContain('WR2012 MAR scaled to the modelled catchment (Mm³/a),2');
		expect(lines).toContain('Overlapping years,2001/02 to 2003/04 (3),2.6,2,1.3');
		expect(lines).toContain('Whole run,1461 days,2.5,2,1.25');
		// 12 months in water-year order; a zero reference month has no ratio.
		const header = lines.indexOf('Month,Simulated natural (Mm³),Scaled WR2012 (Mm³),Ratio,Dry season');
		expect(lines.slice(header + 1, header + 13).map((l) => l.split(',')[0])).toEqual(['Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep']);
		expect(lines).toContain('Jul,0.2,0,,yes');
		expect(lines).toContain('Oct,0.2,0.16,1.25,no');
		expect(lines).toContain('Dry-season ratio,0.9,Jun Jul Aug,the months the run’s natural flow is lowest');
		expect(lines).toContain('Monthly pattern correlation (Pearson r),0.95');
		expect(lines).toContain('Flag,query,judged on,the overlapping years,Deviation (%),30');
		expect(lines).toContain('Thresholds (%),note,10,query,25,query if wetter by,15,not usable,50');
		expect(lines).toContain('Flag detail,The simulated MAR is 30 % above the scaled WR2012 MAR: query.');
		expect(lines).toContain('Written explanation,see Run notes at the top of this file');
	});

	it('says when a query or not-usable flag has no written explanation; an ok flag needs none', () => {
		const noOverlap = [...wr2012Lines(report('unusable', false), '')];
		expect(noOverlap).toContain('Written explanation,none recorded for this run');
		expect(noOverlap).toContain('Overlapping years,no complete water year inside the reference period');
		expect(noOverlap.some((l) => l.startsWith('Monthly means over the whole run'))).toBe(true);
		const ok = [...wr2012Lines(report('ok'), '')];
		expect(ok.some((l) => l.startsWith('Written explanation'))).toBe(false);
		expect(ok.some((l) => l.startsWith('Flag detail'))).toBe(false);
	});

	it('is part of the summary sheet, after calibration', () => {
		const lines = [...summaryCsvLines(meta, { ...summary, wr2012: report('query') })];
		const cal = lines.indexOf('Calibration (outflow gauge vs observed)');
		const wr = lines.indexOf('WR2012 check: simulated natural flow vs WR2012 naturalised flow');
		expect(cal).toBeGreaterThan(0);
		expect(wr).toBeGreaterThan(cal);
		expect(lines).toContain('Quaternary,X11A');
	});

	it('says whether the calibration scores are in-sample (issue #45)', () => {
		const withStatus = { ...summary, calibration: { ...summary.calibration!, fitStatus: 'notFitted' as const } };
		expect([...summaryCsvLines(meta, withStatus)]).toContain('Parameters fitted on these days (fitted = in-sample scores),notFitted');
		expect([...summaryCsvLines(meta, summary)].some((l) => l.startsWith('Parameters fitted on these days'))).toBe(false);
	});
});

describe('the evidence nomination rows', () => {
	const nominated = { nominatedAt: '2026-09-20T08:00:00.000Z', nominatedBy: 'Ann', reason: 'Calibrated GR4J' };

	it('says "not nominated" for a run never nominated, in the run details', () => {
		expect([...evidenceLines(null)]).toEqual(['Evidence nomination,not nominated']);
		const lines = [...summaryCsvLines(meta, summary)];
		const at = lines.indexOf('Evidence nomination,not nominated');
		expect(at).toBeGreaterThan(lines.indexOf('Run notes,'));
		expect(at).toBeLessThan(lines.indexOf(''));
	});

	it('gives the current nomination’s when, who and why', () => {
		expect([...evidenceLines({ status: 'current', ...nominated, replacedBy: null })]).toEqual([
			'Evidence nomination,the nominated evidence run',
			'Nominated,2026-09-20T08:00:00.000Z,Ann,Calibrated GR4J'
		]);
	});

	it('names what replaced a past nomination, and neutralises formula characters in user text', () => {
		const lines = [
			...evidenceLines({
				status: 'past',
				...nominated,
				reason: '=HYPERLINK("x")',
				replacedBy: { withdrawn: false, runId: 'b', runLabel: '', nominatedAt: '2026-09-21T08:00:00.000Z', nominatedBy: null, reason: 'Refit, see §3' }
			})
		];
		expect(lines).toEqual([
			'Evidence nomination,"nominated before, since replaced"',
			`Nominated,2026-09-20T08:00:00.000Z,Ann,"'=HYPERLINK(""x"")"`,
			'Replaced by,Untitled run,2026-09-21T08:00:00.000Z,,"Refit, see §3"'
		]);
	});
});

describe('a withdrawn nomination (098)', () => {
	it('says "since withdrawn" and gives the withdrawal’s date, author and reason, not a run', () => {
		const lines = [
			...evidenceLines({
				status: 'past',
				nominatedAt: '2026-09-20T08:00:00.000Z',
				nominatedBy: 'Ann',
				reason: 'Calibrated GR4J',
				replacedBy: { withdrawn: true, runId: null, runLabel: null, nominatedAt: '2026-09-22T08:00:00.000Z', nominatedBy: 'Ben', reason: 'Application withdrawn' }
			})
		];
		expect(lines).toEqual([
			'Evidence nomination,"nominated before, since withdrawn"',
			'Nominated,2026-09-20T08:00:00.000Z,Ann,Calibrated GR4J',
			'Withdrawn,2026-09-22T08:00:00.000Z,Ben,Application withdrawn'
		]);
	});
});

describe('multi-day accumulations block (B4)', () => {
	const a: NonNullable<RunSummary['rainAccumulation']> = {
		mode: 'spread',
		criteria: { minMm: 20, minRunDays: 3, maxRunDays: 92, readingDayShare: 0.25, runShare: 0.5 },
		windows: [
			{
				start: '2003-06-01',
				end: '2003-06-21',
				source: 'detected',
				reason: null,
				status: 'spread',
				keptReason: null,
				totalMm: 120,
				readingMm: 120,
				runDays: 20,
				nearChirpsMm: 1.5,
				runChirpsMm: 90,
				chirpsMm: 91.5,
				daysInRun: 21,
				usedMm: 120
			},
			{
				start: '2004-07-01',
				end: '2004-07-09',
				source: 'detected',
				reason: null,
				status: 'kept',
				keptReason: 'thunderstorm',
				totalMm: 40,
				readingMm: 40,
				runDays: 8,
				nearChirpsMm: 0,
				runChirpsMm: 30,
				chirpsMm: null,
				daysInRun: 9,
				usedMm: 0
			}
		],
		skipped: ['Listed accumulation 2005-01-01 to 2005-01-05 overlaps another listed accumulation, so it is not spread.'],
		spreadWindows: 1,
		spreadDays: 21,
		spreadMm: 120
	};

	it('lists each window, what the run did with it, the totals and anything skipped', () => {
		expect([...accumulationLines(a)]).toEqual([
			'Multi-day rain accumulations',
			'Accumulations,spread over the days they cover',
			'Detected when,reading ≥ 20 mm after ≥ 3 days of 0 or blank; CHIRPS ±1 day < 25 % of it; CHIRPS over the run ≥ 50 % of it; window ≤ 92 days + the reading day',
			'Start,End (reading day),Source,Reason,What the run did,Days in the run,Recorded total (mm),Reading (mm),Zero or blank days before,CHIRPS around the reading (mm),CHIRPS over the run (mm),CHIRPS over the window (mm),Rain used from it (mm)',
			'2003-06-01,2003-06-21,detected,,spread by CHIRPS,21,120,120,20,1.5,90,91.5,120',
			'2004-07-01,2004-07-09,detected,thunderstorm,kept as recorded (settings),9,40,40,8,0,30,,0',
			'Windows spread,1',
			'Run days from a window,21',
			'Rain on them (mm),120',
			'"Listed accumulation 2005-01-01 to 2005-01-05 overlaps another listed accumulation, so it is not spread."'
		]);
	});

	it('says when there is nothing, no catchment rain, or the run predates the check', () => {
		expect([...accumulationLines({ ...a, windows: [], skipped: [], spreadWindows: 0, spreadDays: 0, spreadMm: 0 })].at(-1)).toBe('None detected or listed');
		expect([...accumulationLines(null)][1]).toBe('No catchment rain series');
		expect([...accumulationLines(undefined)][1]).toMatch(/before engine 0\.20\.0/);
	});
});

describe('Reserve compliance block (engine ≥ 0.21.0)', () => {
	// Synthetic: two Octobers of 1.5 Mm³ natural flow, 70 % on the table's natural curve, 0.75 Mm³ required.
	const start = '2000-10-01';
	const days = 366 + 365;
	const natural = new Float64Array(days).fill(1.5e6 / 31);
	const impacted = natural.map((v, t) => (t < 31 ? v * 0.4 : v));
	const table = {
		siteNodeId: null,
		source: 'Synthetic, table 1',
		component: 'lowFlow' as const,
		unit: 'mcm' as const,
		points: [10, 50, 90],
		ewr: Array.from({ length: 12 }, () => [1.5, 1, 0.5]),
		naturalSource: 'table' as const,
		natural: Array.from({ length: 12 }, () => [3, 2, 1]),
		scale: 1
	};
	const report = assessSite(start, days, { table, nodeId: null, name: 'Outlet gauge', isOutlet: true, natural, impacted }).report;

	it('gives the provenance, the headline, the months of the year and each month', () => {
		const lines = [...ewrAssuranceLines([report])];
		expect(lines[0]).toBe('Reserve compliance by month (EWR rule tables)');
		expect(lines).toContain('Site,Outlet gauge,outlet');
		expect(lines).toContain('Source,"Synthetic, table 1"');
		expect(lines).toContain('Covers,low flows only');
		expect(lines).toContain("Natural-flow percentile from,the table's natural flows");
		expect(lines).toContain('% points,10,50,90');
		// 24 complete months; the first October (0.6 Mm³ < 0.75) is the only one short.
		expect(lines).toContain(`Months met,23,of,24,Met (%),${Number(((23 / 24) * 100).toPrecision(12))}`);
		expect(lines).toContain('Longest run of months not met,1');
		const header = lines.indexOf('Month,Complete years,Months met,Met (%),Deficit (m³),Mean required (Mm³),Mean simulated (Mm³),FDC points met');
		expect(header).toBeGreaterThan(0);
		expect(lines.slice(header + 1, header + 13).map((l) => l.split(',')[0])).toEqual(['Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep']);
		expect(lines[header + 1]!.split(',').slice(0, 4)).toEqual(['Oct', '2', '1', '50']);
		const detail = lines.findIndex((l) => l.startsWith('Year,Month,Water year'));
		const oct = lines[detail + 1]!.split(',');
		expect(oct.slice(0, 3)).toEqual(['2000', 'Oct', '2000/01']);
		expect(oct[8]).toBe('no');
		expect(Number(oct[9])).toBeCloseTo(150_000, 3);
		expect(lines.length).toBe(detail + 1 + 24);
	});

	it('adds the low flows and the high-flow components when the table has them (engine ≥ 0.33.0)', () => {
		const withBoth = {
			...table,
			component: 'total' as const,
			lowFlow: Array.from({ length: 12 }, () => [1, 0.6, 0.2]),
			highFlows: [{ label: 'Synthetic freshet', months: [10], peakM3s: 0.5, durationDays: 3, perYear: 1 }]
		};
		const r = assessSite(start, days, { table: withBoth, nodeId: null, name: 'Outlet gauge', isOutlet: true, natural, impacted }).report;
		const lines = [...ewrAssuranceLines([r])];
		// The first October (0.6 Mm³) is below the 0.75 total but above the 0.4 low flow.
		expect(lines).toContain('Low flows: months met,24,of,24,Met (%),100');
		expect(lines).toContain('Month,Complete years,Months met,Met (%),Deficit (m³),Mean required (Mm³),Mean simulated (Mm³),FDC points met,Low flows met (%)');
		const detail = lines.findIndex((l) => l.startsWith('Year,Month,Water year'));
		expect(lines[detail]!.endsWith('Low flow required (Mm³),Low flows met,High-flow part (Mm³)')).toBe(true);
		const oct = lines[detail + 1]!.split(',');
		expect(Number(oct[10])).toBeCloseTo(0.4, 9);
		expect(oct[11]).toBe('yes');
		expect(Number(oct[12])).toBeCloseTo(0.35, 9);
		// Natural ~0.56 m³/s all year stays above the 0.5 m³/s peak: one event a year from 1 October; the first
		// October's flow (40 %) is below it, so water year 2000 is not met.
		expect(lines).toContain('High flow,Synthetic freshet,peaks in,Oct,peak (m³/s),0.5,event days,3,per water year,1');
		expect(lines).toContain('Water years met,1,of,2,that had it naturally,Met (%),50,Water years assessed,2');
		expect(lines.slice(-2)).toEqual(['2000/01,1,0,1,no', '2001/02,1,1,1,yes']);
	});

	it('adds daily compliance, the EWR as %nMAR and the duration curves for the FDC overlay (engine ≥ 1.18.0, CR-29)', () => {
		const lines = [...ewrAssuranceLines([report])];
		// Every day of the first October is short (0.6 of 0.75 Mm³ spread evenly): 31 of the 730 days of complete months.
		const daily = lines.find((l) => l.startsWith("From daily data: days below the day's requirement"))!.split(',');
		expect(daily.slice(1, 5)).toEqual(['31', 'of', '730', 'Time not met (%)']);
		expect(Number(daily[5])).toBeCloseTo((100 * 31) / 730, 6);
		expect(Number(daily[7])).toBeCloseTo((100 * 0.15e6) / report.daily!.requiredM3, 6);
		const nmar = lines.find((l) => l.startsWith('EWR as % of natural MAR'))!.split(',');
		expect(Number(nmar[1])).toBeCloseTo((100 * report.ewrPctNmar!.ewrMcm) / report.ewrPctNmar!.naturalMarMcm, 9);
		const byDay = lines.indexOf('Month,Days assessed,Days not met,Time not met (%),Required (m³),Shortfall (m³),Volume not met (%)');
		expect(lines[byDay + 1]!.split(',').slice(0, 4)).toEqual(['Oct', '62', '31', '50']);
		const fdc = lines.indexOf('Month,% point,EWR (Mm³),Natural flow duration (Mm³),Simulated flow duration (Mm³),Met');
		expect(lines.slice(fdc + 1, fdc + 37).map((l) => l.split(',')[0])).toEqual(['Oct', 'Oct', 'Oct', 'Nov', 'Nov', 'Nov', 'Dec', 'Dec', 'Dec', 'Jan', 'Jan', 'Jan', 'Feb', 'Feb', 'Feb', 'Mar', 'Mar', 'Mar', 'Apr', 'Apr', 'Apr', 'May', 'May', 'May', 'Jun', 'Jun', 'Jun', 'Jul', 'Jul', 'Jul', 'Aug', 'Aug', 'Aug', 'Sep', 'Sep', 'Sep']);
		const oct10 = lines[fdc + 1]!.split(',');
		expect(oct10.slice(0, 3)).toEqual(['Oct', '10', '1.5']);
		expect(Number(oct10[3])).toBeCloseTo(1.5, 9);
		// A run before engine 1.18.0 has none of them.
		const old = structuredClone(report);
		delete old.daily;
		delete old.ewrPctNmar;
		for (const m of old.byMonth) {
			delete m.daily;
			for (const f of m.fdc) delete f.natural;
		}
		const oldLines = [...ewrAssuranceLines([old])];
		expect(oldLines.some((l) => /^(From daily data|EWR as %|Month,Days assessed|Month,% point)/.test(l))).toBe(false);
	});

	it("compares the run's natural MAR with the determination's only when the table records one (engine ≥ 1.11.0)", () => {
		expect([...ewrAssuranceLines([report])].some((l) => l.startsWith('Natural MAR'))).toBe(false);
		const r = assessSite(start, days, { table: { ...table, naturalMarMcm: 10 }, nodeId: null, name: 'Outlet gauge', isOutlet: true, natural, impacted }).report;
		const row = [...ewrAssuranceLines([r])].find((l) => l.startsWith('Natural MAR'))!.split(',');
		// Two complete water years of 365 days (the 731st day is a part month, left out) at 1.5 Mm³ / 31 days.
		const run = (365 * 1.5) / 31;
		expect(row.slice(0, 2)).toEqual(['Natural MAR (Mm³/a): run', expect.any(String)]);
		expect(Number(row[1])).toBeCloseTo(run, 9);
		expect(row.slice(2, 4)).toEqual(['determination', '10']);
		expect(Number(row[5])).toBeCloseTo((100 * (run - 10)) / 10, 9);
	});

	it('says when nothing was assessed, and is part of the summary sheet', () => {
		expect([...ewrAssuranceLines(undefined)]).toEqual([
			'Reserve compliance by month (EWR rule tables)',
			'Not assessed: no EWR rule table in the settings the run used (or a run made before engine 0.21.0)'
		]);
		const lines = [...summaryCsvLines(meta, { ...summary, ewrAssurance: [report] })];
		expect(lines).toContain('Reserve compliance by month (EWR rule tables)');
		expect(lines).toContain('Site,Outlet gauge,outlet');
	});
});

describe('plausibility checks block (engine ≥ 0.25.0)', () => {
	// Synthetic: two water years, 1 mm of station rain a day in the first and fallback (CHIRPS) rain in the
	// second; natural 10 000 m³/day, simulated outflow 6 000, a gauge reading 0.08 m³/s (6 912 m³/day).
	const start = Date.parse('2001-10-01T00:00:00Z') / 86_400_000;
	const days = 730;
	const station = Uint8Array.from({ length: days }, (_, t) => (t < 365 ? 1 : 0));
	const { checks } = plausibilityChecks({
		start,
		days,
		runoffModel: 'gr4j',
		naturalM3Day: new Array(days).fill(10_000),
		simulatedM3Day: new Array(days).fill(6_000),
		observed: { flow_observed_m3s: new Array(days).fill(0.08) },
		calibrationKind: 'flow_observed_m3s',
		excluded: new Uint8Array(days),
		damsM3Day: new Array(days).fill(1_000),
		landCoverM3Day: [],
		rainMm: new Array(days).fill(1),
		station,
		hasStation: true,
		ewrShortfall: Array.from({ length: days }, (_, t) => (t >= 365 && t < 465 ? -1 : 0)),
		reserve: [],
		areaKm2: 10
	});

	it('writes the dry season, each water year of the naturalised check, the rain-source split and the curves', () => {
		const lines = [...plausibilityLines(checks)];
		expect(lines[0]).toBe('Plausibility checks');
		// A constant record: every window ties, so the season starts in October.
		expect(lines[1]).toBe('Dry season (months),Oct Nov Dec Jan Feb Mar,lowest mean flow in the observed gauge');
		expect(lines).toContain('Record,observed gauge');
		expect(lines).toContain('Water years judged,2,failed,2');
		const y = lines.find((l) => l.startsWith('2001/02,365,'))!.split(',');
		expect(Number(y[2])).toBeCloseTo(3.65, 12); // N
		expect(Number(y[4])).toBeCloseTo(1.46, 12); // A = N − S
		expect(Number(y[5])).toBeCloseTo(0.365, 12); // dams
		expect(Number(y[7])).toBeCloseTo(1.095, 12); // use
		expect(Number(y[10])).toBeCloseTo(9.12, 9); // gap, % of N
		expect(y[12]).toBe('no');
		expect(lines).toContain('Good-rain years,1,365,0,0');
		expect(lines).toContain(`Fallback-rain years,1,365,100,${Number(((100 / 365) * 100).toPrecision(12))}`);
		expect(lines).toContain('2002/03,365,0,365,365,100,100,yes,100');
		// Two years are too few for the flow double-mass check.
		expect(lines).toContain('"Not checked: needs an observed flow record, rain and a catchment area, with at least 10 water years of 300+ days with both"');
		expect(lines).toContain('Runoff model,gr4j');
		expect(lines.some((l) => l.startsWith("Q90 on the calibration record's dry-season days,observed gauge,days,"))).toBe(true);
		expect(lines).toContain('Curve,On the days of,Days,Q1,Q2,Q5,Q10,Q20,Q30,Q40,Q50,Q60,Q70,Q75,Q80,Q85,Q90,Q95,Q98,Q99');
		expect(lines.filter((l) => l.startsWith('simulated outflow,'))).toHaveLength(2);
	});

	it('adds checks 1 and 4 for each gauge with a record of its own (engine ≥ 1.4.0), and nothing without one', () => {
		const without = [...plausibilityLines(checks)];
		expect(without.some((l) => l.startsWith('At gauge'))).toBe(false);
		const gauge = { nodeId: 'g1', name: 'Upper weir', flowKind: 'flow_logger_m3s' as const, naturalShare: 0.25, naturalised: checks.naturalised, lowFlow: null };
		const lines = [...plausibilityLines({ ...checks, gauges: [gauge] })];
		// The outlet's blocks are unchanged and come first.
		expect(lines.slice(0, without.length)).toEqual(without);
		const tail = lines.slice(without.length);
		expect(tail[1]).toBe('At gauge Upper weir,Share of the catchment natural flow above it (%),25');
		expect(tail).toContain('Natural flow vs observed flow + net abstraction');
		expect(tail).toContain('Water years judged,2,failed,2');
		expect(tail).toContain('Not computed: no dry season');
	});

	it('says what is missing, and is part of the summary sheet', () => {
		expect([...plausibilityLines(undefined)]).toEqual(['Plausibility checks', 'Run made before engine 0.25.0: no plausibility checks']);
		const none = [...plausibilityLines({ drySeason: null, naturalised: null, rainSource: null, flowDoubleMass: null, lowFlow: null })];
		expect(none).toContain('Dry season (months),none: no record covers every calendar month,');
		expect(none).toContain('Not checked: the run has no observed flow record');
		expect(none).toContain('Not checked: the run has no rainfall series');
		expect(none).toContain('Not computed: no dry season');
		const lines = [...summaryCsvLines(meta, { ...summary, plausibility: checks })];
		expect(lines).toContain('Plausibility checks');
		expect(lines).toContain('Water years judged,2,failed,2');
		expect([...summaryCsvLines(meta, summary)]).toContain('Run made before engine 0.25.0: no plausibility checks');
	});
});
