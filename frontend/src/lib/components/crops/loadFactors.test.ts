import type { CropDef, NetworkNode, ProjectModel } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { CROP_LIBRARY } from './library';
import { applyChanges, b023CropWarnings, cropChanges, defaultKp, demandDifference, isKp, kpForShape, matchByName, nameTokens, nodeWarningText, pctChange, shapeOf, SOURCE_KINDS, withKp } from './loadFactors';

describe('matchByName', () => {
	const lib = CROP_LIBRARY.map((c) => ({ id: c.id, name: c.name }));
	const crops = (...names: string[]) => names.map((name, i) => ({ id: `c${i}`, name }));

	it('matches the same name, ignoring case, accents, punctuation and a plural s', () => {
		expect(nameTokens('Pecans')).toEqual(['pecan']);
		expect(nameTokens('Citrus')).toEqual(['citrus']); // "us", not a plural
		expect(nameTokens('Grass')).toEqual(['grass']);
		expect(nameTokens('Pâturage, mixed!')).toEqual(['paturage', 'mixed']);
		const m = matchByName(crops('citrus', 'ONIONS', 'Pasture - Kikuyu', 'Table grapes'), lib);
		expect([...m.values()]).toEqual(['citrus', 'onions', 'pasture-kikuyu', 'table-grapes']);
	});

	it("matches when one name's words hold the other's, only when that is unique", () => {
		const m = matchByName(crops('Pecan', 'Lucerne', 'Guavas', 'Potatoes', 'Wine grapes', 'Pasture'), lib);
		// Pecan ⊂ "Pecan nuts"; Lucerne ⊂ "Alfalfa (lucerne) …"; potatoes has four plantings, wine grapes three, pasture two.
		expect([...m.values()]).toEqual(['pecan', 'alfalfa', 'guavas', null, null, null]);
	});

	it('keeps the current factors for a crop with no match, or no name', () => {
		const m = matchByName(crops('Orchard', 'Stone fruit', ''), lib);
		expect([...m.values()]).toEqual([null, null, null]);
	});
});

describe('withKp', () => {
	it('multiplies by the pan coefficient without float dust', () => {
		expect(withKp([1.1, 0.4, 0], 0.75)).toEqual([0.825, 0.3, 0]);
		expect(withKp([0.1, 0.2], 3)).toEqual([0.3, 0.6]);
		expect(withKp([0.55], 1)).toEqual([0.55]);
	});
});

describe('the pan coefficient default by source shape', () => {
	it('is 1 for A-pan factors and 0.75 (mid FAO-56 Table 5, 0.35–0.85) for FAO-56 Kc against ET₀', () => {
		expect(defaultKp('a-pan')).toBe(1);
		expect(defaultKp('fao-et0')).toBe(0.75);
		const k = defaultKp('fao-et0');
		expect(k).toBeGreaterThanOrEqual(0.35);
		expect(k).toBeLessThanOrEqual(0.85);
	});

	it('gives the library and a b023 workbook, both A-pan tables, the A-pan shape, and the node-based set FAO-56 Kc; every kind has one', () => {
		expect(shapeOf('library')).toBe('a-pan');
		expect(shapeOf('b023')).toBe('a-pan');
		expect(shapeOf('node')).toBe('fao-et0');
		expect(defaultKp(shapeOf('node'))).toBe(0.75);
		expect(new Set(SOURCE_KINDS.map((k) => k.id)).size).toBe(SOURCE_KINDS.length);
		for (const k of SOURCE_KINDS) expect(['a-pan', 'fao-et0']).toContain(k.shape);
	});

	it("re-applies the new shape's default while Kp is still the previous default", () => {
		expect(kpForShape(1, 1, 'fao-et0')).toBe(0.75);
		expect(kpForShape(0.75, 0.75, 'a-pan')).toBe(1);
		expect(kpForShape(1, 1, 'a-pan')).toBe(1);
	});

	it('keeps a Kp the modeller typed, and never clobbers it on a change of source', () => {
		expect(kpForShape(0.6, 1, 'fao-et0')).toBe(0.6);
		expect(kpForShape(0.6, 0.75, 'a-pan')).toBe(0.6);
		// Their own value that happens to be the new default stays too.
		expect(kpForShape(0.75, 1, 'fao-et0')).toBe(0.75);
	});

	it('isKp compares within float dust; a blank Kp is no value', () => {
		expect(isKp(0.75, 0.75)).toBe(true);
		expect(isKp(0.1 + 0.2, 0.3)).toBe(true);
		expect(isKp(0.8, 0.75)).toBe(false);
		expect(isKp(null, 1)).toBe(false);
	});

	it('treats a blank or invalid Kp as unset: it takes the default', () => {
		expect(kpForShape(null, 1, 'fao-et0')).toBe(0.75);
		expect(kpForShape(0, 1, 'fao-et0')).toBe(0.75);
		expect(kpForShape(-1, 0.75, 'a-pan')).toBe(1);
	});
});

