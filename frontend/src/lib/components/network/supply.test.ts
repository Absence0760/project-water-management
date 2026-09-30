import { describe, expect, it } from 'vitest';
import { diverts, divertMonthsPreview, handsOffPreview, hasSupplySettings, noDamSupplyHint, pumpM3Day, sharedPumpHint } from './supply';

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
	});

	it('counts the hands-off flow and River to dam by month (engine 1.31.0), so a gauge left with them can clear them', () => {
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
const WINTER = [0, 0, 0, 0, 0, 0, 0, 800, 800, 800, 800, 800];

describe('diverts', () => {
	it('is the one capacity above 0, or any month above 0 once set by month', () => {
		expect(diverts({ divertCapacityM3Day: 500 })).toBe(true);
		expect(diverts({ divertCapacityM3Day: 0 })).toBe(false);
		expect(diverts({ divertCapacityM3Day: 0, divertMonthlyM3Day: WINTER })).toBe(true);
		expect(diverts({ divertCapacityM3Day: 500, divertMonthlyM3Day: new Array(12).fill(0) })).toBe(false);
		expect(diverts({ divertCapacityM3Day: 500, divertMonthlyM3Day: null })).toBe(true);
	});
});

describe('handsOffPreview', () => {
	it('says what River to dam and the pump leave without one: senior users only, not the EWR', () => {
		expect(handsOffPreview({})).toMatch(/^No hands-off flow: .*senior water users downstream need, not the EWR\.$/);
		// 0 in every month without the EWR is none, as the run reads it.
		expect(handsOffPreview({ handsOffM3Day: new Array(12).fill(0), handsOffEwr: false })).toMatch(/^No hands-off flow/);
	});

	it('gives one amount, a range, the months without one and the EWR in plain words', () => {
		expect(handsOffPreview({ handsOffM3Day: new Array(12).fill(150) })).toBe(
			'Leaves 150 m³/day in the river before the river pump or River to dam takes anything. When less flows, neither takes anything.'
		);
		expect(handsOffPreview({ handsOffM3Day: [0, 0, 0, 100, 250, 250, 0, 0, 0, 0, 0, 0] })).toBe(
			'Leaves 100–250 m³/day (none in Oct–Dec, Apr–Sep) in the river before the river pump or River to dam takes anything. When less flows, neither takes anything.'
		);
		expect(handsOffPreview({ handsOffM3Day: null, handsOffEwr: true })).toMatch(/^Leaves the EWR required here \(this unit’s share and upstream shares\) in the river/);
		expect(handsOffPreview({ handsOffM3Day: new Array(12).fill(1200), handsOffEwr: true })).toMatch(/^Leaves the larger of 1\u202f200 m³\/day and the EWR required here/);
	});
});

describe('divertMonthsPreview', () => {
	it('is null for the one value all year', () => {
		expect(divertMonthsPreview({ divertMonthlyM3Day: null })).toBeNull();
		expect(divertMonthsPreview({})).toBeNull();
	});

	it('names the months it takes nothing in, and says the one value is not used', () => {
		expect(divertMonthsPreview({ divertMonthlyM3Day: WINTER })).toBe('River to dam takes up to 800 m³/day; nothing in Oct–Apr. The one value above is not used.');
		expect(divertMonthsPreview({ divertMonthlyM3Day: new Array(12).fill(0) })).toBe('River to dam is 0 in every month: it diverts nothing.');
		expect(divertMonthsPreview({ divertMonthlyM3Day: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] })).toBe(
			'River to dam takes up to 1–12 m³/day in every month. The one value above is not used.'
		);
	});
});
