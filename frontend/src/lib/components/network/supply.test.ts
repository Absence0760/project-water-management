import { describe, expect, it } from 'vitest';
import { diverts, divertMonthsCell, divertMonthsPreview, divertMonthsTicked, handsOffPreview, handsOffTakers, handsOffTicked, hasSupplySettings, noDamSupplyHint, pumpM3Day, sharedPumpHint } from './supply';

describe('pumpM3Day', () => {
	it('is pumps × m³/h per pump × 24 h', () => {
		expect(pumpM3Day(2, 25)).toBe(1200);
		expect(pumpM3Day(1, 50)).toBe(1200);
		expect(pumpM3Day(3, 12.5)).toBe(900);
		expect(pumpM3Day(0, 40)).toBe(0);
	});

	it('has no value until both are entered, and none for a negative entry', () => {
		expect(pumpM3Day(null, 25)).toBeNull();
		expect(pumpM3Day(2, null)).toBeNull();
		expect(pumpM3Day(-1, 25)).toBeNull();
		expect(pumpM3Day(2, Number.NaN)).toBeNull();
	});

	it('does not leave floating-point dust on a product', () => {
		expect(pumpM3Day(3, 0.1)).toBe(7.2);
	});
});

describe('noDamSupplyHint', () => {
	const farm = { kind: 'farm' as const, damCapacityM3: 0, pctUpstreamToDam: 1, pctRunoffToDam: 0, divertCapacityM3Day: 0, supplyRule: 'damFirst' as const };

	it('warns a farm with no dam that has upstream inflow routed to it, as the run does', () => {
		expect(noDamSupplyHint(farm)).toMatch(/irrigated straight from the river, with no pump limit.*run of river/);
		expect(noDamSupplyHint({ ...farm, supplyRule: undefined })).not.toBeNull();
		expect(noDamSupplyHint({ ...farm, pctUpstreamToDam: 0, divertCapacityM3Day: 500 })).not.toBeNull();
	});

	it('says nothing with a dam, another rule, nothing routed, or on another kind', () => {
		expect(noDamSupplyHint({ ...farm, damCapacityM3: 10_000 })).toBeNull();
		expect(noDamSupplyHint({ ...farm, supplyRule: 'runOfRiver' })).toBeNull();
		expect(noDamSupplyHint({ ...farm, pctUpstreamToDam: 0 })).toBeNull();
		expect(noDamSupplyHint({ ...farm, kind: 'user' })).toBeNull();
	});
});

describe('hasSupplySettings', () => {
	it('is true for anything but the default rule with no pump', () => {
		expect(hasSupplySettings({})).toBe(false);
		expect(hasSupplySettings({ supplyRule: 'damFirst', pumpCapacityM3Day: null })).toBe(false);
		expect(hasSupplySettings({ supplyRule: 'riverFirst' })).toBe(true);
		expect(hasSupplySettings({ pumpCapacityM3Day: 0 })).toBe(true);
		// An other water user's pump is its own field (engine 1.58.0), not a stale supply setting; a gauge's is.
		expect(hasSupplySettings({ kind: 'user', pumpCapacityM3Day: 500 })).toBe(false);
		expect(hasSupplySettings({ kind: 'user', supplyRule: 'riverFirst' })).toBe(true);
		expect(hasSupplySettings({ kind: 'gauge', pumpCapacityM3Day: 500 })).toBe(true);
	});

	it('counts the hands-off flow and River to dam by month (engine 1.32.0), so a gauge left with them can clear them', () => {
		expect(hasSupplySettings({ handsOffM3Day: null, handsOffEwr: false, divertMonthlyM3Day: null })).toBe(false);
		expect(hasSupplySettings({ handsOffM3Day: new Array(12).fill(0) })).toBe(true);
		expect(hasSupplySettings({ handsOffEwr: true })).toBe(true);
		expect(hasSupplySettings({ divertMonthlyM3Day: new Array(12).fill(0) })).toBe(true);
	});
});

