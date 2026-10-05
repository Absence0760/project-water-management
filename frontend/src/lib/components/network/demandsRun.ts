// The Demands grid's run columns (docs/ui.md § Demands grid): what the latest
// run supplied each demand and how short it fell, from the run summary. A
// demand object reads its own DemandObjectSummary; a unit's crops read the
// unit's figures less its objects' (the summary's own rule: the irrigation
// part is avgDemandM3Day − Σ the objects'); another water user reads its
// UserSummary. A row the run doesn't have (added since, or an object that
// was off) has no figure.
import type { RunSummary } from '@water-management/engine';
import type { DemandRow } from './demands';

export interface RunFigure {
	/** Mean demand over the run, m³/day. */
	demandM3Day: number;
	/** Mean supplied, m³/day. */
	suppliedM3Day: number;
	/** Mean short-fall, m³/day. */
	shortM3Day: number;
	/** Short-fall ÷ demand, 0–1; null without demand. */
	shortShare: number | null;
}

/** Below this (m³/day) a subtraction's leftover is rounding, not water. */
const NOISE = 1e-6;

function figure(demand: number, supplied: number, short: number): RunFigure {
	const d = Math.max(0, demand);
	const s = Math.max(0, supplied);
	const k = Math.max(0, short);
	return {
		demandM3Day: d < NOISE ? 0 : d,
		suppliedM3Day: s < NOISE ? 0 : s,
		shortM3Day: k < NOISE ? 0 : k,
		shortShare: d >= NOISE ? Math.min(1, (k < NOISE ? 0 : k) / d) : null
	};
}

/** Each row's run figure by its key; a row the run has no figure for is absent. */
export function demandRunFigures(rows: readonly DemandRow[], summary: RunSummary): Map<string, RunFigure> {
	const farms = new Map(summary.farms.map((f) => [f.nodeId, f]));
	const users = new Map((summary.users ?? []).map((u) => [u.nodeId, u]));
	const out = new Map<string, RunFigure>();
	for (const r of rows) {
		if (r.kind === 'user') {
			const u = users.get(r.nodeId);
			if (u) out.set(r.key, figure(u.avgDemandM3Day, u.avgSuppliedM3Day, u.avgDeficitM3Day));
			continue;
		}
		const f = farms.get(r.nodeId);
		if (!f) continue;
		const objects = f.demandObjects ?? [];
		if (r.kind === 'object') {
			const id = r.key.slice('object@'.length);
			const o = objects.find((x) => x.id === id);
			if (o) out.set(r.key, figure(o.avgDemandM3Day, o.avgSuppliedM3Day, o.avgDeficitM3Day));
			continue;
		}
		const sum = (k: 'avgDemandM3Day' | 'avgSuppliedM3Day' | 'avgDeficitM3Day') => objects.reduce((s, o) => s + o[k], 0);
		out.set(r.key, figure(f.avgDemandM3Day - sum('avgDemandM3Day'), f.avgSuppliedM3Day - sum('avgSuppliedM3Day'), f.avgDeficitM3Day - sum('avgDeficitM3Day')));
	}
	return out;
}

/** The catchment row: Σ the rows with a figure (only modelled rows: an object that is off has none). */
export function runTotal(rows: readonly DemandRow[], figures: ReadonlyMap<string, RunFigure>): RunFigure | null {
	let d = 0;
	let s = 0;
	let k = 0;
	let any = false;
	for (const r of rows) {
		const x = figures.get(r.key);
		if (!x || !r.enabled) continue;
		any = true;
		d += x.demandM3Day;
		s += x.suppliedM3Day;
		k += x.shortM3Day;
	}
	return any ? figure(d, s, k) : null;
}
