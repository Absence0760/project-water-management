// How far to trust a run, read at the top of its summary: the run's warnings
// split into what to check before relying on it and notes on how its data
// were handled, and one line of model checks (self-checks, plausibility,
// WR2012, the fit) each linking to its panel further down. An assessor and a
// hydrologist both asked for this before the river results.
import type { RunSummary } from '@water-management/engine';
import { fmtNum } from '$lib/format/number';
import { checksHeadline } from './checks';
import { findings } from './plausibility';
import { FLAG_LABEL } from './wr2012';
import { calibrationSample } from '$lib/components/calibration/sample';

/**
 * Warnings that report how the engine handled the input data, as it was set
 * up to: informative, but not a reason to doubt the run. Anything not listed
 * here is something to check (a new engine warning included: unknown texts
 * stay prominent).
 */
const DATA_NOTES: RegExp[] = [
	/^CHIRPS rain bias-corrected on /,
	/^Catchment rain treated as missing on /,
	/^Catchment rain accumulations spread over /,
	/: \d+ runs? of zero rain/,
	/flat stretch(es)? of \d+ or more days/
];

export function warningGroups(warnings: readonly string[] | undefined): { check: string[]; data: string[] } {
	const check: string[] = [];
	const data: string[] = [];
	for (const w of warnings ?? []) (DATA_NOTES.some((re) => re.test(w)) ? data : check).push(w);
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

type CredibilityInput = Pick<RunSummary, 'verification' | 'plausibility' | 'wr2012' | 'calibration'>;

export function credibility(summary: CredibilityInput): CredibilityItem[] {
	const out: CredibilityItem[] = [];
	const v = summary.verification;
	const head = checksHeadline(v);
	out.push({
		label: 'Self-checks',
		text: !v ? 'not run (older engine)' : head.tone === 'ok' ? `all ${fmtNum(v.checks.length)} passed` : `${fmtNum(v.checks.filter((c) => !c.passed).length)} of ${fmtNum(v.checks.length)} failed`,
		tone: head.tone === 'ok' ? 'ok' : head.tone === 'bad' ? 'bad' : 'none',
		href: '#res-checks'
	});
	if (summary.plausibility) {
		const f = findings(summary.plausibility);
		const found = f.filter((x) => x.ok === false).length;
		const judged = f.filter((x) => x.ok !== null).length;
		out.push({
			label: 'Plausibility',
			text: found ? `${fmtNum(found)} of ${fmtNum(judged)} checks found something` : judged ? `no findings (${fmtNum(judged)} checked)` : 'nothing could be checked',
			tone: found ? 'warn' : judged ? 'ok' : 'none',
			href: '#res-plausibility'
		});
	}
	if (summary.wr2012) {
		const level = summary.wr2012.flag.level;
		out.push({
			label: 'WR2012',
			text: FLAG_LABEL[level],
			tone: level === 'ok' ? 'ok' : level === 'note' ? 'warn' : 'bad',
			href: '#res-wr2012'
		});
	}
	const cal = summary.calibration;
	// "in-sample" only when the parameters were fitted on these days (issue #45).
	const qualifier = calibrationSample(cal).qualifier;
	out.push(
		cal && cal.days > 0 && cal.nse != null
			? {
					label: 'Fit',
					text: `NSE ${fmtNum(cal.nse, 2)} over ${fmtNum(cal.days)} observed days${qualifier ? ` (${qualifier})` : ''}`,
					tone: 'none',
					href: '#res-calibration'
				}
			: { label: 'Fit', text: 'not scored: no observed flow in the calibration window', tone: 'none', href: '#res-calibration' }
	);
	return out;
}
