import { FARM_COLUMNS, type RunSummary, type RunVerification, type WaterBalance, type WaterBalanceRow } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import {
	chirpsFactorLines,
	zeroRainLines,
	columnGuideLines,
	nodeColumnHeader,
	seriesKeyOrder,
	summaryCsvLines,
	verificationLines,
	waterBalanceLines
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
		const farm = ['deficit', 'balance_residual', 'return_flow', 'outflow', 'interim_storage', 'upstream_to_dam', 'demand', 'gross_demand'];
		expect(farm.sort(seriesKeyOrder('node'))).toEqual(['gross_demand', 'demand', 'upstream_to_dam', 'interim_storage', 'return_flow', 'outflow', 'balance_residual', 'deficit']);
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
		expect(lines[farmHeader]).toContain('Average demand (m³/day)');
		expect(lines[farmHeader]).toContain('Demand supplied (%)');
		expect(lines[farmHeader + 1]).toBe('"Farm, upper",100,80,20,80,-5,3');
		expect(lines).toContain('Mean natural flow (m³/day),1000');
		expect(lines).toContain('NSE,0.5');
		expect(lines).toContain('Days EWR not met at the outflow gauge (%),1');
		expect(lines.at(-1)).toBe('flow shares sum to 0.99');
		// blocks are separated by empty records (run, self-checks, farms, catchment, water balance,
		// CHIRPS factors, rain treated as missing, calibration, column guide, warnings)
		expect(lines.filter((l) => l === '').length).toBe(9);
	});

	it('writes fractions as percentages without binary noise', () => {
		const s = structuredClone(summary);
		s.farms[0]!.fractionSupplied = 0.07;
		s.catchment.ewrFractionDaysNotMet = 1 / 3;
		const lines = [...summaryCsvLines(meta, s)];
		expect(lines.find((l) => l.startsWith('"Farm, upper"'))).toBe('"Farm, upper",100,80,20,7,-5,3');
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
		expect(lines).toContain('V,balance_residual,(H + I + J) − (G − T) − (Q[t] − Q[t−1]) − U; 0 up to float noise');
	});
});
