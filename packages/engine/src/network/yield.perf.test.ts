// Wall-clock budget of the firm-yield search (WP-3.6): the acceptance is a
// storage–yield curve for an example dam in under 60 s in a job. This runs it
// on a synthetic 30-year, 16-node catchment (no fixture needed) in the `perf`
// project (median of 3 after a warm-up; run alone, `pnpm test:engine:perf`),
// with a budget well inside the job's so a regression shows before it bites.
import { describe, expect, it } from 'vitest';
import type { Monthly } from '../calendar';
import type { ModelInput, NetworkNode } from '../project';
import { Rng } from '../random';
import { firmYield, prepareYield, storageYieldCurve } from './yield';

function catchment(): ModelInput {
	const rng = new Rng(20260926);
	const days = 30 * 365 + 7;
	const rain = Array.from({ length: days }, () => (rng.bool(0.25) ? rng.float(0, 40) : 0));
	const nodes: NetworkNode[] = [];
	for (let k = 0; k < 15; k++) {
		nodes.push({
			id: `f${k}`,
			name: `Farm ${k}`,
			kind: 'farm',
			downstreamNodeId: k === 0 ? 'out' : `f${Math.floor((k - 1) / 2)}`,
			sortOrder: k,
			areaKm2: rng.float(2, 20),
			areaHiKm2: 0,
			areaLoKm2: 0,
			flowShareManual: null,
			pctUpstreamToDam: rng.float(0, 1),
			pctRunoffToDam: rng.float(0.3, 1),
			damCapacityM3: rng.float(20_000, 400_000),
			damInitialPct: 0.8,
			damMinPct: 0.1,
			divertCapacityM3Day: rng.float(0, 2000),
			irrigationEfficiency: 0.8,
			lossReturnFraction: 0.5,
			damAreaFullM2: null,
			damAreaExponent: 0.7,
			damSeepagePerDay: 0.001
		});
	}
	nodes.push({ ...nodes[0]!, id: 'out', name: 'Outlet', kind: 'gauge', downstreamNodeId: null, sortOrder: 99, areaKm2: 0, damCapacityM3: 0 });
	return {
		settings: { apanMm: new Array(12).fill(180) as unknown as Monthly },
		model: {
			nodes,
			crops: [{ id: 'c1', name: 'Citrus', cropFactor: new Array(12).fill(0.7) }],
			cropAreas: nodes.filter((n) => n.kind === 'farm').map((n) => ({ nodeId: n.id, cropId: 'c1', areaM2: 200_000 })),
			transfers: []
		},
		series: { rain_catchment_mm: { startDate: '1990-10-01', values: rain } }
	};
}

function medianMs(n: number, run: () => void): number {
	run();
	const ms = Array.from({ length: n }, () => {
		const t0 = performance.now();
		run();
		return performance.now() - t0;
	}).sort((a, b) => a - b);
	return ms[Math.floor(n / 2)]!;
}

describe('firm-yield performance (synthetic 30-year, 16-node catchment)', () => {
	const input = catchment();

	it('one firm yield, prepare included, well under 5 s (median of 3)', () => {
		const ms = medianMs(3, () => {
			firmYield(input, 'f3');
		});
		expect(ms).toBeLessThan(5_000);
	});

	it('an 11-point storage–yield curve well under the 60 s job budget (median of 3)', () => {
		const p = prepareYield(input);
		const ms = medianMs(3, () => {
			storageYieldCurve(p, 'f3');
		});
		expect(ms).toBeLessThan(30_000);
	});
});
