// Model settings → Demand → A-pan from "CCWR A-pan (Hydrological Unit)":
// each hydrological unit's monthly A-pan from the CCWR A-pan grid, beside the
// catchment's, and Use, which runs each unit on its own (UnitApanTable.svelte;
// docs/ui.md § Demand, docs/maps.md § A-pan for each unit, docs/model.md
// §2.3b). The words and numbers the table shows.
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

/** What the settings hold for the units now, in a sentence; null with nothing saved and the catchment row chosen. */
export function savedText(p: UnitApanProposal): string | null {
	const saved = p.saved;
	if (!saved) return null;
	const n = Object.keys(saved.units).length;
	if (p.same && saved.basis === 'units') return `Saved: the model runs ${n === 1 ? 'this unit' : `these ${n} units`} on ${n === 1 ? 'its' : 'their'} own A-pan.`;
	if (p.same) return `Saved for ${n === 1 ? 'this unit' : `these ${n} units`}; save the settings with this option to run on them.`;
	if (n && saved.basis === 'units') return `The model runs ${n} unit${n === 1 ? '' : 's'} on A-pan saved earlier${saved.dataset ? ` from ${saved.dataset}` : ''}, not what is shown here: use these to replace ${n === 1 ? 'it' : 'them'}.`;
	if (saved.basis === 'units') return 'No unit has its own A-pan saved yet, so every unit runs on the A-pan row below until you use these.';
	return null;
}

/** The Use confirmation: what changes, and what the units left out run on. */
export function useMessage(p: UnitApanProposal): string {
	const n = p.units.length;
	const out = leftOut(p);
	return (
		`Crop demand, dam evaporation and, under pan coefficient × A-pan, GR4J will read each unit’s own 12 months for ${n} unit${n === 1 ? '' : 's'} instead of the one A-pan row. ` +
		(out.length ? `${out.map((u) => u.name).join(', ')} ${out.length === 1 ? 'has' : 'have'} none and ${out.length === 1 ? 'runs' : 'run'} on the covered units’ area-weighted mean, as does a dam outside every unit. ` : 'A dam outside every unit runs on the covered units’ area-weighted mean. ') +
		'A daily A-pan record isn’t read while this option is chosen.'
	);
}
