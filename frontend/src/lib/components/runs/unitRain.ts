// Runs & results → Rain for each unit (issue #482, docs/ui.md § Runs &
// results, docs/model.md §2.4h): each land unit's rule, factor and its
// source, its rain and runoff, as a run with settings.unitRain `perUnit`
// reports them in summary.unitRain (engine ≥ 1.78.0). Read defensively: a run
// from before it has none, and the panel shows only when the summary carries
// the field.
import type { UnitRainSummary, UnitRainUnit } from '@water-management/engine';
import { fmtNum } from '$lib/format/number';

/** summary.unitRain as the engine reports it (RunSummary.unitRain, engine ≥ 1.78.0). */
export type UnitRainResultUnit = UnitRainUnit;
export type UnitRainResult = UnitRainSummary;

/** summary.unitRain when the run has it, in the shape the panel reads; null otherwise (an older run, or catchment rain). */
export function unitRainOf(summary: unknown): UnitRainResult | null {
	// A stored summary is JSON from whichever engine made the run: checked, not trusted to the type.
	const u = (summary as { unitRain?: unknown } | null | undefined)?.unitRain as Partial<UnitRainResult> | null | undefined;
	if (!u || typeof u !== 'object' || u.mode !== 'perUnit' || !Array.isArray(u.units)) return null;
	return u as UnitRainResult;
}

export const RULE_LABEL: Record<UnitRainResultUnit['rule'], string> = {
	unitGauge: 'Its own rain gauge',
	gaugeMap: 'Catchment gauge × MAP ratio',
	unitChirps: 'Its own CHIRPS',
	catchment: 'Catchment rain (fallback)'
};

const FACTOR_SOURCE: Record<UnitRainResultUnit['factorSource'], string> = {
	gauge: 'as recorded',
	gaugeMap: 'unit MAP ÷ gauge MAP',
	chirpsMap: 'unit MAP ÷ its CHIRPS mean',
	chirpsBias: 'the catchment’s monthly CHIRPS factors',
	chirpsRaw: 'none: CHIRPS as published',
	catchment: 'the catchment’s rain, with its areal correction'
};

/** "× 1.18, unit MAP ÷ gauge MAP" or the source alone when the factor varies by day. */
export function factorText(u: Pick<UnitRainResultUnit, 'factor' | 'factorSource'>): string {
	const src = FACTOR_SOURCE[u.factorSource] ?? u.factorSource;
	return u.factor === null ? src : `× ${fmtNum(u.factor, 2, true)}, ${src}`;
}

/** Whether the unit's factor was held at the 0.25–4 bound. */
export const factorClamped = (u: Pick<UnitRainResultUnit, 'gaugeMapClamped' | 'chirps' | 'rule'>): boolean =>
	(u.rule === 'gaugeMap' && !!u.gaugeMapClamped) || (u.rule === 'unitChirps' && u.chirps?.source === 'map' && u.chirps.clamped);

/**
 * What the hydrologist should look at, in words, one per unit: the units that
 * fell back to the catchment rain, the held factors, a CHIRPS mean taken
 * outside the MAP period, and CHIRPS used raw.
 */
export function unitRainNotes(r: Pick<UnitRainResult, 'units'>): string[] {
	const out: string[] = [];
	const fellBack = r.units.filter((u) => u.rule === 'catchment').map((u) => u.name);
	if (fellBack.length)
		out.push(`${fellBack.join(', ')} ${fellBack.length === 1 ? 'has' : 'have'} no rain of ${fellBack.length === 1 ? 'its' : 'their'} own (no gauge, and no CHIRPS feed or MAP to scale by), so ${fellBack.length === 1 ? 'it runs' : 'they run'} on the catchment rain.`);
	for (const u of r.units) {
		if (factorClamped(u)) out.push(`${u.name}: the factor was held at the 0.25–4 bound; check its MAP${u.rule === 'gaugeMap' ? ' and the gauge’s' : ''}.`);
		if (u.rule === 'unitChirps' && u.chirps?.source === 'map' && !u.chirps.inPeriod)
			out.push(`${u.name}: too few complete years of CHIRPS in the MAP period, so its mean was taken over ${u.chirps.years.length === 1 ? '1 year' : `${u.chirps.years.length} years`} of the record.`);
		if (u.rule === 'unitChirps' && u.chirps?.source === 'raw') out.push(`${u.name}: its CHIRPS is used as published, with no MAP and no catchment CHIRPS factors to level it.`);
	}
	return out;
}

/** "1991–2020" from the run's MAP period. */
export const periodText = (p: { start: string; end: string }) => `${p.start.slice(0, 4)}–${p.end.slice(0, 4)}`;

/** The units to look at first: fell back to the catchment rain, then a held factor, then the rest, each in the run's order. */
export function sortResultUnits(units: readonly UnitRainResultUnit[], order: readonly string[] = []): UnitRainResultUnit[] {
	const rank = (u: UnitRainResultUnit) => (u.rule === 'catchment' ? 0 : factorClamped(u) ? 1 : 2);
	// Within a rank, the run's farm order (summary.farms, upstream first, as every other per-unit table); the engine's node-id order is random to a reader.
	const at = new Map(order.map((id, i) => [id, i]));
	const pos = (u: UnitRainResultUnit, i: number) => at.get(u.nodeId) ?? order.length + i;
	return units
		.map((u, i) => ({ u, i: pos(u, i) }))
		.sort((a, b) => rank(a.u) - rank(b.u) || a.i - b.i)
		.map((x) => x.u);
}
