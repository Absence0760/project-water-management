import { describe, expect, it } from 'vitest';
import { hasSupplySettings, noDamSupplyHint, pumpM3Day, sharedPumpHint } from './supply';

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
});
