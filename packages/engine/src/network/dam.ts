// Dam geometry and releases (WP-3.5, docs/model.md §2.7a): the survey curve
// that replaces the power-law area, the release rule and the seepage
// destination, resolved from a node as runModel runs them. Pure; the
// simulation (./simulate.ts) and the self-checks (../verify/checks.ts) both
// read a node through these, so a curve means the same thing to both.
import { waterYearIndex } from '../calendar';
import type { NetworkNode } from '../project';
import { damCurveProblem } from './damCurve';

/** A survey curve ready to interpolate: volumes strictly increasing from 0, areas non-decreasing, both ≥ 0. */
export interface DamCurve {
	volume: Float64Array;
	area: Float64Array;
}

/**
 * The node's survey curve, sorted by volume and anchored at an empty dam: a
 * curve whose lowest row stores water starts from (0 m³, 0 m²). null without
 * a usable curve (none entered, or one damCurveProblem rejects; runModel
 * warns about the latter and falls back to the power law).
 */
export function resolveDamCurve(n: Pick<NetworkNode, 'damCurve'>): DamCurve | null {
	const rows = n.damCurve;
	if (!rows || rows.length === 0 || damCurveProblem(rows)) return null;
	const s = [...rows].sort((a, b) => a.volumeM3 - b.volumeM3);
	const pts = s[0]!.volumeM3 > 0 ? [{ volumeM3: 0, areaM2: 0 }, ...s] : s;
	return { volume: Float64Array.from(pts, (p) => p.volumeM3), area: Float64Array.from(pts, (p) => p.areaM2) };
}

/**
 * The curve's area at storage q (m²) and its slope dA/dV there (per m),
 * linear between rows. Above the top row the area stays at the top row's
 * (a capacity just above the survey's top, within the ±1 % validation allows,
 * doesn't extrapolate a surface nobody measured). At a row the slope is the
 * segment above it's, so it is the one the dam fills into.
 */
export function curveAreaAt(c: DamCurve, q: number): { area: number; slope: number } {
	const v = c.volume;
	const a = c.area;
	const top = v.length - 1;
	if (!(q > 0)) return { area: a[0]!, slope: (a[1]! - a[0]!) / (v[1]! - v[0]!) };
	if (q >= v[top]!) return { area: a[top]!, slope: 0 };
	// Binary search: the last row at or below q.
	let lo = 0;
	let hi = top;
	while (hi - lo > 1) {
		const mid = (lo + hi) >> 1;
		if (v[mid]! <= q) lo = mid;
		else hi = mid;
	}
	const slope = (a[lo + 1]! - a[lo]!) / (v[lo + 1]! - v[lo]!);
	return { area: a[lo]! + slope * (q - v[lo]!), slope };
}

/**
 * A dam's release rule as the simulation runs it: `rule` 1 = pass inflow,
 * 2 = fixed; `m3DayByMonth[m]` for calendar month m (1–12), or null under
 * pass inflow for "the EWR required at this node"; `outletM3Day` the outlet
 * cap (Infinity = none). null = no release (rule 'none', no dam, or fixed
 * with no amounts).
 */
export interface PlanRelease {
	rule: 1 | 2;
	m3DayByMonth: Float64Array | null;
	outletM3Day: number;
}

export function resolveRelease(n: NetworkNode, warnings: string[]): PlanRelease | null {
	const rule = n.damReleaseRule ?? 'none';
	if (rule === 'none' || n.kind !== 'farm' || !(n.damCapacityM3 > 0)) return null;
	if (rule !== 'passInflow' && rule !== 'fixed') {
		warnings.push(`farm "${n.name}": unknown dam release rule "${String(rule)}"; no release`);
		return null;
	}
	const raw = n.damReleaseM3Day;
	let byMonth: Float64Array | null = null;
	if (Array.isArray(raw)) {
		if (raw.length !== 12) warnings.push(`farm "${n.name}": dam release should have 12 monthly values, has ${raw.length}; missing months are 0`);
		byMonth = new Float64Array(13);
		for (let m = 1; m <= 12; m++) {
			const x = Number(raw[waterYearIndex(m)]);
			byMonth[m] = Number.isFinite(x) && x > 0 ? x : 0;
		}
	}
	if (rule === 'fixed' && !byMonth) return null;
	const cap = n.damOutletCapacityM3Day;
	const outletM3Day = cap === null || cap === undefined ? Infinity : Number.isFinite(cap) && cap >= 0 ? cap : Infinity;
	if (cap !== null && cap !== undefined && outletM3Day === Infinity) warnings.push(`farm "${n.name}": outlet capacity ${String(cap)} m³/day is not a size ≥ 0; no limit`);
	return { rule: rule === 'passInflow' ? 1 : 2, m3DayByMonth: byMonth, outletM3Day };
}

/** Share of the dam's seepage returning below it (WP-3.5): 1 unless set, clamped to 0–1. */
export function seepageReturnOf(n: Pick<NetworkNode, 'damSeepageReturnPct'>): number {
	const r = n.damSeepageReturnPct;
	return typeof r === 'number' && Number.isFinite(r) ? Math.min(Math.max(r, 0), 1) : 1;
}

/**
 * Today's release (m³): under pass inflow, MIN(inflow to the dam, the flow
 * still needed below it, outlet, what the dam holds); under fixed, MIN(the
 * month's amount, outlet, storage above dead storage). `need` is the flow
 * to keep below the dam (the rule's amount or the EWR required at the node)
 * less what already passes it (S).
 */
export function releaseToday(r: PlanRelease, calendarMonth: number, inflow: number, ewrRequired: number, passing: number, avail: number, dead: number): number {
	if (r.rule === 1) {
		const target = r.m3DayByMonth ? r.m3DayByMonth[calendarMonth]! : ewrRequired;
		return Math.max(0, Math.min(inflow, target - passing, r.outletM3Day, avail));
	}
	return Math.max(0, Math.min(r.m3DayByMonth![calendarMonth]!, r.outletM3Day, avail - dead));
}
