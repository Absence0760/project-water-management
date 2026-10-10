// The farm's surface take at the river intake, for a dam beside the river
// (engine ≥ 1.82.0, issue #513, docs/model.md §2.12). The allocation
// comparison's input only: the water balance is the simulation's, and nothing
// here feeds back into it (no cap reads it either, §2.12a).
//
// A dam beside the river fills from river water diverted into it. Its licence
// states the volume taken at the river intake (s21(a)) and the dam's volume
// (s21(b)) (the client's hydrologist, 2026-10-10, issue #507 item 1), so the
// farm's surface use is measured where the water leaves the river, not where
// it leaves the dam:
//
//   take = O + top-up + direct − MIN(spill, O + top-up) + received from dams on the river
//
// O is River to dam, top-up the river off-take water delivered into the dam,
// direct the river water that met the demand without passing the dam (the
// river pump, off-take water used, the unit's river abstractions), and the
// spill is netted at most the day's diversion: a farmer doesn't divert into a
// full dam. Draws from the dam are not counted again. Water a dam on the river
// gave it (a dam rule's transfer, a remote share) was counted nowhere else, so
// it counts here; water it got from another dam beside the river was already
// counted at that dam's intake.
//
// The other units keep §2.12's rule (draws are the use). Water one of them
// gets from a dam beside the river was counted at that dam's intake, so it is
// stored on it as `received_at_intake` and the comparison nets it against the
// unit's dam draw, like groundwater pumped into the dam.
//
// Pure, like the rest of the engine.
import type { NetworkPlan, NetworkResult } from '../network/simulate';

export const INTAKE_SERIES = {
	take: {
		key: 'intake_take',
		label: 'River water taken at the intake (River to dam, top-up off-takes and river water used directly, less the same day’s spill of diverted water): the surface use the allocation comparison counts',
		unit: 'm³/day'
	},
	received: {
		key: 'received_at_intake',
		label: 'Water received from a dam beside the river (a dam rule or a remote share), already counted at that dam’s intake',
		unit: 'm³/day'
	}
} as const;

/**
 * Whether unit i's dam is beside the river and fills from a diversion (engine ≥
 * 1.82.0): a farm with a dam (capacity > 0), a supply rule other than run of
 * river, River to dam above 0 (its capacity, or any month of River to dam by
 * month) or a river off-take that tops up its dam, and none of the upstream
 * inflow going into the dam (pctUpstreamToDam = 0: the river doesn't flow
 * through it). Its own runoff may still reach it; that isn't a river take
 * (the storage comparison covers the dam). A dam that takes any of the
 * upstream inflow is on the river and keeps §2.12's rule.
 */
export function takesAtIntake(plan: NetworkPlan, i: number): boolean {
	const n = plan.nodes[i]!;
	if (n.kind !== 'farm' || !(n.damCapacityM3 > 0) || n.supply?.rule === 3 || n.pctUpstreamToDam !== 0) return false;
	if (n.divertCapacityM3Day > 0 || n.divertM3DayByMonth?.some((v) => v > 0)) return true;
	return plan.offtakes?.some((o) => o.to === i && o.topUpDam) ?? false;
}

/**
 * Each unit's intake take (on a unit whose dam is beside the river) and the
 * water it received already counted at another dam's intake (on any other
 * unit a dam rule that can move water, or a remote share, reaches from such a
 * dam), per day, by node index.
 */
export function intakeTakes(plan: NetworkPlan, sim: NetworkResult): { take: Map<number, Float64Array>; received: Map<number, Float64Array> } {
	const take = new Map<number, Float64Array>();
	const received = new Map<number, Float64Array>();
	const n = plan.nodes.length;
	const atIntake = Array.from({ length: n }, (_, i) => takesAtIntake(plan, i));
	if (!atIntake.some(Boolean)) return { take, received };
	const days = plan.days;
	// What each unit got from other units' dams, split by whether that dam is beside the river.
	const fromRiverDams: (Float64Array | null)[] = new Array(n).fill(null);
	const fromIntakeDams: (Float64Array | null)[] = new Array(n).fill(null);
	const add = (to: number, from: number, v: ArrayLike<number>) => {
		const list = atIntake[from] ? fromIntakeDams : fromRiverDams;
		const a = (list[to] ??= new Float64Array(days));
		for (let t = 0; t < days; t++) a[t] = a[t]! + v[t]!;
	};
	// Dam rules (in plan order) and remote shares, each a fixed order, so the sums don't depend on the node order.
	// Only a rule that can move water (it has a series, ../network/transferSeries.ts canMove) is a leg, so which
	// units carry received_at_intake follows the model, never the day's values (a resumed run has the same columns).
	plan.transfers.forEach((tr, k) => {
		if (tr.seriesKey) add(tr.to, tr.from, sim.transfers[k]!);
	});
	for (let i = 0; i < n; i++) {
		const rm = plan.nodes[i]!.remote;
		const got = sim.nodes[i]!.remoteIn;
		if (rm && got) add(i, rm.from, got);
	}
	for (let i = 0; i < n; i++) {
		if (!atIntake[i]) {
			const got = fromIntakeDams[i];
			if (got) received.set(i, got);
			continue;
		}
		const r = sim.nodes[i]!;
		const w = sim.workings?.[i];
		const O = w?.divertedToDam;
		const toDam = w?.offtakeToDam;
		const used = w?.offtakeUsed;
		const ra = r.riverAbstraction;
		const rivers = r.riverTakes?.got ?? [];
		const other = fromRiverDams[i];
		const out = new Float64Array(days);
		for (let t = 0; t < days; t++) {
			const diverted = (O ? O[t]! : 0) + (toDam ? toDam[t]! : 0);
			let v = diverted - Math.min(r.spill[t]!, diverted);
			if (ra) v += ra[t]!;
			if (used) v += used[t]!;
			for (const x of rivers) v += x[t]!;
			if (other) v += other[t]!;
			out[t] = v;
		}
		take.set(i, out);
	}
	return { take, received };
}
