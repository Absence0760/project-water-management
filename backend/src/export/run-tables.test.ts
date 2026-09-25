import { EQUITABLE_SHARE_FOOTNOTE, FARM_COLUMNS, type RunSummary, type RunVerification, type WaterBalance, type WaterBalanceRow } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import {
	chirpsFactorLines,
	curtailmentLines,
	ewrSiteLines,
	zeroRainLines,
	doubleMassLines,
	columnGuideLines,
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
		expect(lines[farmHeader + 1]).toBe('"Farm, upper",90,100,80,20,80,-5,3');
		expect(lines).toContain('Mean natural flow (m³/day),1000');
		expect(lines).toContain('NSE,0.5');
		expect(lines).toContain('Days EWR not met at the outflow gauge (%),1');
		expect(lines.at(-1)).toBe('flow shares sum to 0.99');
		// blocks are separated by empty records (run, self-checks, farms, catchment, curtailment,
		// EWR sites, water balance, CHIRPS factors, rain treated as missing, double-mass check,
		// calibration, WR2012 check, column guide, warnings)
		expect(lines.filter((l) => l === '').length).toBe(13);
		expect(lines[farmHeader]).toContain('Average EWR charge (m³/day),Days charged for the EWR');
	});

	it('writes fractions as percentages without binary noise', () => {
		const s = structuredClone(summary);
		s.farms[0]!.fractionSupplied = 0.07;
		s.catchment.ewrFractionDaysNotMet = 1 / 3;
		const lines = [...summaryCsvLines(meta, s)];
		expect(lines.find((l) => l.startsWith('"Farm, upper"'))).toBe('"Farm, upper",90,100,80,20,7,-5,3');
		expect(lines).toContain('Days EWR not met at the outflow gauge (%),33.3333333333');
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
		expect(at('EWR charge [R] (m³/day)')).toBe('-30');
		expect(at('EWR charge met by irrigating less (m³/day)')).toBe('-12');
		expect(at('EWR charge met by storing less / passing inflow (m³/day)')).toBe('-18');
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
		expect(lines.slice(2)).toEqual(['Outlet,yes,1,10,-40,-30,-10', 'Weir,no,1,4,-30,-30,0']);
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
				excludedWaterYears: [1996, 1999],
				lowVsChirpsYears: [1996],
				doubtfulKeepDry: [{ start: '1999-12-28', end: '2000-02-10', days: 45, chirpsMm: 120, limitMm: 150, waterYears: [1999] }],
				flaggedDaysLeftOut: 63,
				missingDaysLeftOut: 5,
				keptDryDaysInFit: 20
			})
		];
		expect(lines.slice(15)).toEqual([
			'Water years left out of the fit,1996 1999',
			'of which far below CHIRPS,1996',
			'of which a kept-dry run CHIRPS contradicts,1999,1999-12-28 to 2000-02-10,45,CHIRPS on the kept-dry days (mm),120,limit (mm),150',
			'Days of flagged zero runs left out (treated as missing),63',
			'Days listed as missing left out,5',
			'Kept-dry days kept in the fit,20'
		]);
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
		// Legacy runs have no runoff-model stores: those cells are empty.
		expect(lines[header + 1]!.split(',').slice(1, 9)).toEqual(['365', '500', '50', '0.1', '', '', '', '']);
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
		expect(lines).toContain('V,balance_residual,(H + I + J + rain on dam) − (G − T) − evaporation − (Q[t] − Q[t−1]) − U; 0 up to float noise');
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
});
