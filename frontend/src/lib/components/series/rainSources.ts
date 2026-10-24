// Where each day of an area's rain used came from (issue #553 round 5, docs/ui.md § Data): the day counts, the
// chart's source strip and the sentence AreaRainPanel shows. Kept apart from ./derivedRain.ts, whose engine run
// preparation is loaded only when an area row opens (it would otherwise enter the Data tab's chunk). Pure.
import { fromEpochDay, toEpochDay, type StationRainDaySource } from '@water-management/engine';
import { fmtNum } from '#lib/format/number.js';

/** The days by source, as the run counts them (StationAreaForcing.days). */
export function sourceCounts(source: readonly StationRainDaySource[]): Record<StationRainDaySource, number> {
	const n: Record<StationRainDaySource, number> = { station: 0, chirps: 0, fallback: 0, none: 0 };
	for (const s of source) n[s]++;
	return n;
}

/** The chart's source strip: one lane per source other than the station (the default, no strip), with its days in words. */
export interface SourceLane {
	label: string;
	color: string;
	ranges: { start: string; end: string }[];
	text: string;
}

const SOURCE_LANES: readonly { source: Exclude<StationRainDaySource, 'station'>; label: string; color: string; what: string }[] = [
	{ source: 'chirps', label: 'Corrected CHIRPS', color: '--series-9', what: 'corrected CHIRPS (the station has no reading, or it was set aside)' },
	{ source: 'fallback', label: 'Next fallback', color: '--series-10', what: 'the next fallback (no corrected CHIRPS that day)' },
	{ source: 'none', label: 'No rain', color: '--text-muted', what: 'no rain from any source (read as dry)' }
];

export function sourceLanes(startDate: string, source: readonly StationRainDaySource[]): SourceLane[] {
	const d0 = toEpochDay(startDate);
	const out: SourceLane[] = [];
	for (const l of SOURCE_LANES) {
		const ranges: { start: string; end: string }[] = [];
		let days = 0;
		for (let t = 0; t < source.length; t++) {
			if (source[t] !== l.source) continue;
			days++;
			const last = ranges[ranges.length - 1];
			const iso = fromEpochDay(d0 + t);
			if (last && toEpochDay(last.end) === d0 + t - 1) last.end = iso;
			else ranges.push({ start: iso, end: iso });
		}
		if (days) out.push({ label: l.label, color: l.color, ranges, text: `${fmtNum(days)} ${days === 1 ? 'day' : 'days'} from ${l.what}` });
	}
	return out;
}

/** One line of what the run read, in words: "4,018 days from the station, 312 from corrected CHIRPS, 2 from the next fallback." */
export function sourceSummary(source: readonly StationRainDaySource[]): string {
	const n = sourceCounts(source);
	const day = (k: number) => `${fmtNum(k)} ${k === 1 ? 'day' : 'days'}`;
	const parts = [`${day(n.station)} from the station`];
	if (n.chirps) parts.push(`${fmtNum(n.chirps)} from corrected CHIRPS`);
	if (n.fallback) parts.push(`${fmtNum(n.fallback)} from the next fallback`);
	if (n.none) parts.push(`${fmtNum(n.none)} with no rain from any source`);
	return `${parts.join(', ')}.`;
}
