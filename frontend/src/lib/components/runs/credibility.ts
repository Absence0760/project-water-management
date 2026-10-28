// How far to trust a run, read at the top of its summary: the run's warnings
// split into what to check before relying on it and notes on how its data
// were handled, and one line of model checks (self-checks, calibration,
// plausibility, WR2012) each linking to its panel: the self-checks further
// down, the rest on the Calibration page, where Model quality moved (issue
// #586 Round 3). An assessor and a hydrologist both asked for this before the
// river results. The fit has no verdict of its own (issue #177): its item says
// the scores and is only toned when the NSE is no better than the mean flow, as
// the NSE card is (#586 D12).
import type { RunSummary } from '@water-management/engine';
import { isWarningCode, WARNING_CODES, type CodedWarning } from '@water-management/engine/warnings';
import { fmtNum } from '#lib/format/number.js';
import { checksHeadline } from './checks';
import { findings } from './plausibility';
import { FLAG_LABEL } from './wr2012';
import { volumeBiasText, worseThanMean, WORSE_THAN_MEAN } from '#lib/components/calibration/metrics.js';
import { calibrationHref } from '#lib/components/calibration/links.js';

/**
 * Warnings that report how the engine handled the input data, as it was set
 * up to: informative, but not a reason to doubt the run. Anything not listed
 * here is something to check (a new engine warning included: unknown texts
 * stay prominent). The fallback for a warning without a code (a run before
 * engine 1.102.0, or a warning not coded yet): a coded one is grouped by its
 * code's group in the engine's catalogue (warningCodes.ts).
 */
const DATA_NOTES: RegExp[] = [
	/^CHIRPS rain bias-corrected on /,
	/^Catchment rain treated as missing on /,
	/^Catchment rain accumulations spread over /,
	/: \d+ runs? of zero rain/,
	/flat stretch(es)? of \d+ or more days/
];

/**
 * A warning as a list item: its first letter a capital. Some engine warnings start lower case
 * ("bed losses are on: …") because the engine also joins them into sentences; changing the
 * engine's own text would need an ENGINE_VERSION bump (#586 D19, Round 3).
 */
export const warningItem = (w: string) => w.charAt(0).toUpperCase() + w.slice(1);

/** True when a warning reports how the data were handled: by its code when it has one the catalogue knows, else by its text. */
function isDataNote(w: string, codeOf: ReadonlyMap<string, string>): boolean {
	const code = codeOf.get(w);
	if (code !== undefined && isWarningCode(code)) return WARNING_CODES[code].group === 'note';
	return DATA_NOTES.some((re) => re.test(w));
}

/**
 * The run's warnings split into what to check and notes on how the data were handled, each as an item. `codes` is
 * summary.warningCodes (engine ≥ 1.102.0): a warning with a code is grouped by it; one without (an older run, a
 * warning not coded yet, a code from a newer engine this page doesn't know) by its text.
 */
export function warningGroups(warnings: readonly string[] | undefined, codes?: readonly Pick<CodedWarning, 'code' | 'text'>[] | null): { check: string[]; data: string[] } {
	const check: string[] = [];
	const data: string[] = [];
	const codeOf = new Map<string, string>((codes ?? []).map((c) => [c.text, c.code]));
	for (const w of warnings ?? []) (isDataNote(w, codeOf) ? data : check).push(warningItem(w));
	return { check, data };
}

export type Tone = 'ok' | 'warn' | 'bad' | 'none';

export interface CredibilityItem {
	label: string;
	text: string;
	tone: Tone;
	/** The panel's anchor. */
	href: string;
}

type CredibilityInput = Pick<RunSummary, 'verification' | 'plausibility' | 'wr2012'> & {
	calibration?: Pick<NonNullable<RunSummary['calibration']>, 'days' | 'nse' | 'pbias'> | null;
};

/**
 * `onCalibration`: a link to a Model quality panel on the Calibration page by its anchor, for the run shown (the
 * workspace passes calibration/links.ts calibrationHref with the run); without the run by default.
 */
export function credibility(summary: CredibilityInput, onCalibration: (anchor: string) => string = (a) => calibrationHref(null, a)): CredibilityItem[] {
	const out: CredibilityItem[] = [];
	const v = summary.verification;
	const head = checksHeadline(v);
	out.push({
		label: 'Arithmetic checks',
		text: !v ? 'not run (older engine)' : head.tone === 'ok' ? `all ${fmtNum(v.checks.length)} passed` : `${fmtNum(v.checks.filter((c) => !c.passed).length)} of ${fmtNum(v.checks.length)} failed`,
		tone: head.tone === 'ok' ? 'ok' : head.tone === 'bad' ? 'bad' : 'none',
		href: '#res-checks'
	});
	const cal = summary.calibration;
	if (cal && cal.days > 0) {
		const poor = worseThanMean('nse', cal.nse);
		// PBIAS is the volume error's negative, as the Summary's volume bias card reads it.
		const bias = volumeBiasText(cal.pbias == null ? null : -cal.pbias);
		out.push({
			label: 'Calibration',
			text: `NSE ${fmtNum(cal.nse, 2)}${poor ? `, ${WORSE_THAN_MEAN}` : ''}${bias === '–' ? '' : `, volume bias ${bias}`}`,
			tone: poor ? 'warn' : 'none',
			href: onCalibration('res-calibration')
		});
	} else {
		out.push({ label: 'Calibration', text: 'not scored: no observed flow in the run', tone: 'none', href: onCalibration('res-calibration') });
	}
	if (summary.plausibility) {
		const f = findings(summary.plausibility);
		const found = f.filter((x) => x.ok === false).length;
		const judged = f.filter((x) => x.ok !== null).length;
		out.push({
			label: 'Plausibility',
			text: found ? `${fmtNum(found)} of ${fmtNum(judged)} checks found something` : judged ? `no findings (${fmtNum(judged)} checked)` : 'nothing could be checked',
			tone: found ? 'warn' : judged ? 'ok' : 'none',
			href: onCalibration('res-plausibility')
		});
	}
	if (summary.wr2012) {
		const level = summary.wr2012.flag.level;
		out.push({
			label: 'WR2012',
			text: FLAG_LABEL[level],
			tone: level === 'ok' ? 'ok' : level === 'note' ? 'warn' : 'bad',
			href: onCalibration('res-wr2012')
		});
	}
	return out;
}
