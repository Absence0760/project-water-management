// The Load crop factors dialog's presentation helpers (docs/ui.md § Load crop
// factors): the order the demand review lists units in, a staged crop's
// planting when its source crop is picked or matched, and the dialog's
// one-line summaries. Pure, so the dialog stays markup. The maths (the diff,
// the demand difference, Kp) is in ./loadFactors.ts.
import type { StagedLibraryCrop } from './library';
import type { DemandRow } from './loadFactors';

/**
 * The demand review's units, the biggest change first: by the absolute change
 * in abstraction (what the river gives up), then in the crop requirement, then
 * the model's order, so units the changes don't touch sink to the end.
 */
export function rowsByChange(rows: readonly DemandRow[]): DemandRow[] {
	const d = (p: readonly [number, number]) => Math.abs(p[1] - p[0]);
	return rows
		.map((r, i) => ({ r, i }))
		.sort((x, y) => d(y.r.abstraction) - d(x.r.abstraction) || d(y.r.gross) - d(x.r.gross) || x.i - y.i)
		.map((x) => x.r);
}

/** A staged library crop's planting for one project crop: calendar month (0 = not picked), day, season days, and which library crop set it. */
export interface PlantingDraft {
	month: number;
	day: number | null;
	days: number | null;
	/** The library crop whose season length `days` came from. */
	for: string;
}

/**
 * The planting a project crop starts with when `lib` becomes its source:
 * the one it had if it was already for `lib`; otherwise the month and day
 * already typed (a planting date doesn't depend on the crop) with `lib`'s
 * own season length from Table 4.7, never another vegetable's.
 */
export function plantingFor(lib: StagedLibraryCrop, prev?: PlantingDraft | null): PlantingDraft {
	if (prev && prev.for === lib.id) return prev;
	return { month: prev?.month ?? 0, day: prev?.day ?? 1, days: lib.seasons[0]?.days ?? null, for: lib.id };
}

/** "3 of 30 crops matched by name." for the crop step's intro. */
export function matchedLine(matched: number, total: number): string {
	if (!total) return '';
	if (!matched) return `No crop matched a source crop by name: pick one for each crop to change.`;
	return `${matched} of ${total} ${total === 1 ? 'crop' : 'crops'} matched by name. Check each match.`;
}

/** The action row's line: how many crops Apply changes, out of how many. */
export function applyLine(accepted: number, total: number): string {
	if (!accepted) return 'Nothing to apply yet.';
	return `${accepted} of ${total} ${total === 1 ? 'crop' : 'crops'} will change. Save the model afterwards to keep it.`;
}
