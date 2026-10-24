// Runs & results → Rain for each unit (issue #482): reading summary.unitRain
// defensively, and each unit's rule, factor and what to check, in words.
import { render } from 'svelte/server';
import { describe, expect, it, vi } from 'vitest';
import UnitRainPanel from './UnitRainPanel.svelte';
import { factorClamped, factorOutsideBand, factorText, periodText, referenceFactorsText, referenceFitText, sortResultUnits, unitRainNotes, unitRainOf, type UnitRainResult, type UnitRainResultUnit } from './unitRain';
import { withoutComments } from '../__fixtures__/withoutComments';

vi.mock('$app/paths', () => ({ resolve: (p: string) => `/${p}`, asset: (f: string) => `/${f}` }));

const unit = (over: Partial<UnitRainResultUnit> = {}): UnitRainResultUnit => ({
	nodeId: 'u1',
	name: 'Upper unit',
	areaKm2: 10,
	mapMm: 820,
	mapSource: 'a synthetic MAP grid',
	rule: 'gaugeMap',
	rainKey: 'rain_catchment_mm',
	factor: 1.25,
	factorSource: 'gaugeMap',
	gaugeMapFactor: 1.25,
	gaugeMapOwnFactor: 1.25,
	gaugeMapClamped: false,
	gaugeMapOutsideBand: false,
	chirps: null,
	days: { unitGauge: 0, gaugeMap: 3000, unitChirps: 40, catchment: 0, forecast: 0, none: 2 },
	rainMm: 9100,
	petMm: 12_000,
	aetMm: 7800,
	flowMm: 1200,
	exchangeMm: 0,
	storageStartMm: 200,
	storageEndMm: 300,
	runoffM3: 12_000_000,
	runoffCoefficient: 0.132,
	...over
});
const result = (units: UnitRainResultUnit[]): UnitRainResult => ({ mode: 'perUnit', gaugeMapMm: 656, gaugeMapSource: 'gauge record', mapPeriod: { start: '1991-01-01', end: '2020-12-31' }, units });

describe('unitRainOf', () => {
	it('reads summary.unitRain only from a run that ran per unit', () => {
		expect(unitRainOf({ farms: [] })).toBeNull();
		expect(unitRainOf(null)).toBeNull();
		expect(unitRainOf({ unitRain: { mode: 'catchment', units: [] } })).toBeNull();
		expect(unitRainOf({ unitRain: { mode: 'perUnit' } })).toBeNull();
		const r = result([unit()]);
		expect(unitRainOf({ unitRain: r })).toBe(r);
	});
});

describe('the factor in words', () => {
	it('gives the factor and its source, or the source alone when it varies by day', () => {
		expect(factorText(unit())).toBe('× 1.25, unit MAP ÷ gauge MAP');
		expect(factorText(unit({ factor: null, factorSource: 'chirpsBias' }))).toBe('the catchment’s monthly CHIRPS factors');
		expect(factorText(unit({ factor: 1, factorSource: 'gauge' }))).toBe('× 1, as recorded');
	});

	it('marks a factor held at the bound by the rule that used it', () => {
		expect(factorClamped(unit({ gaugeMapClamped: true }))).toBe(true);
		expect(factorClamped(unit({ rule: 'unitChirps', gaugeMapClamped: true, chirps: { source: 'raw' } }))).toBe(false);
		expect(factorClamped(unit({ rule: 'unitChirps', chirps: { source: 'map', factor: 4, clamped: true, ownFactor: 4.6, meanAnnualMm: 200, years: [2001], inPeriod: true, outsideBand: true } }))).toBe(true);
	});

	it('writes the MAP period as years', () => {
		expect(periodText({ start: '1991-01-01', end: '2020-12-31' })).toBe('1991–2020');
	});
});

