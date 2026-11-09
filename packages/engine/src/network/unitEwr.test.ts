// Each unit's EWR met (docs/model.md §2.11c): the pure sums, then RunSummary.unitEwr
// against the run's own daily series, worked from the definitions (Σ Z, Σ MIN(U, Z),
// Σ U), never from the summary code. Synthetic networks only.
import { describe, expect, it } from 'vitest';
import type { ModelOutput } from '../project';
import { runModel } from '../run';
import { randomInput } from '../testing';
import { unitEwrMet } from './unitEwr';

describe('unitEwrMet', () => {
	it('sums the requirement, the part of it met and the outflow, and counts the days short', () => {
		const [u] = unitEwrMet([{ nodeId: 'a', name: 'A', kind: 'farm', outflow: [10, 2, 0, 7], required: [5, 5, 5, 0], shortfall: [0, -3, -5, 0] }], 4);
		expect(u).toEqual({ nodeId: 'a', name: 'A', kind: 'farm', requiredM3: 15, metM3: 7, outflowM3: 19, daysNotMet: 2 });
	});

	it('reads 0 for a unit with no EWR share at or above it, and keeps the order given', () => {
		const out = unitEwrMet(
			[
				{ nodeId: 'u', name: 'User', kind: 'user', outflow: [3, 3], required: [0, 0], shortfall: [0, 0] },
				{ nodeId: 'f', name: 'Farm', kind: 'farm', outflow: [1, 1], required: [1, 1], shortfall: [0, 0] }
			],
			2
		);
		expect(out.map((u) => [u.nodeId, u.requiredM3, u.metM3, u.daysNotMet])).toEqual([
			['u', 0, 0, 0],
			['f', 2, 2, 0]
		]);
	});

	it('never has more met than required, nor a negative day', () => {
		// A shortfall below −Z (float noise in the engine) adds nothing rather than taking away.
		const [u] = unitEwrMet([{ nodeId: 'a', name: 'A', kind: 'farm', outflow: [0, 9], required: [2, 3], shortfall: [-2.0000001, 0] }], 2);
		expect(u!.metM3).toBe(3);
		expect(u!.metM3).toBeLessThanOrEqual(u!.requiredM3);
	});
});

const values = (out: ModelOutput, nodeId: string, key: string) => {
	const s = out.series.find((x) => x.nodeId === nodeId && x.key === key);
	if (!s) throw new Error(`no ${key} for ${nodeId}`);
	return s.values;
};

describe('RunSummary.unitEwr', () => {
	for (const seed of [3, 17, 41, 1486]) {
		it(`agrees with each unit's outflow and EWR series (seed ${seed})`, () => {
			const out = runModel(randomInput(seed, { maxNodes: 8, maxDays: 900 }));
			const units = out.summary.unitEwr!;
			const ids = [...out.summary.farms.map((f) => f.nodeId), ...(out.summary.users ?? []).map((u) => u.nodeId)];
			expect(units.map((u) => u.nodeId)).toEqual(ids);
			for (const u of units) {
				const U = values(out, u.nodeId, 'outflow');
				const Z = values(out, u.nodeId, 'ewr_cumulative');
				let req = 0;
				let met = 0;
				let flow = 0;
				for (let t = 0; t < U.length; t++) {
					req += Z[t]!;
					met += Math.min(U[t]!, Z[t]!);
					flow += U[t]!;
				}
				const tol = 1e-6 * Math.max(1, req);
				expect(Math.abs(u.requiredM3 - req), `${u.name} required`).toBeLessThanOrEqual(tol);
				// MIN(U, Z) and Z + AA differ only by the shortfall's float-noise tolerance (simulate.ts shortfall).
				expect(Math.abs(u.metM3 - met), `${u.name} met`).toBeLessThanOrEqual(tol);
				expect(Math.abs(u.outflowM3 - flow), `${u.name} outflow`).toBeLessThanOrEqual(1e-6 * Math.max(1, flow));
				expect(u.metM3).toBeLessThanOrEqual(u.requiredM3);
			}
		});
	}
});
