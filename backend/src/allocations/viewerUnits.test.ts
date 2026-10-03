// A viewer's registered-water totals and the run they read (162, decision D3;
// viewerUnits.ts). The database side (who gets which rows, the 5-holder
// refusal) is in allocations.db.test.ts.
import { compareAllocations } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { comparisonTotals, redactRunAllocations, volumeTotals, withoutAllocationIdentifiers, type VolumeRow } from './viewerUnits.js';

const row = (o: Partial<VolumeRow>): VolumeRow => ({
	waterSource: 'surface',
	holders: 6,
	nodeId: 'n1',
	volumeM3PerYear: 1000,
	storageM3: null,
	waterUse: '21a',
	validFrom: null,
	validTo: null,
	...o
});

describe('volumeTotals', () => {
	it('sums the takes and storage in force on the day, per water source, a storage-only row as storage only', () => {
		const rows = [
			row({ volumeM3PerYear: 1000, storageM3: 500 }),
			row({ nodeId: 'n2', volumeM3PerYear: 2000 }),
			row({ nodeId: 'n3', waterUse: '21b', volumeM3PerYear: 0, storageM3: 700 }),
			// Lapsed before the day, and not yet in force: neither counts.
			row({ nodeId: 'n4', volumeM3PerYear: 9e6, validTo: '2020-12-31' }),
			row({ nodeId: 'n5', volumeM3PerYear: 9e6, validFrom: '2030-01-01' }),
			row({ waterSource: 'groundwater', holders: 5, volumeM3PerYear: 300 })
		];
		expect(volumeTotals(rows, '2026-10-01')).toEqual([
			{ waterSource: 'surface', holders: 6, registeredM3PerYear: 3000, storageM3: 1200 },
			{ waterSource: 'groundwater', holders: 5, registeredM3PerYear: 300, storageM3: null }
		]);
		// A source the database withheld (fewer than 5 holders) has no rows, so no total.
		expect(volumeTotals([], '2026-10-01')).toEqual([]);
	});
});

describe('comparisonTotals', () => {
	it('sums each unit’s registered volume and modelled use per water year, as compareAllocations reads them', () => {
		const days = 365;
		const nodes = ['n1', 'n2', 'n3'].map((id, i) => ({ nodeId: id, name: `Unit ${id}`, kind: 'farm' as const, supplied: new Array<number>(days).fill(i + 1), groundwater: null, riverAbstraction: null }));
		const rows = [row({ nodeId: 'n1', volumeM3PerYear: 100 }), row({ nodeId: 'n2', volumeM3PerYear: 10_000 })];
		const t = comparisonTotals({ startDate: '2021-10-01', nodes, tolerance: 0.1, rows });
		expect(t.sources).toHaveLength(1);
		const s = t.sources[0]!;
		expect([s.waterSource, s.holders, s.units]).toEqual(['surface', 6, 2]);
		// n3 has no volume: its use isn't in the total.
		const c = compareAllocations({ startDate: '2021-10-01', nodes, tolerance: 0.1, allocations: rows.map((r, i) => ({ id: `x${i}`, nodeId: r.nodeId, waterSource: 'surface', volumeM3PerYear: r.volumeM3PerYear })) });
		const want = (k: 'modelledM3' | 'registeredM3') => c.nodes.filter((n) => n.nodeId !== 'n3').reduce((a, n) => a + n.surface.years[0]![k], 0);
		expect(s.years[0]!.modelledM3).toBeCloseTo(want('modelledM3'), 6);
		expect(s.years[0]!.registeredM3).toBeCloseTo(want('registeredM3'), 6);
		expect(s.years[0]!).toMatchObject({ waterYear: 2021, partial: false, status: 'under' });
		expect(JSON.stringify(t)).not.toContain('Unit');
	});
});

describe('redactRunAllocations', () => {
	it('leaves the volumes out of the run’s model, inputs and summary, keeping the mode, band and counts', () => {
		const run = {
			id: 'r',
			model: { nodes: [], allocations: [{ id: 'a', volumeM3PerYear: 5 }] },
			inputs: { model: { allocations: [{ id: 'a', volumeM3PerYear: 5 }] }, settings: {} },
			summary: { farms: [], allocations: { mode: 'cap', tolerance: 0.1, used: 1, notMatched: 0, nodes: [{ nodeId: 'n1' }] } }
		};
		const out = redactRunAllocations(run);
		expect(out.model.allocations).toEqual([]);
		expect(out.inputs.model.allocations).toEqual([]);
		expect(out.summary.allocations).toEqual({ mode: 'cap', tolerance: 0.1, used: 1, notMatched: 0, nodes: [] });
		expect(out.id).toBe('r');
		// The original isn't changed (it may be cached or reused).
		expect(run.model.allocations).toHaveLength(1);
		// A run with none: its model gets an empty list, its summary stays as it was.
		const plain = { model: { nodes: [] as unknown[], allocations: undefined }, summary: { farms: [] as unknown[], allocations: null } };
		expect(redactRunAllocations(plain)).toEqual({ model: { nodes: [], allocations: [] }, summary: { farms: [], allocations: null } });
	});
});

describe('withoutAllocationIdentifiers', () => {
	it('leaves an allocation event’s registration number and volume out, and keeps what was done', () => {
		const e = { kind: 'allocation.created', createdAt: 't', subject: { allocationId: 'a', registrationNo: 'R-1', nodeId: 'n', waterSource: 'surface', volumeM3PerYear: 5, waterUse: '21a' } };
		expect(withoutAllocationIdentifiers(e)).toEqual({ kind: 'allocation.created', createdAt: 't', subject: { allocationId: 'a', nodeId: 'n', waterSource: 'surface', waterUse: '21a' } });
		// The input is not changed.
		expect(e.subject.registrationNo).toBe('R-1');
		expect(withoutAllocationIdentifiers({ kind: 'allocation.deleted', subject: { allocationId: 'a', registrationNo: 'R-1' } }).subject).toEqual({ allocationId: 'a' });
	});

	it('leaves every other event, and a malformed one, as it is', () => {
		const run = { kind: 'run.created', subject: { registrationNo: 'kept' } };
		expect(withoutAllocationIdentifiers(run)).toBe(run);
		expect(withoutAllocationIdentifiers(null)).toBe(null);
		const noSubject = { kind: 'allocation.created' };
		expect(withoutAllocationIdentifiers(noSubject)).toBe(noSubject);
	});
});