describe('a unit on its rainfall station (issue #553)', () => {
	it('says the station and its MAP ratio, held and noted like the gauge’s', () => {
		const u = unit({ rule: 'station', rainKey: 'rain_station_mm#s1', factor: 4, factorSource: 'gaugeMap', gaugeMapOwnFactor: 4.6, gaugeMapClamped: true });
		expect(factorText(u)).toBe('× 4, unit MAP ÷ station MAP');
		expect(factorClamped(u)).toBe(true);
		expect(unitRainNotes({ units: [u] })).toEqual(['Upper unit: the factor was held at the 0.25–4 bound; check its MAP and the station’s.']);
		const body = withoutComments(render(UnitRainPanel, { props: { result: result([u]) } }).body);
		expect(body).toContain('Its rainfall station × MAP ratio');
	});
});

describe('unitRainNotes', () => {
	it('names the units that fell back to the catchment rain, held factors, a short CHIRPS mean and raw CHIRPS', () => {
		expect(unitRainNotes(result([unit()]))).toEqual([]);
		const notes = unitRainNotes(
			result([
				unit({ nodeId: 'a', name: 'A', rule: 'catchment', factor: null, factorSource: 'catchment' }),
				unit({ nodeId: 'b', name: 'B', rule: 'catchment', factor: null, factorSource: 'catchment' }),
				unit({ nodeId: 'c', name: 'C', gaugeMapClamped: true }),
				unit({ nodeId: 'd', name: 'D', rule: 'unitChirps', factorSource: 'chirpsMap', chirps: { source: 'map', factor: 1.1, clamped: false, ownFactor: 1.1, meanAnnualMm: 700, years: [2001, 2002, 2003], inPeriod: false, outsideBand: false } }),
				unit({ nodeId: 'e', name: 'E', rule: 'unitChirps', factor: null, factorSource: 'chirpsRaw', chirps: { source: 'raw' } })
			])
		);
		expect(notes[0]).toBe('A, B have no rain of their own (no gauge, and no CHIRPS feed or MAP to scale by), so they run on the catchment rain.');
		expect(notes[1]).toBe('C: the factor was held at the 0.25–4 bound; check its MAP and the gauge’s.');
		expect(notes[2]).toMatch(/^D: too few complete years .* over 3 years of the record\.$/);
		expect(notes[3]).toMatch(/^E: its CHIRPS is used as published/);
		expect(unitRainNotes(result([unit({ name: 'Solo', rule: 'catchment' })]))[0]).toMatch(/^Solo has no rain of its own .* so it runs on/);
	});
});

describe('sortResultUnits', () => {
	it('puts the units that fell back first, then held factors, keeping the run’s order otherwise', () => {
		const order = sortResultUnits([
			unit({ nodeId: 'a', name: 'A' }),
			unit({ nodeId: 'b', name: 'B', gaugeMapClamped: true }),
			unit({ nodeId: 'c', name: 'C', rule: 'catchment' }),
			unit({ nodeId: 'd', name: 'D' })
		]).map((u) => u.name);
		expect(order).toEqual(['C', 'B', 'A', 'D']);
	});

	it('follows the run’s farm order within a rank, not the engine’s node-id order; a unit it doesn’t name goes last', () => {
		const units = [unit({ nodeId: 'a', name: 'A' }), unit({ nodeId: 'b', name: 'B' }), unit({ nodeId: 'c', name: 'C' }), unit({ nodeId: 'x', name: 'X', gaugeMapClamped: true })];
		expect(sortResultUnits(units, ['c', 'x', 'a']).map((u) => u.name)).toEqual(['X', 'C', 'A', 'B']);
	});
});

