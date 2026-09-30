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
	// Engine ≥ 0.29.0: the fit period, its ranges and every fit's reference window.
	const pa = fit.fitPeriodA ?? null;
	const pb = fit.fitPeriodB ?? null;
	if ((pa || pb) && pa !== pb) parts.push(`fit period: ${pa ?? 'no fit'} → ${pb ?? 'no fit'}`);
	const sa = fit.segmentsA ?? [];
	const sb = fit.segmentsB ?? [];
	if (pa === pb && sa.join() !== sb.join()) parts.push(`fit ranges: ${sa.join('; ') || 'none'} → ${sb.join('; ') || 'none'}`);
	const wa = fit.fitWindowsA ?? [];
	const wb = fit.fitWindowsB ?? [];
	if (wa.length && wb.length && wa.join() !== wb.join()) parts.push(`fitted on: ${wa.join('; ')} → ${wb.join('; ')}`);
	// Engine ≥ 1.47.0 (CR-23): the gap map, when either run had one.
	const qa = fit.quantileMapA ?? null;
	const qb = fit.quantileMapB ?? null;
	if (qa !== qb) parts.push(`quantile map: ${qa ?? 'off'} → ${qb ?? 'off'}`);
	return (
		`The CHIRPS bias factors differ between the runs (${parts.join('; ')}), so rain differs on the days CHIRPS fills in for blank catchment rain. ` +
		'Keep-dry or missing periods, the rain records, the CHIRPS settings (bias correction, fit period, quantile map) or the engine version can each move them.'
	);
}
