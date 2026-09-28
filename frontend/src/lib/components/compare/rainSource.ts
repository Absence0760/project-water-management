// The compare page's note when the two runs' rain-source periods differ
// (RunComparison.rainSource, engine ≥ 0.30.0, docs/model.md §2.4e,
// docs/run-comparison.md).
import type { RunComparison } from '@water-management/engine';

const side = (lines: string[]) => (lines.length ? lines.join(' | ') : 'none (the catchment series throughout)');

/** One sentence: each run's periods (with factors, their origin and fallback), and what can move them. */
export function rainSourceNote(r: NonNullable<RunComparison['rainSource']>): string {
	return (
		`The rain-source periods differ between the runs (A: ${side(r.periodsA)}; B: ${side(r.periodsB)}), so catchment rain differs over those dates. ` +
		'The periods themselves, a fit’s reference era, the alternative gauge’s or reference series’ data, or its product and version can each move them.'
	);
}
