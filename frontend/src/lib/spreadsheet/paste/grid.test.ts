import { describe, expect, it } from 'vitest';
import { csvCell, headingKeys, isBlockPaste, mapPaste, normalName, toCsv } from './grid';

const rows = [
	{ id: 'u', name: 'Upper farm' },
	{ id: 'l', name: 'Lower farm' },
	{ id: 'g', name: 'Outflow gauge' }
];
const cols = [
	{ key: 'a', labels: ['Area', 'Size'] },
	{ key: 'c', labels: ['Dam capacity', 'Capacity'] },
	{ key: 'p', labels: ['Efficiency'] }
];
const ok = (r: ReturnType<typeof mapPaste>) => {
	if ('error' in r) throw new Error(r.error);
	return r;
};

describe('mapPaste', () => {
	it('matches rows by name and columns by heading, in any order, ignoring case and units', () => {
		const r = ok(mapPaste('Name\tEfficiency (%)\tarea (km²)\nlower FARM\t80\t9,5\nUpper farm\t75%\t12', rows, cols));
		expect(r.values).toEqual([
			{ rowId: 'l', key: 'p', value: 80 },
			{ rowId: 'l', key: 'a', value: 9.5 },
			{ rowId: 'u', key: 'p', value: 75 },
			{ rowId: 'u', key: 'a', value: 12 }
		]);
		expect(r.notes).toContain('Matched 2 rows by name.');
		expect(r.notes).toContain('Decimal commas were read as decimal points (1,207 = 1.207).');
	});

	it('leaves out headings and names the grid does not have, and says so', () => {
		const r = ok(mapPaste('Farm\tArea\tTotal\nUpper farm\t1\t9\nNew farm\t2\t9', rows, cols, { nameHeadings: ['Farm'] }));
		expect(r.values).toEqual([{ rowId: 'u', key: 'a', value: 1 }]);
		expect(r.notes).toEqual(["Left out a column the table doesn't have: Total.", 'Matched 1 row by name.', "Left out a row the table doesn't have: New farm."]);
	});

	it('without names or headings, fills from the anchor cell in the grid’s order', () => {
		const r = ok(mapPaste('5\t6\n7\t8', rows, cols, { anchor: { row: 1, col: 1 } }));
		expect(r.values).toEqual([
			{ rowId: 'l', key: 'c', value: 5 },
			{ rowId: 'l', key: 'p', value: 6 },
			{ rowId: 'g', key: 'c', value: 7 },
			{ rowId: 'g', key: 'p', value: 8 }
		]);
	});

	it('with names but no headings, the values start at the anchor’s column', () => {
		const r = ok(mapPaste('Lower farm\t5\t6', rows, cols, { anchor: { row: 0, col: 1 } }));
		expect(r.values).toEqual([
			{ rowId: 'l', key: 'c', value: 5 },
			{ rowId: 'l', key: 'p', value: 6 }
		]);
	});

	it('a blank or a dash leaves a value; a CSV export’s formula guard is dropped from a name', () => {
		const r = ok(mapPaste("Name,Area,Capacity\n'-Upper farm,,–\nLower farm,-,3", [{ id: 'u', name: '-Upper farm' }, ...rows.slice(1)], cols));
		expect(r.values).toEqual([{ rowId: 'l', key: 'c', value: 3 }]);
	});

	it('stops on a value that is not a number, naming its row and column', () => {
		expect(mapPaste('Upper farm\t1\tlots', rows, cols)).toEqual({ error: 'Upper farm, Dam capacity: “lots” isn\'t a number.' });
	});

	it('stops when the block runs off the grid', () => {
		expect('error' in mapPaste('1\t2\t3\t4', rows, cols)).toBe(true);
		expect(mapPaste('1\n2\n3', rows, cols, { anchor: { row: 1, col: 0 } })).toEqual({
			error: 'The paste has 3 rows, but the table has 2 rows from Lower farm down. Put the names in the first column to paste rows in any order.'
		});
	});

	it('stops on a name twice, and when no name matches', () => {
		expect(mapPaste('Upper farm\t1\nupper farm\t2', rows, cols)).toEqual({ error: 'upper farm appears twice in the paste.' });
		expect('error' in mapPaste('Nowhere\t1', rows, cols)).toBe(true);
	});

	it('leaves out a name two rows share, and a heading two columns share', () => {
		const twins = [...rows, { id: 'u2', name: 'Upper farm' }];
		const r = ok(mapPaste('Lower farm\t1\nUpper farm\t2', twins, cols));
		expect(r.values).toEqual([{ rowId: 'l', key: 'a', value: 1 }]);
		expect(r.notes.at(-1)).toBe('Left out Upper farm: two rows of the table have that name.');
		const crops = [
			{ key: 'x', labels: ['Citrus'] },
			{ key: 'y', labels: ['Citrus'] },
			{ key: 'z', labels: ['Vines'] }
		];
		const h = ok(mapPaste('Farm\tCitrus\tVines\nLower farm\t1\t2', rows, crops, { nameHeadings: ['Farm'] }));
		expect(h.values).toEqual([{ rowId: 'l', key: 'z', value: 2 }]);
	});

	it('never reads 300,000 quietly as 300: thousands when the block shows it, else it asks', () => {
		const g = ok(mapPaste('Name\tDam capacity\nUpper farm\t1,500,000\nLower farm\t300,000', rows, cols));
		expect(g.values.map((v) => v.value)).toEqual([1500000, 300000]);
		expect(g.notes).toContain('Commas were read as thousands separators (1,500,000 = 1500000).');
		expect(mapPaste('Name\tDam capacity\nUpper farm\t300,000', rows, cols)).toEqual({
			error: 'Is “300,000” 300 000 or 300? Remove the separator (300000) or write the decimal with a point.'
		});
		expect('error' in mapPaste('Name\tArea\tDam capacity\nUpper farm\t12,5\t1,500,000', rows, cols)).toBe(true);
	});

	it('refuses an empty paste', () => {
		expect(mapPaste(' \n', rows, cols)).toEqual({ error: 'Paste the block of cells first.' });
	});
});

