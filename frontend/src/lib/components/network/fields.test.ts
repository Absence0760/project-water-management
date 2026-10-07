import { describe, expect, it } from 'vitest';
import { newNetworkNode } from '@water-management/engine';
import { cardLabel, damHints, fieldScale, fieldUnused, fmtVolume, GROUPS, hasDam, hasDamDevelopment, hiLoHint, isVolume, NODE_FIELDS, TABLE_FIELDS } from './fields';

describe('node fields', () => {
	it('keeps the table accessible names the editor and tests rely on', () => {
		const aria = Object.fromEntries(NODE_FIELDS.map((f) => [f.key, f.aria('Hilltop')]));
		expect(aria.areaKm2).toBe('Area of Hilltop, km²');
		expect(aria.damCapacityM3).toBe('Dam capacity of Hilltop, m³');
		expect(aria.damInitialPct).toBe('Dam initial storage of Hilltop, %');
	});

	it('gives every field help text and a unit', () => {
		for (const f of NODE_FIELDS) {
			expect(f.help.length).toBeGreaterThan(20);
			expect(f.unit).toBeTruthy();
		}
	});
});

describe('cardLabel', () => {
	it('names each table field on its own, without the group header over it', () => {
		const label = Object.fromEntries(TABLE_FIELDS.map((f) => [f.key, cardLabel(f)]));
		expect(label).toEqual({
			areaKm2: 'Area',
			areaHiKm2: 'High-MAP area',
			areaLoKm2: 'Low-MAP area',
			damCapacityM3: 'Dam capacity',
			damInitialPct: 'Dam initial storage',
			damMinPct: 'Dam minimum level',
			pctUpstreamToDam: 'Upstream inflow to dam',
			pctRunoffToDam: 'Incremental runoff to dam',
			divertCapacityM3Day: 'River to dam',
			irrigationEfficiency: 'Efficiency',
			returnFlowFraction: 'Return flow',
			flowShareManual: 'Manual flow share'
		});
		// Distinct, so no two cells of a card read the same.
		expect(new Set(Object.values(label)).size).toBe(TABLE_FIELDS.length);
	});
});

describe('hasDam / fmtVolume', () => {
	it('ignores placeholder dams under 1 m³ and gauges', () => {
		expect(hasDam({ kind: 'farm', damCapacityM3: 0.5 })).toBe(false);
		expect(hasDam({ kind: 'farm', damCapacityM3: 40_000 })).toBe(true);
		expect(hasDam({ kind: 'gauge', damCapacityM3: 40_000 })).toBe(false);
	});

	it('uses Mm³ for large dams', () => {
		expect(fmtVolume(2_400_000)).toBe('2.40 Mm³');
		expect(fmtVolume(60_000)).toBe('60\u202f000 m³');
	});
});

describe('damHints', () => {
	it('flags a dam irrigation may empty (minimum operating level 0 %), as a hint (Q5)', () => {
		expect(damHints({ kind: 'farm', damCapacityM3: 40_000, damMinPct: 0, damAreaFullM2: 15_000 })).toEqual(['Irrigation may empty this dam: its minimum operating level is 0 %.']);
	});

	it('says when evaporation uses an estimated surface area (N2)', () => {
		expect(damHints({ kind: 'farm', damCapacityM3: 90_000, damMinPct: 0.1, damAreaFullM2: null })).toEqual([
			"No surface area: evaporation uses 7.2 × capacity^0.77 m², about 4.7 ha. Enter the dam's area when full for a better figure."
		]);
		expect(damHints({ kind: 'farm', damCapacityM3: 40_000, damMinPct: 0.1, damAreaFullM2: 15_000 })).toEqual([]);
	});

	it('does not ask for an area when a survey curve gives it (WP-3.5)', () => {
		const damCurve = [
			{ levelM: 0, areaM2: 0, volumeM3: 0 },
			{ levelM: 3, areaM2: 15_000, volumeM3: 40_000 }
		];
		expect(damHints({ kind: 'farm', damCapacityM3: 40_000, damMinPct: 0.1, damAreaFullM2: null, damCurve })).toEqual([]);
	});

	it('says nothing for a farm without a dam or a gauge', () => {
		expect(damHints({ kind: 'farm', damCapacityM3: 0, damMinPct: 0 })).toEqual([]);
		expect(damHints({ kind: 'gauge', damCapacityM3: 40_000, damMinPct: 0 })).toEqual([]);
	});
});