describe('sharedPumpHint', () => {
	const farm = { kind: 'farm' as const, divertCapacityM3Day: 500, supplyRule: 'riverFirst' as const, pumpCapacityM3Day: 1200 };

	it('notes a farm that fills its dam from the river and also pumps the river to irrigate', () => {
		expect(sharedPumpHint(farm)).toMatch(/River to dam.*two pumps.*split its capacity/);
		expect(sharedPumpHint({ ...farm, supplyRule: 'trigger' })).not.toBeNull();
		// No limit is still a pump.
		expect(sharedPumpHint({ ...farm, pumpCapacityM3Day: null })).not.toBeNull();
	});

	it('says nothing without a river pump, without a diversion, on run of river, or on another kind', () => {
		expect(sharedPumpHint({ ...farm, supplyRule: 'damFirst' })).toBeNull();
		expect(sharedPumpHint({ ...farm, supplyRule: undefined })).toBeNull();
		expect(sharedPumpHint({ ...farm, pumpCapacityM3Day: 0 })).toBeNull();
		expect(sharedPumpHint({ ...farm, divertCapacityM3Day: 0 })).toBeNull();
		// Run of river has no dam, so the diversion is ignored (docs/model.md §2.7e).
		expect(sharedPumpHint({ ...farm, supplyRule: 'runOfRiver' })).toBeNull();
		expect(sharedPumpHint({ ...farm, kind: 'user' })).toBeNull();
	});

	it('reads River to dam by month as the run does: any month above 0 diverts, and the one value is then ignored', () => {
		expect(sharedPumpHint({ ...farm, divertCapacityM3Day: 0, divertMonthlyM3Day: [0, 0, 0, 0, 0, 0, 0, 900, 0, 0, 0, 0] })).not.toBeNull();
		expect(sharedPumpHint({ ...farm, divertMonthlyM3Day: new Array(12).fill(0) })).toBeNull();
	});
});

// Water-year order Oct–Sep: index 3 is January.
// River to dam is stored in m³/day and shown in m³/s: 864 m³/day is 0.01 m³/s.
const WINTER = [0, 0, 0, 0, 0, 0, 0, 864, 864, 864, 864, 864];

describe('diverts', () => {
	it('is the one capacity above 0, or any month above 0 once set by month', () => {
		expect(diverts({ divertCapacityM3Day: 500 })).toBe(true);
		expect(diverts({ divertCapacityM3Day: 0 })).toBe(false);
		expect(diverts({ divertCapacityM3Day: 0, divertMonthlyM3Day: WINTER })).toBe(true);
		expect(diverts({ divertCapacityM3Day: 500, divertMonthlyM3Day: new Array(12).fill(0) })).toBe(false);
		expect(diverts({ divertCapacityM3Day: 500, divertMonthlyM3Day: null })).toBe(true);
	});
});

describe('handsOffTakers', () => {
	// An off-channel dam (River to dam is for one; a dam on the river takes none, engine 1.68.0).
	const farm = { damCapacityM3: 150_000, pctUpstreamToDam: 0, pctRunoffToDam: 1, divertCapacityM3Day: 0, divertMonthlyM3Day: null };

	it('is the pump on any rule but the dam only, unless its capacity is 0', () => {
		expect(handsOffTakers({ ...farm, supplyRule: 'riverFirst', pumpCapacityM3Day: 500 }).pump).toBe(true);
		expect(handsOffTakers({ ...farm, supplyRule: 'trigger', pumpCapacityM3Day: null }).pump).toBe(true);
		expect(handsOffTakers({ ...farm, supplyRule: 'riverFirst', pumpCapacityM3Day: 0 }).pump).toBe(false);
		expect(handsOffTakers({ ...farm, supplyRule: 'damFirst', pumpCapacityM3Day: 500 }).pump).toBe(false);
	});

	it('is River to dam on a farm with a dam that diverts, not the dam’s own split', () => {
		expect(handsOffTakers(farm)).toEqual({ pump: false, riverToDam: false, noDamRouting: false });
		expect(handsOffTakers({ ...farm, divertCapacityM3Day: 800 })).toEqual({ pump: false, riverToDam: true, noDamRouting: false });
		expect(handsOffTakers({ ...farm, divertCapacityM3Day: 800, divertMonthlyM3Day: new Array(12).fill(0) }).riverToDam).toBe(false);
		// A dam on the river has no River to dam, whatever is stored.
		expect(handsOffTakers({ ...farm, pctUpstreamToDam: 1, divertCapacityM3Day: 800 }).riverToDam).toBe(false);
	});

	it('is what a farm with no dam irrigates straight from the river, except on run of river (engine 1.32.0)', () => {
		expect(handsOffTakers({ ...farm, damCapacityM3: 0 })).toEqual({ pump: false, riverToDam: false, noDamRouting: true });
		expect(handsOffTakers({ ...farm, damCapacityM3: 0, pctUpstreamToDam: 0, pctRunoffToDam: 0 }).noDamRouting).toBe(false);
		expect(handsOffTakers({ ...farm, damCapacityM3: 0, pctUpstreamToDam: 0, pctRunoffToDam: 0, divertCapacityM3Day: 10 }).noDamRouting).toBe(true);
		expect(handsOffTakers({ ...farm, damCapacityM3: 0, supplyRule: 'runOfRiver', pumpCapacityM3Day: 500, divertCapacityM3Day: 10 })).toEqual({
			pump: true,
			riverToDam: false,
			noDamRouting: false
		});
	});
});

