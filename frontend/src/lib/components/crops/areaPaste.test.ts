import { describe, expect, it } from 'vitest';
import { applyAreaPaste, plantedAreasCsv, planAreaPaste } from './areaPaste';

const farms = [
	{ id: 'u', name: 'Upper farm' },
	{ id: 'l', name: 'Lower farm' }
];
const crops = [
	{ id: 'c', name: 'Citrus' },
	{ id: 'v', name: 'Vines' }
];
const areas = () => [
	{ nodeId: 'u', cropId: 'c', areaM2: 200_000 },
	{ nodeId: 'l', cropId: 'v', areaM2: 50_000 }
];
const plan = (r: ReturnType<typeof planAreaPaste>) => {
	if ('error' in r) throw new Error(r.error);
	return r;
};

describe('planAreaPaste', () => {
	it('reads hectares by farm name and crop heading, and writes m²', () => {
		const p = plan(planAreaPaste('Farm\tVines (ha)\tCitrus (ha)\tTotal\nLower farm\t5\t2,5\t7,5\nUpper farm\t0\t20', farms, crops, areas()));
		expect(p.changes).toEqual([
			{ rowId: 'l', rowName: 'Lower farm', key: 'c', column: 'Citrus', unit: 'ha', from: 0, to: 2.5 }
		]);
		expect(p.unchanged).toBe(3);
		expect(p.notes[0]).toBe("Left out a column the table doesn't have: Total.");
		const set: [string, string, number][] = [];
		applyAreaPaste(p, (n, c, m2) => set.push([n, c, m2]));
		expect(set).toEqual([['l', 'c', 25_000]]);
	});

	it('fills from the cell pasted into without names or headings; 0 clears an area', () => {
		const p = plan(planAreaPaste('0\t3', farms, crops, areas(), { row: 0, col: 0 }));
		expect(p.changes.map((c) => [c.rowId, c.key, c.from, c.to])).toEqual([
			['u', 'c', 20, 0],
			['u', 'v', 0, 3]
		]);
	});

	it('stops on a negative area', () => {
		expect(planAreaPaste('Upper farm\t-2', farms, crops, areas())).toEqual({ error: 'Upper farm, Citrus: -2 ha is below 0.' });
	});
});

describe('plantedAreasCsv', () => {
	it('is the grid in hectares and pastes back as no change', () => {
		const csv = plantedAreasCsv(farms, crops, areas());
		expect(csv).toBe('Farm,Citrus (ha),Vines (ha)\r\nUpper farm,20,0\r\nLower farm,0,5\r\n');
		expect(plan(planAreaPaste(csv, farms, crops, areas())).changes).toEqual([]);
	});

	it('round-trips names that differ only in brackets', () => {
		const fs = [
			{ id: 'e', name: 'Farm A (east)' },
			{ id: 'w', name: 'Farm A (west)' }
		];
		const cs = [
			{ id: 'mw', name: 'Maize (white)' },
			{ id: 'my', name: 'Maize (yellow)' }
		];
		const a = [{ nodeId: 'w', cropId: 'my', areaM2: 30_000 }];
		const csv = plantedAreasCsv(fs, cs, a);
		expect(plan(planAreaPaste(csv, fs, cs, a))).toEqual({ changes: [], unchanged: 4, notes: ['Matched 2 rows by name.'] });
		const p = plan(planAreaPaste(csv.replace('Farm A (east),0,0', 'Farm A (east),0,7'), fs, cs, a));
		expect(p.changes.map((c) => [c.rowId, c.key, c.to])).toEqual([['e', 'my', 7]]);
	});
});
