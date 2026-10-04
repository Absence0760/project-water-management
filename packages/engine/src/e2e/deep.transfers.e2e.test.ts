// Deep end-to-end pass on dam rules of one priority (docs/model.md §2.6,
// engine 1.70.0's proportional rationing in rounds, issue #90 Q25/Q26): a
// small re-derivation of the documented sharing, written from model.md (not
// from network/simulate.ts), replayed over a few hundred seeded random
// networks of source dams and receiving dams (several sources into one
// receiver, empty and nearly empty sources, reserves, priorities, fixed
// releases on the receivers, receivers that fill), plus the properties the
// rounds promise: a split rule gets the same total, and no water is left
// that a receiver with room could have taken. Synthetic values only.
import { describe, expect, it } from 'vitest';
import type { Monthly } from '../calendar';
import type { ModelInput, ModelOutput, NetworkNode, Transfer } from '../project';
import { Rng } from '../random';
import { runModelWith, withVerification } from '../run';

const flat = (v: number) => new Array(12).fill(v) as number[];
function farm(id: string, over: Partial<NetworkNode> = {}): NetworkNode {
	return {
		id,
		name: `Unit ${id}`,
		kind: 'farm',
		downstreamNodeId: 'G',
		sortOrder: 0,
		areaKm2: 0,
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
const rule = (id: string, from: string, to: string, cap: number, reserve: number, priority: number): Transfer => ({
	id,
	fromNodeId: from,
	toNodeId: to,
	months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
	maxRateM3s: 1,
	dailyCapM3: cap,
	minStoragePct: reserve,
	enabled: true,
	priority,
	source: 'dam'
});
const series = (out: ModelOutput, id: string, key: string) => out.series.find((x) => x.nodeId === id && x.key === key)!.values;

interface Case {
	input: ModelInput;
	days: number;
	sources: string[];
	receivers: string[];
}
/** Source dams S0…, receiving dams R0… (no demand, no rain, no evaporation); one catchment unit with the runoff (none: dry). */
function randomCase(seed: number): Case {
	const g = new Rng(seed);
	const sources = Array.from({ length: g.int(1, 2) }, (_, k) => `S${k}`);
	const receivers = Array.from({ length: g.int(1, 4) }, (_, k) => `R${k}`);
	const nodes: NetworkNode[] = [farm('G', { kind: 'gauge', downstreamNodeId: null, sortOrder: 99 }), farm('A', { areaKm2: 1 })];
	for (const id of sources) {
		const cap = g.float(100, 4000);
		nodes.push(farm(id, { damCapacityM3: cap, damInitialPct: g.pick([0, 0.02, g.frac(), 1]), damMinPct: g.pick([0, 0, 0.2]) }));
	}
	for (const id of receivers) {
		const cap = g.float(100, 4000);
		const release = g.bool(0.3) ? { damReleaseRule: 'fixed' as const, damReleaseM3Day: flat(g.float(0, 300)), damOutletCapacityM3Day: g.pick([null, g.float(0, 200)]) } : {};
		// Often nearly full, so receivers fill and the rounds hand their sources' water on.
		nodes.push(farm(id, { damCapacityM3: cap, damInitialPct: g.pick([g.frac(), 0.9, 0.97]), ...release }));
	}
	const transfers: Transfer[] = [];
	const n = g.int(2, 8);
	for (let k = 0; k < n; k++) transfers.push(rule(`t${String.fromCharCode(97 + ((k * 5 + seed) % 26))}${k}`, g.pick(sources), g.pick(receivers), g.float(10, 2500), g.pick([0, 0, 0.3, 0.6]), g.pick([0, 0, 0, 1])));
	const days = 10;
	return {
		input: {
			settings: { ewrPragmaticM3PerDay: flat(0) as unknown as Monthly, apanMm: flat(0) as unknown as Monthly } as ModelInput['settings'],
			model: { nodes, crops: [], cropAreas: [], transfers, demandObjects: [] },
			series: { rain_catchment_mm: { startDate: '2021-01-01', values: new Array(days).fill(0) } }
		},
		days,
		sources,
		receivers
	};
}

/**
 * One day of dam rules as model.md §2.6 documents them (engine ≥ 1.70.0). By
 * priority, lowest first. A receiver's room: capacity − what it held
 * yesterday + a fixed release's MIN(amount, outlet) − what earlier priorities
 * moved into it. Within one priority, in rounds: (1) at each source, the water
 * left above each rule's reserve is shared in bands at the reserves (highest
 * first; the band between two reserves goes to the rules whose reserve is at
 * or below it), pro rata to what each still asks (its daily limit, less what
 * it moved); only rules into a receiver that isn't full ask; (2) each
 * receiver's room is shared by the rules into it pro rata to what their
 * sources gave, and a receiver given more than its room is full; (3) while a
 * receiver filled in the round, repeat. `maxRounds` 1 leaves step 3 out (to
 * count the days the cases need it).
 */
function refDay(
	rules: readonly { id: string; from: string; to: string; limit: number; reserve: number; priority: number }[],
	held: Map<string, number>,
	room0: Map<string, number>,
	maxRounds = Infinity
): Map<string, number> {
	const moved = new Map(rules.map((r) => [r.id, 0]));
	const drawn = new Map<string, number>();
	const into = new Map<string, number>();
	for (const p of [...new Set(rules.map((r) => r.priority))].sort((a, b) => a - b)) {
		const mine = rules.filter((r) => r.priority === p);
		const room = new Map([...new Set(mine.map((r) => r.to))].map((d) => [d, Math.max(0, room0.get(d)! - (into.get(d) ?? 0))]));
		const full = new Set([...room].filter(([, v]) => !(v > 0)).map(([d]) => d));
		const rem = new Map(mine.map((r) => [r.id, r.limit]));
		const taken = new Map<string, number>();
		for (let round = 0; round < maxRounds; round++) {
			const given = new Map<string, number>();
			for (const s of new Set(mine.map((r) => r.from))) {
				const act = mine.filter((r) => r.from === s && rem.get(r.id)! > 0 && !full.has(r.to)).map((r) => ({ r, left: rem.get(r.id)! }));
				let top = held.get(s)! - (drawn.get(s) ?? 0) - (taken.get(s) ?? 0);
				for (const f of [...new Set(act.map((a) => a.r.reserve))].sort((a, b) => b - a)) {
					const elig = act.filter((a) => a.r.reserve <= f && a.left > 0);
					const want = elig.reduce((x, a) => x + a.left, 0);
					const band = Math.max(0, top - f);
					const scale = want > band ? band / want : 1;
					for (const a of elig) {
						const v = a.left * scale;
						given.set(a.r.id, (given.get(a.r.id) ?? 0) + v);
						a.left -= v;
					}
					top = Math.min(top, f);
				}
			}
			let filled = false;
			for (const d of room.keys()) {
				if (full.has(d)) continue;
				const ins = mine.filter((r) => r.to === d && rem.get(r.id)! > 0);
				const total = ins.reduce((x, r) => x + (given.get(r.id) ?? 0), 0);
				const left = room.get(d)!;
				for (const r of ins) {
					const x = total > left ? ((given.get(r.id) ?? 0) * left) / total : (given.get(r.id) ?? 0);
					moved.set(r.id, moved.get(r.id)! + x);
					rem.set(r.id, rem.get(r.id)! - x);
					taken.set(r.from, (taken.get(r.from) ?? 0) + x);
				}
				if (total > left) {
					full.add(d);
					room.set(d, 0);
					filled = true;
				} else room.set(d, left - total);
			}
			if (!filled) break;
		}
		for (const r of mine) {
			drawn.set(r.from, (drawn.get(r.from) ?? 0) + moved.get(r.id)!);
			into.set(r.to, (into.get(r.to) ?? 0) + moved.get(r.id)!);
		}
	}
	return moved;
}

function replay(c: Case, out: ModelOutput): { bad: string | null; full: number; rounds: number } {
	const nodes = new Map(c.input.model.nodes.map((n) => [n.id, n]));
	// A rule keeps the higher of its own minimum and its source dam's minimum operating level (§2.6, Q5).
	const rules = c.input.model.transfers.map((tr) => {
		const src = nodes.get(tr.fromNodeId)!;
		return { id: tr.id, from: tr.fromNodeId, to: tr.toNodeId, limit: tr.dailyCapM3!, reserve: Math.max(tr.minStoragePct, src.damMinPct) * src.damCapacityM3, priority: tr.priority };
	});
	let full = 0;
	let rounds = 0;
	for (let t = 0; t < c.days; t++) {
		const prev = (id: string) => (t === 0 ? nodes.get(id)!.damInitialPct * nodes.get(id)!.damCapacityM3 : series(out, id, 'dam_storage')[t - 1]!);
		const held = new Map(c.sources.map((s) => [s, prev(s)]));
		const room0 = new Map(
			c.receivers.map((d) => {
				const n = nodes.get(d)!;
				const rel = n.damReleaseRule === 'fixed' ? Math.max(0, Math.min(n.damReleaseM3Day![0]!, n.damOutletCapacityM3Day ?? Infinity)) : 0;
				return [d, n.damCapacityM3 - prev(d) + rel];
			})
		);
		const ref = refDay(rules, held, room0);
		for (const r of rules) {
			const v = series(out, r.from, `transfer_rule@${r.id}`)[t]!;
			if (Math.abs(v - ref.get(r.id)!) > 1e-9 * Math.max(1, v)) return { bad: `day ${t} rule ${r.id}: engine ${v}, documented ${ref.get(r.id)}`, full, rounds };
		}
		for (const d of c.receivers) if (Math.abs(series(out, d, 'dam_storage')[t]! - nodes.get(d)!.damCapacityM3) < 1e-6) full++;
		// A day where room was offered again: some rule into a receiver with room left moved more than one round gave.
		const one = refDay(rules, held, room0, 1);
		if (rules.some((r) => Math.abs(one.get(r.id)! - ref.get(r.id)!) > 1e-6)) rounds++;
	}
	return { bad: null, full, rounds };
}
const SEEDS = Array.from({ length: 600 }, (_, k) => 4400 + k);

describe('deep: random dam-rule networks against the documented proportional rationing in rounds (§2.6, engine 1.70.0)', () => {
	it('every rule, every day, matches the re-derivation; the run’s self-checks pass; nothing overfills', () => {
		const bad: string[] = [];
		let full = 0;
		let rounds = 0;
		for (const seed of SEEDS) {
			const c = randomCase(seed);
			const out = withVerification(c.input, runModelWith(c.input, () => ({ naturalFlowM3Day: new Array(c.days).fill(0) })));
			const r = replay(c, out);
			if (r.bad) bad.push(`seed ${seed}: ${r.bad}`);
			if (!out.summary.verification?.passed) bad.push(`seed ${seed}: self-check ${JSON.stringify(out.summary.verification?.checks.filter((x) => !x.passed).map((x) => x.detail))}`);
			for (const d of c.receivers) for (const [t, q] of series(out, d, 'dam_storage').entries()) if (q > c.input.model.nodes.find((n) => n.id === d)!.damCapacityM3 * (1 + 1e-12)) bad.push(`seed ${seed}: ${d} day ${t} above capacity`);
			full += r.full;
			rounds += r.rounds;
			if (bad.length > 5) break;
		}
		expect(bad).toEqual([]);
		// The cases reach the room (receivers that fill) and the rounds (days a second round moved water): about 4 900
		// and 70 at writing.
		expect(full).toBeGreaterThan(1000);
		expect(rounds).toBeGreaterThan(40);
	});

	it('no water left on the table: after the day, every rule that still wants water goes to a full receiver or has a source with nothing above its reserve', () => {
		for (const seed of SEEDS.slice(0, 150)) {
			const c = randomCase(seed);
			const out = runModelWith(c.input, () => ({ naturalFlowM3Day: new Array(c.days).fill(0) }));
			const nodes = new Map(c.input.model.nodes.map((n) => [n.id, n]));
			// One priority only, so the whole day's rules share one pool.
			const rules = c.input.model.transfers.filter((tr) => tr.priority === 0);
			if (c.input.model.transfers.some((tr) => tr.priority !== 0)) continue;
			for (let t = 0; t < c.days; t++) {
				const prev = (id: string) => (t === 0 ? nodes.get(id)!.damInitialPct * nodes.get(id)!.damCapacityM3 : series(out, id, 'dam_storage')[t - 1]!);
				for (const tr of rules) {
					const v = series(out, tr.fromNodeId, `transfer_rule@${tr.id}`)[t]!;
					if (v >= tr.dailyCapM3! - 1e-6) continue;
					const d = nodes.get(tr.toNodeId)!;
					const rel = d.damReleaseRule === 'fixed' ? Math.max(0, Math.min(d.damReleaseM3Day![0]!, d.damOutletCapacityM3Day ?? Infinity)) : 0;
					const roomLeft = d.damCapacityM3 - prev(d.id) + rel - series(out, d.id, 'transfer')[t]!;
					const src = nodes.get(tr.fromNodeId)!;
					const sent = -series(out, src.id, 'transfer')[t]!;
					const above = prev(src.id) - sent - Math.max(tr.minStoragePct, src.damMinPct) * src.damCapacityM3;
					expect(Math.min(roomLeft, above), `seed ${seed} day ${t} rule ${tr.id}: room ${roomLeft}, water above its reserve ${above}`).toBeLessThan(1e-6 * Math.max(1, d.damCapacityM3, src.damCapacityM3));
				}
			}
		}
	});
});
