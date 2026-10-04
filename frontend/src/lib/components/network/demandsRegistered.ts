// Registered volumes in the Demands grid (docs/ui.md § Demands grid,
// docs/allocations.md): an allocation is matched to a node (a hydrological
// unit or another water user), never to one demand on it, so the grid shows
// each node's registered volume once, beside the sum of that node's modelled
// demands (an object that isn't modelled counts nothing). The volume is what
// is in force today: every take (s21a) row, surface and groundwater summed, as
// the comparison adds them; a storage-only (s21b) row is never a take. The
// status is the comparison's (engine allocationStatus, the project's band), on
// the preview's annual demand rather than a run's use, so it is a flag to look
// at before running, not a finding.
import { allocationStatus, isStorageOnly, type AllocationStatus } from '@water-management/engine';
import type { Allocation } from '$lib/api';
import type { DemandRow } from './demands';

export interface RegisteredCell {
	nodeId: string;
	/** Σ the node's take volumes in force today, m³ a year; 0 with none. */
	registeredM3: number;
	/** How many allocations make it up. */
	count: number;
	/** Σ the node's modelled demands, m³ a year. */
	demandM3: number;
	status: AllocationStatus;
}

/** In force on `today` (ISO date): its valid-from on or before, its valid-to on or after; an open end is no limit. */
export function inForce(a: Pick<Allocation, 'validFrom' | 'validTo'>, today: string): boolean {
	return (a.validFrom === null || a.validFrom <= today) && (a.validTo === null || a.validTo >= today);
}

/**
 * One cell per node with a demand row, keyed by node id: its registered volume
 * in force today beside its modelled demand. Allocations matched to no node, or
 * to a node with no demand row, aren't shown here (the Allocations page lists them).
 */
export function registeredCells(rows: readonly DemandRow[], allocations: readonly Allocation[], today: string, tolerance = 0.1): Map<string, RegisteredCell> {
	const demand = new Map<string, number>();
	for (const r of rows) demand.set(r.nodeId, (demand.get(r.nodeId) ?? 0) + (r.enabled ? r.annualMm3 * 1e6 : 0));
	const reg = new Map<string, { m3: number; count: number }>();
	for (const a of allocations) {
		if (!a.nodeId || !demand.has(a.nodeId) || isStorageOnly(a) || !inForce(a, today)) continue;
		const x = reg.get(a.nodeId) ?? { m3: 0, count: 0 };
		x.m3 += a.volumeM3PerYear;
		x.count += 1;
		reg.set(a.nodeId, x);
	}
	const out = new Map<string, RegisteredCell>();
	for (const [nodeId, demandM3] of demand) {
		const r = reg.get(nodeId) ?? { m3: 0, count: 0 };
		out.set(nodeId, { nodeId, registeredM3: r.m3, count: r.count, demandM3, status: allocationStatus(demandM3, r.m3, tolerance) });
	}
	return out;
}

/** The first row of each node's run of rows (the cell sits there, spanning them), and how many rows it spans. */
export function nodeSpans(rows: readonly DemandRow[]): Map<string, number> {
	const spans = new Map<string, number>();
	rows.forEach((r, i) => {
		if (i > 0 && rows[i - 1]!.nodeId === r.nodeId) return;
		let n = 1;
		while (rows[i + n]?.nodeId === r.nodeId) n++;
		spans.set(r.key, n);
	});
	return spans;
}

/** The catchment's registered total in force (only nodes with a demand row) and how many nodes are flagged above it. */
export function registeredTotal(cells: ReadonlyMap<string, RegisteredCell>): { registeredM3: number; over: number; unregistered: number } {
	let registeredM3 = 0;
	let over = 0;
	let unregistered = 0;
	for (const c of cells.values()) {
		registeredM3 += c.registeredM3;
		if (c.status === 'over') over++;
		if (c.status === 'unregistered') unregistered++;
	}
	return { registeredM3, over, unregistered };
}
