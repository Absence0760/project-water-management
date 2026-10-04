import { describe, expect, it } from 'vitest';
import type { NetworkNode } from '@water-management/engine';
import { newNode } from '$lib/model/editor.svelte';
import { readPastedBlock } from '$lib/spreadsheet/paste/read';
import { applyNodePaste, nodeTableCsv, planNodePaste } from './nodePaste';
import { TABLE_FIELDS } from './fields';

function sample(): NetworkNode[] {
	const gauge = { ...newNode(1, null), id: 'g', name: 'Outflow gauge' };
	const upper = { ...newNode(2, 'g'), id: 'u', name: 'Upper farm', areaKm2: 12, damCapacityM3: 150_000, irrigationEfficiency: 0.9 };
	const lower = { ...newNode(3, 'g'), id: 'l', name: 'Lower farm', areaKm2: 8 };
	return [gauge, upper, lower];
}
const plan = (r: ReturnType<typeof planNodePaste>) => {
	if ('error' in r) throw new Error(r.error);
	return r;
};

describe('planNodePaste', () => {
	it('reads a % as 0–100 and stores it 0–1; only real changes are listed, with what they replace', () => {
		const nodes = sample();
		const p = plan(planNodePaste('Name\tArea (km²)\tReturn flow (% of supply)\tDam capacity (m³)\nUpper farm\t12\t5\t150 000\nLower farm\t9,5\t10\t', nodes));
		expect(p.changes).toEqual([
			{ rowId: 'u', rowName: 'Upper farm', key: 'returnFlowFraction', column: 'Return flow', unit: '% of supply', from: 10, to: 5 },
			{ rowId: 'l', rowName: 'Lower farm', key: 'areaKm2', column: 'Area', unit: 'km²', from: 8, to: 9.5 }
		]);
		// Upper's area and capacity, and Lower's 10 % return flow, are what the table holds already.
		expect(p.unchanged).toBe(3);
		applyNodePaste(nodes, p);
		expect(nodes[1]!.returnFlowFraction).toBeCloseTo(0.05, 12);
		expect(nodes[2]!.areaKm2).toBe(9.5);
		expect(nodes[1]!.areaKm2).toBe(12);
	});

	it('leaves out a field the node does not use, and says so', () => {
		const p = plan(planNodePaste('Name\tArea\tDam capacity\nOutflow gauge\t3\t5000', sample()));
		expect(p.changes.map((c) => [c.rowId, c.key])).toEqual([['g', 'areaKm2']]);
		expect(p.notes.at(-1)).toBe("Left out values for fields these nodes don't use: Outflow gauge dam capacity (a gauge).");
	});

	it('leaves out River to dam on a node that sets it by month', () => {
		const nodes = sample();
		nodes[1]!.divertMonthlyM3Day = Array(12).fill(500);
		const p = plan(planNodePaste('Name\tRiver to dam\nUpper farm\t800', nodes));
		expect(p.changes).toEqual([]);
		expect(p.notes.at(-1)).toContain('Upper farm river to dam (set by month)');
	});

	it('reads River to dam in m³/s and stores m³/day, and leaves it out on a dam on the river (engine 1.68.0)', () => {
		const nodes = sample();
		nodes[2]!.pctUpstreamToDam = 0; // Lower farm's dam is off the river; Upper farm's (a new node's 100 %) is on it
		const p = plan(planNodePaste('Name\tRiver to dam (m³/s)\nUpper farm\t0.2\nLower farm\t0.2', nodes));
		expect(p.changes).toEqual([{ rowId: 'l', rowName: 'Lower farm', key: 'divertCapacityM3Day', column: 'River to dam', unit: 'm³/s', from: 0, to: 0.2 }]); // gitleaks:allow (a field name, not a secret)
		expect(p.notes.at(-1)).toContain('Upper farm river to dam (a dam on the river)');
		applyNodePaste(nodes, p);
		expect(nodes[2]!.divertCapacityM3Day).toBe(17_280);
		expect(nodeTableCsv(nodes).split('\n')[0]).toContain('River to dam (m³/s)');
	});

	it('fills from the cell pasted into when the block has no names or headings', () => {
		const nodes = sample();
		const area = TABLE_FIELDS.findIndex((f) => f.key === 'areaKm2');
		const p = plan(planNodePaste('20\t1\n30\t2', nodes, { row: 1, col: area }));
		expect(p.changes.map((c) => [c.rowId, c.key, c.to])).toEqual([
			['u', 'areaKm2', 20],
			['u', 'areaHiKm2', 1],
			['l', 'areaKm2', 30],
			['l', 'areaHiKm2', 2]
		]);
	});

	it('stops on a negative value or a % above 100', () => {
		expect(planNodePaste('Name\tArea\nUpper farm\t-1', sample())).toEqual({ error: 'Upper farm, Area: -1 is below 0.' });
		expect(planNodePaste('Name\tReturn flow\nUpper farm\t120', sample())).toEqual({ error: 'Upper farm, Return flow: 120 % is above 100 %.' });
	});

	it('leaves out the efficiency, which comes from the crops’ irrigation systems (engine 1.72.0), and says so', () => {
		const p = plan(planNodePaste('Name\tEfficiency (%)\tArea\tTotal\nUpper farm\t85\t12\t1', sample()));
		expect(p.changes).toEqual([]);
		expect(p.notes).toContain("Left out Efficiency (%): it comes from each unit's crops' irrigation systems, set on Crops & demand.");
		expect(p.notes).toContain("Left out a column the table doesn't have: Total.");
	});

	it('clears a nullable field only by typing it: a blank leaves it', () => {
		const nodes = sample();
		nodes[1]!.flowShareManual = 0.4;
		const p = plan(planNodePaste('Name\tManual flow share\nUpper farm\t', nodes));
		expect(p.changes).toEqual([]);
	});
});

describe('nodeTableCsv', () => {
	it('is the table with units in the headings, a % as 0–100 and unused fields blank, and pastes back as no change', () => {
		const nodes = sample();
		const csv = nodeTableCsv(nodes);
		const cells = readPastedBlock(csv).cells;
		expect(cells[0]!.slice(0, 5)).toEqual(['Name', 'Area (km²)', 'High-MAP area (km²)', 'Low-MAP area (km²)', 'Dam capacity (m³)']);
		// Every column a paste can write: not the efficiency, which is worked out (engine 1.72.0).
		const pasteable = TABLE_FIELDS.filter((f) => !f.derived);
		expect(cells[0]!.length).toBe(1 + pasteable.length);
		expect(cells[0]).not.toContain('Efficiency (%)');
		const ret = 1 + pasteable.findIndex((f) => f.key === 'returnFlowFraction');
		expect(cells[2]![ret]).toBe('10');
		// The gauge has no dam: blank.
		expect(cells[1]![4]).toBe('');
		const back = plan(planNodePaste(csv, nodes));
		expect(back.changes).toEqual([]);
		expect(back.unchanged).toBeGreaterThan(0);
	});
});
