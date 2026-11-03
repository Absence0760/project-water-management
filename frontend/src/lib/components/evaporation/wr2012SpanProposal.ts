// Calibration → Flow calibration → "WR2012 S-pan by quaternary" (docs/maps.md
// § WR2012 S-pan, docs/ui.md § Set up the fit): WR2012's S-pan for each
// quaternary the catchment boundary overlaps (MAE × its zone's monthly % of
// MAE), the catchment's area-weighted S-pan, and the A-pan it gives through
// the S→A equation the user picks. The server re-derives everything on Use;
// this only words it.
import type { SpanConversionId, Wr2012SpanProposal } from '#lib/api/index.js';
import { fmtNum } from '#lib/format/number.js';

type Span = NonNullable<Wr2012SpanProposal['span']>;

/** A share of the catchment, as a whole percentage ("75 %", or "< 1 %" for a sliver). */
export const shareText = (share: number) => (share > 0 && share < 0.005 ? '< 1 %' : `${fmtNum(Math.round(share * 100))} %`);

/** A row's 12 months, as a year's total in whole mm. */
export const annualMm = (row: readonly number[]) => Math.round(row.reduce((a, b) => a + b, 0));

/** The quaternaries with WR2012 evaporation. */
export const withSpan = (s: Span) => s.quaternaries.filter((q) => q.spanMm);

/** What the catchment's row is, in a sentence: one quaternary's row, or the area-weighted mean, and the part left out. */
export function meanText(s: Span): string {
	const used = withSpan(s);
	const what = used.length === 1 ? `${used[0]!.code}’s row: the catchment lies in it` : `the mean of the ${fmtNum(used.length)} quaternaries’ rows, each weighted by its share of the catchment’s area`;
	const left = 1 - s.coverage;
	return left >= 0.005
		? `The catchment’s S-pan is ${what}. ${shareText(left)} of the catchment lies in quaternaries with no WR2012 evaporation loaded, or in none, and is left out of the mean.`
		: `The catchment’s S-pan is ${what}.`;
}

/** The A-pan the equation picked gives, or null (none picked yet, or it refuses). */
export function chosenApan(s: Span, conversion: SpanConversionId | null): number[] | null {
	const r = conversion ? s.conversions.find((c) => c.id === conversion)?.result : null;
	return r?.ok ? r.values : null;
}

/** The confirmation before Use: what is written, from where, and what reads it. */
export function useMessage(s: Span, apan: readonly number[], conversionLabel: string, dailyApan: Wr2012SpanProposal['settings']['dailyApan']): string {
	const used = withSpan(s);
	const from =
		used.length === 1
			? `quaternary ${used[0]!.code}’s WR2012 S-pan (zone ${used[0]!.zone}, MAE ${fmtNum(Math.round(used[0]!.maeMm!))} mm)`
			: `the area-weighted WR2012 S-pan of ${used.map((q) => `${q.code} (${shareText(q.share)})`).join(', ')}`;
	const what = `The A-pan row becomes ${fmtNum(annualMm(apan))} mm a year, from ${from}, converted by the ${conversionLabel}.`;
	const reads = 'Irrigation demand, dam evaporation and, under pan coefficient × A-pan, GR4J read it; a GR4J fit made before is then marked “Forcing changed since fit”.';
	const daily = dailyApan.length ? ` The daily A-pan series “${dailyApan[0]!.name}” still replaces the monthly row on every day it covers.` : '';
	return `${what} ${reads}${daily}`;
}
