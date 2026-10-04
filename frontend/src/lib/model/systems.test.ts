// The editor's irrigation systems (engine 1.72.0, ./systems.ts): the table, a
// row by id or preset key, the words for one, what uses it, and a unit's
// efficiency blended from its plantings' systems as a run blends them; and the
// editor's own changes to the table and a planting's system.
import { describe, expect, it } from 'vitest';
import { DEFAULT_IRRIGATION_SYSTEMS, newNetworkNode, type ProjectModel } from '@water-management/engine';
import { ModelEditor } from './editor.svelte';
import { findSystem, sabiRange, systemLabel, systemsOf, systemUse, unitEfficiency } from './systems';
import { validateModel } from './validate';
import { returnFlowHint } from '$lib/components/network/fields';

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
