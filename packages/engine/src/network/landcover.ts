// Land-cover streamflow reductions (WP-1.35, docs/model.md §2.5a): invasive
// alien trees and forestry use more water than the vegetation they replaced,
// so each farm (hydrological unit) passes on less of its natural runoff.
//
// Per patch p on unit u: its share of the unit f_p = area × condensed cover ÷
// the unit's area, and its class's reductions at full cover (mar, lowFlow).
// They add up linearly per unit: MAR_u = Σ f_p mar_p, LOW_u = Σ f_p lowFlow_p.
// Each day, with I0 the unit's natural runoff and q its low-flow threshold
// (share × the catchment natural flow exceeded 75 % of the days):
//   reduction = LOW_u × MIN(I0, q) + MAR_u × MAX(I0 − q, 0)
// so low flows lose the low-flow share and the rest of the day's flow the
// MAR share, continuously in I0 (Scott & Smith 1997 report total and low-flow
// reductions separately; the WR2012 / Pitman approach applies them per unit).
// Pure: runModel and the self-checks both read patches through here.
import { LAND_COVER_CLASSES, type LandCoverClass, type NetworkNode, type ProjectModel } from '../project';
import { cmpStr } from '../order';

export interface UnitLandCover {
	/** Share of the part of each day's flow above the low-flow threshold that is removed, 0–1. */
	mar: number;
	/** Share of the part up to the threshold that is removed, 0–1. */
	lowFlow: number;
	/** Σ area × density per class on this unit (km²), for the summary. */
	condensedKm2: Partial<Record<LandCoverClass, number>>;
	/** The same patches' (mar, lowFlow) weights per class, so the reduction can be split by class. */
	byClass: Partial<Record<LandCoverClass, { mar: number; lowFlow: number }>>;
}

const clamp01 = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(Math.max(v, 0), 1) : fallback);

/**
 * Each farm's land cover, by node index; undefined for nodes without any. A
 * patch on a node that isn't a farm, or on a farm of no area, can't reduce
 * anything and is skipped with a warning; so is one naming no known node.
 * Patches that together cover more than the unit are scaled down to it.
 */
export function resolveLandCover(model: Pick<ProjectModel, 'nodes' | 'landCover'>, warnings: string[]): (UnitLandCover | undefined)[] {
	const nodes = model.nodes;
	const out: (UnitLandCover | undefined)[] = nodes.map(() => undefined);
	// Patches in (node id, patch id) order, so a unit's weights add up the same
	// to the last bit however the patches are listed (../order.ts).
	const patches = [...(model.landCover ?? [])].sort((a, b) => cmpStr(String(a.nodeId), String(b.nodeId)) || cmpStr(String(a.id), String(b.id)));
	if (!patches.length) return out;
	const index = new Map(nodes.map((n, i) => [n.id, i]));
	const cover = new Map<number, { f: number; cls: LandCoverClass; mar: number; lowFlow: number }[]>();
	for (const p of patches) {
		const i = index.get(p.nodeId);
		const n: NetworkNode | undefined = i === undefined ? undefined : nodes[i];
		if (i === undefined || !n) {
			warnings.push(`a land-cover patch refers to a node that does not exist; skipped`);
			continue;
		}
		if (n.kind !== 'farm' || !(n.areaKm2 > 0)) {
			warnings.push(`land cover on "${n.name}" skipped: it needs a farm with an area to reduce the runoff of`);
			continue;
		}
		const cls = LAND_COVER_CLASSES.find((c) => c.id === p.coverClass) ?? LAND_COVER_CLASSES.find((c) => c.id === 'other')!;
		const area = typeof p.areaKm2 === 'number' && Number.isFinite(p.areaKm2) && p.areaKm2 > 0 ? p.areaKm2 : 0;
		const f = (area * clamp01(p.densityPct, 0)) / n.areaKm2;
		if (!(f > 0)) continue;
		const list = cover.get(i) ?? [];
		list.push({ f, cls: cls.id, mar: clamp01(p.factors?.mar, cls.mar), lowFlow: clamp01(p.factors?.lowFlow, cls.lowFlow) });
		cover.set(i, list);
	}
	for (const [i, list] of cover) {
		const n = nodes[i]!;
		const total = list.reduce((s, x) => s + x.f, 0);
		const scale = total > 1 ? 1 / total : 1;
		if (total > 1)
			warnings.push(`land cover on "${n.name}" covers ${(total * 100).toFixed(0)} % of its ${n.areaKm2} km² (area × density); scaled down to the whole unit`);
		const u: UnitLandCover = { mar: 0, lowFlow: 0, condensedKm2: {}, byClass: {} };
		for (const x of list) {
			const f = x.f * scale;
			u.mar += f * x.mar;
			u.lowFlow += f * x.lowFlow;
			u.condensedKm2[x.cls] = (u.condensedKm2[x.cls] ?? 0) + f * n.areaKm2;
			const c = (u.byClass[x.cls] ??= { mar: 0, lowFlow: 0 });
			c.mar += f * x.mar;
			c.lowFlow += f * x.lowFlow;
		}
		// Float noise must not push a reduction past the runoff.
		u.mar = Math.min(u.mar, 1);
		u.lowFlow = Math.min(u.lowFlow, 1);
		out[i] = u;
	}
	return out;
}

/**
 * The catchment's low-flow threshold: natural flow exceeded on 75 % of the
 * days (its 25th percentile, linear between order statistics). 0 for an empty run.
 */
export function lowFlowThreshold(natural: ArrayLike<number>): number {
	const n = natural.length;
	if (n === 0) return 0;
	const sorted = Float64Array.from(natural).sort();
	const h = (n - 1) * 0.25;
	const lo = Math.floor(h);
	const hi = Math.min(lo + 1, n - 1);
	return sorted[lo]! + (h - lo) * (sorted[hi]! - sorted[lo]!);
}

/** The day's reduction of runoff I0 with threshold q: lowFlow × MIN(I0, q) + mar × MAX(I0 − q, 0), never more than I0. */
export function landCoverReduction(i0: number, q: number, u: { mar: number; lowFlow: number }): number {
	if (!(i0 > 0)) return 0;
	const low = Math.min(i0, Math.max(q, 0));
	return Math.min(u.lowFlow * low + u.mar * (i0 - low), i0);
}
