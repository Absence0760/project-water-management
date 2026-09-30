// The Reserve heat maps of § 1 (issue #71, docs/design/evidence-report.md
// §4.2, C10): month × water-year grids, baseline and application, each cell
// shaded by the share of the requirement delivered (depth of failure, the
// environmentalist's ask) and outlined where the application changes the
// verdict. A failed month is the heavier mark, so it survives a photocopy;
// the numbers are in the cells too, never only a shade (§8).
import type { EvidenceChange, EvidenceSite } from '@water-management/engine';
import { WATER_YEAR_CALENDAR, monthName } from '$lib/format/months';
import { signed, worseText } from './format';

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

/**
 * The caption of one FDC check plot. With the paired change tabled under it
 * (evidence-7) the shading is each run's own spread and the table carries
 * the change. Where the application's band is drawn but no change is tabled
 * (a pack issued before evidence-7, or runs read at different table points)
 * the caption keeps the warning that overlapping ranges don't mean no change.
 */
export function fdcCaption(
	site: Pick<EvidenceSite, 'fdcBands' | 'fdcBandNote' | 'fdcChange'>,
	f: { month: number; why: string },
	application: boolean
): string {
	const head = `${monthName(f.month)}: ${f.why} The simulated curve should lie on or above the EWR curve.`;
	if (!site.fdcBands) return `${head} Curve band: ${site.fdcBandNote ?? 'no band'}.`;
	const note = site.fdcBandNote ? ` ${site.fdcBandNote}` : '';
	const hatched = application && (site.fdcBands.find((m) => m.month === f.month)?.b?.some((x) => x !== null) ?? false);
	if (!hatched) return `${head} Shaded: the range of the kept parameter sets on the baseline’s curve (R1).${note}`;
	const tabled = site.fdcChange?.some((m) => m.month === f.month && m.points.length) ?? false;
	if (!tabled)
		return `${head} Shaded: the range of the kept parameter sets (R1; the application’s under R2, not a difference). Overlapping ranges don’t mean no change: the paired change is in the rows above and in § 2.${note}`;
	return `${head} Shaded: how far the kept parameter sets spread each run’s own curve (R1; the application’s hatched, R2). The table below pairs them: each set on both runs, the change at each point.${note}`;
}

export interface FdcChangeRow {
	/** The table point: % of the time the flow is equalled or exceeded. */
	point: number;
	/** The paired median, or the runs' own difference without a band. */
	main: string;
	/** The 5–95 % range and the runs' own difference, or why there is no band. */
	sub: string | null;
	/** "k of n sets (p %)": the sets in which the application's flow is lower. */
	worse: string;
}

/** Decimal places for a month's changes: enough for its largest to show three significant figures, 0–4. */
function flowDigits(values: number[]): number {
	const big = Math.max(0, ...values.map(Math.abs));
	if (big >= 100) return 0;
	if (big >= 10) return 1;
	if (big >= 1) return 2;
	if (big >= 0.1) return 3;
	return 4;
}

/**
 * The paired change in one month's FDC check curve (evidence-7), one row per
 * table point: `points` are the table's points (% exceedance), `site.fdcChange`
 * the document's cells. Empty when the document has none for the month.
 */
export function fdcChangeRows(site: Pick<EvidenceSite, 'fdcChange'>, month: number, points: readonly number[]): FdcChangeRow[] {
	const cells = site.fdcChange?.find((m) => m.month === month)?.points ?? [];
	if (!cells.length) return [];
	const digits = flowDigits(cells.flatMap((c) => [c.run, c.band?.p5, c.band?.p50, c.band?.p95].filter((v): v is number => typeof v === 'number' && Number.isFinite(v))));
	// A cell past the plotted points has no point to name: left out rather than printed as "NaN %".
	return cells.flatMap((c: EvidenceChange, j) => {
		const point = points[j];
		if (point === undefined) return [];
		const run = c.run === null ? null : signed(c.run, digits);
		const b = c.band;
		const banded = !c.bandNote && b && b.p5 !== null && b.p50 !== null && b.p95 !== null;
		return [
			{
				point,
				main: banded ? signed(b.p50!, digits) : run ? `run: ${run}` : '–',
				sub: banded ? `${signed(b.p5!, digits)} to ${signed(b.p95!, digits)}${run ? ` · run: ${run}` : ''}` : (c.bandNote ?? 'no band'),
				worse: worseText(c)
			}
		];
	});
}
