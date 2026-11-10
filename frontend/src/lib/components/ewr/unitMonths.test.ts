// The daily EWR months met at a hydrological unit (ewr/unitMonths.ts, docs/ui.md § EWR).
import { assessDailyEwrMonths, type UnitEwrMet } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { loadUnitMonths, pickedUnit, placeWords, unitChoices, unitInRun, unitMonths } from './unitMonths';

const unit = (nodeId: string, name: string, requiredM3: number): UnitEwrMet => ({ nodeId, name, kind: 'farm', requiredM3, metM3: 0, outflowM3: 0, daysNotMet: 0 });
const series = (startDate: string, values: (number | null)[]) => ({ startDate, values });

describe('unitChoices', () => {
	it('lists the units with an EWR share in either run, the first run’s order first, a unit only the second has after', () => {
		const base = { unitEwr: [unit('a', 'Top', 10), unit('b', 'Dry', 0), unit('c', 'Kunje', 30)] };
		const scen = { unitEwr: [unit('c', 'Kunje', 25), unit('d', 'Hexberg', 5)] };
		expect(unitChoices(base, scen)).toEqual([
			{ nodeId: 'a', name: 'Top' },
			{ nodeId: 'c', name: 'Kunje' },
			{ nodeId: 'd', name: 'Hexberg' }
		]);
	});
	it('offers none for runs made before engine 1.116.0, or none at all', () => {
		expect(unitChoices({}, null, undefined)).toEqual([]);
	});
});

describe('unitInRun and pickedUnit', () => {
	it('a unit a scenario added is not in its base run', () => {
		expect(unitInRun({ unitEwr: [unit('a', 'Top', 1)] }, 'a')).toBe(true);
		expect(unitInRun({ unitEwr: [unit('a', 'Top', 1)] }, 'z')).toBe(false);
		expect(unitInRun({}, 'a')).toBe(false);
	});
	it('falls back to the outlet when the pick is no longer offered', () => {
		const choices = [{ nodeId: 'a', name: 'Top' }];
		expect(pickedUnit(choices, 'a')).toEqual({ nodeId: 'a', name: 'Top' });
		expect(pickedUnit(choices, 'gone')).toBeNull();
		expect(pickedUnit(choices, null)).toBeNull();
	});
});

describe('unitMonths', () => {
	it('is the engine’s outlet test on the unit’s outflow against the EWR required at it', () => {
		// 1 Jan to 31 Mar 2021: January met (outflow ≥ requirement), February short, March owed nothing.
		const req = [...Array(31).fill(100), ...Array(28).fill(100), ...Array(31).fill(0)];
		const out = [...Array(31).fill(150), ...Array(28).fill(50), ...Array(31).fill(10)];
		const r = unitMonths(series('2021-01-01', out), series('2021-01-01', req));
		expect(r).toEqual(assessDailyEwrMonths('2021-01-01', 90, req, out));
		expect([r.months, r.met, r.zeroRequirementMonths, r.longestNotMetRun]).toEqual([3, 2, 1, 1]);
		expect(r.deficitM3).toBe(28 * 50);
	});
	it('counts a missing value as 0 and leaves out a month a forecast tail starts inside', () => {
		const req = Array(59).fill(100);
		const out: (number | null)[] = [null, ...Array(58).fill(200)];
		const all = unitMonths(series('2021-01-01', out), series('2021-01-01', req));
		expect(all.months).toBe(2);
		const recorded = unitMonths(series('2021-01-01', out), series('2021-01-01', req), 40);
		expect(recorded.months).toBe(1);
	});
	it('refuses two series that start on different days', () => {
		expect(() => unitMonths(series('2021-01-01', [1]), series('2021-01-02', [1]))).toThrow(/starts 2021-01-01/);
	});
});

describe('loadUnitMonths', () => {
	it('fetches the unit’s outflow and EWR required and judges them', async () => {
		const asked: string[] = [];
		const r = await loadUnitMonths(async (key, nodeId) => {
			asked.push(`${key}:${nodeId}`);
			return series('2021-01-01', Array(31).fill(key === 'outflow' ? 5 : 10));
		}, 'k');
		expect(asked.sort()).toEqual(['ewr_cumulative:k', 'outflow:k']);
		expect([r.months, r.met]).toEqual([1, 0]);
	});
});

describe('placeWords', () => {
	it('names the outlet or the unit, and the unit’s requirement as its share', () => {
		expect(placeWords(null).where).toBe('the outlet');
		expect(placeWords(null).requirement('the daily EWR from the DRM TAB file')).toBe('the daily EWR from the DRM TAB file');
		const k = placeWords({ nodeId: 'k', name: 'Kunje' });
		expect(k.flow).toBe('the flow leaving Kunje (after its abstractions)');
		expect(k.requirement('the pragmatic EWR')).toBe('its share of the pragmatic EWR (with the shares of the units above it)');
	});
});
