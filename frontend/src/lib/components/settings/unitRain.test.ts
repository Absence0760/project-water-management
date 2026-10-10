// Settings → Flow generation → Rain for each unit (settings.unitRain, issue
// #482): the switch, the gauge MAP, the MAP period in whole years, and the
// check that blocks Save, which must agree with the API's (engine
// unitRainError). The form itself: UnitRainFields.test.ts and
// e2e/tests/unit-rain.spec.ts.
import { describe, expect, it } from 'vitest';
import { DEFAULT_UNIT_MAP_PERIOD, unitRainError, type UnitRainSettings } from '@water-management/engine';
import {
	mapPeriodNote,
	mapPeriodYears,
	unitMapCoverage,
	unitRainFormError,
	unitRainOn,
	unitRainProblem,
	withGaugeMap,
	withMapPeriodYears,
	withReferenceGauge,
	withReferenceUnit,
	withUnitRain
} from './unitRain';

describe('withUnitRain', () => {
	it('switches on per unit with nothing else set, or back to what was switched off, and off to none', () => {
		expect(withUnitRain(true)).toEqual({ mode: 'perUnit' });
		const before: UnitRainSettings = { mode: 'perUnit', gaugeMapMm: 640, gaugeMapSource: 'gauge record', mapPeriod: { start: '1991-01-01', end: '2010-12-31' } };
		const back = withUnitRain(true, before)!;
		expect(back).toEqual(before);
		expect(back.mapPeriod).not.toBe(before.mapPeriod);
		expect(withUnitRain(true, { mode: 'catchment', gaugeMapMm: 500, gaugeMapSource: 's' })).toEqual({ mode: 'perUnit', gaugeMapMm: 500, gaugeMapSource: 's' });
		expect(withUnitRain(false, before)).toBeNull();
	});

	it('counts only perUnit as on', () => {
		expect(unitRainOn(null)).toBe(false);
		expect(unitRainOn(undefined)).toBe(false);
		expect(unitRainOn({ mode: 'catchment' })).toBe(false);
		expect(unitRainOn({ mode: 'perUnit' })).toBe(true);
	});
});

describe('the MAP period in whole years', () => {
	it('reads the stored years, or the default 1991–2020', () => {
		expect(mapPeriodYears({ mode: 'perUnit' })).toEqual({ from: 1991, to: 2020 });
		expect(mapPeriodYears({ mapPeriod: { start: '2001-01-01', end: '2015-12-31' } })).toEqual({ from: 2001, to: 2015 });
	});

	it('stores 1 Jan to 31 Dec, and the default years as none', () => {
		expect(withMapPeriodYears({ mode: 'perUnit' }, 2001, 2015)).toEqual({ mode: 'perUnit', mapPeriod: { start: '2001-01-01', end: '2015-12-31' } });
		expect(withMapPeriodYears({ mode: 'perUnit', mapPeriod: { start: '2001-01-01', end: '2015-12-31' } }, 1991, 2020)).toEqual({ mode: 'perUnit' });
		expect(DEFAULT_UNIT_MAP_PERIOD).toEqual({ start: '1991-01-01', end: '2020-12-31' });
	});

	it('notes a period shorter than five years or starting before CHIRPS, without blocking Save', () => {
		expect(mapPeriodNote({ mode: 'perUnit' })).toBeNull();
		expect(mapPeriodNote(withMapPeriodYears({ mode: 'perUnit' }, 2010, 2012))).toMatch(/^3 years: .* at least 5 complete years/);
		expect(mapPeriodNote(withMapPeriodYears({ mode: 'perUnit' }, 2010, 2010))).toMatch(/^1 year:/);
		expect(mapPeriodNote(withMapPeriodYears({ mode: 'perUnit' }, 1975, 2000))).toMatch(/^CHIRPS begins in 1981/);
		expect(mapPeriodNote({ mode: 'catchment' })).toBeNull();
		expect(unitRainFormError(withMapPeriodYears({ mode: 'perUnit' }, 2010, 2010))).toBeNull();
	});
});

describe('withGaugeMap', () => {
	it('sets the MAP with an empty source to fill, and clearing it clears its source', () => {
		expect(withGaugeMap({ mode: 'perUnit' }, 640)).toEqual({ mode: 'perUnit', gaugeMapMm: 640, gaugeMapSource: '' });
		expect(withGaugeMap({ mode: 'perUnit', gaugeMapMm: 600, gaugeMapSource: 'kept' }, 640)).toEqual({ mode: 'perUnit', gaugeMapMm: 640, gaugeMapSource: 'kept' });
		expect(withGaugeMap({ mode: 'perUnit', gaugeMapMm: 600, gaugeMapSource: 'kept' }, null)).toEqual({ mode: 'perUnit' });
	});
});

