import type { DemandObject, NetworkNode, ProjectModel } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { cropsFrom, demandRows, demandShares, demandTotal } from './demands';

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

const model = (over: Partial<ProjectModel> = {}): ProjectModel => ({
	nodes: [node('Upper', 'farm'), node('Gauge', 'gauge'), node('Mine', 'user', { userDemandM3Day: new Array(12).fill(50), userPriority: 'junior' }), node('Lower', 'farm')],
	crops: [{ id: 'vines', name: 'Vines', cropFactor: new Array(12).fill(0.5) }],
	cropAreas: [{ nodeId: 'Upper', cropId: 'vines', areaM2: 100_000 }],
	transfers: [],
	demandObjects: [object('Town', 'Upper'), object('Cattle', 'Upper', { category: 'livestock', sizing: 'perUnit', monthlyM3Day: null, count: 200, litresPerUnitDay: 50, lossPct: 0.2, priority: 'last' })],
	...over
});

describe('demandRows', () => {
	it('lists the crops and each object in the unit’s supply order, then a user, in node order; skips gauges and empty units', () => {
		const rows = demandRows(model(), apan);
		expect(rows.map((r) => [r.unit, r.name, r.order])).toEqual([
			['Upper', 'Town', '1 of 3'],
			['Upper', 'Crops', '2 of 3'],
			['Upper', 'Cattle', '3 of 3'],
			['Mine', 'Mine', 'Non-priority']
		]);
	});

	it('reads each demand as a run does: the crops’ requirement, a monthly object’s values, a per-unit object’s count × litres grossed up for losses', () => {
		const rows = demandRows(model(), apan);
		const by = new Map(rows.map((r) => [r.name, r]));
		// Oct: 100 000 m² × 50 mm ÷ 1000 ÷ 31 days.
		expect(by.get('Crops')!.monthlyM3Day[0]).toBeCloseTo(5000 / 31, 9);
		expect(by.get('Town')!.monthlyM3Day).toEqual(new Array(12).fill(100));
		// 200 × 50 l ÷ 1000 ÷ (1 − 0.2) = 12.5 m³/day.
		expect(by.get('Cattle')!.monthlyM3Day[0]).toBeCloseTo(12.5, 9);
		expect(by.get('Cattle')!.sizing).toBe('200 × 50 l a day, losses 20 %');
		expect(by.get('Cattle')!.editable).toBe(false);
		expect(by.get('Town')!.editable).toBe(true);
		expect(by.get('Crops')!.editable).toBe(false);
		expect(by.get('Mine')!.editable).toBe(true);
		expect(by.get('Town')!.annualMm3).toBeCloseTo((100 * 365.25) / 1e6, 9);
	});

	it('puts an object that is off after the modelled ones, with no place in the order, and leaves it out of the total', () => {
		const m = model({ demandObjects: [object('Old mill', 'Upper', { enabled: false }), object('Town', 'Upper')] });
		const rows = demandRows(m, apan);
		expect(rows.filter((r) => r.unit === 'Upper').map((r) => [r.name, r.order, r.enabled])).toEqual([
			['Town', '1 of 2', true],
			['Crops', '2 of 2', true],
			['Old mill', null, false]
		]);
		const total = demandTotal(rows);
		expect(total.monthly[1]).toBeCloseTo(100 + 5000 / 30 + 50, 9);
	});

	it('gives no order when everything on a unit shares one place', () => {
		const rows = demandRows(model({ demandObjects: [object('Town', 'Upper', { priority: 'shared' })] }), apan);
		expect(rows.filter((r) => r.unit === 'Upper').every((r) => r.order === null)).toBe(true);
	});

	it('shows a unit with objects but no crops', () => {
		const rows = demandRows(model({ cropAreas: [], demandObjects: [object('Town', 'Lower')] }), apan);
		expect(rows.map((r) => r.name)).toEqual(['Mine', 'Town']);
	});

	it('marks piped-out and scheduled objects', () => {
		const rows = demandRows(model({ demandObjects: [object('Export', 'Upper', { destination: 'external', schedule: [{ from: '2020-01-01', to: '2020-02-01', factor: 0 }] as DemandObject['schedule'] })] }), apan);
		const r = rows.find((x) => x.name === 'Export')!;
		expect(r.external).toBe(true);
		expect(r.scheduled).toBe(true);
	});
});

describe('cropsFrom', () => {
	const byId = new Map([['Up', node('Up', 'farm', { name: 'Up dam' } as Partial<NetworkNode>)]]);
	it('names the one source, or the supply table’s shares', () => {
		expect(cropsFrom(node('A', 'farm'), byId)).toBe('dam side');
		expect(cropsFrom(node('A', 'farm', { cropWaterSource: 'river' }), byId)).toBe('river abstraction');
		expect(cropsFrom(node('A', 'farm', { cropShareDam: 0.6, cropShareRiver: 0.3, cropShareRemote: 0.1, cropRemoteNodeId: 'Up' }), byId)).toBe('dam side 60 %, river 30 %, Up dam’s dam 10 %');
	});
});

describe('demandShares', () => {
	it('splits the modelled total by kind, largest first', () => {
		const shares = demandShares(demandRows(model(), apan));
		expect(shares[0]!.what).toBe('Irrigation (crops)');
		expect(shares.reduce((s, x) => s + x.share, 0)).toBeCloseTo(1, 9);
	});
	it('is empty with no demand', () => {
		expect(demandShares([])).toEqual([]);
	});
});
