// Dams → "Seen from space" (issue #604 R5-B; docs/ui.md § Dams, docs/model.md
// § Modelled vs observed dam area). The picked dam's surface area from the run
// beside what Digital Earth Africa's satellites saw, with the spill, empty and
// mismatch flags the API worked out (backend dams/observed/compare.ts). Pure:
// the fold's one line, the chart's series and flag lanes, the summary
// sentence, the match notes and the table of views.
import { beforeForecast, fromEpochDay, toEpochDay, type DailySeries } from '@water-management/engine';
import type { DamObservations, ObservedDam, ObservedPoint, ObservedSkip, ObservedSource } from '#lib/api/types.js';
import type { ChartSeries } from '#lib/components/charts/series.js';
import { fmtDay, fmtNum } from '#lib/format/number.js';

/** Areas on this panel are hectares: a dam's surface reads better as "3.2 ha" than "32 000 m²". */
export const HA = 10_000;
export const fmtHa = (m2: number) => `${fmtNum(m2 / HA, m2 < 10 * HA ? 2 : 1)} ha`;

export const SOURCE_WORDS: Record<ObservedSource, string> = { waterbodies: 'DE Africa Waterbodies', wofs: 'WOfS, inside the dam’s outline' };

export const SKIP_WORDS: Record<ObservedSkip, string> = {
	'partly-seen': 'partly seen (cloud or shadow)',
	'not-this-dam': 'a Waterbodies polygon that isn’t this dam alone',
	'partial-unit': 'not every one of the unit’s dams seen that day',
	'other-source': 'WOfS saw it the same day',
	'outside-run': 'outside the run',
	'no-run': 'no run to compare with'
};

/** The four mismatches in words: which side says what. */
export const MISMATCH_WORDS = {
	'model-full': 'model full, satellite not',
	'model-empty': 'model empty, satellite sees water',
	'seen-full': 'satellite full, model not',
	'seen-empty': 'satellite empty, model holds water'
} as const;

/** The unit's entry, or null when none of its dams is drawn as an outline. */
export const observedFor = (data: DamObservations | null, nodeId: string): ObservedDam | null => data?.dams.find((d) => d.nodeId === nodeId) ?? null;

const pct = (share: number) => `${fmtNum(share * 100, 0)}%`;
const views = (n: number) => `${fmtNum(n)} clear view${n === 1 ? '' : 's'}`;

/**
 * The fold's line: how many views were compared, how many disagree and how many agree within `withinShare` of the
 * full area (the API's threshold, DamObservations.thresholds), or why there's nothing to show.
 */
export function observedLine(dam: ObservedDam | null, loading: boolean, error: string | null, withinShare: number): string {
	if (error) return 'couldn’t be loaded';
	if (loading) return 'loading…';
	if (!dam) return 'no outline of this dam on the map';
	if (!dam.points.length) return 'no satellite views yet';
	const s = dam.summary;
	if (!s.compared) return s.latestClear ? `none compared · latest clear view ${fmtDay(s.latestClear.date)}` : 'no clear view yet';
	const parts = [`${views(s.compared)} compared`, s.mismatches ? `${fmtNum(s.mismatches)} disagree${s.mismatches === 1 ? 's' : ''}` : 'none disagree'];
	if (s.withinShare !== null) parts.push(`${pct(s.withinShare)} within ±${fmtNum(withinShare * 100, 0)}%`);
	return parts.join(' · ');
}