describe('handsOffPreview', () => {
	const pumpAndDivert = { supplyRule: 'riverFirst' as const, pumpCapacityM3Day: 500, damCapacityM3: 150_000, pctUpstreamToDam: 0, pctRunoffToDam: 1, divertCapacityM3Day: 800 };

	it('says what River to dam and the pump leave without one: priority users only, not the EWR', () => {
		expect(handsOffPreview({})).toMatch(/^No hands-off flow: .*priority water users downstream need, not the EWR\.$/);
		// 0 in every month without the EWR is none, as the run reads it.
		expect(handsOffPreview({ handsOffM3Day: new Array(12).fill(0), handsOffEwr: false })).toMatch(/^No hands-off flow/);
	});

	it('gives one amount, a range, the months without one and the EWR in plain words', () => {
		expect(handsOffPreview({ ...pumpAndDivert, handsOffM3Day: new Array(12).fill(150) })).toBe(
			'Leaves 150 m³/day in the river before the river pump or River to dam takes anything. When less flows, neither takes anything.'
		);
		expect(handsOffPreview({ ...pumpAndDivert, handsOffM3Day: [0, 0, 0, 100, 250, 250, 0, 0, 0, 0, 0, 0] })).toBe(
			'Leaves the set flow (between 100 and 250 m³/day by month; none in Oct–Dec, Apr–Sep) in the river before the river pump or River to dam takes anything. When less flows, neither takes anything.'
		);
		expect(handsOffPreview({ ...pumpAndDivert, handsOffM3Day: null, handsOffEwr: true })).toMatch(/^Leaves the EWR required here \(this unit’s share and upstream shares\) in the river/);
		expect(handsOffPreview({ ...pumpAndDivert, handsOffM3Day: new Array(12).fill(1200), handsOffEwr: true })).toMatch(
			/^Leaves the larger of the set flow \(1 200 m³\/day\) and the EWR required here/
		);
	});

	it('writes every figure entered, as the field shows it', () => {
		expect(handsOffPreview({ ...pumpAndDivert, handsOffM3Day: [0.0129, 12_345.5, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1] })).toMatch(
			/^Leaves between 0\.0129 and 12 345\.5 m³\/day by month in the river /
		);
	});

	it('names only the pump, or only River to dam, where only one applies', () => {
		expect(handsOffPreview({ ...pumpAndDivert, divertCapacityM3Day: 0, handsOffM3Day: new Array(12).fill(150) })).toBe(
			'Leaves 150 m³/day in the river before the river pump takes anything. When less flows, nothing is taken.'
		);
		expect(handsOffPreview({ ...pumpAndDivert, supplyRule: 'damFirst', handsOffM3Day: new Array(12).fill(150) })).toBe(
			'Leaves 150 m³/day in the river before River to dam takes anything. When less flows, nothing is taken.'
		);
	});

	it('says it changes nothing on the dam only with no River to dam', () => {
		expect(handsOffPreview({ ...pumpAndDivert, supplyRule: 'damFirst', divertCapacityM3Day: 0, handsOffEwr: true })).toBe(
			'Would leave the EWR required here (this unit’s share and upstream shares) in the river, but it changes nothing here: this hydrological unit takes nothing from the river past its dam (no river pump, no River to dam).'
		);
	});

	it('on a farm with no dam, limits what it irrigates straight from the river (engine 1.32.0)', () => {
		expect(handsOffPreview({ ...pumpAndDivert, supplyRule: 'damFirst', damCapacityM3: 0, divertCapacityM3Day: 0, handsOffM3Day: new Array(12).fill(150) })).toBe(
			'Leaves 150 m³/day in the river before its irrigation straight from the river takes anything. It has no dam, so what is routed to its dam (upstream inflow, runoff, River to dam) is irrigated straight from the river. When less flows, nothing is taken.'
		);
		// Run of river routes nothing to the dam: the pump only.
		expect(handsOffPreview({ ...pumpAndDivert, supplyRule: 'runOfRiver', damCapacityM3: 0, handsOffM3Day: new Array(12).fill(150) })).toBe(
			'Leaves 150 m³/day in the river before the river pump takes anything. When less flows, nothing is taken.'
		);
	});
});