describe('TABLE_FIELDS', () => {
	it('keeps the rarely edited dam physics in the one-node form only, so the table fits a laptop screen', () => {
		const keys = TABLE_FIELDS.map((f) => f.key);
		expect(keys).not.toContain('damAreaFullM2');
		expect(keys).not.toContain('damAreaExponent');
		expect(keys).not.toContain('damSeepagePerDay');
		expect(keys).toContain('irrigationEfficiency');
		// … and the boreholes (WP-1.34), which apply to few nodes.
		for (const k of ['boreholeCapacityM3Day', 'boreholeTriggerPct', 'streamDepletionFrac', 'streamDepletionLagDays', 'gaPropertyAreaHa']) expect(keys).not.toContain(k);
		// … and the seepage destination and outlet (WP-3.5).
		for (const k of ['damSeepageReturnPct', 'damOutletCapacityM3Day']) expect(keys).not.toContain(k);
		// … and the bed losses in the reach below (engine 1.75.0).
		for (const k of ['reachLossFrac', 'reachLossMaxM3Day']) expect(keys).not.toContain(k);
		expect(TABLE_FIELDS.length).toBe(NODE_FIELDS.length - 12);
	});
});

describe('isVolume', () => {
	it('marks the m³ and m³/day fields, whose columns need room for large values (River to dam is m³/s, a small number)', () => {
		expect(NODE_FIELDS.filter(isVolume).map((f) => f.key)).toEqual(['damCapacityM3', 'damOutletCapacityM3Day', 'boreholeCapacityM3Day', 'reachLossMaxM3Day']);
	});
});

describe('River to dam in m³/s', () => {
	const divert = NODE_FIELDS.find((f) => f.key === 'divertCapacityM3Day')!; // gitleaks:allow (a field name, not a secret)

	it('is entered in m³/s and stored in m³/day: 0.2 m³/s is 17 280 m³ a day', () => {
		expect(divert.unit).toBe('m³/s');
		expect(17_280 * fieldScale(divert)).toBeCloseTo(0.2, 12);
		expect(Math.round((0.2 / fieldScale(divert)) * 1e9) / 1e9).toBe(17_280);
		expect(fieldScale(NODE_FIELDS.find((f) => f.key === 'pctUpstreamToDam')!)).toBe(100);
		expect(fieldScale(NODE_FIELDS.find((f) => f.key === 'damCapacityM3')!)).toBe(1);
	});

	it('is not available for a dam on the river (Upstream inflow to dam 100 %, engine 1.68.0); any less, it is', () => {
		expect(fieldUnused(divert, { pctUpstreamToDam: 1 })).toMatch(/^Not available: the dam is on the river/);
		expect(fieldUnused(divert, { pctUpstreamToDam: 0.99 })).toBeNull();
		expect(fieldUnused(divert, { pctUpstreamToDam: 0 })).toBeNull();
		expect(fieldUnused(NODE_FIELDS.find((f) => f.key === 'damCapacityM3')!, { pctUpstreamToDam: 1 })).toBeNull();
	});
});

describe('bed losses in the reach below (engine 1.75.0)', () => {
	const share = NODE_FIELDS.find((x) => x.key === 'reachLossFrac')!;
	const cap = NODE_FIELDS.find((x) => x.key === 'reachLossMaxM3Day')!;

	it('is a percentage up to 50 %, and a nullable cap, both in the one-node form only', () => {
		expect(share.unit).toBe('%');
		expect(share.max).toBe(50);
		expect(cap.nullable).toBe(true);
		expect(TABLE_FIELDS.some((f) => f.group === 'reach')).toBe(false);
		expect(GROUPS.reach).toBe('Bed losses in the reach below');
	});

	it('is not used on the outlet, unless a share is left there to clear; the cap not without a share', () => {
		expect(fieldUnused(share, { pctUpstreamToDam: 0, downstreamNodeId: null })).toMatch(/^Not used: the outlet has no reach below it/);
		expect(fieldUnused(share, { pctUpstreamToDam: 0, downstreamNodeId: null, reachLossFrac: 0.1 })).toBeNull();
		expect(fieldUnused(share, { pctUpstreamToDam: 0, downstreamNodeId: 'g' })).toBeNull();
		expect(fieldUnused(cap, { pctUpstreamToDam: 0, downstreamNodeId: 'g', reachLossFrac: 0 })).toMatch(/^Not used: no bed losses/);
		expect(fieldUnused(cap, { pctUpstreamToDam: 0, downstreamNodeId: 'g', reachLossFrac: 0.2 })).toBeNull();
	});
});

