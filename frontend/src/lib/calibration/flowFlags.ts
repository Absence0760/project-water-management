// The per-day quality flags of an observed flow record (CR-18, engine
// ≥ 1.48.0, docs/model.md §2.10h) as strips along the foot of a daily chart:
// one strip per flagged class, so a class reads by its place as well as its
// colour, and a key line per strip saying how many days it holds and what
// Fit automatically does with them. The Runs hydrograph reads the run's
// `observed_flow_quality` column; the Data tab's flow chart computes the
// same classes from the stored record (engine recordFlowFlags). Pure.
import { FLAG_USE_TEXT, FLOW_DAY_FLAGS, FLOW_FLAG_LABEL, fromEpochDay, toEpochDay, type FlowDayFlag, type QualityFlagSettings } from '@water-management/engine';
import { fmtNum } from '$lib/format/number';

/** One class's strip: the days it covers as inclusive date ranges, and its key line. */
export interface FlagLane {
	flag: FlowDayFlag;
	label: string;
	/** A colour token (the chart reads it from the page's CSS). */
	color: string;
	ranges: { start: string; end: string }[];
	days: number;
	/** The key's line: "Above the highest gauging: 14 days; Fit automatically: censored at the highest gauging". */
	text: string;
}

/** The classes drawn, top strip first; in range and missing are not (the line itself shows a missing day as a gap). */
export const LANE_FLAGS: readonly FlowDayFlag[] = ['aboveRating', 'belowRating', 'suspect', 'infilled', 'humanUse'];

const LANE_COLOR: Record<FlowDayFlag, string> = {
	aboveRating: '--series-9',
	belowRating: '--series-10',
	suspect: '--series-5',
	infilled: '--series-8',
	humanUse: '--series-6',
	inRange: '--series-3',
	missing: '--text-muted'
};

/** What Fit automatically does with a class's days under the quality-flag settings, in the engine's words (FLAG_USE_TEXT); '' without them. */
export function flagUseText(flag: FlowDayFlag, use: Omit<QualityFlagSettings, 'ratings'> | null | undefined): string {
	if (!use) return '';
	const u = flag === 'aboveRating' ? use.aboveRating : flag === 'belowRating' ? use.belowRating : flag === 'suspect' ? use.suspect : flag === 'infilled' ? use.infilled : 'include';
	return `Fit automatically: ${FLAG_USE_TEXT[u]}`;
}

/**
 * The strips of a record's class codes (FLOW_FLAG_CODE per day from
 * `startDate`), one per class with at least one day, in LANE_FLAGS order.
 * `use` is the quality-flag settings the key names each class's treatment
 * by (a run's own settings snapshot on the Runs tab); null leaves it out.
 */
export function flowFlagLanes(codes: ArrayLike<number>, startDate: string, use: Omit<QualityFlagSettings, 'ratings'> | null = null): FlagLane[] {
	const d0 = toEpochDay(startDate);
	const out: FlagLane[] = [];
	for (const flag of LANE_FLAGS) {
		const code = FLOW_DAY_FLAGS.indexOf(flag);
		const ranges: FlagLane['ranges'] = [];
		let days = 0;
		for (let t = 0; t < codes.length; t++) {
			if (codes[t] !== code) continue;
			let j = t;
			while (j + 1 < codes.length && codes[j + 1] === code) j++;
			ranges.push({ start: fromEpochDay(d0 + t), end: fromEpochDay(d0 + j) });
			days += j - t + 1;
			t = j;
		}
		if (!days) continue;
		const how = flagUseText(flag, use);
		const label = FLOW_FLAG_LABEL[flag];
		out.push({ flag, label, color: LANE_COLOR[flag], ranges, days, text: `${label}: ${fmtNum(days)} day${days === 1 ? '' : 's'}${how ? `; ${how}` : ''}` });
	}
	return out;
}
