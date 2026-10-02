// A water source per demand (engine ≥ 1.65.0, issue #344, docs/model.md
// §2.7j): a unit's crops and each of its demand objects draw either on the
// dam side (the unit's supply rule, every engine before 1.65.0) or on the
// river through a river abstraction of their own, with its own pump and an
// optional pool, beside the dam. Pure; the simulation (./simulate.ts), the
// run (../run.ts) and the self-checks (../verify/checks.ts) read a demand's
// source through these, so a stored value means the same thing to each.
import { DAM_AREA_EXPONENT, estimatedDamAreaM2, type DemandObject, type NetworkNode } from '../project';

/**
 * A pool at a river abstraction's pump (engine ≥ 1.65.0, after draft PR
 * #341's run-of-river pool): in-channel storage the pump draws down once the
 * flow it may take is used, refilled from the flow above what must pass the
 * unit. It starts the run full; its surface area is estimated from its
 * capacity, as an unknown dam area is (§2.7a).
 */
export interface PlanPool {
	/** Capacity, m³ (> 0). */
	capM3: number;
	/** Surface area when full, m²: A = areaFullM2 × (storage / capacity)^DAM_AREA_EXPONENT. */
	areaFullM2: number;
}

/** One river abstraction as the simulation runs it. */
export interface PlanTake {
	/** 'crops', or the demand object's id: the `<key>` of its series. */
	key: string;
	name: string;
	/** The demand object's index in the unit's plan objects; −1 for the crops. */
	obj: number;
	/** The pump's capacity, m³/day; Infinity = no limit. */
	pumpM3Day: number;
	pool?: PlanPool;
}

/** A unit's river abstractions; absent on a unit whose demands all draw on the dam. */
export interface PlanRiver {
	takes: PlanTake[];
	/** Whether the crops draw on the river. */
	cropsOnRiver: boolean;
	/** 1 = the plan object at that index draws on the river. */
	objOnRiver: Uint8Array;
}

/** The key of the crops' river abstraction in its series. */
export const CROPS_TAKE_KEY = 'crops';

/**
 * A river abstraction's run series, on its unit, `<prefix><key>` with key
 * 'crops' or the demand object's id, the `<kind>@<id>` shape of the demand
 * objects' series.
 */
export const RIVER_TAKE_SERIES = {
	take: { prefix: 'river_take@', label: (name: string) => `River abstraction "${name}": pumped (part of supplied)`, unit: 'm³/day' },
	pool: { prefix: 'river_pool@', label: (name: string) => `River abstraction "${name}": pool storage (end of the day)`, unit: 'm³' },
	poolEvaporation: { prefix: 'river_pool_evaporation@', label: (name: string) => `River abstraction "${name}": evaporation from the pool`, unit: 'm³/day' },
	/** Engine ≥ 1.66.0, only with a pump capacity: the demand its pump left unmet although the river (or its pool) had it. */
	pumpLimited: { prefix: 'river_pump_limited@', label: (name: string) => `River abstraction "${name}": demand the pump capacity left unmet (the river had it)`, unit: 'm³/day' }
} as const;

export const riverTakeKey = (key: string): string => `${RIVER_TAKE_SERIES.take.prefix}${key}`;
export const riverPoolKey = (key: string): string => `${RIVER_TAKE_SERIES.pool.prefix}${key}`;
export const riverPoolEvaporationKey = (key: string): string => `${RIVER_TAKE_SERIES.poolEvaporation.prefix}${key}`;
export const riverPumpLimitedKey = (key: string): string => `${RIVER_TAKE_SERIES.pumpLimited.prefix}${key}`;

/** Whether a river abstraction publishes its pump-limited series (engine ≥ 1.66.0): only with a pump capacity (a finite one; 0 = no pump). */
export const hasPumpLimit = (take: Pick<PlanTake, 'pumpM3Day'>): boolean => Number.isFinite(take.pumpM3Day);

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Whether a demand's water source is the river: only 'river' is; null, absent and 'dam' are the dam. */
export const onRiver = (source: unknown): boolean => source === 'river';

/**
 * A pump capacity as the run uses it: Infinity for null / absent (no limit,
 * with a warning: a river take with no capacity is limited only by the
 * flow), else the size; a value that isn't a size ≥ 0 runs as no limit with
 * a warning (the API refuses it on save).
 */
function pumpOf(raw: unknown, who: string, warnings: string[]): number {
	if (raw === null || raw === undefined) {
		warnings.push(`${who}: no river pump capacity is set, so what it pumps from the river is limited only by the flow`);
		return Infinity;
	}
	if (finite(raw) && raw >= 0) return raw;
	warnings.push(`${who}: river pump capacity ${String(raw)} m³/day is not a size ≥ 0; no limit`);
	return Infinity;
}