/** "On average the model holds 6% of the full area more than seen …": the summary of the compared views, or null with none. */
export function summaryWords(dam: ObservedDam, withinShare: number): string | null {
	const s = dam.summary;
	const c = dam.points.filter((p) => p.compared);
	if (!s.compared || !c.length || s.biasPctOfFull === null || s.withinShare === null || !dam.fullArea) return null;
	const b = s.biasPctOfFull;
	const bias = Math.abs(b) < 0.5 ? 'the model and the satellite agree on average' : `on average the model has ${fmtNum(Math.abs(b), 0)}% of the full area ${b > 0 ? 'more' : 'less'} water surface than the satellite saw`;
	const flags = [s.seenFull ? `seen full ${fmtNum(s.seenFull)} time${s.seenFull === 1 ? '' : 's'}` : '', s.seenEmpty ? `seen empty ${fmtNum(s.seenEmpty)} time${s.seenEmpty === 1 ? '' : 's'}` : ''].filter(Boolean);
	return (
		`${views(s.compared)} from ${fmtDay(c[0]!.date)} to ${fmtDay(c.at(-1)!.date)}: ${bias}; ` +
		`within ±${fmtNum(withinShare * 100, 0)}% of the full area on ${pct(s.withinShare)} of them.` +
		(flags.length ? ` ${capital(flags.join(', '))}.` : '')
	);
}
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** What the full area is and where it comes from. */
export function fullAreaWords(dam: ObservedDam): string | null {
	const f = dam.fullArea;
	if (!f) return null;
	const from = f.from === 'survey' ? 'the top of its survey curve' : f.from === 'entered' ? 'as entered' : 'estimated from its capacity (no area entered)';
	return `Full area ${fmtHa(f.areaM2)}, ${from}.`;
}

/** One line per polygon that Waterbodies doesn't see as this dam alone, so its Waterbodies views aren't compared. */
export function matchNotes(dam: ObservedDam): string[] {
	const out: string[] = [];
	for (const f of dam.features) {
		const name = f.name ? `“${f.name}”` : 'An unnamed dam outline';
		if (f.match?.status === 'merged') out.push(`${name} is merged with a neighbouring water body in DE Africa Waterbodies, so only WOfS views of its own outline are compared.`);
		else if (f.match?.status === 'none') out.push(`${name} has no DE Africa Waterbodies polygon (too small, or not mapped): only WOfS views of its own outline.`);
		else if (!f.match) out.push(`${name} hasn’t been matched to DE Africa Waterbodies yet: only WOfS views of its own outline are compared.`);
	}
	return out;
}

/** A daily series from `from` to `to` (inclusive), null except on the points' dates. */
function sparse(points: readonly ObservedPoint[], from: string, to: string, value: (p: ObservedPoint) => number): DailySeries & { values: (number | null)[] } {
	const start = toEpochDay(from);
	const values: (number | null)[] = new Array(toEpochDay(to) - start + 1).fill(null);
	for (const p of points) values[toEpochDay(p.date) - start] = value(p);
	return { startDate: from, values };
}

/**
 * The chart: the run's modelled surface area as a line (ha), the compared
 * views as points, the views not compared as fainter points (off until the
 * legend shows them), and the full area dashed. null with nothing to draw.
 * A forecast run's modelled area ends before its forecast (`forecastFrom`):
 * those days aren't modelled history, and the comparison leaves views on them
 * out too (backend dams/observed/compare.ts, 'outside-run').
 */
export function observedChartSeries(dam: ObservedDam, stored: DailySeries | null, forecastFrom: string | null = null): ChartSeries[] {
	const modelled = stored && { startDate: stored.startDate, values: Array.from(beforeForecast(stored.values, stored.startDate, forecastFrom)) };
	const pts = dam.points;
	const series: ChartSeries[] = [];
	const ends = [pts[0]?.date, pts.at(-1)?.date, modelled?.startDate, modelled ? fromEpochDay(toEpochDay(modelled.startDate) + modelled.values.length - 1) : undefined].filter((d): d is string => !!d).sort();
	if (!ends.length) return [];
	const [from, to] = [ends[0]!, ends.at(-1)!];
	if (modelled) series.push({ label: 'Modelled area', startDate: modelled.startDate, values: modelled.values.map((v) => (v == null || !Number.isFinite(v) ? null : v / HA)), color: '--series-1', width: 2 });
	const compared = pts.filter((p) => p.compared);
	const other = pts.filter((p) => !p.compared);
	if (compared.length) series.push({ label: 'Seen from space', ...sparse(compared, from, to, (p) => p.wetAreaM2 / HA), style: 'points', color: '--series-2', pointSize: 8 });
	if (other.length) series.push({ label: 'Seen, not compared', ...sparse(other, from, to, (p) => p.wetAreaM2 / HA), style: 'points', color: '--text-muted', pointSize: 6, hidden: true });
	if (dam.fullArea) {
		const len = toEpochDay(to) - toEpochDay(from) + 1;
		series.push({ label: 'Full area', startDate: from, values: new Array(len).fill(dam.fullArea.areaM2 / HA), style: 'dashed', color: '--text-2', width: 1 });
	}
	return series;
}

