import type { RunSummary } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { seriesKeyOrder, summaryCsvLines } from './run-tables.js';

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
		// blocks are separated by empty records
		expect(lines.filter((l) => l === '').length).toBe(4);
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
