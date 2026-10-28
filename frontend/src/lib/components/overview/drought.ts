// The Summary's Drought index card (issue #620; docs/ui.md § Summary, docs/model.md §2.15b): which of the
// latest run's series it reads, and the engine's badge as the card's rows. Workspace only, English: the
// farm view shows the restriction level the WUA publishes, never a raw index (#620 open question 4).
import {
	DROUGHT_CLASS_LABEL,
	DROUGHT_MIN_YEARS,
	DROUGHT_SCALES,
	addMonths,
	driestIndex,
	type DroughtBadge,
	type DroughtBadgeIndex,
	type DroughtClass,
	type DroughtReference
} from '@water-management/engine';
import type { RunSeriesRef } from '#lib/api/types.js';
import { fmtNum } from '#lib/format/number.js';
import { monthName } from '#lib/format/months.js';

/** The catchment series the card reads: rain_final for the SPI, pet beside it for the SPEI. */
export const DROUGHT_RAIN = 'rain_final';
export const DROUGHT_PET = 'pet';

/** Which of them the run stores (catchment-level, node null): no rain_final, no card body. */
export function droughtSeries(refs: readonly RunSeriesRef[]): { rain: boolean; pet: boolean } {
	const has = (key: string) => refs.some((r) => r.key === key && r.nodeId === null);
	return { rain: has(DROUGHT_RAIN), pet: has(DROUGHT_PET) };
}

export type DroughtTone = 'dry' | 'wet' | 'normal';

export function droughtTone(c: DroughtClass): DroughtTone {
	return c.endsWith('-dry') ? 'dry' : c.endsWith('-wet') ? 'wet' : 'normal';
}

/** `YYYY-MM` → "Oct 2024". */
export const monthText = (ym: string) => `${monthName(Number(ym.slice(5, 7)))} ${ym.slice(0, 4)}`;

/** "Aug–Oct 2024" for the 3 months ending Oct 2024; across a year end "Nov 2023 – Oct 2024". */
export function periodText(month: string, scale: number): string {
	const first = addMonths(month, -(scale - 1));
	if (first.slice(0, 4) === month.slice(0, 4)) return `${monthName(Number(first.slice(5, 7)))}–${monthText(month)}`;
	return `${monthText(first)} – ${monthText(month)}`;
}

export interface DroughtCell {
	/** "−1.62", or "–" without a value. */
	value: string;
	/** The class, or why there is no value. */
	label: string;
	tone: DroughtTone | null;
}

const GAP_TEXT = {
	'no-pet': 'No evaporation in this run',
	'missing-month': 'A month is missing',
	'short-record': 'Record too short'
} as const;

function cell(i: DroughtBadgeIndex | undefined): DroughtCell {
	if (!i || i.value === null || i.class === null) return { value: '–', label: i?.gap ? GAP_TEXT[i.gap] : '', tone: null };
	return { value: fmtNum(i.value, 2), label: DROUGHT_CLASS_LABEL[i.class], tone: droughtTone(i.class) };
}

export interface DroughtRow {
	scale: number;
	/** The months the row covers, "Aug–Oct 2024". */
	period: string;
	spi: DroughtCell;
	spei: DroughtCell;
}

/** One row per accumulation period: its SPI and SPEI. Empty without a month. */
export function droughtRows(badge: DroughtBadge): DroughtRow[] {
	if (!badge.month) return [];
	const find = (kind: 'spi' | 'spei', scale: number) => badge.indices.find((i) => i.kind === kind && i.scale === scale);
	return DROUGHT_SCALES.map((scale) => ({ scale, period: periodText(badge.month!, scale), spi: cell(find('spi', scale)), spei: cell(find('spei', scale)) }));
}

/** The card's headline: the driest index with a value, "Severely dry · SPEI-12". */
export function droughtHeadline(badge: DroughtBadge): { label: string; index: string; tone: DroughtTone } | null {
	const d = driestIndex(badge);
	if (!d || d.class === null) return null;
	return { label: DROUGHT_CLASS_LABEL[d.class], index: `${d.kind.toUpperCase()}-${d.scale}`, tone: droughtTone(d.class) };
}

const refText = (r: DroughtReference) =>
	r.kind === 'standard' ? `${r.from}–${r.to}` : `the whole record, ${r.from}–${r.to}${r.minYears < 30 ? ` (as few as ${r.minYears} years a month)` : ''}`;

/** Which years the fits used, for the card's foot: "Fitted on 1991–2020." (SPI and SPEI apart only when they differ). */
export function referenceText(badge: DroughtBadge): string | null {
	const spi = badge.indices.find((i) => i.kind === 'spi' && i.reference)?.reference ?? null;
	const spei = badge.indices.find((i) => i.kind === 'spei' && i.reference)?.reference ?? null;
	if (!spi && !spei) return null;
	if (spi && spei && refText(spi) !== refText(spei)) return `SPI fitted on ${refText(spi)}; SPEI on ${refText(spei)}.`;
	return `Fitted on ${refText((spi ?? spei)!)}.`;
}

/** The record's length to the badge's month: "4 months", "12 years" (whole years from 24 months). */
export function recordText(badge: DroughtBadge): string {
	if (!badge.month || !badge.firstMonth) return 'no whole month';
	const n = (Number(badge.month.slice(0, 4)) - Number(badge.firstMonth.slice(0, 4))) * 12 + Number(badge.month.slice(5, 7)) - Number(badge.firstMonth.slice(5, 7)) + 1;
	return n >= 24 ? `${Math.floor(n / 12)} years` : `${n} month${n === 1 ? '' : 's'}`;
}

/** Why no index has a value, in one line (the card shows it in place of the table). */
export function noIndexText(badge: DroughtBadge): string {
	if (badge.indices.some((i) => i.gap === 'short-record'))
		return `Needs at least ${DROUGHT_MIN_YEARS} years of rain in each calendar month; this run has ${recordText(badge)}.`;
	return 'A month of rain is missing in every period, so none can be scored.';
}
