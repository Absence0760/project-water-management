// The Reserve heat maps of § 1 (issue #71, docs/design/evidence-report.md
// §4.2, C10): month × water-year grids, baseline and application, each cell
// shaded by the share of the requirement delivered (depth of failure, the
// environmentalist's ask) and outlined where the application changes the
// verdict. A failed month is the heavier mark, so it survives a photocopy;
// the numbers are in the cells too, never only a shade (§8).
import type { EvidenceSite } from '@water-management/engine';
import { WATER_YEAR_CALENDAR, monthName } from '$lib/format/months';

export interface GridCell {
	/** Share of the requirement delivered, 0–1+; null when nothing was required. */
	delivered: number | null;
	met: boolean;
	/** The application loses (met → not met) or gains the month; null when unchanged or baseline evidence. */
	change: 'lost' | 'gained' | null;
	/** 0 (met) … 4 (under a quarter delivered): the shade. */
	depth: 0 | 1 | 2 | 3 | 4;
	/** The cell in words, for a screen reader and the title. */
	text: string;
}

export interface ReserveGrid {
	waterYears: number[];
	/** [water-year row][water-year month, 0 = Oct]; null where the run has no complete month. */
	cells: (GridCell | null)[][];
}

/** How deep a failure is: 0 met; 1 at least 75 % delivered; 2 at least half; 3 at least a quarter; 4 less. */
export function depthOf(met: boolean, delivered: number | null): GridCell['depth'] {
	if (met) return 0;
	if (delivered === null) return 4;
	if (delivered >= 0.75) return 1;
	if (delivered >= 0.5) return 2;
	if (delivered >= 0.25) return 3;
	return 4;
}

/** One run's grid ('a' baseline, 'b' application). */
export function reserveGrid(site: Pick<EvidenceSite, 'months'>, side: 'a' | 'b'): ReserveGrid {
	const years = [...new Set(site.months.map((m) => m.waterYear))].sort((x, y) => x - y);
	const row = new Map(years.map((y, i) => [y, i]));
	const cells: (GridCell | null)[][] = years.map(() => new Array<GridCell | null>(12).fill(null));
	for (const m of site.months) {
		const met = side === 'a' ? m.metA : m.metB;
		if (met === null) continue;
		const delivered = side === 'a' ? m.deliveredA : m.deliveredB;
		const change = m.metB === null ? null : m.metA && !m.metB ? 'lost' : !m.metA && m.metB ? 'gained' : null;
		const col = WATER_YEAR_CALENDAR.indexOf(m.month as (typeof WATER_YEAR_CALENDAR)[number]);
		const pct = delivered === null ? 'nothing required' : `${Math.round(delivered * 100)} % of the requirement delivered`;
		const moved = change === 'lost' ? '; lost by the application' : change === 'gained' ? '; gained by the application' : '';
		cells[row.get(m.waterYear)!]![col] = {
			delivered,
			met,
			change,
			depth: depthOf(met, delivered),
			text: `${monthName(m.month)} ${m.year}: ${met ? 'met' : 'not met'}, ${pct}${moved}`
		};
	}
	return { waterYears: years, cells };
}

/** The water year's label: 1990 → "1990/91". */
export const waterYearLabel = (y: number) => `${y}/${String((y + 1) % 100).padStart(2, '0')}`;

/**
 * The FDC checks § 1 plots at a site, in order: the month the report ranks
 * first (`fdcMonth`: the largest drop in months met, else the one met least
 * often) and the river's driest month (`fdcDriestMonth`: the lowest mean
 * natural flow in the baseline), one plot when they are the same month.
 */
export function fdcMonths(site: Pick<EvidenceSite, 'fdcMonth' | 'fdcDriestMonth'>, application: boolean): { month: number; kind: 'change' | 'driest' | 'both'; why: string }[] {
	const chosen = application ? 'the month the application loses most months met in, or else the month met least often' : 'the month met least often';
	const driest = 'the river’s driest month (the lowest mean natural flow in the baseline)';
	const out: { month: number; kind: 'change' | 'driest' | 'both'; why: string }[] = [];
	if (site.fdcMonth !== null)
		out.push(site.fdcMonth === site.fdcDriestMonth ? { month: site.fdcMonth, kind: 'both', why: `${chosen}, and ${driest}.` } : { month: site.fdcMonth, kind: 'change', why: `${chosen}.` });
	if (site.fdcDriestMonth !== null && site.fdcDriestMonth !== site.fdcMonth) out.push({ month: site.fdcDriestMonth, kind: 'driest', why: `${driest}.` });
	return out;
}