describe('divertMonthsPreview', () => {
	it('is null for the one value all year', () => {
		expect(divertMonthsPreview({ divertMonthlyM3Day: null })).toBeNull();
		expect(divertMonthsPreview({})).toBeNull();
	});

	it('names the months it takes nothing in, and says the one value is not used', () => {
		expect(divertMonthsPreview({ divertMonthlyM3Day: WINTER })).toBe('River to dam takes up to 0.01 m³/s; nothing in Oct–Apr. The one value above is not used.');
		expect(divertMonthsPreview({ divertMonthlyM3Day: new Array(12).fill(0) })).toBe('River to dam is 0 in every month: it diverts nothing.');
		expect(divertMonthsPreview({ divertMonthlyM3Day: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((k) => k * 864) })).toBe(
			'River to dam takes between 0.01 and 0.12 m³/s by month. The one value above is not used.'
		);
		expect(divertMonthsPreview({ divertMonthlyM3Day: [86.4, 1_296_000, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] })).toBe(
			'River to dam takes between 0.001 and 15 m³/s by month; nothing in Dec–Sep. The one value above is not used.'
		);
	});
});

describe('divertMonthsCell', () => {
	it('is null for the one value all year, which the node table edits', () => {
		expect(divertMonthsCell({ divertMonthlyM3Day: null }, 'Hilltop')).toBeNull();
		expect(divertMonthsCell({}, 'Hilltop')).toBeNull();
	});

	it('shows the months’ range, and names it in full for a screen reader', () => {
		expect(divertMonthsCell({ divertMonthlyM3Day: WINTER }, 'Hilltop')).toEqual({
			text: 'by month: 0–0.01',
			aria: 'River to dam at Hilltop is set by month, between 0 and 0.01 m³/s'
		});
		expect(divertMonthsCell({ divertMonthlyM3Day: new Array(12).fill(17_280) }, 'Hilltop')).toEqual({
			text: 'by month: 0.2',
			aria: 'River to dam at Hilltop is set by month, 0.2 m³/s every month'
		});
		expect(divertMonthsCell({ divertMonthlyM3Day: [86.4, 1_296_000, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] }, 'Hilltop')!.text).toBe('by month: 0–15');
	});

	it('says by month without a range when no month holds a number (a row the save refuses)', () => {
		expect(divertMonthsCell({ divertMonthlyM3Day: [] }, 'Hilltop')).toEqual({ text: 'by month', aria: 'River to dam at Hilltop is set by month' });
	});
});

describe('the boxes that switch a monthly row on', () => {
	it('start the hands-off flow at 0 in every month, and clear it unticked', () => {
		expect(handsOffTicked(true)).toEqual(new Array(12).fill(0));
		expect(handsOffTicked(false)).toBeNull();
	});

	it('start River to dam by month at the one value in every month, so the run is unchanged until a month is edited', () => {
		expect(divertMonthsTicked(true, 800)).toEqual(new Array(12).fill(800));
		expect(divertMonthsTicked(false, 800)).toBeNull();
	});
});
