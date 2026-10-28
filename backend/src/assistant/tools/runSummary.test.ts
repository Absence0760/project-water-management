// get_run_summary's trimming (issue #610).
import { describe, expect, it } from 'vitest';
import type { RunSummary } from '@water-management/engine';
import { MAX_WARNINGS, runSummaryTool, trimSummary } from './runSummary.js';
import type { ToolContext } from '../types.js';

const summary = {
	farms: [{ nodeId: 'x', name: 'A' }],
	catchment: { meanNaturalFlowM3Day: 12345.6789, meanSimulatedOutflowM3Day: 9000, ewrDaysNotMet: 4, ewrFractionDaysNotMet: 0.01 },
	calibration: { days: 300, nse: 0.71234, pbias: -4.2, rmseM3s: 0.3, meanObservedM3s: 1, meanSimulatedM3s: 1.04, annualVolumes: Array.from({ length: 30 }, (_, i) => ({ waterYear: 1990 + i, observedMm3: 1, simulatedMm3: 1 })) },
	warnings: Array.from({ length: 50 }, (_, i) => `warning ${i}`),
	dataQuality: { observedAgreement: null, seriesChecks: Array.from({ length: 40 }, (_, i) => ({ kind: 'outlier', index: i })) },
	withheld: ['farms']
} as unknown as RunSummary;

describe('trimSummary', () => {
	it('keeps the asked-for parts, cut down, and says what the API withheld', () => {
		const t = trimSummary(summary, ['catchment', 'warnings', 'calibration', 'dataQuality', 'plausibility']);
		expect(t.catchment).toMatchObject({ meanNaturalFlowM3Day: 12350 });
		expect(t.warnings).toHaveLength(MAX_WARNINGS);
		expect(t.warningsNotShown).toBe(50 - MAX_WARNINGS);
		expect((t.calibration as { nse: number; annualVolumes: unknown[] }).nse).toBe(0.7123);
		expect((t.calibration as { annualVolumes: unknown[] }).annualVolumes).toHaveLength(9);
		expect((t.dataQuality as { seriesChecks: unknown[] }).seriesChecks).toHaveLength(16);
		expect(t.plausibility).toBeNull();
		expect(t.withheld).toEqual(['farms']);
		expect(t.farms).toBeUndefined();
		expect(Object.keys(trimSummary(summary, ['warnings']))).toEqual(['warnings', 'warningsNotShown', 'withheld']);
	});
});

describe('get_run_summary arguments', () => {
	const ctx = { db: { query: () => Promise.reject(new Error('no database in a unit test')) } } as unknown as ToolContext;
	it('refuses an unknown section', async () => {
		expect((await runSummaryTool.run(ctx, { sections: ['everything'] })).ok).toBe(false);
	});
});
