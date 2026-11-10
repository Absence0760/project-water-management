// Model settings → Demand → A-pan from "CCWR A-pan (Hydrological Unit)":
// each hydrological unit's monthly A-pan from the CCWR A-pan grid, beside the
// catchment's (UnitApanTable.svelte; docs/ui.md § Demand,
// docs/maps.md § A-pan for each unit). The words and numbers the table shows.
import type { UnitApanProposal } from '#lib/api/index.js';
import { fmtNum } from '#lib/format/number.js';

/** A difference from the catchment's year, signed, one decimal: "+5.5 %", "−5.5 %", "0.0 %"; "–" without one. */
export function diffText(pct: number | null): string {
	if (pct === null || !Number.isFinite(pct)) return '–';
	const r = Math.round(pct * 10) / 10;
	if (r === 0) return '0.0 %';
	return `${r > 0 ? '+' : '−'}${fmtNum(Math.abs(r), 1)} %`;
}

/** The catchment average when there is one (null: no boundary, or the grid can't be summarised over it). */
export const catchmentRow = (p: UnitApanProposal): { monthlyMm: number[]; annualMm: number } | null => (p.catchment && 'annualMm' in p.catchment ? p.catchment : null);

/**
 * How far the units' years spread around the catchment's, in a sentence, so the
 * hydrologist can judge whether they differ enough to matter; null without a
 * unit or a catchment average.
 */
export function spreadText(p: UnitApanProposal): string | null {
	const diffs = p.units.map((u) => u.diffPct).filter((d): d is number => d !== null);
	if (!diffs.length) return null;
	const lo = Math.min(...diffs);
	const hi = Math.max(...diffs);
	const n = diffs.length;
	if (n === 1) return `The one unit the grid covers is ${diffText(lo)} from the catchment’s year.`;
	return `The ${n} units the grid covers range from ${diffText(lo)} to ${diffText(hi)} of the catchment’s year.`;
}

/** Every unit left out of the table, each with why, in the model's order within each kind. */
export function leftOut(p: UnitApanProposal): { nodeId: string; name: string; reason: string }[] {
	return [
		...p.uncovered.map((u) => ({ nodeId: u.nodeId, name: u.name, reason: u.reason })),
		...p.withoutPolygon.map((u) => ({ ...u, reason: 'the unit has no outline (parcel) on the map' })),
		...p.refused
	];
}