describe('fieldUnused in the one-node form (a flow-share method given)', () => {
	const f = (key: string) => NODE_FIELDS.find((x) => x.key === key)!;
	const noDam = { pctUpstreamToDam: 0, damCapacityM3: 0 };
	const dam = { pctUpstreamToDam: 0, damCapacityM3: 50_000 };

	it("marks a dam's own fields unused with no dam, except the capacity that makes one", () => {
		expect(fieldUnused(f('damMinPct'), noDam, 'area')).toBe('Not used: no dam (capacity 0). Enter a capacity to use it.');
		expect(fieldUnused(f('damOutletCapacityM3Day'), noDam, 'area')).toMatch(/^Not used: no dam/);
		expect(fieldUnused(f('damCapacityM3'), noDam, 'area')).toBeNull();
		expect(fieldUnused(f('damMinPct'), dam, 'area')).toBeNull();
		// A sub-1 m³ placeholder is still a dam to the engine, so its fields stay live.
		expect(fieldUnused(f('damMinPct'), { pctUpstreamToDam: 0, damCapacityM3: 0.5 }, 'area')).toBeNull();
		// Routing to the dam still matters without one: it irrigates straight from the river (noDamSupplyHint).
		expect(fieldUnused(f('pctRunoffToDam'), noDam, 'area')).toBeNull();
	});

	it('marks the high/low MAP areas and the manual share unused unless their method is chosen', () => {
		expect(fieldUnused(f('areaHiKm2'), dam, 'area')).toMatch(/high\/low MAP split/);
		expect(fieldUnused(f('areaLoKm2'), dam, 'manual')).toMatch(/high\/low MAP split/);
		expect(fieldUnused(f('areaHiKm2'), dam, 'hiLo')).toBeNull();
		expect(fieldUnused(f('flowShareManual'), dam, 'hiLo')).toMatch(/isn’t Manual/);
		expect(fieldUnused(f('flowShareManual'), dam, 'manual')).toBeNull();
		expect(fieldUnused(f('areaKm2'), dam, 'manual')).toBeNull();
	});

	it('leaves the node table (no method) editable throughout', () => {
		expect(fieldUnused(f('damMinPct'), noDam)).toBeNull();
		expect(fieldUnused(f('flowShareManual'), noDam)).toBeNull();
	});
});

describe('hiLoHint', () => {
	const node = (areaKm2: number, areaHiKm2: number, areaLoKm2: number) => ({ ...newNetworkNode('u', 1, null), kind: 'farm' as const, areaKm2, areaHiKm2, areaLoKm2 });
	it('says when High-MAP + Low-MAP is more than 1 % off the area, as the run would', () => {
		expect(hiLoHint(node(10, 5, 4))).toBe('High-MAP + Low-MAP = 9.00 km², but the area is 10.00 km²: they should add up to it.');
		expect(hiLoHint(node(10, 5, 5))).toBeNull();
		expect(hiLoHint(node(10, 5, 4.95))).toBeNull();
		expect(hiLoHint(node(0, 0, 0))).toBeNull();
	});
});

describe('the combined boreholes', () => {
	it('are named apart from the individual boreholes, so no two fields share a label', () => {
		expect(GROUPS.groundwater).toBe('Combined boreholes (one capacity)');
		const labels = NODE_FIELDS.filter((x) => x.group === 'groundwater').map((x) => x.label);
		expect(labels).toContain('Combined borehole capacity');
		expect(labels).toContain('Combined stream depletion');
		expect(labels).not.toContain('Stream depletion');
	});
});

describe('hasDamDevelopment', () => {
	it('is true while any of a dam’s development fields is set (engine 1.30.0), so the form keeps them in reach', () => {
		const none = { damSurveyDate: null, damSedimentPctPerYear: null, damInServiceFrom: null };
		expect(hasDamDevelopment(none)).toBe(false);
		expect(hasDamDevelopment({})).toBe(false);
		expect(hasDamDevelopment({ ...none, damSurveyDate: '2015-06-30' })).toBe(true);
		// A rate of 0 is still an entry the form should show.
		expect(hasDamDevelopment({ ...none, damSedimentPctPerYear: 0 })).toBe(true);
		expect(hasDamDevelopment({ ...none, damInServiceFrom: '2003-10-01' })).toBe(true);
	});
});