describe('the workbook warnings the dialog lists', () => {
	it("keeps a b023 import's crop-table notes only, without the WARNING: prefix", () => {
		const notes = [
			{ code: 'crop-factors-copied', message: "WARNING: [Crop demand] crop Pasture F: its 12 factors are the same as Pasture C's" },
			{ code: 'non-numeric-value', message: 'WARNING: [Dams] something else' },
			{ code: 'crop-factors-suspect', message: 'WARNING: [Crop demand] crop Fodder E: Dec factor is 0' },
			{ code: 'missing-crop', message: '[Farm demand] crop Hops X is not in [Crop demand]; ignored' }
		];
		expect(b023CropWarnings(notes)).toEqual(["[Crop demand] crop Pasture F: its 12 factors are the same as Pasture C's", '[Crop demand] crop Fodder E: Dec factor is 0']);
		expect(b023CropWarnings([])).toEqual([]);
	});

	it('adds the cell to a node-based warning that names one', () => {
		expect(nodeWarningText({ message: 'Olives Nov factor is not a number (n/a); read as 0.', sheet: 'Crop_Factors', cell: 'C9' })).toBe(
			'Olives Nov factor is not a number (n/a); read as 0. ([Crop_Factors] C9)'
		);
		expect(nodeWarningText({ message: 'The workbook has no [Crop_Areas] sheet.', sheet: 'Crop_Areas' })).toBe('The workbook has no [Crop_Areas] sheet.');
		expect(nodeWarningText({ message: 'x', cell: 'B2' })).toBe('x (B2)');
	});
});

const crop = (id: string, f: number, extra: Partial<CropDef> = {}): CropDef => ({ id, name: id.toUpperCase(), cropFactor: new Array(12).fill(f), ...extra });

describe('cropChanges and applyChanges', () => {
	const crops = [crop('a', 0.5), crop('b', 0.4, { irrigationEfficiency: 0.8 }), crop('c', 0.3)];

	it('diffs month by month, and the efficiency, for crops with a choice only', () => {
		const next = [...new Array(11).fill(0.5), 0.6];
		const changes = cropChanges(
			crops,
			new Map([
				['a', { factors: next }],
				['b', { factors: null, efficiency: 0.9 }]
			])
		);
		expect(changes.map((c) => c.cropId)).toEqual(['a', 'b']);
		expect(changes[0]!.changed).toEqual([...new Array(11).fill(false), true]);
		expect(changes[0]!).toMatchObject({ currentEfficiency: null, nextEfficiency: null, differs: true });
		expect(changes[1]!).toMatchObject({ next: new Array(12).fill(0.4), currentEfficiency: 0.8, nextEfficiency: 0.9, differs: true });
		expect(changes[1]!.changed.some(Boolean)).toBe(false);
	});

	it('says when a choice changes nothing', () => {
		const [c] = cropChanges(crops, new Map([['b', { factors: new Array(12).fill(0.4), efficiency: 0.8 }]]));
		expect(c!.differs).toBe(false);
	});

	it('applies only the accepted changes, leaving the other crops untouched', () => {
		const changes = cropChanges(
			crops,
			new Map([
				['a', { factors: new Array(12).fill(0.25), efficiency: 0.9 }],
				['c', { factors: new Array(12).fill(0.1) }]
			])
		);
		const out = applyChanges(crops, changes.filter((c) => c.cropId === 'a'));
		expect(out[0]).toEqual({ id: 'a', name: 'A', cropFactor: new Array(12).fill(0.25), irrigationEfficiency: 0.9 });
		expect(out[1]).toBe(crops[1]);
		expect(out[2]).toBe(crops[2]);
		expect(crops[0]!.cropFactor[0]).toBe(0.5); // the input isn't mutated
	});
});

describe('demandDifference', () => {
	const farm = (id: string, e: number) => ({ id, name: id.toUpperCase(), kind: 'farm', irrigationEfficiency: e }) as unknown as NetworkNode;
	const model: ProjectModel = {
		nodes: [farm('f1', 0.8), farm('f2', 0.5)],
		crops: [crop('a', 0.5)],
		cropAreas: [{ nodeId: 'f1', cropId: 'a', areaM2: 100_000 }],
		transfers: []
	};
	const apan = new Array(12).fill(100);

	it('recomputes a small case by hand: half the factor is half the demand; a crop efficiency changes the abstraction', () => {
		const next = applyChanges(model.crops, cropChanges(model.crops, new Map([['a', { factors: new Array(12).fill(0.25), efficiency: 0.9 }]])));
		const d = demandDifference(model, next, apan, 28.25, ['f1', 'f2']);
		// 10 ha × 100 mm × 0.5 = 5 000 m³ a month, 60 000 m³ a year over 365.25 days.
		const now = 60_000 / 365.25;
		expect(d.rows[0]!.gross[0]).toBeCloseTo(now, 9);
		expect(d.rows[0]!.gross[1]).toBeCloseTo(now / 2, 9);
		expect(d.rows[0]!.abstraction[0]).toBeCloseTo(now / 0.8, 9);
		expect(d.rows[0]!.abstraction[1]).toBeCloseTo(now / 2 / 0.9, 9);
		expect(d.rows[1]).toEqual({ nodeId: 'f2', name: 'F2', gross: [0, 0], abstraction: [0, 0] });
		expect(d.total.gross[1]).toBeCloseTo(now / 2, 9);
		// October: 10 ha × 25 mm ÷ 31 days.
		expect(d.monthly[0][0]).toBeCloseTo(5000 / 31, 9);
		expect(d.monthly[1][0]).toBeCloseTo(2500 / 31, 9);
		expect(pctChange(d.total.gross)).toBe('−50 %');
	});

	it('runs a farm efficiency outside (0, 1] as 1, as the engine does', () => {
		const bad = { ...model, nodes: [farm('f1', 0)] };
		const d = demandDifference(bad, bad.crops, apan, 28.25, ['f1']);
		expect(d.rows[0]!.abstraction[0]).toBeCloseTo(d.rows[0]!.gross[0], 9);
	});
});

describe('pctChange', () => {
	it('rounds to whole percent with a real minus sign', () => {
		expect(pctChange([100, 72])).toBe('−28 %');
		expect(pctChange([100, 104.4])).toBe('+4 %');
		expect(pctChange([100, 100.2])).toBe('±0 %');
		expect(pctChange([0, 0])).toBe('–');
		expect(pctChange([0, 5])).toBe('new');
	});
});
