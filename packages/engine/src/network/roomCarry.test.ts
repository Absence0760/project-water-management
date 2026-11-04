// A receiver's room across priorities (engine 1.114.0, docs/model.md §2.6): what a priority leaves of a
// receiver's room is the next priority's to share, carried, not worked out again from the dam's storage less
// what came in. The two are the same number but for float noise, and a receiver an earlier priority filled
// exactly could then show 1e-14 of room: its rules at the next priority drew band shares from their source they
// could never take, and the other receiver's room was shared by those diluted shares (the cross-check's dense-55,
// verify/). Invented numbers of that case's shape, found by search: a full dam that rain, evaporation and
// seepage move off its capacity; without the carry, s1 took 199.249 here and s2c 13.532.
import { describe, expect, it } from 'vitest';
import type { Monthly } from '../calendar';
import type { DemandObject, ModelInput, NetworkNode, RunSeries, Transfer } from '../project';
import { runModelWith, withVerification } from '../run';

const flat = (v: number) => new Array(12).fill(v);
function node(id: string, over: Partial<NetworkNode> = {}): NetworkNode {
	return { id, name: id, kind: 'farm', downstreamNodeId: 'G', sortOrder: 0, areaKm2: 0, pctUpstreamToDam: 0, pctRunoffToDam: 0, damCapacityM3: 0, damInitialPct: 0, damMinPct: 0, divertCapacityM3Day: 0, irrigationEfficiency: 1, returnFlowFraction: 0, damAreaFullM2: 0, damAreaExponent: 0.7, damSeepagePerDay: 0, ...over };
}
const town = (nodeId: string, m3Day: number): DemandObject => ({ id: `town-${nodeId}`, nodeId, name: 'Town', category: 'municipal', sizing: 'monthly', monthlyM3Day: flat(m3Day), count: null, litresPerUnitDay: null, lossPct: 0, monthlyFactor: null, returnPct: 0, priority: 'first', destination: 'internal', enabled: true, note: '' });
const rule = (id: string, from: string, to: string, m3Day: number, over: Partial<Transfer> = {}): Transfer => ({ id, fromNodeId: from, toNodeId: to, months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], maxRateM3s: m3Day / 86_400, dailyCapM3: null, minStoragePct: 0, enabled: true, priority: 1, ...over });
const get = (out: { series: RunSeries[] }, n: string, k: string) => out.series.find((s) => s.nodeId === n && s.key === k)!.values;

describe('a receiver an earlier priority filled has no room at the next', () => {
	it('shares the other receiver’s room by the source’s bands as if the full one asked nothing', () => {
		// B: a full dam with rain and evaporation on it and a town, so its room is a sum of several terms. A fills it at
		// priority 0. At priority 1 the small dam S sends to B (full) and to C, its rules keeping 20 % and 10 %.
		const nodes = [
			node('G', { kind: 'gauge', downstreamNodeId: null, sortOrder: 9 }),
			node('A', { sortOrder: 1, damCapacityM3: 1e6, damInitialPct: 1 }),
			node('B', { sortOrder: 2, damCapacityM3: 26_686, damInitialPct: 1, damAreaFullM2: 1000 + 13 * 37.3, damSeepagePerDay: 0.000_82 }),
			node('S', { sortOrder: 3, damCapacityM3: 287, damInitialPct: 1, damMinPct: 0.1 }),
			node('C', { sortOrder: 4, damCapacityM3: 212.781, damInitialPct: 0 })
		];
		const transfers = [
			rule('a', 'A', 'B', 1e5, { priority: 0 }),
			rule('s1', 'S', 'C', 4_606.916, { minStoragePct: 0.2 }),
			rule('s2c', 'S', 'C', 64.751),
			rule('s2b', 'S', 'B', 90.594)
		];
		const input: ModelInput = {
			settings: { ewrPragmaticM3PerDay: flat(0) as unknown as Monthly, apanMm: flat(126) as unknown as Monthly },
			model: { nodes, crops: [], cropAreas: [], transfers, demandObjects: [town('B', 100 + 13 * 9.71)] },
			series: { rain_catchment_mm: { startDate: '2021-01-01', values: [3 + 13 * 1.13] } }
		};
		const out = withVerification(input, runModelWith(input, () => ({ naturalFlowM3Day: [0] })));
		expect(out.summary.verification?.passed, JSON.stringify(out.summary.verification?.checks.filter((c) => !c.passed))).toBe(true);
		// B took its room from A, so S's rule into B takes nothing and draws no band share. S holds 287: the band
		// 287–57.4 is shared 4 606.916 : 64.751 by the rules into C, the band 57.4–28.7 goes to s2c alone, and C's
		// 212.781 of room is shared by what they were given.
		expect(get(out, 'S', 'transfer_rule@s2b')[0]).toBe(0);
		const band1 = 287 - 57.4;
		const g1 = (band1 * 4_606.916) / (4_606.916 + 64.751);
		const g2 = band1 - g1 + 28.7;
		expect(get(out, 'S', 'transfer_rule@s1')[0]).toBeCloseTo((212.781 * g1) / (g1 + g2), 9);
		expect(get(out, 'S', 'transfer_rule@s2c')[0]).toBeCloseTo((212.781 * g2) / (g1 + g2), 9);
	});
});
