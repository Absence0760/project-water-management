import type { RunSummary } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { chirpsFactorLines, seriesKeyOrder, summaryCsvLines } from './run-tables.js';

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
		// blocks are separated by empty records (run, farms, catchment, CHIRPS factors, calibration, warnings)
		expect(lines.filter((l) => l === '').length).toBe(5);
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
