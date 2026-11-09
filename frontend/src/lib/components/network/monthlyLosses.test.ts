import { describe, expect, it } from 'vitest';
import type { NetworkNode } from '@water-management/engine';
import { baseflowMonthlySummary, capByMonth, hasBaseflowSettings, reachLoses, reachMonthlySummary, sectionByMonth, setByMonth, shownRow, varyByMonth } from './monthlyLosses';
import { nodeSections } from './nodeSections';
import { NODE_FIELDS, splitFields, unusedReason } from './fields';
import { sectionSummary } from './nodeSummary';

const wetDry = (wet: number, dry: number) => [dry, wet, wet, wet, wet, wet, dry, dry, dry, dry, dry, dry];
const field = (k: string) => NODE_FIELDS.find((f) => f.key === k)!;
const unitNode = (over: Partial<NetworkNode> = {}) =>
	({ id: 'a', name: 'A', kind: 'farm', downstreamNodeId: 'o', pctUpstreamToDam: 0, damCapacityM3: 0, ...over }) as NetworkNode;

describe('vary by month (engine 1.116.0)', () => {
	it('ticking starts every month at the one value, so nothing changes until a month is edited; clearing keeps the one values', () => {
		const n = unitNode({ reachLossFrac: 0.1, reachLossMaxM3Day: 40_000, baseflowLossM3Day: 500, baseflowGainM3Day: 0 });
		varyByMonth(n, 'reach', true);
		expect(n.reachLossFracMonthly).toEqual(new Array(12).fill(0.1));
		expect(n.reachLossMaxMonthlyM3Day).toEqual(new Array(12).fill(40_000));
		varyByMonth(n, 'baseflow', true);
		expect(n.baseflowLossMonthlyM3Day).toEqual(new Array(12).fill(500));
		expect(n.baseflowGainMonthlyM3Day).toEqual(new Array(12).fill(0));
		varyByMonth(n, 'reach', false);
		expect([n.reachLossFracMonthly, n.reachLossMaxMonthlyM3Day, n.reachLossFrac, n.reachLossMaxM3Day]).toEqual([null, null, 0.1, 40_000]);
	});

	it('with no cap the months stay uncapped until the cap by month is ticked; clearing it is no cap again', () => {
		const n = unitNode({ reachLossFrac: 0.2, reachLossMaxM3Day: null });
		varyByMonth(n, 'reach', true);
		expect(n.reachLossMaxMonthlyM3Day).toBeNull();
		capByMonth(n, true);
		expect(n.reachLossMaxMonthlyM3Day).toEqual(new Array(12).fill(0));
		capByMonth(n, false);
		expect(n.reachLossMaxMonthlyM3Day).toBeNull();
	});

	it('a one value with its row set is shown as set by month, not as a field; a cap counts when any month loses', () => {
		const n = unitNode({ reachLossFrac: 0, reachLossFracMonthly: wetDry(0.05, 0.3), baseflowLossMonthlyM3Day: wetDry(2000, 0) });
		expect(setByMonth('reachLossFrac', n)).toBe(true);
		expect(setByMonth('baseflowGainM3Day', n)).toBe(false);
		expect(reachLoses(n)).toBe(true);
		expect(unusedReason(field('reachLossFrac'), n, true)).toBe('byMonth');
		// The one cap still applies to every month: shown, not "no losses" (positive control for the reach losing).
		expect(unusedReason(field('reachLossMaxM3Day'), n, true)).toBeNull();
		expect(unusedReason(field('baseflowLossM3Day'), n, true)).toBe('byMonth');
		expect(unusedReason(field('baseflowGainM3Day'), n, true)).toBeNull();
		const sp = splitFields(NODE_FIELDS.filter((f) => f.group === 'reach'), n, true);
		expect(sp.unused).toEqual([{ reason: 'byMonth', fields: [field('reachLossFrac')] }]);
		expect(sectionByMonth('reach', n) && sectionByMonth('baseflow', n)).toBe(true);
		// A row of zeros loses nothing: the cap is unused again.
		expect(unusedReason(field('reachLossMaxM3Day'), unitNode({ reachLossFrac: 0.4, reachLossFracMonthly: new Array(12).fill(0) }), true)).toBe('noLoss');
	});

	it('the section summaries say the range by month', () => {
		const n = unitNode({ reachLossFracMonthly: wetDry(0.05, 0.3), reachLossMaxMonthlyM3Day: wetDry(40_000, 300) });
		expect(reachMonthlySummary(n).replace(/\s/g, ' ')).toBe('5–30 % lost by month, at most 300–40 000 m³/day by month');
		expect(sectionSummary('reach', n, {} as never)).toBe(reachMonthlySummary(n));
		const b = unitNode({ baseflowLossMonthlyM3Day: wetDry(2000, 0), baseflowGainMonthlyM3Day: wetDry(0, 300) });
		expect(baseflowMonthlySummary(b).replace(/\s/g, ' ')).toBe('loses 0–2 000 m³/day, gains 0–300 m³/day by month');
		expect(baseflowMonthlySummary(unitNode({ baseflowLossMonthlyM3Day: new Array(12).fill(0) }))).toBe('None (by month, all 0)');
	});

	it('a row not set shows the one value the run reads in every month, never 0s, beside a row that is set', () => {
		// Only the cap by month (the API allows one row alone): the share row shows the one 20 %.
		const n = unitNode({ reachLossFrac: 0.2, reachLossMaxMonthlyM3Day: wetDry(40_000, 300), baseflowLossMonthlyM3Day: wetDry(2000, 0), baseflowGainM3Day: 50 });
		expect(shownRow(n, 'reachLossFrac')).toEqual(new Array(12).fill(0.2));
		expect(shownRow(n, 'reachLossMaxM3Day')).toEqual(wetDry(40_000, 300));
		expect(shownRow(n, 'baseflowGainM3Day')).toEqual(new Array(12).fill(50));
		expect(shownRow(n, 'baseflowLossM3Day')).toEqual(wetDry(2000, 0));
		// The summary agrees with the fields.
		expect(baseflowMonthlySummary(n).replace(/\s/g, ' ')).toBe('loses 0–2 000 m³/day, gains 50 m³/day by month');
	});

	it('a node that isn’t a unit shows the base-flow section only while it carries one, so it can be cleared', () => {
		const gauge = unitNode({ kind: 'gauge' });
		expect(hasBaseflowSettings(gauge)).toBe(false);
		expect(nodeSections(gauge, 0)).not.toContain('baseflow');
		const left = unitNode({ kind: 'gauge', baseflowGainMonthlyM3Day: new Array(12).fill(5) });
		expect(hasBaseflowSettings(left)).toBe(true);
		expect(nodeSections(left, 0)).toContain('baseflow');
		expect(nodeSections(unitNode({ kind: 'user', baseflowLossM3Day: 10 }), 0)).toContain('baseflow');
		// A unit always has it (positive control).
		expect(nodeSections(unitNode(), 0)).toContain('baseflow');
	});
});
