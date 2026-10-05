import { describe, expect, it } from 'vitest';
import type { Allocation } from '$lib/api';
import type { DemandRow } from './demands';
import { inForce, nodeSpans, registeredCells, registeredTotal } from './demandsRegistered';

const row = (key: string, nodeId: string, annualMm3: number, enabled = true) => ({ key, nodeId, annualMm3, enabled }) as DemandRow;
const alloc = (nodeId: string | null, volumeM3PerYear: number, extra: Partial<Allocation> = {}) =>
	({ id: `${nodeId}-${volumeM3PerYear}`, nodeId, volumeM3PerYear, waterUse: '21a', validFrom: null, validTo: null, waterSource: 'surface', ...extra }) as Allocation;

const TODAY = '2026-10-04';

describe('inForce', () => {
	it('takes open ends as no limit and both ends inclusive', () => {
		expect(inForce({ validFrom: null, validTo: null }, TODAY)).toBe(true);
		expect(inForce({ validFrom: TODAY, validTo: TODAY }, TODAY)).toBe(true);
		expect(inForce({ validFrom: '2026-10-05', validTo: null }, TODAY)).toBe(false);
		expect(inForce({ validFrom: null, validTo: '2026-10-03' }, TODAY)).toBe(false);
	});
});

describe('registeredCells', () => {
	const rows = [row('crops@U', 'U', 0.1), row('object@T', 'U', 0.05), row('object@Off', 'U', 0.5, false), row('user@Q', 'Q', 0.02), row('crops@L', 'L', 0.03)];

	it('sums a node’s takes in force, surface and groundwater, against all its modelled demands together', () => {
		const cells = registeredCells(rows, [alloc('U', 100_000), alloc('U', 30_000, { waterSource: 'groundwater' })], TODAY);
		const u = cells.get('U')!;
		// 0.1 + 0.05 Mm³ (the object that is off counts nothing) against 130 000 m³: above the ±10 % band.
		expect(u.demandM3).toBeCloseTo(150_000, 6);
		expect(u.registeredM3).toBe(130_000);
		expect(u.count).toBe(2);
		expect(u.status).toBe('over');
	});

	it('leaves out storage-only rows, lapsed and future ones, unmatched ones and nodes with no demand row', () => {
		const cells = registeredCells(
			rows,
			[
				alloc('U', 0, { waterUse: '21b', storageM3: 50_000 }),
				alloc('U', 999_999, { validTo: '2020-09-30' }),
				alloc('U', 999_999, { validFrom: '2030-10-01' }),
				alloc(null, 5_000),
				alloc('Gauge', 5_000),
				alloc('Q', 20_000)
			],
			TODAY
		);
		expect([...cells.keys()]).toEqual(['U', 'Q', 'L']);
		expect(cells.get('U')).toMatchObject({ registeredM3: 0, count: 0, status: 'unregistered' });
		expect(cells.get('Q')).toMatchObject({ registeredM3: 20_000, status: 'within' });
		expect(cells.get('L')!.status).toBe('unregistered');
	});

	it('bands with the project’s tolerance', () => {
		expect(registeredCells([row('user@Q', 'Q', 0.02)], [alloc('Q', 17_000)], TODAY, 0.1).get('Q')!.status).toBe('over');
		expect(registeredCells([row('user@Q', 'Q', 0.02)], [alloc('Q', 17_000)], TODAY, 0.2).get('Q')!.status).toBe('within');
		expect(registeredCells([row('user@Q', 'Q', 0.02)], [alloc('Q', 40_000)], TODAY).get('Q')!.status).toBe('under');
	});

	it('totals the registered volumes and counts the flags', () => {
		const cells = registeredCells(rows, [alloc('U', 100_000), alloc('Q', 20_000)], TODAY);
		expect(registeredTotal(cells)).toEqual({ registeredM3: 120_000, over: 1, unregistered: 1 });
	});
});

describe('nodeSpans', () => {
	it('puts each node’s cell on its first row, spanning its run of rows', () => {
		const spans = nodeSpans([row('a', 'U', 0), row('b', 'U', 0), row('c', 'U', 0), row('d', 'Q', 0), row('e', 'L', 0)]);
		expect([...spans]).toEqual([
			['a', 3],
			['d', 1],
			['e', 1]
		]);
	});
});
