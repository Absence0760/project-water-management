// Runs & results → Rain for each unit (issue #482): reading summary.unitRain
// defensively, and each unit's rule, factor and what to check, in words.
import { render } from 'svelte/server';
import { describe, expect, it, vi } from 'vitest';
import UnitRainPanel from './UnitRainPanel.svelte';
import { factorClamped, factorText, periodText, referenceFactorsText, sortResultUnits, unitRainNotes, unitRainOf, type UnitRainResult, type UnitRainResultUnit } from './unitRain';
import { withoutComments } from '../__fixtures__/withoutComments';

vi.mock('$app/paths', () => ({ base: '' }));

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
		expect(factorClamped(unit({ rule: 'unitChirps', chirps: { source: 'map', factor: 4, clamped: true, ownFactor: 4.6, meanAnnualMm: 200, years: [2001], inPeriod: true } }))).toBe(true);
	});

	it('writes the MAP period as years', () => {
		expect(periodText({ start: '1991-01-01', end: '2020-12-31' })).toBe('1991–2020');
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
				unit({ nodeId: 'd', name: 'D', rule: 'unitChirps', factorSource: 'chirpsMap', chirps: { source: 'map', factor: 1.1, clamped: false, ownFactor: 1.1, meanAnnualMm: 700, years: [2001, 2002, 2003], inPeriod: false } }),
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

describe('the reference gauge (engine ≥ 1.80.0, issue #500)', () => {
	const month = (m: number, over = {}) => ({ month: m, sharedDays: 120, gaugeMm: 400, chirpsMm: 200, ownFactor: 2, factor: 2, clamped: false, fitted: true, ...over });
	const reference = {
		gauge: 'rain_catchment_mm',
		unitId: 'u0',
		unitName: 'Gauge unit',
		mapMm: 600,
		cellKey: 'rain_chirps_cell_mm@u0',
		pinned: false,
		months: [month(1, { factor: 1, ownFactor: null, fitted: false }), month(2, { factor: 4, ownFactor: 5.5, clamped: true }), ...Array.from({ length: 10 }, (_, i) => month(i + 3))]
	};
	const levelled = unit({ rule: 'unitChirps', rainKey: 'rain_chirps_mm@u1', factor: null, factorSource: 'chirpsReference', chirps: { source: 'reference', factors: Array(12).fill(2), mapRatio: 1.5, mapOwnRatio: 1.5, mapClamped: false } });

	it('says a unit’s factor as the MAP ratio on the monthly factors, and holds a clamped ratio', () => {
		expect(factorText(levelled)).toBe('the reference gauge’s monthly factors × 1.5 (unit MAP ÷ the reference unit’s MAP)');
		expect(factorClamped(levelled)).toBe(false);
		expect(factorClamped({ ...levelled, chirps: { source: 'reference', factors: Array(12).fill(2), mapRatio: 4, mapOwnRatio: 5, mapClamped: true } })).toBe(true);
	});

	it('lists the factors, and notes the months with factor 1 and the held ones', () => {
		const r = { ...result([levelled]), reference };
		expect(referenceFactorsText(r)).toMatch(/^Jan 1, Feb 4, Mar 2, Apr 2/);
		expect(referenceFactorsText(result([levelled]))).toBeNull();
		const notes = unitRainNotes(r);
		expect(notes).toContain('Reference gauge: Jan shares too little record with the CHIRPS cell (90 days, and 50 mm of CHIRPS on them), so its factor is 1.');
		expect(notes).toContain('Reference gauge: the factor for Feb was held at the 0.25–4 bound; check the gauge and the cell describe the same rain.');
		const none = { ...r, reference: { ...reference, months: reference.months.map((m) => ({ ...m, factor: 1, fitted: false, clamped: false })) } };
		expect(unitRainNotes(none)[0]).toBe('Reference gauge: no month shares enough record with the CHIRPS cell (90 days, and 50 mm of CHIRPS on them), so every factor is 1.');
		expect(unitRainNotes({ ...r, reference: { ...reference, pinned: true } }).some((n) => n.startsWith('Reference gauge'))).toBe(false);
	});

	it('the panel names the reference and its factors', () => {
		const body = withoutComments(render(UnitRainPanel, { props: { result: { ...result([levelled]), reference } } }).body);
		expect(body).toContain('data-testid="run-unit-rain-reference"');
		expect(body).toMatch(/levelled by the reference gauge \(the catchment rain gauge, compared with the CHIRPS\s+cell of Gauge unit\): Jan 1, Feb 4, Mar 2/);
		expect(withoutComments(render(UnitRainPanel, { props: { result: result([unit()]) } }).body)).not.toContain('run-unit-rain-reference');
	});
});
