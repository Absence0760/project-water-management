// The Settings form's rain-source periods (settings.rainSource, engine ≥
// 0.30.0, issue #40 (b), docs/model.md §2.4e): what a new period starts as,
// switching between fixed and fitted factors, and the check the form blocks
// Save on (the engine's own, which the API uses too).
import { rainSourceError, type RainSourcePeriod } from '@water-management/engine';

/** Last complete water year (each named by the calendar year its 1 October falls in). */
export function lastWaterYear(now = new Date()): number {
	return now.getUTCFullYear() - (now.getUTCMonth() + 1 >= 10 ? 1 : 2);
}

/**
 * A new period: the last five water years from the alternative gauge, fitted
 * against the reanalysis over the ten years before them. The reason is blank
 * on purpose: the form won't save until it is written.
 */
export function newRainSourcePeriod(now = new Date()): RainSourcePeriod {
	const y = lastWaterYear(now);
	return {
		start: `${y - 4}-10-01`,
		end: `${y + 1}-09-30`,
		series: 'rain_catchment_alt_mm',
		factors: 'fit',
		fitReference: { series: 'rain_reanalysis_mm', fromWaterYear: y - 14, toWaterYear: y - 5 },
		reason: ''
	};
}

/**
 * Switch a period between fixed and fitted factors. Fixed starts at 1 for
 * every month with blank provenance (the form then asks for it); a fit
 * starts against the reanalysis over the ten water years before the period.
 */
export function withFactorMode(p: RainSourcePeriod, mode: 'fixed' | 'fit'): RainSourcePeriod {
	const { provenance: _p, fitReference: _f, ...rest } = p;
	if (mode === 'fit') {
		if (p.factors === 'fit') return p;
		const y = Number(p.start.slice(0, 4)) - (Number(p.start.slice(5, 7)) >= 10 ? 0 : 1);
		return { ...rest, factors: 'fit', fitReference: { series: 'rain_reanalysis_mm', fromWaterYear: y - 10, toWaterYear: y - 1 } };
	}
	if (p.factors !== 'fit') return p;
	return { ...rest, factors: new Array<number>(12).fill(1), provenance: { source: '', fittedFrom: p.start, fittedTo: p.end, method: '' } };
}

/** Name a reanalysis fallback over the fit's reference era (or the ten years before), or go back to CHIRPS. */
export function withFallback(p: RainSourcePeriod, fallback: 'chirps' | 'rain_reanalysis_mm'): RainSourcePeriod {
	const { fallback: _f, ...rest } = p;
	if (fallback === 'chirps') return rest;
	const era = p.fitReference ?? withFactorMode({ ...p, factors: [] }, 'fit').fitReference!;
	return { ...rest, fallback: { series: 'rain_reanalysis_mm', fromWaterYear: era.fromWaterYear, toWaterYear: era.toWaterYear } };
}

/** The first problem with the list, as the form shows it, or null. */
export const rainSourceFormError = (list: readonly RainSourcePeriod[]): string | null => rainSourceError(list);
