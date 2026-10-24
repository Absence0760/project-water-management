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
	/** Drawn as a double line (strip and key swatch: a ground-coloured line along its middle), so it reads apart from a neighbour without its colour (LANE_DOUBLED). */
	doubled: boolean;
	ranges: { start: string; end: string }[];
	days: number;
	/** The key's line: "Above the highest gauging: 14 days; Fit automatically: censored at the highest gauging". */
	text: string;
}

/** The classes drawn, top strip first; in range and missing are not (the line itself shows a missing day as a gap). */
export const LANE_FLAGS: readonly FlowDayFlag[] = ['aboveRating', 'periodHigh', 'belowRating', 'suspect', 'infilled', 'humanUse'];

export const LANE_COLOR: Record<FlowDayFlag, string> = {
	aboveRating: '--series-9',
	belowRating: '--series-10',
	suspect: '--lane-suspect',
	infilled: '--lane-infilled',
	humanUse: '--lane-human-use',
	// Never drawn (LANE_FLAGS): an in-range day has no strip, a missing one is a gap in the line.
	inRange: '--text-muted',
	missing: '--text-muted',
	periodHigh: '--series-7'
};

/**
 * The classes drawn as a double line (a ground-coloured line along the strip's
 * middle, the key swatch the same) rather than solid. Two looks, by what the
 * class says: solid, a reading outside the flow it can be trusted at (above the
 * highest gauging, above a low-flow period's threshold, below the lowest
 * gauging); a double line, the reading itself is doubtful or not the river's
 * own (suspect, infilled, human use dominant; their own --lane-* colours).
 * No choice of six palette tokens keeps every pair apart for colour-blind
 * readers, nor any with one class set apart (every choice was computed, PR
 * #570); within each look every pair is ΔE00 ≥ 10 for normal vision,
 * protanopia, deuteranopia and tritanopia, light and dark, every strip is
 * ≥ 3:1 on the card, and none shares a colour with a line the flow charts draw. Not hatching: a strip's range
 * is often one day, under a pixel on a decade's view, where a line along the
 * middle still shows. flowFlagColours.test.ts computes every pair from app.css;
 * docs/design/ui-playbook.md § 3, Hold non-text parts to 3:1.
 */
export const LANE_DOUBLED: ReadonlySet<FlowDayFlag> = new Set<FlowDayFlag>(['suspect', 'infilled', 'humanUse']);

/** The key's note on the two looks, while a strip is a double line ('' otherwise: every strip is solid). */
export const lanesLooksNote = (lanes: readonly FlagLane[]): string =>
	lanes.some((l) => l.doubled) ? 'solid: outside the flow the record can be trusted at; double line: a doubtful reading, or not the river’s own flow' : '';

/** What Fit automatically does with a class's days under the quality-flag settings, in the engine's words (FLAG_USE_TEXT); '' without them. */
export function flagUseText(flag: FlowDayFlag, use: Omit<QualityFlagSettings, 'ratings'> | null | undefined): string {
	if (!use) return '';
	// A period-high day (engine ≥ 1.90.0, issue #557) is always left out.
	if (flag === 'periodHigh') return 'left out of Fit automatically and the run’s statistics';
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
		const doubled = LANE_DOUBLED.has(flag);
		out.push({ flag, label, color: LANE_COLOR[flag], doubled, ranges, days, text: `${label}${doubled ? ', double line' : ''}: ${fmtNum(days)} day${days === 1 ? '' : 's'}${how ? `; ${how}` : ''}` });
	}
	return out;
}
