// Which days of an observed flow record a run fills (settings.flowGapFill,
// engine ≥ 1.20.0, docs/model.md §2.10h), for shading the Data tab's chart
// like the rain a run treats as missing (./zeroRain.ts). The engine's own
// fillFlowGaps decides, over the whole stored record, so the chart shows
// what a run over the full record would fill. The stored values are never
// changed: the filled ones are drawn as their own line.
import {
	FLOW_FILL_CODE,
	fillFlowGaps,
	fromEpochDay,
	gapFillRecordLabel,
	specFills,
	toEpochDay,
	type DailySeries,
	type FlowFillSummary,
	type FlowGapFillSettings,
	type GapFillKind
} from '@water-management/engine';

export interface FlowFillShading {
	/** Inclusive date ranges to shade (runs of filled days). */
	ranges: { start: string; end: string }[];
	/** The filled days' values (m³/s), NaN on every other day: the chart's second line. */
	filled: { startDate: string; values: number[] };
	summary: FlowFillSummary;
	/** What the shading means, for the chart caption. */
	caption: string;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const ratio = (v: number) => (v >= 100 ? v.toFixed(0) : v >= 1 ? v.toFixed(2) : v.toPrecision(2));

/**
 * The shading for `record` of `kind` under the project's gap-fill settings,
 * `donor` the record its spec names (null when it names none or the project
 * has none). Null when the record isn't filled at all.
 */
export function flowFillShading(kind: GapFillKind, record: DailySeries, settings: FlowGapFillSettings | null | undefined, donor: DailySeries | null): FlowFillShading | null {
	const spec = settings?.[kind];
	if (!specFills(spec)) return null;
	const f = fillFlowGaps(kind, record, spec, donor);
	const d0 = toEpochDay(record.startDate);
	const ranges: { start: string; end: string }[] = [];
	for (let i = 0; i < f.code.length; i++) {
		if (f.code[i] === FLOW_FILL_CODE.none) continue;
		let j = i;
		while (j + 1 < f.code.length && f.code[j + 1] !== FLOW_FILL_CODE.none) j++;
		ranges.push({ start: fromEpochDay(d0 + i), end: fromEpochDay(d0 + j) });
		i = j;
	}
	const s = f.summary;
	const parts: string[] = [];
	if (s.interpolatedDays) parts.push(`${plural(s.interpolatedDays, 'day')} interpolated across gaps of up to ${plural(spec.interpolateMaxDays, 'day')}`);
	if (s.donorDays && s.donor) parts.push(`${plural(s.donorDays, 'day')} from the ${gapFillRecordLabel(s.donor.kind)} × ${ratio(s.donor.ratio)}`);
	const refused = s.donorRefused ? ` Nothing from the ${gapFillRecordLabel(spec.donor!)}: ${s.donorRefused}.` : '';
	const open = s.openGaps ? ` ${plural(s.openGaps, 'gap')} (${plural(s.openDays, 'day')}) stay open.` : '';
	return {
		ranges,
		filled: { startDate: record.startDate, values: f.values.map((v, i) => (f.code[i] !== FLOW_FILL_CODE.none && v !== null ? v : NaN)) },
		summary: s,
		caption: `${parts.length ? `Shaded: ${parts.join('; ')}, in a run only (Settings → Flow gaps); the stored record is unchanged.` : 'No gap is filled (Settings → Flow gaps).'}${refused}${open}`
	};
}