describe('UnitRainPanel', () => {
	it('lists each unit’s rule, factor, MAP, rain and runoff, with the notes and the days by source', () => {
		const { body: html } = render(UnitRainPanel, { props: { result: result([unit(), unit({ nodeId: 'u2', name: 'Lower unit', rule: 'catchment', factor: null, factorSource: 'catchment', mapMm: null, mapSource: null, runoffCoefficient: null })]) } });
		// Without Svelte's hydration markers, so a sentence reads as one string.
		const body = withoutComments(html);
		expect(body).toContain('Rain for each unit');
		expect(body).toContain('MAP period 1991–2020; rain gauge’s MAP 656 mm (gauge record)');
		expect(body).toContain('Catchment gauge × MAP ratio');
		expect(body).toContain('× 1.25, unit MAP ÷ gauge MAP');
		expect(body).toContain('Catchment rain (fallback)');
		expect(body).toContain('Lower unit has no rain of its own');
		expect(body).toContain('<strong>Upper unit</strong>: a synthetic MAP grid');
		// The unit that fell back comes first.
		expect(body.indexOf('Lower unit')).toBeLessThan(body.indexOf('Upper unit'));
		expect(body).toContain('Days by where the rain came from');
		expect((body.match(/data-testid="run-unit-rain-row"/g) ?? []).length).toBe(2);
	});

	it('folds a long list of units behind Show all', () => {
		const many = Array.from({ length: 12 }, (_, i) => unit({ nodeId: `u${i}`, name: `Unit ${i + 1}` }));
		const { body } = render(UnitRainPanel, { props: { result: result(many) } });
		expect((body.match(/data-testid="run-unit-rain-row"/g) ?? []).length).toBe(8);
		expect(body).toContain('Show all 12 units');
	});
});

describe('the warning band and unusable CHIRPS (issue #500 answers 2 and 7a)', () => {
	it('tags a factor outside 0.5–2 but inside the clamp, by the rule that used it, and a held one only as held', () => {
		const wide = unit({ gaugeMapFactor: 2.4, gaugeMapOwnFactor: 2.4, factor: 2.4, gaugeMapOutsideBand: true });
		expect(factorOutsideBand(wide)).toBe(true);
		expect(factorClamped(wide)).toBe(false);
		expect(factorOutsideBand(unit({ gaugeMapOutsideBand: true, gaugeMapClamped: true }))).toBe(false);
		expect(factorOutsideBand(unit({ rule: 'catchment', gaugeMapOutsideBand: true }))).toBe(false);
		const map = unit({ rule: 'unitChirps', factorSource: 'chirpsMap', chirps: { source: 'map', factor: 0.4, clamped: false, ownFactor: 0.4, meanAnnualMm: 1500, years: [2001], inPeriod: true, outsideBand: true } });
		expect(factorOutsideBand(map)).toBe(true);
		expect(unitRainNotes(result([wide, { ...map, nodeId: 'm', name: 'M' }]))).toEqual([
			'Upper unit: its level factor, 2.4, is outside 0.5–2; it is used, but check its MAP and the gauge’s.',
			'M: its level factor, 0.4, is outside 0.5–2; it is used, but check its MAP.'
		]);
		// Held first, then outside the band, then the rest.
		const order = sortResultUnits([unit({ nodeId: 'a', name: 'A' }), { ...wide, nodeId: 'w', name: 'W' }, unit({ nodeId: 'h', name: 'H', gaugeMapClamped: true })]).map((u) => u.name);
		expect(order).toEqual(['H', 'W', 'A']);
	});

	it('says a unit skipped its CHIRPS as unusable, and what it ran on instead, first in the list', () => {
		const broken = unit({ nodeId: 'b', name: 'Broken', chirps: { source: 'unusable', meanAnnualMm: 0, years: [2001, 2002, 2003] } });
		expect(unitRainNotes(result([broken]))).toEqual([
			'Broken: its CHIRPS averages 0 mm a year over 3 complete years, so it looks broken and is not used: the unit runs on the catchment gauge × its MAP ratio instead. Check its feed.'
		]);
		expect(unitRainNotes(result([{ ...broken, rule: 'catchment', chirps: { source: 'unusable', meanAnnualMm: 0, years: [2001] } }]))[1]).toMatch(/over 1 complete year, .* runs on the catchment rain instead/);
		expect(sortResultUnits([unit({ nodeId: 'a', name: 'A', gaugeMapClamped: true }), broken]).map((u) => u.name)).toEqual(['Broken', 'A']);
	});
});

