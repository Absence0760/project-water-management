// A Symons S-pan record put on a Class-A pan basis, for the A-pan row
// (settings.apanMm) proposed from a DWS evaporation station (issue #646
// item 6; docs/model.md §2.3a "A station's pan record", docs/maps.md §
// Evaporation stations). Pure: the 12 monthly means in, the 12 converted
// means (or why not) out.
//
// South Africa's two published general monthly pan equations run the other
// way, S-pan from A-pan (lakeFactorPresets.ts SPAN_FROM_APAN):
//
//   S = a × A + b     (mm/month; WR90 a 0.8793, b −16.2354; Taljaard 2023 Eq. 33 a 0.8706, b −11.1745)
//
// and are reused here, inverted:
//
//   A = (S − b) ÷ a
//
// Taljaard (2023, §2.6.1.4, p. 43) warns that these equations "can only be
// used as written and cannot be inverted": a least-squares fit of S on A is
// not the fit of A on S, and inverting it stretches the scatter. No published
// national A ← S equation exists, so the inversion is offered only as a
// choice the user makes, with that warning shown and the equation cited in
// the revision. Nothing converts by default.
//
// Small values: b is negative, so the inverse never gives a negative A (an
// S of 0 gives −b ÷ a, 12.8 mm under Taljaard), but below the depths the
// regression was fitted on it adds the intercept to a pan that barely
// evaporated. The forward floor (panConversionFloorMm, where the intercept is
// at most a third of a × A) maps to an S-pan floor of a × floor + b = −2b
// (WR90 32.5 mm, Taljaard 22.3 mm a month): a month whose S-pan mean is under
// it refuses the conversion, naming the month, rather than inventing an
// A-pan. The A-pan it gives is then always at or above the forward floor, so
// a WR90 lake-factor preset (lakeFactorPresetFill) accepts the result.

import { type PanConversion, panConversionFloorMm, SPAN_FROM_APAN } from './lakeFactorPresets';

export type SpanConversionId = keyof typeof SPAN_FROM_APAN;

/** The S → A choices, in the order a form offers them. */
export const SPAN_CONVERSIONS: readonly { id: SpanConversionId; label: string; conversion: PanConversion }[] = [
	{ id: 'taljaard2023', label: 'Taljaard (2023) general monthly equation, inverted', conversion: SPAN_FROM_APAN.taljaard2023 },
	{ id: 'wr90', label: 'WR90 general monthly equation, inverted', conversion: SPAN_FROM_APAN.wr90 }
];

/** What a form shows beside the choice. */
export const SPAN_INVERSION_CAVEAT =
	'Both equations are fitted as S-pan from A-pan, and Taljaard (2023) warns they “cannot be inverted”: the inverse is not a fitted A-pan from S-pan relation, and stretches the scatter. No national A-pan from S-pan equation is published, so this is your choice to make and is cited with the values.';

export const isSpanConversionId = (id: unknown): id is SpanConversionId => typeof id === 'string' && Object.hasOwn(SPAN_FROM_APAN, id);

/** One month's A-pan (mm) from its S-pan (mm): (S − b) ÷ a. */
export function apanFromSpan(spanMm: number, c: PanConversion): number {
	return (spanMm - c.interceptMm) / c.slope;
}

/** The lowest monthly S-pan (mm) a conversion is used at: the forward floor's S, −2b (WR90 32.5 mm, Taljaard 22.3 mm). */
export function spanConversionFloorMm(c: PanConversion): number {
	return c.slope * panConversionFloorMm(c) + c.interceptMm;
}

const MONTHS = ['Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep'];
const r1 = (x: number) => Math.round(x * 10) / 10;

export type SpanToApanFill = { ok: true; values: number[]; note: string } | { ok: false; reason: string };

/**
 * The 12 monthly A-pan means (mm, water-year order Oct–Sep, one decimal) from
 * 12 S-pan means by the chosen inverted equation, and a note citing it; or
 * why not (a month missing, negative or under the floor).
 */
export function apanMonthlyFromSpan(spanMm: readonly number[], id: SpanConversionId): SpanToApanFill {
	const c = SPAN_FROM_APAN[id];
	if (spanMm.length !== 12 || spanMm.some((s) => !Number.isFinite(s) || s < 0)) {
		return { ok: false, reason: 'the S-pan record needs a mean of 0 mm or more for each of the 12 months' };
	}
	const floor = spanConversionFloorMm(c);
	const low = spanMm.flatMap((s, m) => (s < floor ? [MONTHS[m]!] : []));
	if (low.length) {
		return {
			ok: false,
			reason: `the S-pan in ${low.join(', ')} is below ${r1(floor)} mm, under the depths the equation was fitted on (its intercept would make up most of the A-pan); enter those months by hand or pick a Class-A station`
		};
	}
	const values = spanMm.map((s) => r1(apanFromSpan(s, c)));
	return { ok: true, values, note: `S-pan converted to A-pan by A = (S + ${-c.interceptMm}) ÷ ${c.slope}, the inverse of the ${c.citation}` };
}
