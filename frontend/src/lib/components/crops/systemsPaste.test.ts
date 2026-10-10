import { describe, expect, it } from 'vitest';
import { DEFAULT_IRRIGATION_SYSTEMS } from '@water-management/engine';
import { applySystemPaste, planSystemPaste, systemsCsv, SYSTEMS_FORMAT } from './systemsPaste';

const systems = () => [
	{ id: 'drip', name: 'Drip', efficiency: 0.9, preset: 'drip' as const },
	{ id: 'own', name: 'Canal', efficiency: 0.6, preset: null }
];
const plan = (r: ReturnType<typeof planSystemPaste>) => {
	if ('error' in r) throw new Error(r.error);
	return r;
};

describe('irrigation systems paste (issue #477)', () => {
	it('updates a known system’s efficiency and adds a new one, in %', () => {
		const p = plan(planSystemPaste('System\tEfficiency (%)\tUsed by\ndrip\t92%\t1 crop\nCentre pivot\t85\t', systems()));
		expect(p.added).toEqual([{ id: 'new:0', name: 'Centre pivot' }]);
		expect(p.changes.map((c) => [c.rowId, c.rowName, c.from, c.to])).toEqual([
			['drip', 'Drip', 90, 92],
			['new:0', 'Centre pivot (new system)', null, 85]
		]);
		expect(p.notes).toEqual(['Matched 1 row by name.', "Adds a system the project doesn't have: Centre pivot."]);
		const set: [string, number][] = [];
		const made: string[] = [];
		applySystemPaste(
			p,
			(id, e) => set.push([id, e]),
			(n) => {
				made.push(n);
				return 'id-' + n;
			}
		);
		expect(made).toEqual(['Centre pivot']);
		expect(set).toEqual([
			['drip', 0.92],
			['id-Centre pivot', 0.85]
		]);
	});

	it('fills from the row pasted into without names', () => {
		const p = plan(planSystemPaste('70', systems(), { row: 1, col: 0 }));
		expect(p.changes.map((c) => [c.rowId, c.to])).toEqual([['own', 70]]);
	});

	it('refuses an efficiency outside (1, 100], a fraction, and a new system without one', () => {
		expect(planSystemPaste('Drip\t120', systems())).toEqual({ error: 'Drip: an efficiency of 120 % is above 100 %.' });
		expect(planSystemPaste('Drip\t0', systems())).toEqual({ error: "Drip: an efficiency of 0 % isn't above 0." });
		expect(planSystemPaste('Drip\t0.85', systems())).toEqual({ error: 'Drip: is 0.85 a fraction? Write the efficiency as a percentage (85, not 0.85).' });
		expect(planSystemPaste('System\tEfficiency\nPivot\t\nDrip\t90', systems())).toEqual({ error: 'Pivot is a new system: give its efficiency (%).' });
	});

	it('its CSV pastes back as no change; the default table’s too', () => {
		expect(systemsCsv(systems())).toBe('System,Efficiency (%),SABI range\r\nDrip,90,SABI 90–95 %\r\nCanal,60,\r\n');
		expect(plan(planSystemPaste(systemsCsv(systems()), systems())).changes).toEqual([]);
		const defaults = plan(planSystemPaste(systemsCsv(DEFAULT_IRRIGATION_SYSTEMS), DEFAULT_IRRIGATION_SYSTEMS));
		expect(defaults.changes).toEqual([]);
		expect(defaults.unchanged).toBe(DEFAULT_IRRIGATION_SYSTEMS.length);
	});

	it('its Expected format example reads against the default table: two updates and a new system', () => {
		const p = plan(planSystemPaste(SYSTEMS_FORMAT.example, DEFAULT_IRRIGATION_SYSTEMS));
		expect(p.added?.map((a) => a.name)).toEqual(['Scheme canal and furrow']);
		expect(p.changes.map((c) => [c.rowName, c.to])).toEqual([
			['Drip', 92],
			['Centre pivot / linear move', 82.5],
			['Scheme canal and furrow (new system)', 62]
		]);
	});
});