/** A pool as the run uses it: none for null / absent / 0, else its capacity and estimated area; one that isn't a size runs as none, with a warning. */
function poolOf(raw: unknown, who: string, warnings: string[]): PlanPool | undefined {
	if (raw === null || raw === undefined || raw === 0) return undefined;
	if (!finite(raw) || raw < 0) {
		warnings.push(`${who}: pool capacity ${String(raw)} m³ is not a size ≥ 0; no pool`);
		return undefined;
	}
	return { capM3: raw, areaFullM2: estimatedDamAreaM2(raw) };
}

/**
 * A unit's river abstractions for the plan (engine ≥ 1.65.0): the crops'
 * when `cropWaterSource` is 'river', then each plan object's whose
 * `waterSource` is 'river', in plan-object order (id order). {} when none,
 * so the unit runs exactly as engines before 1.65.0 did. A crop water source
 * on a node that isn't a farm, and an unknown source, run as the dam with a
 * warning (the API refuses both on save).
 */
export function riverSourcesOf(n: NetworkNode, objects: readonly DemandObject[] | undefined, warnings: string[]): { river?: PlanRiver } {
	const cs = n.cropWaterSource;
	if (cs !== undefined && cs !== null && cs !== 'dam' && cs !== 'river') warnings.push(`unit "${n.name}": unknown crop water source "${String(cs)}"; the dam`);
	if (n.kind !== 'farm') {
		if (onRiver(cs)) warnings.push(`${n.kind === 'user' ? 'user' : 'gauge'} "${n.name}": only a unit's crops have a water source; ignored`);
		return {};
	}
	const takes: PlanTake[] = [];
	const cropsOnRiver = onRiver(cs);
	if (cropsOnRiver) {
		const who = `unit "${n.name}": the crops' river abstraction`;
		const pool = poolOf(n.cropRiverPoolM3, who, warnings);
		takes.push({ key: CROPS_TAKE_KEY, name: `${n.name}: crops`, obj: -1, pumpM3Day: pumpOf(n.cropRiverPumpM3Day, who, warnings), ...(pool ? { pool } : {}) });
	}
	const list = objects ?? [];
	const objOnRiver = new Uint8Array(list.length);
	list.forEach((o, k) => {
		const s = o.waterSource;
		if (s !== undefined && s !== null && s !== 'dam' && s !== 'river') warnings.push(`demand object "${o.name}": unknown water source "${String(s)}"; the dam`);
		if (!onRiver(s)) return;
		objOnRiver[k] = 1;
		const who = `demand object "${o.name}"`;
		const pool = poolOf(o.riverPoolM3, who, warnings);
		takes.push({ key: o.id, name: o.name, obj: k, pumpM3Day: pumpOf(o.riverPumpM3Day, who, warnings), ...(pool ? { pool } : {}) });
	});
	if (!takes.length) return {};
	return { river: { takes, cropsOnRiver, objOnRiver } };
}

/**
 * A pool's surface area and evaporation today, from its start-of-day storage
 * `prev` (A = A_full × (prev / capacity)^b, the dams' small-reservoir
 * exponent b), at most what it holds. Returns [area, evaporation].
 */
export function poolLosses(pool: PlanPool, prev: number, evapMmDay: number): [number, number] {
	if (!(prev > 0)) return [0, 0];
	const A = pool.areaFullM2 * Math.pow(Math.min(prev / pool.capM3, 1), DAM_AREA_EXPONENT);
	return [A, Math.min((evapMmDay * A) / 1000, prev)];
}

/** What riverTakesDay writes per abstraction (index = take). */
export interface TakeDay {
	/** Pumped today, flow + pool (m³). */
	got: Float64Array;
	/** The part of `got` drawn from the pool. */
	fromPool: Float64Array;
	/** What the pool refilled from the flow. */
	refill: Float64Array;
	/**
	 * The demand its pump capacity left unmet although the water was there
	 * (engine ≥ 1.66.0): MIN(its demand − got, the flow left after its level
	 * + its own pool, the allocation room left after its level), only once
	 * its pump is spent; 0 otherwise.
	 */
	pumpLimited: Float64Array;
	/** Scratch, one per take, kept between days so the day loop allocates nothing: what is left of each pump, and what each still wants in a level. */
	pumpLeft: Float64Array;
	want: Float64Array;
}

/** A unit's TakeDay for `n` river abstractions. */
export const takeDayFor = (n: number): TakeDay => ({
	got: new Float64Array(n),
	fromPool: new Float64Array(n),
	refill: new Float64Array(n),
	pumpLimited: new Float64Array(n),
	pumpLeft: new Float64Array(n),
	want: new Float64Array(n)
});

/**
 * What the pumps of level `l` left unmet (engine ≥ 1.66.0, docs/model.md
 * §2.7j): for each abstraction there whose pump is spent and whose demand
 * isn't met, what was still there for it once its level had taken: the flow
 * left plus its own pool, within the allocation room left. Only a spent pump
 * can leave any: one with pump left took all the flow, pool and room there
 * was. Later levels rank below it, so what they take was its for the asking.
 */
