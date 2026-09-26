// Whether a dam's survey curve is usable, and how close its top must sit to
// the capacity. Apart from the curve's use in a run (./dam.ts), so the
// Network editor that checks a pasted curve doesn't load it (issue #9).
import { DAM_CURVE_MAX_ROWS, type DamCurvePoint } from '../project';

/** How far a survey curve's top volume may sit from the dam's capacity before a run warns (±1 %, WP-3.5). */
export const DAM_CURVE_CAPACITY_TOLERANCE = 0.01;

/**
 * Why a survey curve can't be used, or null when it can. Needs at least two
 * rows, every value finite and ≥ 0 (level may be any finite number: a datum
 * is arbitrary), volume strictly increasing and level and area never falling
 * as volume rises (a dam doesn't shrink as it fills), and some area above the
 * bottom row. Rows are taken in volume order, so the list order doesn't matter.
 */
export function damCurveProblem(rows: readonly DamCurvePoint[] | null | undefined): string | null {
	if (!rows || rows.length === 0) return null;
	if (rows.length < 2) return 'a survey curve needs at least two rows';
	if (rows.length > DAM_CURVE_MAX_ROWS) return `a survey curve has at most ${DAM_CURVE_MAX_ROWS} rows`;
	for (const r of rows) {
		if (!r || !Number.isFinite(r.levelM) || !Number.isFinite(r.areaM2) || !Number.isFinite(r.volumeM3)) return 'every survey row needs a level, an area and a volume';
		if (r.areaM2 < 0 || r.volumeM3 < 0) return 'survey areas and volumes are ≥ 0';
	}
	const s = [...rows].sort((a, b) => a.volumeM3 - b.volumeM3);
	for (let k = 1; k < s.length; k++) {
		if (!(s[k]!.volumeM3 > s[k - 1]!.volumeM3)) return `two survey rows have the same volume (${s[k]!.volumeM3} m³)`;
		if (s[k]!.areaM2 < s[k - 1]!.areaM2) return `the survey area falls from ${s[k - 1]!.areaM2} to ${s[k]!.areaM2} m² as the volume rises`;
		if (s[k]!.levelM < s[k - 1]!.levelM) return `the survey level falls from ${s[k - 1]!.levelM} to ${s[k]!.levelM} m as the volume rises`;
	}
	if (!(s[s.length - 1]!.areaM2 > 0)) return 'the survey curve has no surface area';
	return null;
}