/**
 * The flags as the chart's lanes: one strip each along the plot's foot, named in its key. Their own colours
 * (app.css --lane-disagree, --lane-seen-full, --lane-seen-empty), not --danger / --accent / --warning: a deuteranope
 * saw the light --danger and --warning as one colour (ΔE00 0.7), and the dark --danger sat under 13 from the
 * --series-2 points. observedLaneColours.test.ts computes every pair and each strip against every line the chart draws.
 */
export const OBSERVED_LANE_COLOR = { disagree: '--lane-disagree', seenFull: '--lane-seen-full', seenEmpty: '--lane-seen-empty' } as const;
/** The chart's own lines and points, by token (observedChartSeries), which the strips must stay apart from. */
export const OBSERVED_LINE_COLORS = ['--series-1', '--series-2', '--text-muted', '--text-2'] as const;

export function observedLanes(dam: ObservedDam): { label: string; color: string; ranges: { start: string; end: string }[]; text: string }[] {
	const c = dam.points.filter((p) => p.compared);
	const days = (f: (p: ObservedPoint) => boolean) => c.filter(f).map((p) => ({ start: p.date, end: p.date }));
	const lanes = [
		{ label: 'Disagree', color: OBSERVED_LANE_COLOR.disagree, ranges: days((p) => p.mismatch !== null), text: 'the model and the satellite disagree: one says full or empty, the other clearly doesn’t' },
		{ label: 'Seen full', color: OBSERVED_LANE_COLOR.seenFull, ranges: days((p) => p.seenFull), text: 'the satellite saw the dam at its full area or more (likely spilling)' },
		{ label: 'Seen empty', color: OBSERVED_LANE_COLOR.seenEmpty, ranges: days((p) => p.seenEmpty), text: 'the satellite saw almost no water' }
	];
	return lanes.filter((l) => l.ranges.length);
}

/** The table shows this many of the newest views until "Show all N views" opens the rest (ui-playbook.md § 2, fold every long list). */
export const VIEWS_SHOWN = 10;

/** A view's row in the table: what it says, newest first. */
export interface ViewRow {
	key: string;
	date: string;
	source: string;
	seen: string;
	clear: string;
	modelled: string;
	/** The flags or why it wasn't compared. */
	note: string;
	mismatch: boolean;
}

export function viewRows(dam: ObservedDam): ViewRow[] {
	return [...dam.points].reverse().map((p) => {
		const d = p.modelledAreaM2 === null ? null : p.modelledAreaM2 - p.wetAreaM2;
		const flags = [p.mismatch ? `Disagree: ${MISMATCH_WORDS[p.mismatch]}` : '', p.seenFull ? 'seen full' : '', p.seenEmpty ? 'seen empty' : ''].filter(Boolean);
		const diff = d === null ? '' : `model ${d >= 0 ? '+' : '\u2212'}${fmtHa(Math.abs(d))}`;
		return {
			key: `${p.date}|${p.source}`,
			date: fmtDay(p.date),
			source: SOURCE_WORDS[p.source],
			seen: fmtHa(p.wetAreaM2),
			clear: `${fmtNum(p.pctObserved, 0)}%`,
			modelled: p.modelledAreaM2 === null ? '–' : fmtHa(p.modelledAreaM2),
			note: p.compared ? capital([diff, ...flags].filter(Boolean).join('; ')) : `Not compared: ${SKIP_WORDS[p.skip!]}`,
			mismatch: !!p.mismatch
		};
	});
}