describe('unitRainProblem', () => {
	it('blocks Save on a gauge MAP out of range or without its source, naming the field', () => {
		expect(unitRainProblem({ mode: 'perUnit', gaugeMapMm: 0, gaugeMapSource: 's' })).toEqual({ field: 'gaugeMap', message: 'The rain gauge’s MAP must be 1 to 12000 mm.' });
		expect(unitRainProblem({ mode: 'perUnit', gaugeMapMm: 640, gaugeMapSource: '  ' })?.field).toBe('gaugeSource');
		expect(unitRainProblem({ mode: 'perUnit', gaugeMapMm: 640, gaugeMapSource: 'x'.repeat(601) })?.message).toMatch(/at most 600 characters; it has 601/);
		expect(unitRainProblem(withMapPeriodYears({ mode: 'perUnit' }, 2015, 2001))).toEqual({ field: 'period', message: 'The MAP period’s first year must not be after its last.' });
	});

	it('agrees with the API’s rule (engine unitRainError) on what saves', () => {
		const cases: (UnitRainSettings | null | undefined)[] = [
			null,
			undefined,
			{ mode: 'catchment' },
			{ mode: 'perUnit' },
			{ mode: 'perUnit', gaugeMapMm: 640, gaugeMapSource: 'gauge record 1991–2020' },
			{ mode: 'perUnit', gaugeMapMm: 0, gaugeMapSource: 's' },
			{ mode: 'perUnit', gaugeMapMm: 12_001, gaugeMapSource: 's' },
			{ mode: 'perUnit', gaugeMapMm: 640, gaugeMapSource: '' },
			withMapPeriodYears({ mode: 'perUnit' }, 2015, 2001),
			withMapPeriodYears({ mode: 'perUnit' }, 2010, 2010),
			{ mode: 'catchment', gaugeMapMm: -1, gaugeMapSource: 's' },
			{ mode: 'perUnit', mapPeriod: { start: '2001-01-01', end: '2001-06-30' } },
			{ mode: 'perUnit', reference: { gauge: 'rain_catchment_mm', unitId: 'a' } },
			{ mode: 'perUnit', reference: { gauge: 'rain_catchment_mm', unitId: '' } },
			{ mode: 'perUnit', reference: null }
		];
		for (const c of cases) expect(unitRainFormError(c) === null, JSON.stringify(c)).toBe(unitRainError(c) === null);
	});
});

describe('unitMapCoverage', () => {
	it('counts the units with land and those with a MAP', () => {
		expect(unitMapCoverage([]).text).toBe('No unit has land yet.');
		const nodes = [
			{ kind: 'farm' as const, areaKm2: 10, mapMm: 700 },
			{ kind: 'farm' as const, areaKm2: 5, mapMm: null },
			{ kind: 'farm' as const, areaKm2: 0, mapMm: 900 },
			{ kind: 'gauge' as const, areaKm2: 0, mapMm: null }
		];
		expect(unitMapCoverage(nodes)).toEqual({ land: 2, withMap: 1, text: '1 of 2 units with land has a MAP.', without: [nodes[1]] });
		expect(unitMapCoverage(nodes.slice(1, 2)).text).toBe('0 of 1 unit with land have a MAP.');
	});
});

describe('the reference gauge and unit (issue #500)', () => {
	it('a unit’s own gauge makes that unit the reference; the catchment gauge keeps the unit chosen, else asks for one', () => {
		const on: UnitRainSettings = { mode: 'perUnit', gaugeMapMm: 640, gaugeMapSource: 'gauge record' };
		expect(withReferenceGauge(on, 'rain_catchment_mm@b').reference).toEqual({ gauge: 'rain_catchment_mm@b', unitId: 'b' });
		const catchment = withReferenceGauge(on, 'rain_catchment_mm');
		expect(catchment.reference).toEqual({ gauge: 'rain_catchment_mm', unitId: '' });
		expect(unitRainProblem(catchment)).toEqual({ field: 'reference', message: 'Pick the reference unit: the unit the reference gauge stands in.' });
		const picked = withReferenceUnit(catchment, 'a');
		expect(picked.reference).toEqual({ gauge: 'rain_catchment_mm', unitId: 'a' });
		expect(unitRainProblem(picked)).toBeNull();
		expect(withReferenceGauge(picked, 'rain_catchment_mm').reference).toEqual({ gauge: 'rain_catchment_mm', unitId: 'a' });
		// None clears the reference, leaving the rest of the setting alone.
		expect(withReferenceGauge(picked, '')).toEqual(on);
	});
});
