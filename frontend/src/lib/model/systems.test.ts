// The editor's irrigation systems (engine 1.72.0, ./systems.ts): the table, a
// row by id or preset key, the words for one, what uses it, and a unit's
// efficiency blended from its plantings' systems as a run blends them; and the
// editor's own changes to the table and a planting's system.
import { describe, expect, it } from 'vitest';
import { DEFAULT_IRRIGATION_SYSTEMS, newNetworkNode, type ProjectModel } from '@water-management/engine';
import { ModelEditor } from './editor.svelte';
import { apanInputOf, apanOf, findSystem, ownEfficiencyUsed, plantingSystemsLine, sabiRange, systemLabel, systemsOf, systemUse, unitEfficiency } from './systems';
import { validateModel } from './validate';
import { returnFlowHint } from '#lib/components/network/fields.js';

function model(): ProjectModel {
	const g = { ...newNetworkNode('g', 0, null), name: 'Gauge' };
	const u = { ...newNetworkNode('u', 1, 'g'), name: 'Unit', irrigationEfficiency: 0.8, returnFlowFraction: 0.1 };
	return {
		nodes: [g, u],
		crops: [
			{ id: 'a', name: 'Citrus', cropFactor: new Array(12).fill(1), irrigationSystemId: 'drip' },
			{ id: 'b', name: 'Pasture', cropFactor: new Array(12).fill(1) }
		],
		cropAreas: [
			{ nodeId: 'u', cropId: 'a', areaM2: 1000 },
			{ nodeId: 'u', cropId: 'b', areaM2: 1000, irrigationSystemId: 'surface' }
		],
		transfers: []
	};
}

describe('systems', () => {
	it('reads the model’s table, else the SABI defaults, a row by id or preset key, and its words', () => {
		const m = model();
		expect(systemsOf(m)).toBe(DEFAULT_IRRIGATION_SYSTEMS);
		const own = { ...m, irrigationSystems: [{ id: 'x1', name: 'Our drip', efficiency: 0.93, preset: 'drip' as const }] };
		expect(findSystem(own, 'x1')?.name).toBe('Our drip');
		expect(findSystem(own, 'drip')?.name).toBe('Our drip');
		expect(findSystem(own, 'nope')).toBeNull();
		expect(systemLabel({ name: 'Flood / furrow', efficiency: 0.7 })).toBe('Flood / furrow, 70 %');
		expect(systemLabel({ name: 'Imported, 66 %', efficiency: 0.66 })).toBe('Imported, 66 %');
		expect(systemLabel({ name: 'Imported, 66 %', efficiency: 0.7 })).toBe('Imported, 66 %, 70 %');
		expect(sabiRange({ preset: 'drip' })).toBe('SABI 90–95 %');
		expect(sabiRange({ preset: null })).toBeNull();
		expect(systemUse(m, 'drip')).toEqual({ crops: 1, plantings: 0 });
		expect(systemUse(m, 'surface')).toEqual({ crops: 0, plantings: 1 });
	});

	it('blends a unit’s plantings’ systems by their requirement: drip and flood on equal areas and factors', () => {
		const m = model();
		// Equal weights: e = 2 ÷ (1/0.9 + 1/0.7).
		expect(unitEfficiency(m, 'u', new Array(12).fill(150))).toBeCloseTo(2 / (1 / 0.9 + 1 / 0.7), 12);
		expect(unitEfficiency(m, 'g', [])).toBe(1);
	});

	it('groups a unit’s crops by system, and says when its own efficiency is still used (a crop on no system)', () => {
		const m = model();
		m.crops.push({ id: 'c', name: 'Lucerne', cropFactor: new Array(12).fill(1), irrigationSystemId: 'drip' });
		m.cropAreas.push({ nodeId: 'u', cropId: 'c', areaM2: 500 });
		expect(plantingSystemsLine(m, 'u')).toBe('Drip, 90 %: Citrus, Lucerne · Flood / furrow, 70 %: Pasture');
		expect(ownEfficiencyUsed(m, 'u')).toBe(false);
		expect(plantingSystemsLine(m, 'g')).toBeNull();
		expect(ownEfficiencyUsed(m, 'g')).toBe(false);
		// Pasture back on its default, which is none: the unit's own 80 % is used for it.
		delete m.cropAreas[1]!.irrigationSystemId;
		expect(ownEfficiencyUsed(m, 'u')).toBe(true);
		expect(plantingSystemsLine(m, 'u')).toBe('Drip, 90 %: Citrus, Lucerne · No system (its own 80 %): Pasture');
		// An unplanted row (area 0) counts for neither.
		m.cropAreas[1]!.areaM2 = 0;
		expect(ownEfficiencyUsed(m, 'u')).toBe(false);
	});

	it('warns of a return flow above the losses at the blend, without refusing the model (a run caps it)', () => {
		const m = model();
		const blend = unitEfficiency(m, 'u', new Array(12).fill(150));
		// The unit's own 80 % would allow 20 %; the blend (78.75 %) allows a little more, 21.25 %.
		expect(returnFlowHint(0.21, blend)).toBeNull();
		expect(returnFlowHint(0.25, blend)).toBe(
			"Only 21.2 % of the water supplied is lost at its 78.8 % irrigation efficiency (its crops' systems), so runs return 21.2 %, not 25 %. Lower it to match, or check its crops' systems."
		);
		// 10 % at 90 % is all the losses (1 − 0.9 is 0.0999…98): no warning.
		expect(returnFlowHint(0.1, 0.9)).toBeNull();
		m.nodes[1]!.returnFlowFraction = 0.25;
		expect(validateModel(m)).toEqual([]);
	});
});

