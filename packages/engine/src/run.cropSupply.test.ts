// The crop supply table (engine ≥ 1.73.0, issue #408, docs/model.md §2.7k):
// a unit's crop demand asked in fixed shares of its own dam side, the river
// at the unit and the dam of another unit. Hand-worked cases on a fixed
// natural flow, the one-source tables running to the bit as the crops' water
// source, and the remote share's order and loops.
import { describe, expect, it } from 'vitest';
import type { ModelInput, NetworkNode } from './project';
import { runModelWith, runModelWithoutChecks, withVerification } from './run';
import { randomInput } from './testing/fuzz';
import { orderFreeDifference, sameOutput } from './testing/invariants';

function node(id: string, kind: NetworkNode['kind'], down: string | null, over: Partial<NetworkNode> = {}): NetworkNode {
	return {
		id,
		name: id,
		kind,
		downstreamNodeId: down,
		sortOrder: 0,
		areaKm2: kind === 'farm' ? 1 : 0,
		areaHiKm2: 0,
		areaLoKm2: 0,
		flowShareManual: null,
		pctUpstreamToDam: 0,
		pctRunoffToDam: 0,
		damCapacityM3: 0,
		damInitialPct: 0,
		damMinPct: 0,
		divertCapacityM3Day: 0,
		irrigationEfficiency: 1,
		returnFlowFraction: 0,
		damAreaFullM2: 0,
		damAreaExponent: 0.7,
		damSeepagePerDay: 0,
		...over
	};
}

const flat = (v: number) => new Array(12).fill(v) as number[];

/**
 * A January run of dry days. Units B and A each get half the natural flow
 * as runoff; B drains into A, A into the outlet gauge G (unless `nodes`
 * says otherwise). A's crops need `need` m³/day (31 000 m² of a crop with
 * factor 1 and the January A-pan set to the need, efficiency 1, no
 * effective rain).
 */
function input(a: Partial<NetworkNode>, b: Partial<NetworkNode>, need: number, days: number, nodes?: NetworkNode[]): ModelInput {
	const apanMm = new Array(12).fill(0);
	apanMm[3] = need;
	return {
		settings: { apanMm: apanMm as never, effectiveRainFraction: 0, ewrPragmaticM3PerDay: flat(0) as never },
		model: {
			nodes: nodes ?? [node('G', 'gauge', null), node('A', 'farm', 'G', a), node('B', 'farm', 'A', b)],
			crops: [{ id: 'c', name: 'Crop', cropFactor: flat(1) }],
			cropAreas: need > 0 ? [{ nodeId: 'A', cropId: 'c', areaM2: 31_000 }] : [],
			transfers: []
		},
		series: { rain_catchment_mm: { startDate: '2021-01-01', values: new Array(days).fill(0) } }
	};
}

const run = (i: ModelInput, natural: number[]) => withVerification(i, runModelWith(i, () => ({ naturalFlowM3Day: natural })));
const col = (o: ReturnType<typeof run>, id: string | null, key: string) => o.series.find((s) => s.nodeId === id && s.key === key)?.values;
const passed = (o: ReturnType<typeof run>) => expect(o.summary.verification!.passed, JSON.stringify(o.summary.verification!.checks.filter((c) => !c.passed))).toBe(true);
const close = (got: readonly number[] | undefined, want: number[]) => {
	expect(got).toBeDefined();
	got!.forEach((v, t) => expect(v, `day ${t}`).toBeCloseTo(want[t]!, 6));
};

// B: a full 10 000 m³ dam taking all its runoff, no crops. A: a 10 000 m³ dam at half, half its runoff into it.
const fullB = { damCapacityM3: 10_000, damInitialPct: 1, pctRunoffToDam: 1 };
const damA = { damCapacityM3: 10_000, damInitialPct: 0.5, pctRunoffToDam: 0.5 };
const table = (dam: number, river: number, remote: number, over: Partial<NetworkNode> = {}): Partial<NetworkNode> => ({ cropShareDam: dam, cropShareRiver: river, cropShareRemote: remote, cropRemoteNodeId: 'B', ...over });

