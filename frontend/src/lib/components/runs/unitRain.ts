// Runs & results → Rain for each unit (issue #482, docs/ui.md § Runs &
// results, docs/model.md §2.4h): each land unit's rule, factor and its
// source, its rain and runoff, as a run with settings.unitRain `perUnit`
// reports them in summary.unitRain (engine ≥ 1.78.0). Read defensively: a run
// from before it has none, and the panel shows only when the summary carries
// the field.
import { AREAL_RAIN_FACTOR_MAX, AREAL_RAIN_FACTOR_MIN, AREAL_RAIN_FACTOR_WARN_MAX, AREAL_RAIN_FACTOR_WARN_MIN, type UnitRainSummary, type UnitRainUnit } from '@water-management/engine';
import { fmtNum } from '#lib/format/number.js';

/** The hard clamp and the soft warning band on a level factor, in words ("0.25–4", "0.5–2"; issue #500 answer 2). */
const CLAMP = `${AREAL_RAIN_FACTOR_MIN}–${AREAL_RAIN_FACTOR_MAX}`;
const BAND = `${AREAL_RAIN_FACTOR_WARN_MIN}–${AREAL_RAIN_FACTOR_WARN_MAX}`;

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
	chirpsReference: 'the reference gauge’s monthly factors, rescaled to the unit’s MAP',
	catchment: 'the catchment’s rain, with its areal correction'
};

/** The rule a unit ran on, inside a sentence ("the unit runs on …"). */
const RUNS_ON: Record<UnitRainResultUnit['rule'], string> = {
	unitGauge: 'its own rain gauge',
	gaugeMap: 'the catchment gauge × its MAP ratio',
	unitChirps: 'its own CHIRPS',
	catchment: 'the catchment rain'
};

type ReferenceLevel = Extract<UnitRainResultUnit['chirps'] & {}, { source: 'reference' }>;
/** k_unit on a unit's reference-gauge level (engine with issue #500's decisions); undefined on a run from before it (engine 1.80–1.83 stored a MAP ratio instead). */
const kUnitOf = (c: ReferenceLevel): ReferenceLevel['kUnit'] | undefined => (c as Partial<ReferenceLevel>).kUnit;
/** The MAP ratio an engine 1.80–1.83 run stored on the reference level (unit MAP ÷ the reference unit's MAP): read only to show such a run as it ran. */
const legacyRatio = (c: ReferenceLevel) => c as unknown as { mapRatio?: number; mapClamped?: boolean };

/**
 * "× 1.18, unit MAP ÷ gauge MAP" or the source alone when the factor varies by
 * day; on the reference factors, k_unit on top of them: unit MAP ÷ the unit's
 * mean annual (CHIRPS × factors) over the MAP period.
 */
export function factorText(u: Pick<UnitRainResultUnit, 'factor' | 'factorSource'> & { chirps?: UnitRainResultUnit['chirps'] }): string {
	const src = FACTOR_SOURCE[u.factorSource] ?? u.factorSource;
	if (u.factor === null && u.factorSource === 'chirpsReference' && u.chirps?.source === 'reference') {
		const k = kUnitOf(u.chirps);
		if (k)
			return `the reference gauge’s monthly factors × ${fmtNum(k.factor, 2, true)} (k_unit: unit MAP ÷ its CHIRPS × factors, ${fmtNum(k.meanAnnualMm)} mm a year)`;
		const old = legacyRatio(u.chirps).mapRatio;
		if (k === undefined && typeof old === 'number') return `the reference gauge’s monthly factors × ${fmtNum(old, 2, true)} (unit MAP ÷ the reference unit’s MAP)`;
		return 'the reference gauge’s monthly factors, not rescaled (no complete year of CHIRPS yet)';
	}
	return u.factor === null ? src : `× ${fmtNum(u.factor, 2, true)}, ${src}`;
}

/** Whether the unit's factor was held at the 0.25–4 bound. */
export function factorClamped(u: Pick<UnitRainResultUnit, 'gaugeMapClamped' | 'chirps' | 'rule'>): boolean {
	if (u.rule === 'gaugeMap') return !!u.gaugeMapClamped;
	if (u.rule !== 'unitChirps') return false;
	if (u.chirps?.source === 'map') return u.chirps.clamped;
	if (u.chirps?.source === 'reference') {
		const k = kUnitOf(u.chirps);
		return k === undefined ? !!legacyRatio(u.chirps).mapClamped : !!k?.clamped;
	}
	return false;
}

