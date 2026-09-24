// Display helpers for a run's WR2012 check (RunSummary.wr2012; issue #4 phase 8).
import type { Wr2012FlagLevel, Wr2012Report } from '@water-management/engine';
import { fmtNum } from '$lib/format/number';
import { monthName } from '$lib/format/months';

export const FLAG_LABEL: Record<Wr2012FlagLevel, string> = {
	ok: 'Within the note threshold',
	note: 'Note the difference',
	query: 'Query',
	unusable: 'Not usable for EWR findings'
};

/** "1.30 (+30 %)": a ratio and its deviation from 1. */
export function ratioText(r: number | null | undefined): string {
	if (r == null || !Number.isFinite(r)) return '–';
	const d = Math.round(100 * (r - 1));
	return `${fmtNum(r, 2)} (${d > 0 ? '+' : d < 0 ? '−' : '±'}${Math.abs(d)} %)`;
}

/** Water year labelled by the calendar year it starts in: 2001 → "2001/02". */
export const waterYear = (y: number) => `${y}/${String((y + 1) % 100).padStart(2, '0')}`;

/** "2001/02 – 2004/05 (4 water years)" */
export function yearsText(years: number[]): string {
	if (!years.length) return 'none';
	const n = `${years.length} water year${years.length === 1 ? '' : 's'}`;
	return years.length === 1 ? `${waterYear(years[0]!)} (${n})` : `${waterYear(years[0]!)} – ${waterYear(years[years.length - 1]!)} (${n})`;
}

/** The scaling rule and factor, in words, e.g. "Area ratio: 10 km² ÷ 40 km² = 0.25". */
export function describeScaling(r: Wr2012Report): string {
	const s = r.scaling;
	const area = `${fmtNum(s.modelAreaKm2, 2, true)} km² ÷ ${fmtNum(s.referenceAreaKm2, 2, true)} km²`;
	if (s.rule === 'areaRain' && s.rainFactor !== null) {
		return `Area and rainfall ratio: (${area}) × (${fmtNum(s.modelMapMm, 0)} mm ÷ ${fmtNum(s.referenceMapMm, 0)} mm) = ${fmtNum(s.factor, 3, true)}`;
	}
	const fell = s.requested === 'areaRain' ? ' (the rainfall ratio was asked for but the data for it is missing)' : '';
	return `Area ratio: ${area} = ${fmtNum(s.factor, 3, true)}${fell}`;
}

/** "Dec, Jan, Feb" in water-year order. */
export function monthsText(months: number[]): string {
	const order = [10, 11, 12, 1, 2, 3, 4, 5, 6, 7, 8, 9];
	return order.filter((m) => months.includes(m)).map(monthName).join(', ');
}
