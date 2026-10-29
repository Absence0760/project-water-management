// § 7 Observed wet days as the report prints it (evidence-21; Sentinel-2
// beside WOfS from evidence-24, issue #624 step 7; engine
// evidence/damObservations.ts, docs/evidence-pack.md § Observed wet days).
// A dam-obs-2 section prints, per dam, the dates either source saw together,
// then each source's own; a pack drafted from evidence-21 to evidence-23
// keeps its WOfS-only dam-obs-1 table as it printed then. Pure, for
// DamObservations.svelte and its test.
import { EVIDENCE_OBSERVED_SOURCE_LABEL, isDamObservationsV1, type EvidenceDamDate, type EvidenceDamObservationsAny, type EvidenceObservedSource } from '@water-management/engine';
import { fmtDate, fmtNum } from '#lib/format/number.js';

/** How each source is named in the table: the satellite and the pixel the rule counts. */
export const SOURCE_ROW_LABEL: Record<EvidenceObservedSource, string> = { s2: `${EVIDENCE_OBSERVED_SOURCE_LABEL.s2} (10 m)`, wofs: `${EVIDENCE_OBSERVED_SOURCE_LABEL.wofs} (Landsat, 30 m)` };

export interface DamObservationRow {
	key: string;
	/** The dam's name, on its first row; null on the rows after it (a dam spans `damRows` rows). */
	dam: string | null;
	damRows: number;
	/** null in a dam-obs-1 table, which has no source column. */
	source: string | null;
	/** The dates either source saw together: the dam's headline row. */
	together: boolean;
	cells: [string, string, string, string];
	span: string;
}

const spanOf = (dates: readonly string[]) => {
	if (!dates.length) return '–';
	const sorted = [...dates].sort();
	return `${fmtDate(sorted[0]!)} to ${fmtDate(sorted.at(-1)!)}`;
};
const cells = (c: { observedDates: number; wetDates: number; dryDates: number; inconclusiveDates: number }): DamObservationRow['cells'] => [
	fmtNum(c.observedDates),
	fmtNum(c.wetDates),
	fmtNum(c.dryDates),
	fmtNum(c.inconclusiveDates)
];
const daysOf = (dates: readonly EvidenceDamDate[]) => dates.map(([d]) => d);

/** The table's rows: per dam, the dates together then each source (dam-obs-2), or one row a dam (dam-obs-1). */
export function damObservationRows(s: EvidenceDamObservationsAny): DamObservationRow[] {
	if (isDamObservationsV1(s)) {
		return s.dams.map((d) => ({ key: d.featureId, dam: d.name || 'Unnamed dam', damRows: 1, source: null, together: false, cells: cells(d), span: spanOf(daysOf(d.dates)) }));
	}
	const sources = s.sources.map((x) => x.source);
	return s.dams.flatMap((d) => [
		{
			key: `${d.featureId}:days`,
			dam: d.name || 'Unnamed dam',
			damRows: 1 + sources.length,
			source: 'Either satellite',
			together: true,
			cells: cells(d),
			span: spanOf([...new Set(sources.flatMap((src) => daysOf(d.sources[src].dates)))])
		},
		...sources.map((src) => ({
			key: `${d.featureId}:${src}`,
			dam: null,
			damRows: 0,
			source: SOURCE_ROW_LABEL[src],
			together: false,
			cells: cells(d.sources[src]),
			span: spanOf(daysOf(d.sources[src].dates))
		}))
	]);
}

/**
 * The credit line under the table: WOfS's always; with Sentinel-2 values, Sentinel-2 named beside it and the
 * Copernicus credit, verbatim with its years, as its own sentence. An older pack's line as it printed.
 */
export function damObservationCreditLine(s: EvidenceDamObservationsAny): string {
	const tail = 'summed inside the dams’ traced outlines by this app.';
	if (isDamObservationsV1(s)) return `Source: ${s.citation}, ${tail}`;
	const wofs = s.sources.find((x) => x.source === 'wofs')?.citation;
	const sentinel = s.sources.find((x) => x.source === 's2')?.citation ?? null;
	return sentinel ? `Sources: ${wofs}, and ${EVIDENCE_OBSERVED_SOURCE_LABEL.s2}, each ${tail} ${sentinel}.` : `Source: ${wofs}, ${tail}`;
}

/** One source's rule in words: "Sentinel-2 (10 m): at least 8 pixels (about 800 m²)". */
export const ruleText = (label: string, r: { wetMinPixels: number; pixelAreaM2: number }) => `${label}: at least ${fmtNum(r.wetMinPixels)} pixels (about ${fmtNum(r.wetMinPixels * r.pixelAreaM2)} m²)`;