/**
 * Whether the unit's factor is outside the 0.5–2 warning band but inside the
 * clamp (issue #500 answer 2: the run warns, the value stands). A held factor
 * is outside it too, and says so as held (factorClamped).
 */
export function factorOutsideBand(u: Pick<UnitRainResultUnit, 'gaugeMapOutsideBand' | 'chirps' | 'rule' | 'gaugeMapClamped'>): boolean {
	if (factorClamped(u)) return false;
	if (u.rule === 'gaugeMap') return !!u.gaugeMapOutsideBand;
	if (u.rule !== 'unitChirps') return false;
	if (u.chirps?.source === 'map') return !!u.chirps.outsideBand;
	if (u.chirps?.source === 'reference') return !!kUnitOf(u.chirps)?.outsideBand;
	return false;
}

/** The unit's level factor's own value (before any clamp), for a note; null when it varies by day. */
function ownFactor(u: UnitRainResultUnit): number | null {
	if (u.rule === 'gaugeMap') return u.gaugeMapOwnFactor;
	if (u.chirps?.source === 'map') return u.chirps.ownFactor;
	if (u.chirps?.source === 'reference') return kUnitOf(u.chirps)?.ownFactor ?? null;
	return null;
}

/**
 * How the reference gauge's factors were fitted (issue #500): against the
 * checked or the recorded gauge rain, at which CHIRPS cell and why. Null on a
 * run from before the fit recorded its cell's reason (engine 1.80–1.83).
 */