describe('normalName and headingKeys', () => {
	it('names keep their brackets; a heading also matches without its last bracket (the unit)', () => {
		expect(normalName(' Farm  A (East) ')).toBe('farm a (east)');
		expect(normalName('High\u2011MAP')).toBe('high-map');
		expect(headingKeys('Dam Capacity (m³)')).toEqual(['dam capacity (m³)', 'dam capacity']);
		expect(headingKeys('Maize (white) (ha)')).toEqual(['maize (white) (ha)', 'maize (white)']);
		expect(headingKeys('Area')).toEqual(['area']);
	});

	it('tells apart rows and columns whose names differ only in brackets', () => {
		const twins = [
			{ id: 'e', name: 'Farm A (east)' },
			{ id: 'w', name: 'Farm A (west)' }
		];
		const maize = [
			{ key: 'mw', labels: ['Maize (white)'] },
			{ key: 'my', labels: ['Maize (yellow)'] }
		];
		const r = ok(mapPaste('Farm\tMaize (yellow) (ha)\tMaize (white)\nFarm A (west)\t1\t2\nfarm a (east)\t3\t4', twins, maize, { nameHeadings: ['Farm'] }));
		expect(r.values).toEqual([
			{ rowId: 'w', key: 'my', value: 1 },
			{ rowId: 'w', key: 'mw', value: 2 },
			{ rowId: 'e', key: 'my', value: 3 },
			{ rowId: 'e', key: 'mw', value: 4 }
		]);
		// A bare "Farm A" is neither of them.
		expect('error' in mapPaste('Farm A\t1', twins, maize)).toBe(true);
	});
});

describe('CSV', () => {
	it('quotes, defuses formulas and writes plain numbers', () => {
		expect(csvCell('Smith, J')).toBe('"Smith, J"');
		expect(csvCell('=1+1')).toBe("'=1+1");
		expect(csvCell(0.7 * 100)).toBe('70');
		expect(csvCell(-5)).toBe('-5');
		expect(csvCell(null)).toBe('');
		expect(toCsv([['a', 1], ['b', null]])).toBe('a,1\r\nb,\r\n');
	});
});

describe('isBlockPaste', () => {
	it('is more than one cell; a single value copied with its line break is not', () => {
		expect(isBlockPaste('12\r\n')).toBe(false);
		expect(isBlockPaste('12')).toBe(false);
		expect(isBlockPaste('12\t13')).toBe(true);
		expect(isBlockPaste('12\n13')).toBe(true);
	});
});