function notePumpLimited(takes: readonly PlanTake[], level: ArrayLike<number>, l: number, want: ArrayLike<number>, flow: number, left: number, held: Float64Array, out: TakeDay): void {
	for (let a = 0; a < takes.length; a++) {
		if (level[a] !== l) continue;
		const pump = takes[a]!.pumpM3Day;
		if (!Number.isFinite(pump) || out.pumpLeft[a]! > 1e-12 * Math.max(1, pump)) continue;
		const unmet = want[a]! - out.got[a]!;
		const there = Math.min(flow + (takes[a]!.pool ? held[a]! : 0), left);
		if (unmet > 0 && there > 0) out.pumpLimited[a] = Math.min(unmet, there);
	}
}

/**
 * The river abstractions' day (engine ≥ 1.65.0, docs/model.md §2.7j), after
 * the unit's dam side: by supply level (0 first), each abstraction wants
 * MIN(its demand `want`, what is left of its pump); the level shares the
 * flow it may take, `free`, pro rata to what each wants, and what the flow
 * can't give each draws from its own pool (`held`, after evaporation), all
 * within the surface allocation room `room` (Infinity without a cap). Then
 * each pool refills from the flow left, pro rata to its room, up to its
 * capacity. An abstraction whose pump ran out first records what was still
 * there for it in `pumpLimited` (notePumpLimited, engine ≥ 1.66.0); that
 * changes nothing else. `held` is updated in place to each pool's storage at the end of
 * the day (0 without a pool). Returns the flow taken out of the river
 * (Σ from the flow + Σ refill).
 */
export function riverTakesDay(takes: readonly PlanTake[], level: ArrayLike<number>, levels: number, want: ArrayLike<number>, free: number, room: number, held: Float64Array, out: TakeDay): number {
	const n = takes.length;
	const pumpLeft = out.pumpLeft;
	for (let a = 0; a < n; a++) {
		pumpLeft[a] = takes[a]!.pumpM3Day;
		out.got[a] = 0;
		out.fromPool[a] = 0;
		out.refill[a] = 0;
		out.pumpLimited[a] = 0;
	}
	let flow = Math.max(free, 0);
	let left = room;
	let taken = 0;
	const w = out.want;
	for (let l = 0; l < levels; l++) {
		let total = 0;
		for (let a = 0; a < n; a++) {
			if (level[a] !== l) continue;
			w[a] = Math.max(0, Math.min(want[a]! - out.got[a]!, pumpLeft[a]!));
			total += w[a]!;
		}
		if (!(total > 0) || !(left > 0)) {
			notePumpLimited(takes, level, l, want, flow, left, held, out);
			continue;
		}
		// The flow first, pro rata within the level, within the room.
		const fromFlow = Math.min(total, flow, left);
		const f = fromFlow / total;
		let poolWant = 0;
		for (let a = 0; a < n; a++) {
			if (level[a] !== l || !(w[a]! > 0)) continue;
			const v = f < 1 ? w[a]! * f : w[a]!;
			out.got[a]! += v;
			pumpLeft[a]! -= v;
			w[a] = w[a]! - v;
			if (takes[a]!.pool) poolWant += Math.min(w[a]!, held[a]!);
		}
		// Exactly the flow there was when the level takes all of it (a pro-rata residue would leave float noise).
		flow = fromFlow >= flow ? 0 : flow - fromFlow;
		left -= fromFlow;
		taken += fromFlow;
		// Then each abstraction's own pool, within what is left of the room.
		if (poolWant > 0 && left > 0) {
			const g = poolWant > left ? left / poolWant : 1;
			let drawn = 0;
			for (let a = 0; a < n; a++) {
				if (level[a] !== l || !takes[a]!.pool || !(w[a]! > 0)) continue;
				const v = Math.min(w[a]!, held[a]!) * g;
				out.got[a]! += v;
				out.fromPool[a]! += v;
				pumpLeft[a]! -= v;
				held[a] = Math.max(0, held[a]! - v);
				drawn += v;
			}
			left -= drawn;
		}
		notePumpLimited(takes, level, l, want, flow, left, held, out);
	}
	// Each pool refills from the flow left, pro rata to its room.
	let roomSum = 0;
	for (let a = 0; a < n; a++) if (takes[a]!.pool) roomSum += Math.max(0, takes[a]!.pool!.capM3 - held[a]!);
	if (roomSum > 0 && flow > 0) {
		const g = flow >= roomSum ? 1 : flow / roomSum;
		for (let a = 0; a < n; a++) {
			const p = takes[a]!.pool;
			if (!p) continue;
			const r = Math.max(0, p.capM3 - held[a]!);
			const v = g === 1 ? r : r * g;
			out.refill[a] = v;
			// A full refill lands exactly on the capacity.
			held[a] = g === 1 ? Math.max(held[a]!, p.capM3) : held[a]! + v;
			taken += v;
		}
	}
	return taken;
}
