import { describe, expect, it } from 'vitest';
import { applyAreaPaste, applyFactorPaste, CROP_FACTORS_FORMAT, cropFactorsCsv, planFactorPaste, PLANTED_AREAS_FORMAT, plantedAreasCsv, planAreaPaste } from './areaPaste';

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
	it('the Expected format example fills the areas it names (issue #477)', () => {
		const withMaize = [crops[0]!, { id: 'm', name: 'Maize' }];
		const p = plan(planAreaPaste(PLANTED_AREAS_FORMAT.example, farms, withMaize, areas()));
		expect(p.changes.map((c) => [c.rowId, c.key, c.to])).toEqual([
			['u', 'c', 30],
			['u', 'm', 12.5],
			['l', 'm', 40]
		]);
	});

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

describe('planFactorPaste', () => {
	const factors = () => [
		{ id: 'c', name: 'Citrus', cropFactor: [0.6, 0.7, 0.8, 0.8, 0.8, 0.7, 0.6, 0.5, 0.4, 0.4, 0.5, 0.6] },
		{ id: 'v', name: 'Vines', cropFactor: new Array(12).fill(0) }
	];
	const plan = (r: ReturnType<typeof planFactorPaste>) => {
		if ('error' in r) throw new Error(r.error);
		return r;
	};

	it('takes one copied row of 12 months into the crop it was pasted into, from that month on', () => {
		const p = plan(planFactorPaste('0.3\t0.45\t0.6\t0.6\t0.6\t0.45\t0.3\t0\t0\t0\t0\t0.15', factors(), { row: 1, col: 0 }));
		expect(p.changes.map((c) => [c.rowId, c.column, c.to])).toEqual([
			['v', 'Oct', 0.3],
			['v', 'Nov', 0.45],
			['v', 'Dec', 0.6],
			['v', 'Jan', 0.6],
			['v', 'Feb', 0.6],
			['v', 'Mar', 0.45],
			['v', 'Apr', 0.3],
			['v', 'Sep', 0.15]
		]);
		expect(p.unchanged).toBe(4);
		const set: [string, number, number][] = [];
		applyFactorPaste(p, (id, m, f) => set.push([id, m, f]));
		expect(set[0]).toEqual(['v', 0, 0.3]);
		expect(set.at(-1)).toEqual(['v', 11, 0.15]);
	});

	it('matches crops by name and months by heading, short or long, in any order', () => {
		const p = plan(planFactorPaste('Crop\tJanuary\tOct\nvines\t1,05\t0,2', factors()));
		expect(p.changes.map((c) => [c.rowId, c.key, c.from, c.to])).toEqual([
			['v', '3', 0, 1.05],
			['v', '0', 0, 0.2]
		]);
		expect(p.notes).toContain('Matched 1 row by name.');
	});

	it('with addCrops, a name the project lacks is a new crop type with its factors (issue #477)', () => {
		const p = plan(planFactorPaste('Crop\tIrrigation system\tOct\tNov\nMaize\tPivot\t0.3\t\nCitrus\tDrip\t0.6\t0.7', factors(), null, { addCrops: true }));
		expect(p.added).toEqual([{ id: 'new:0', name: 'Maize' }]);
		expect(p.changes.map((c) => [c.rowId, c.rowName, c.from, c.to])).toEqual([['new:0', 'Maize (new crop)', null, 0.3]]);
		expect(p.unchanged).toBe(2);
		expect(p.notes.at(-1)).toBe("Adds a crop the project doesn't have: Maize. It starts on drip irrigation, as + Add crop does; a blank month is 0.");
		const set: [string, number, number][] = [];
		applyFactorPaste(
			p,
			(id, m, f) => set.push([id, m, f]),
			(n) => `id-${n}`
		);
		expect(set).toEqual([['id-Maize', 0, 0.3]]);
		// A new crop with every month blank is still added (add runs for each added row).
		const blank = plan(planFactorPaste('Crop\tOct\nSorghum\t', factors(), null, { addCrops: true }));
		const made: string[] = [];
		applyFactorPaste(blank, () => {}, (n) => (made.push(n), n));
		expect(made).toEqual(['Sorghum']);
		// Without it (one crop's sheet), the name is left out as before.
		expect(plan(planFactorPaste('Crop\tOct\nMaize\t0.3\nCitrus\t0.1', factors())).notes).toContain("Left out a row the table doesn't have: Maize.");
	});

	it('the Expected format example adds its crops (issue #477)', () => {
		const p = plan(planFactorPaste(CROP_FACTORS_FORMAT.example, factors(), null, { addCrops: true }));
		expect(p.added?.map((a) => a.name)).toEqual(['Maize']);
		expect(p.notes[0]).toBe('Matched 1 row by name.');
		expect(p.changes.filter((c) => c.rowId === 'new:0')).toHaveLength(12);
	});

	it('stops on a negative factor and on a row longer than the months left', () => {
		expect(planFactorPaste('Citrus\t-0.1', factors())).toEqual({ error: 'Citrus, Oct: a crop factor of -0.1 is below 0.' });
		expect(planFactorPaste('1\t2\t3', factors(), { row: 0, col: 10 })).toHaveProperty('error');
	});
});

describe('cropFactorsCsv', () => {
	it('is the grid with a heading of months and pastes back as no change', () => {
		const crops = [{ id: 'c', name: 'Citrus', cropFactor: [0.6, 0.7, 0.8, 0.8, 0.8, 0.7, 0.6, 0.5, 0.4, 0.4, 0.5, 0.6] }];
		const csv = cropFactorsCsv(crops);
		expect(csv).toBe('Crop,Oct,Nov,Dec,Jan,Feb,Mar,Apr,May,Jun,Jul,Aug,Sep\r\nCitrus,0.6,0.7,0.8,0.8,0.8,0.7,0.6,0.5,0.4,0.4,0.5,0.6\r\n');
		const p = planFactorPaste(csv, crops);
		expect('error' in p ? p.error : p.changes).toEqual([]);
	});
});
