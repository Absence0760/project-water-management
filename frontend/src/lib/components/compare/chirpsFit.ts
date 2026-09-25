// The compare page's note when the two runs' CHIRPS fallback factors differ
// (RunComparison.chirpsFit, docs/model.md §2.4b, docs/run-comparison.md).
import { waterYearLabel, type RunComparison } from '@water-management/engine';

const years = (ys: number[] | null) => (ys === null ? 'no fit' : ys.length ? ys.map(waterYearLabel).join(', ') : 'none');
const factor = (f: number | null) => (f === null ? 'none' : f.toFixed(2));

/** One sentence: what differs between the two fits, and what can cause it. */
export function chirpsFitNote(fit: NonNullable<RunComparison['chirpsFit']>): string {
	const a = fit.excludedWaterYearsA;
	const b = fit.excludedWaterYearsB;
	const parts = [`pooled factor ${factor(fit.pooledFactor.a)} → ${factor(fit.pooledFactor.b)}`];
	if (a === null || b === null || a.join() !== b.join()) parts.push(`water years left out of the fit: ${years(a)} → ${years(b)}`);
	return (
		`The CHIRPS bias factors differ between the runs (${parts.join('; ')}), so rain differs on the days CHIRPS fills in for blank catchment rain. ` +
		'Keep-dry or missing periods, the rain records, the CHIRPS setting or the engine version can each move them.'
	);
}
