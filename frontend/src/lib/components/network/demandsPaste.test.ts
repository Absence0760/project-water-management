import type { DemandObject, NetworkNode, ProjectModel } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import type { PastePlan } from '$lib/spreadsheet/paste/grid';
import { demandRows } from './demands';
import { applyDemandPaste, demandsCsv, pasteNames, planDemandPaste } from './demandsPaste';

const apan = new Array(12).fill(100);
const node = (id: string, kind: NetworkNode['kind'], extra: Partial<NetworkNode> = {}) => ({ id, name: id, kind, irrigationEfficiency: 1, ...extra }) as unknown as NetworkNode;
const object = (id: string, nodeId: string, extra: Partial<DemandObject> = {}): DemandObject => ({
	id,
	nodeId,
	name: id,
	category: 'municipal',
	sizing: 'monthly',
	monthlyM3Day: new Array(12).fill(100),
	count: null,
	litresPerUnitDay: null,
	lossPct: 0,
	monthlyFactor: null,
	returnPct: 0,
	priority: 'first',
	destination: 'internal',
	enabled: true,
	note: '',
	...extra
});
const model: ProjectModel = {
	nodes: [node('Upper', 'farm'), node('Lower', 'farm'), node('Mine', 'user', { userDemandM3Day: new Array(12).fill(50) })],
	crops: [{ id: 'vines', name: 'Vines', cropFactor: new Array(12).fill(0.5) }],
	cropAreas: [
		{ nodeId: 'Upper', cropId: 'vines', areaM2: 100_000 },
		{ nodeId: 'Lower', cropId: 'vines', areaM2: 50_000 }
	],
	transfers: [],
	demandObjects: [
		object('Town', 'Upper'),
		object('Cattle', 'Upper', { category: 'livestock', sizing: 'perUnit', monthlyM3Day: null, count: 200, litresPerUnitDay: 50, priority: 'last' })
	]
};
const rows = demandRows(model, apan);
const ok = (r: ReturnType<typeof planDemandPaste>): PastePlan => {
	if ('error' in r) throw new Error(r.error);
	return r;
};

describe('pasteNames', () => {
	it('uses a demand’s own name, adding its unit only where two rows share it', () => {
		const n = pasteNames(rows);
		expect(rows.map((r) => n.get(r.key))).toEqual(['Town', 'Crops (Upper)', 'Cattle', 'Crops (Lower)', 'Mine']);
	});
});

describe('planDemandPaste', () => {
	it('matches rows by name and months by heading, and changes only what differs', () => {
		const p = ok(planDemandPaste('Demand\tOct\tNov (m³/day)\nTown\t250\t100\nMine\t60\t', rows));
		expect(p.changes.map((c) => [c.rowName, c.column, c.from, c.to])).toEqual([
			['Town', 'Oct', 100, 250],
			['Mine', 'Oct', 50, 60]
		]);
		expect(p.unchanged).toBe(1);
	});

	it('leaves out a row whose months are made from other values, and says so', () => {
		const p = ok(planDemandPaste('Demand\tOct\nCrops (Upper)\t9\nCattle\t9\nTown\t1', rows));
		expect(p.changes.map((c) => c.rowName)).toEqual(['Town']);
		expect(p.notes.at(-1)).toBe(
			"Left out rows whose months are made from other values (the crops' planted areas, a count × litres), set in their own form: Crops (Upper), Cattle."
		);
	});

	it('notes a name the table doesn’t have', () => {
		const p = ok(planDemandPaste('Demand\tOct\nNowhere\t1\nTown\t2', rows));
		expect(p.notes).toContain("Left out a row the table doesn't have: Nowhere.");
	});

	it('fills from the anchor cell without names or headings: one copied row of 12 months fills a demand', () => {
		const p = ok(planDemandPaste(new Array(12).fill('7').join('\t'), rows, { row: 0, col: 0 }));
		expect(p.changes).toHaveLength(12);
		expect(p.changes.every((c) => c.rowId === 'object@Town' && c.to === 7)).toBe(true);
	});

	it('refuses a value below 0', () => {
		expect(planDemandPaste('Demand\tOct\nTown\t-1', rows)).toEqual({ error: 'Town, Oct: a demand of -1 m³/day is below 0.' });
	});

	it('takes its own CSV back without a note on the read-only columns, and with no change', () => {
		const p = ok(planDemandPaste(demandsCsv(rows), rows));
		expect(p.changes).toEqual([]);
		expect(p.notes.filter((n) => n.startsWith('Left out a column') || n.startsWith('Left out columns'))).toEqual([]);
	});

	it('reads and writes in the display unit (`scale` per m³/day)', () => {
		const lps = 1000 / 86_400;
		const p = ok(planDemandPaste('Demand\tOct\nTown\t2', rows, null, lps, 'l/s'));
		expect(p.changes[0]!.from).toBeCloseTo(100 * lps, 9);
		const set: [string, number, number][] = [];
		applyDemandPaste(p, (k, m, v) => set.push([k, m, v]), lps);
		expect(set[0]![0]).toBe('object@Town');
		expect(set[0]![2]).toBeCloseTo(172.8, 9);
	});
});

describe('demandsCsv', () => {
	it('writes every row as shown, months in m³/day', () => {
		const lines = demandsCsv(rows).trim().split('\r\n');
		expect(lines[0]).toBe('Demand,Unit,Kind,Water from,Supply order,Oct (m³/day),Nov (m³/day),Dec (m³/day),Jan (m³/day),Feb (m³/day),Mar (m³/day),Apr (m³/day),May (m³/day),Jun (m³/day),Jul (m³/day),Aug (m³/day),Sep (m³/day),Mean (m³/day),Annual (Mm³/a)');
		expect(lines).toHaveLength(rows.length + 1);
		expect(lines[1]!.startsWith('Town,Upper,Municipal (town),dam side,1 of 3,100,100,')).toBe(true);
		expect(lines[5]!.startsWith('Mine,,Other water user,river,senior,50,')).toBe(true);
	});

	it('defuses a name a spreadsheet would read as a formula', () => {
		const evil = demandRows({ ...model, demandObjects: [object('=HYPERLINK("x")', 'Upper')] }, apan);
		expect(demandsCsv(evil)).toContain(`"'=HYPERLINK(""x"")"`);
	});
});