export function referenceFitText(r: Pick<NonNullable<UnitRainResult['reference']>, 'unitId' | 'unitName' | 'pinned'> & Partial<Pick<NonNullable<UnitRainResult['reference']>, 'cellReason' | 'gaugeChecked'>>): string | null {
	if (r.cellReason !== 'referenceUnitCentre') return null;
	const cell = `the CHIRPS cell under the reference unit’s centre (${r.unitName ?? r.unitId}); rain gauges have no map location yet`;
	if (r.pinned) return `The pinned factors are for ${cell}.`;
	return `They were fitted against ${r.gaugeChecked ? 'the checked gauge rain' : 'the gauge rain as recorded'}, at ${cell}.`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** The reference gauge's 12 factors in words ("Jan 1.20, Feb 1, …"), or null without a reference (engine ≥ 1.80.0). */
export function referenceFactorsText(r: Pick<UnitRainResult, 'reference'>): string | null {
	const ref = r.reference;
	if (!ref || !Array.isArray(ref.months)) return null;
	return ref.months.map((m) => `${MONTHS[m.month - 1]} ${fmtNum(m.factor, 2, true)}`).join(', ');
}

/**
 * What the hydrologist should look at, in words, one per unit: the units that
 * fell back to the catchment rain, the held factors and those outside the
 * 0.5–2 warning band (the reference gauge's months too), CHIRPS skipped as
 * unusable, a CHIRPS mean taken outside the MAP period, a reference level
 * without k_unit, and CHIRPS used raw.
 */
export function unitRainNotes(r: Pick<UnitRainResult, 'units'> & Partial<Pick<UnitRainResult, 'reference'>>): string[] {
	const out: string[] = [];
	// The reference gauge's months (engine ≥ 1.80.0): too little shared record keeps a factor of 1; a held factor.
	const ref = r.reference;
	if (ref && Array.isArray(ref.months) && !ref.pinned) {
		const short = ref.months.filter((m) => !m.fitted).map((m) => MONTHS[m.month - 1]);
		const need = '(90 days, and 50 mm of CHIRPS on them)';
		if (short.length === 12) out.push(`Reference gauge: no month shares enough record with the CHIRPS cell ${need}, so every factor is 1.`);
		else if (short.length)
			out.push(`Reference gauge: ${short.join(', ')} ${short.length === 1 ? 'shares' : 'share'} too little record with the CHIRPS cell ${need}, so ${short.length === 1 ? 'its factor is' : 'those factors are'} 1.`);
		const held = ref.months.filter((m) => m.clamped).map((m) => MONTHS[m.month - 1]);
		if (held.length) out.push(`Reference gauge: the factor for ${held.join(', ')} was held at the ${CLAMP} bound; check the gauge and the cell describe the same rain.`);
		// Engine with issue #500's decisions: a fitted month outside the warning band keeps its value, with a warning.
		const wide = ref.months.filter((m) => m.outsideBand && !m.clamped).map((m) => MONTHS[m.month - 1]);
		if (wide.length) out.push(`Reference gauge: the factor for ${wide.join(', ')} is outside ${BAND}; it is used as fitted, but check the gauge and the cell describe the same rain.`);
	}
	const fellBack = r.units.filter((u) => u.rule === 'catchment').map((u) => u.name);
	if (fellBack.length)
		out.push(`${fellBack.join(', ')} ${fellBack.length === 1 ? 'has' : 'have'} no rain of ${fellBack.length === 1 ? 'its' : 'their'} own (no gauge, and no CHIRPS feed or MAP to scale by), so ${fellBack.length === 1 ? 'it runs' : 'they run'} on the catchment rain.`);
	for (const u of r.units) {
		if (factorClamped(u)) out.push(`${u.name}: the factor was held at the ${CLAMP} bound; check its MAP${u.rule === 'gaugeMap' ? ' and the gauge’s' : ''}.`);
		else if (factorOutsideBand(u)) {
			const own = ownFactor(u);
			out.push(`${u.name}: its level factor${own === null ? '' : `, ${fmtNum(own, 2, true)},`} is outside ${BAND}; it is used, but check its MAP${u.rule === 'gaugeMap' ? ' and the gauge’s' : ''}.`);
		}
		// Issue #500 answer 7a: CHIRPS that averages 0 mm a year looks broken, so the unit skipped it.
		if (u.chirps?.source === 'unusable') {
			const n = u.chirps.years.length;
			out.push(`${u.name}: its CHIRPS averages 0 mm a year over ${n === 1 ? '1 complete year' : `${n} complete years`}, so it looks broken and is not used: the unit runs on ${RUNS_ON[u.rule] ?? u.rule} instead. Check its feed.`);
		}
		if (u.rule === 'unitChirps' && u.chirps?.source === 'map' && !u.chirps.inPeriod)
			out.push(`${u.name}: too few complete years of CHIRPS in the MAP period, so its mean was taken over ${u.chirps.years.length === 1 ? '1 year' : `${u.chirps.years.length} years`} of the record.`);
		if (u.rule === 'unitChirps' && u.chirps?.source === 'reference') {
			const k = kUnitOf(u.chirps);
			if (k && !k.inPeriod)
				out.push(`${u.name}: too few complete years of CHIRPS in the MAP period, so its k_unit was taken over ${k.years.length === 1 ? '1 year' : `${k.years.length} years`} of the record.`);
			if (k === null) out.push(`${u.name}: its CHIRPS has no complete year yet, so it has the reference gauge’s monthly factors but is not rescaled to its MAP.`);
		}
		if (u.rule === 'unitChirps' && u.chirps?.source === 'raw') out.push(`${u.name}: its CHIRPS is used as published, with no MAP and no catchment CHIRPS factors to level it.`);
	}
	return out;
}

/** "1991–2020" from the run's MAP period. */
export const periodText = (p: { start: string; end: string }) => `${p.start.slice(0, 4)}–${p.end.slice(0, 4)}`;

/** The units to look at first: fell back to the catchment rain (or skipped unusable CHIRPS), then a held factor, then one outside the warning band, then the rest, each in the run's order. */
export function sortResultUnits(units: readonly UnitRainResultUnit[], order: readonly string[] = []): UnitRainResultUnit[] {
	const rank = (u: UnitRainResultUnit) => (u.rule === 'catchment' || u.chirps?.source === 'unusable' ? 0 : factorClamped(u) ? 1 : factorOutsideBand(u) ? 2 : 3);
	// Within a rank, the run's farm order (summary.farms, upstream first, as every other per-unit table); the engine's node-id order is random to a reader.
	const at = new Map(order.map((id, i) => [id, i]));
	const pos = (u: UnitRainResultUnit, i: number) => at.get(u.nodeId) ?? order.length + i;
	return units
		.map((u, i) => ({ u, i: pos(u, i) }))
		.sort((a, b) => rank(a.u) - rank(b.u) || a.i - b.i)
		.map((x) => x.u);
}
