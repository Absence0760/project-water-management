// The run summary in plain words: one or two sentences above the headline
// cards, built only from the stored RunSummary, so they always agree with the
// cards and the farm table below them.
import type { RunSummary } from '@water-management/engine';
import { fmtNum, fmtPct } from '$lib/format/number';
import { headlineSite } from './ewrAssurance';
import { describePbias } from './rating';
import { calibrationSample } from '$lib/components/calibration/sample';
import { SUPPLY_TARGET } from './results';

export type SentenceInput = Pick<RunSummary, 'catchment' | 'calibration' | 'ewrAssurance'> & {
	/** Always present on current runs; tolerated missing on legacy ones, as the table does. */
	farms?: RunSummary['farms'];
};

/**
 * The river first, then the farms, then (only when the run was scored
 * against observed flow) the calibration fit. The river measure is the one
 * the cards lead with: months meeting the Reserve rules at the headline site
 * when the project has a rule table, else days below the pragmatic EWR at the
 * outflow gauge.
 */
export function runSentences(summary: SentenceInput): string[] {
	const out = [riverSentence(summary)];
	const farms = farmSentence(summary.farms ?? []);
	if (farms) out.push(farms);
	const cal = calibrationSentence(summary.calibration);
	if (cal) out.push(cal);
	return out;
}

export const runSentence = (summary: SentenceInput) => runSentences(summary).join(' ');

function riverSentence(summary: SentenceInput): string {
	const site = headlineSite(summary);
	if (site) {
		const where = site.isOutlet ? 'the outlet' : site.name;
		const o = site.overall;
		if (o.rate === null) return `The Reserve rules at ${where} could not be assessed: the run has no complete calendar month.`;
		if (o.met === o.months) return `The Reserve rules were met in every month at ${where}.`;
		return `The Reserve rules were met in ${fmtPct(o.rate)} of months at ${where} (${fmtNum(o.met)} of ${fmtNum(o.months)}).`;
	}
	const f = summary.catchment.ewrFractionDaysNotMet;
	if (!(f > 0)) return 'Flow at the outflow gauge met the EWR on every day of the run.';
	return `Flow at the outflow gauge was below the EWR on ${fmtPct(f)} of days (${fmtNum(summary.catchment.ewrDaysNotMet)} days).`;
}

function farmSentence(farms: NonNullable<SentenceInput['farms']>): string | null {
	if (!farms.length) return null;
	const target = fmtPct(SUPPLY_TARGET, 0);
	const short = farms.filter((f) => f.fractionSupplied < SUPPLY_TARGET);
	if (!short.length) {
		return farms.length === 1 ? `${farms[0].name} got at least ${target} of its demand.` : `Every unit got at least ${target} of its demand.`;
	}
	// The lowest; on a tie, the first in the run's farm order.
	const lowest = short.reduce((a, b) => (b.fractionSupplied < a.fractionSupplied ? b : a));
	const at = `${lowest.name} at ${fmtPct(lowest.fractionSupplied)}`;
	if (farms.length === 1) return `${lowest.name} got ${fmtPct(lowest.fractionSupplied)} of its demand, less than ${target}.`;
	if (short.length === 1) return `1 of ${fmtNum(farms.length)} units got less than ${target} of its demand: ${at}.`;
	const count = short.length === farms.length ? `All ${fmtNum(farms.length)}` : `${fmtNum(short.length)} of ${fmtNum(farms.length)}`;
	return `${count} units got less than ${target} of their demand; the lowest was ${at}.`;
}

function calibrationSentence(cal: SentenceInput['calibration']): string | null {
	if (!cal || !(cal.days > 0) || (cal.nse == null && cal.pbias == null)) return null;
	const parts: string[] = [];
	if (cal.nse != null) parts.push(`NSE ${fmtNum(cal.nse, 2)}`);
	if (cal.pbias != null) {
		const reading = describePbias(cal.pbias);
		parts.push(`PBIAS ${cal.pbias > 0 ? '+' : ''}${fmtNum(cal.pbias, 1)}%${reading ? ` (${reading})` : ''}`);
	}
	// Not "calibration period (…)": that label belongs to the two calibration cards.
	// "In-sample" only when the parameters were fitted on these days (issue #45).
	const { status, qualifier } = calibrationSample(cal);
	const over = `over ${fmtNum(cal.days)} observed days`;
	const lead = status === 'fitted' ? `Calibration fit, in-sample ${over}` : qualifier ? `Calibration fit ${over} (${qualifier})` : `Calibration fit ${over}`;
	return `${lead}: ${parts.join(', ')}.`;
}