describe('ModelEditor and irrigation systems', () => {
	it('starts a new crop on drip, adds and removes a row, and sets a planting’s own system', () => {
		const ed = new ModelEditor();
		ed.load(model());
		const c = ed.addCrop();
		expect(c.irrigationSystemId).toBe('drip');
		const row = ed.addIrrigationSystem();
		expect(ed.model.irrigationSystems!.at(-1)).toMatchObject({ id: row.id, name: 'System 7', preset: null });
		ed.setPlantingSystem('u', 'a', row.id);
		expect(ed.model.cropAreas[0]!.irrigationSystemId).toBe(row.id);
		ed.setPlantingSystem('u', 'a', null);
		expect('irrigationSystemId' in ed.model.cropAreas[0]!).toBe(false);
		// Removing a row in use leaves its crops and plantings on none.
		ed.removeIrrigationSystem('surface');
		expect(ed.model.irrigationSystems!.some((s) => s.id === 'surface')).toBe(false);
		expect('irrigationSystemId' in ed.model.cropAreas[1]!).toBe(false);
		ed.removeIrrigationSystem('drip');
		expect(ed.model.crops[0]!.irrigationSystemId).toBeNull();
	});
});

describe('apanInputOf (engine 1.117.0, CCWR A-pan (Hydrological Unit))', () => {
	const land = (id: string, areaKm2: number) => ({ ...newNetworkNode(id, 0, null), kind: 'farm' as const, areaKm2 });
	const nodes = [land('a', 3), land('b', 1), land('c', 2)];
	const row = (v: number) => new Array<number>(12).fill(v);
	it('is the one row as it was under the catchment basis, rows stored or not', () => {
		const settings = { apanMm: row(100), apanUnits: { dataset: 'x', source: 's', units: { a: row(200) } } };
		expect(apanInputOf(settings, nodes)).toBe(settings.apanMm);
		expect(apanInputOf({ ...settings, apanBasis: 'catchment' }, nodes)).toBe(settings.apanMm);
	});
	it('under the units basis: each unit’s own, the rest the covered units’ area-weighted row', () => {
		const a = apanInputOf({ apanMm: row(100), apanBasis: 'units', apanUnits: { dataset: 'x', source: 's', units: { a: row(200), b: row(400) } } }, nodes);
		expect(apanOf(a, 'a')).toEqual(row(200));
		expect(apanOf(a, 'b')).toEqual(row(400));
		// (200 × 3 + 400 × 1) ÷ 4 = 250.
		expect(apanOf(a, 'c')).toEqual(row(250));
	});
});