describe('the reference gauge (issue #500)', () => {
	const month = (m: number, over = {}) => ({ month: m, sharedDays: 120, gaugeMm: 400, chirpsMm: 200, ownFactor: 2, factor: 2, clamped: false, fitted: true, outsideBand: false, ...over });
	const reference = {
		gauge: 'rain_catchment_mm',
		unitId: 'u0',
		unitName: 'Gauge unit',
		mapMm: 600,
		cellKey: 'rain_chirps_cell_mm@u0',
		cellReason: 'referenceUnitCentre' as const,
		gaugeChecked: true,
		pinned: false,
		months: [
			month(1, { factor: 1, ownFactor: null, fitted: false }),
			month(2, { factor: 4, ownFactor: 5.5, clamped: true, outsideBand: true }),
			month(3, { factor: 2.5, ownFactor: 2.5, outsideBand: true }),
			...Array.from({ length: 9 }, (_, i) => month(i + 4))
		]
	};
	const kUnit = { factor: 1.3, ownFactor: 1.3, clamped: false, outsideBand: false, meanAnnualMm: 631, years: Array.from({ length: 30 }, (_, i) => 1991 + i), inPeriod: true };
	const levelled = unit({ rule: 'unitChirps', rainKey: 'rain_chirps_mm@u1', factor: null, factorSource: 'chirpsReference', chirps: { source: 'reference', factors: Array(12).fill(2), kUnit } });

	it('says a unit’s level as k_unit on the monthly factors, and holds a clamped or wide k_unit', () => {
		expect(factorText(levelled)).toBe('the reference gauge’s monthly factors × 1.3 (k_unit: unit MAP ÷ its CHIRPS × factors, 631 mm a year)');
		expect(factorClamped(levelled)).toBe(false);
		expect(factorOutsideBand(levelled)).toBe(false);
		const held = unit({ ...levelled, chirps: { source: 'reference', factors: Array(12).fill(2), kUnit: { ...kUnit, factor: 4, ownFactor: 5, clamped: true, outsideBand: true } } });
		expect(factorClamped(held)).toBe(true);
		expect(factorOutsideBand(held)).toBe(false);
		const wide = unit({ ...levelled, chirps: { source: 'reference', factors: Array(12).fill(2), kUnit: { ...kUnit, factor: 2.2, ownFactor: 2.2, outsideBand: true } } });
		expect(factorOutsideBand(wide)).toBe(true);
		expect(unitRainNotes(result([wide]))).toEqual(['Upper unit: its level factor, 2.2, is outside 0.5–2; it is used, but check its MAP.']);
	});

	it('without a complete year, the factors alone, saying so; a k_unit from outside the MAP period says that', () => {
		const none = unit({ ...levelled, chirps: { source: 'reference', factors: Array(12).fill(2), kUnit: null } });
		expect(factorText(none)).toBe('the reference gauge’s monthly factors, not rescaled (no complete year of CHIRPS yet)');
		expect(unitRainNotes(result([none]))).toEqual(['Upper unit: its CHIRPS has no complete year yet, so it has the reference gauge’s monthly factors but is not rescaled to its MAP.']);
		const short = unit({ ...levelled, chirps: { source: 'reference', factors: Array(12).fill(2), kUnit: { ...kUnit, years: [2001, 2002], inPeriod: false } } });
		expect(unitRainNotes(result([short]))).toEqual(['Upper unit: too few complete years of CHIRPS in the MAP period, so its k_unit was taken over 2 years of the record.']);
	});

	it('shows a run from engine 1.80–1.83 as it ran: the reference unit’s MAP ratio', () => {
		const old = unit({ ...levelled, chirps: { source: 'reference', factors: Array(12).fill(2), mapRatio: 1.5, mapOwnRatio: 5, mapClamped: true } as never });
		expect(factorText(old)).toBe('the reference gauge’s monthly factors × 1.5 (unit MAP ÷ the reference unit’s MAP)');
		expect(factorClamped(old)).toBe(true);
		const { cellReason: _c, gaugeChecked: _g, ...oldRef } = reference;
		void _c;
		void _g;
		expect(referenceFitText(oldRef)).toBeNull();
		const body = withoutComments(render(UnitRainPanel, { props: { result: { ...result([old]), reference: oldRef as never } } }).body);
		expect(body).toMatch(/levelled by the reference gauge \(the catchment rain gauge, compared with the CHIRPS cell of Gauge unit\): Jan 1, Feb 4/);
	});

	it('lists the factors, and notes the months with factor 1, the held ones and those outside 0.5–2', () => {
		const r = { ...result([levelled]), reference };
		expect(referenceFactorsText(r)).toMatch(/^Jan 1, Feb 4, Mar 2.5, Apr 2/);
		expect(referenceFactorsText(result([levelled]))).toBeNull();
		const notes = unitRainNotes(r);
		expect(notes).toContain('Reference gauge: Jan shares too little record with the CHIRPS cell (90 days, and 50 mm of CHIRPS on them), so its factor is 1.');
		expect(notes).toContain('Reference gauge: the factor for Feb was held at the 0.25–4 bound; check the gauge and the cell describe the same rain.');
		// Feb is held, so said once, as held.
		expect(notes).toContain('Reference gauge: the factor for Mar is outside 0.5–2; it is used as fitted, but check the gauge and the cell describe the same rain.');
		const none = { ...r, reference: { ...reference, months: reference.months.map((m) => ({ ...m, factor: 1, fitted: false, clamped: false, outsideBand: false })) } };
		expect(unitRainNotes(none)[0]).toBe('Reference gauge: no month shares enough record with the CHIRPS cell (90 days, and 50 mm of CHIRPS on them), so every factor is 1.');
		expect(unitRainNotes({ ...r, reference: { ...reference, pinned: true } }).some((n) => n.startsWith('Reference gauge'))).toBe(false);
	});

	it('says which cell the fit read and why, and whether against the checked gauge rain', () => {
		expect(referenceFitText(reference)).toBe(
			'They were fitted against the checked gauge rain, at the CHIRPS cell under the reference unit’s centre (Gauge unit); rain gauges have no map location yet.'
		);
		expect(referenceFitText({ ...reference, gaugeChecked: false })).toMatch(/^They were fitted against the gauge rain as recorded, at/);
		expect(referenceFitText({ ...reference, pinned: true })).toBe('The pinned factors are for the CHIRPS cell under the reference unit’s centre (Gauge unit); rain gauges have no map location yet.');
	});

	it('the panel names the reference, its factors, the fit’s cell and k_unit', () => {
		const body = withoutComments(render(UnitRainPanel, { props: { result: { ...result([levelled]), reference } } }).body);
		expect(body).toContain('data-testid="run-unit-rain-reference"');
		expect(body).toMatch(/levelled by the reference gauge, the catchment rain gauge: Jan 1, Feb 4, Mar 2\.5/);
		expect(body).toContain('fitted against the checked gauge rain, at the CHIRPS cell under the reference unit’s centre (Gauge unit); rain gauges have no map location yet.');
		expect(body).toMatch(/rescaled to its own MAP\s+\(k_unit\)/);
		expect(withoutComments(render(UnitRainPanel, { props: { result: result([unit()]) } }).body)).not.toContain('run-unit-rain-reference');
	});

	it('the panel tags a factor outside the band', () => {
		const body = withoutComments(render(UnitRainPanel, { props: { result: result([unit({ gaugeMapOutsideBand: true, gaugeMapOwnFactor: 2.3, factor: 2.3 })]) } }).body);
		expect(body).toMatch(/<strong class="tag[^"]*">outside 0.5–2<\/strong>/);
	});
});