describe('crop supply table (engine 1.73.0, docs/model.md §2.7k)', () => {
	it('asks each source for its share: the dam side, the river past the dam, and the other unit’s dam before its spill', () => {
		// Demand 300: dam 150, river 90, B's dam 60. B (full, its 1000 of runoff in) gives 60 and spills 940;
		// A's dam gets M = 500 and gives 150; the river past A's dam (H 940 + N 500) gives 90.
		const o = run(input({ ...damA, ...table(0.5, 0.3, 0.2) }, fullB, 300, 2), [2000, 2000]);
		passed(o);
		close(col(o, 'A', 'supplied'), [300, 300]);
		close(col(o, 'A', 'deficit'), [0, 0]);
		close(col(o, 'A', 'remote_dam_in'), [60, 60]);
		close(col(o, 'B', 'remote_dam_out'), [60, 60]);
		close(col(o, 'A', 'river_take@crops'), [90, 90]);
		close(col(o, 'B', 'spill'), [940, 940]);
		close(col(o, 'B', 'dam_storage'), [10_000, 10_000]);
		close(col(o, 'A', 'dam_storage'), [5350, 5700]);
		close(col(o, 'A', 'outflow'), [1350, 1350]);
		expect(o.summary.warnings.some((w) => w.includes('no pipe capacity is set'))).toBe(true);
	});

	it('never passes one source’s shortfall to another: an empty other dam leaves its share as a deficit', () => {
		// B at its dead storage (and taking no runoff) gives nothing; A's dam has plenty but is asked for its share only.
		const emptyB = { damCapacityM3: 10_000, damInitialPct: 0.2, damMinPct: 0.2 };
		const o = run(input({ ...damA, ...table(0.5, 0.3, 0.2) }, emptyB, 300, 2), [2000, 2000]);
		passed(o);
		close(col(o, 'A', 'remote_dam_in'), [0, 0]);
		close(col(o, 'A', 'deficit'), [60, 60]);
		close(col(o, 'B', 'dam_storage'), [2000, 2000]);
	});

	it('comes after the other unit’s own demand, takes only what is above its dead storage, and is held to the pipe', () => {
		// B: 1000 above dead storage, its own crops need 900 first (its own unit's demand); A asks 300 × 0.5 = 150, gets 100.
		const nodes = [
			node('G', 'gauge', null),
			node('A', 'farm', 'G', { ...damA, ...table(0.5, 0, 0.5) }),
			node('B', 'farm', 'A', { damCapacityM3: 10_000, damInitialPct: 0.3, damMinPct: 0.2 })
		];
		const i = input({}, {}, 300, 1, nodes);
		i.model.cropAreas.push({ nodeId: 'B', cropId: 'c', areaM2: 93_000 });
		const o = run(i, [0]);
		passed(o);
		close(col(o, 'B', 'supplied'), [900]);
		close(col(o, 'A', 'remote_dam_in'), [100]);
		close(col(o, 'B', 'dam_storage'), [2000]);
		close(col(o, 'A', 'deficit'), [50]);
		// A pipe of 40 m³/day holds it to 40.
		const capped = input({}, {}, 300, 1, structuredClone(nodes));
		capped.model.nodes[1]!.cropRemoteCapM3Day = 40;
		capped.model.cropAreas.push({ nodeId: 'B', cropId: 'c', areaM2: 93_000 });
		const c = run(capped, [0]);
		passed(c);
		close(col(c, 'A', 'remote_dam_in'), [40]);
		close(col(c, 'B', 'dam_storage'), [2060]);
	});

	it('shares a short dam between its receivers pro rata to their asks, however the nodes are listed', () => {
		// B has 100 above dead storage; A asks 150, C asks 50 (C: 31 000 m² needing 100, half from B): A 75, C 25.
		const mk = (rev: boolean, checked = true) => {
			const nodes = [
				node('G', 'gauge', null),
				node('A', 'farm', 'G', { ...damA, ...table(0.5, 0, 0.5) }),
				node('C', 'farm', 'G', table(0.5, 0, 0.5)),
				node('B', 'farm', 'A', { damCapacityM3: 10_000, damInitialPct: 0.21, damMinPct: 0.2 })
			];
			const i = input({}, {}, 300, 1, rev ? nodes.reverse() : nodes);
			i.model.cropAreas.push({ nodeId: 'C', cropId: 'c', areaM2: 31_000 / 3 });
			return checked ? run(i, [0]) : runModelWith(i, () => ({ naturalFlowM3Day: [0] }));
		};
		const o = mk(false);
		passed(o);
		close(col(o, 'A', 'remote_dam_in'), [75]);
		close(col(o, 'C', 'remote_dam_in'), [25]);
		close(col(o, 'B', 'remote_dam_out'), [100]);
		// Without the self-checks' summary, whose largest residual names the first node listed when several tie at 0.
		expect(orderFreeDifference(mk(false, false), mk(true, false))).toBeNull();
	});

	it('skips a dam the unit drains into, with a warning, and the share is a deficit', () => {
		// A drains into B: B is simulated after A, so its dam can't supply A the same day.
		const nodes = [node('G', 'gauge', null), node('B', 'farm', 'G', fullB), node('A', 'farm', 'B', { ...damA, ...table(0.5, 0, 0.5) })];
		const o = run(input({}, {}, 300, 1, nodes), [2000]);
		passed(o);
		expect(o.summary.warnings.some((w) => w.includes('drains into "B"'))).toBe(true);
		expect(col(o, 'A', 'remote_dam_in')).toBeUndefined();
		close(col(o, 'A', 'deficit'), [150]);
	});

	it('a table all on the dam, or all on the river, runs to the bit as the crops’ water source', () => {
		for (let seed = 1; seed <= 30; seed++) {
			const base = randomInput(seed);
			// The generator's own tables (addCropSupply) out, so each unit's crops are on their water source.
			for (const n of base.model.nodes) n.cropShareDam = n.cropShareRiver = n.cropShareRemote = null;
			const dam = structuredClone(base);
			for (const n of dam.model.nodes) {
				if (n.kind !== 'farm' || n.cropWaterSource === 'river') continue;
				Object.assign(n, { cropShareDam: 1, cropShareRiver: 0, cropShareRemote: null, cropWaterSource: 'river' });
			}
			expect(sameOutput(runModelWithoutChecks(base), runModelWithoutChecks(dam)), `seed ${seed} dam`).toBe(true);
			const river = structuredClone(base);
			for (const n of river.model.nodes) {
				if (n.kind !== 'farm' || n.cropWaterSource !== 'river') continue;
				Object.assign(n, { cropShareDam: 0, cropShareRiver: 1, cropShareRemote: 0, cropWaterSource: 'dam' });
			}
			expect(sameOutput(runModelWithoutChecks(base), runModelWithoutChecks(river)), `seed ${seed} river`).toBe(true);
		}
	});
});
