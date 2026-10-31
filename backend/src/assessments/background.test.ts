// backgroundVerdicts (assessments/background.ts, 295): a full-allocation
// background as a reader kept from the registered volumes reads it (D3).
import type { CumulativeReport, CumulativeRow } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { BACKGROUND_LABEL, BACKGROUND_VERDICT_METRICS, backgroundVerdicts, type AssessmentReport } from './background.js';

const row = (metric: CumulativeRow['metric'], v: number): CumulativeRow => ({
	metric,
	siteNodeId: null,
	site: 'Outlet',
	isOutlet: metric !== 'outlet_flow' && metric !== 'existing_supplied' && metric !== 'existing_reliability',
	unit: 'x',
	higherIsWorse: true,
	baseline: v,
	singles: [v + 1],
	combined: v + 2,
	singleChanges: [1],
	sumOfSingles: 1,
	combinedChange: 2,
	interaction: 1
});
const ALL: CumulativeRow['metric'][] = ['ewr_days_not_met', 'ewr_shortfall', 'reserve_months_met', 'reserve_deficit', 'outlet_flow', 'existing_supplied', 'existing_reliability'];
const table = (base: number): CumulativeReport => ({ scenarios: [{ id: 'a', name: 'A' }], rows: ALL.map((m, i) => row(m, base + i)), warnings: [] });

describe('backgroundVerdicts', () => {
	const report: AssessmentReport = { ...table(10), background: { label: BACKGROUND_LABEL, run: { id: 'r', label: 'Full', scenarioName: 'Full', createdAt: '2026-10-30T00:00:00.000Z' }, report: table(100) } };

	it('keeps the background’s EWR days and Reserve months only, marked, and the baseline’s table whole', () => {
		const got = backgroundVerdicts(report)!;
		expect(got.background!.verdictsOnly).toBe(true);
		expect(got.background!.report.rows.map((r) => r.metric)).toEqual(['ewr_days_not_met', 'reserve_months_met']);
		expect([...BACKGROUND_VERDICT_METRICS].sort()).toEqual(['ewr_days_not_met', 'reserve_months_met']);
		// No flow, shortfall, deficit or use figure of the full-allocation run is left anywhere in it.
		for (const v of [101, 103, 104, 105, 106]) expect(got.background!.report.rows.some((r) => r.baseline === v)).toBe(false);
		// The baseline's table is a compare-only run's: untouched (positive control: its volume rows stay).
		const { background: _b, ...baseline } = got;
		const { background: _o, ...original } = report;
		expect(baseline).toEqual(original);
		expect(baseline.rows.map((r) => r.metric)).toContain('existing_supplied');
	});

	it('is idempotent, and leaves a report without a background (or none) as it is', () => {
		expect(backgroundVerdicts(backgroundVerdicts(report))).toEqual(backgroundVerdicts(report));
		const plain = table(1);
		expect(backgroundVerdicts(plain)).toBe(plain);
		expect(backgroundVerdicts(null)).toBeNull();
		expect(backgroundVerdicts(undefined)).toBeUndefined();
	});
});
