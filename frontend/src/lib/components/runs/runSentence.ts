// The run summary in plain words: one or two sentences above the headline
// cards, built only from the stored RunSummary, so they always agree with the
// cards and the farm table below them. The calibration fit is left to the NSE
// and PBIAS cards (issue #177: a sentence repeating them put the NSE on the
// screen three times); the printable report draws the same cards.
import type { RunSummary } from '@water-management/engine';
import { fmtNum, fmtPct } from '$lib/format/number';
import { headlineSite } from './ewrAssurance';
import { SUPPLY_TARGET } from './results';

export type SentenceInput = Pick<RunSummary, 'catchment' | 'ewrAssurance'> & {
	/** Always present on current runs; tolerated missing on legacy ones, as the table does. */
	farms?: RunSummary['farms'];
};

/**
 * The river first, then the farms. The river measure is the one
 * the cards lead with: months meeting the Reserve rules at the headline site
 * when the project has a rule table, else days below the pragmatic EWR at the
 * outflow gauge.
 */
export function runSentences(summary: SentenceInput): string[] {
	const out = [riverSentence(summary)];
	const farms = farmSentence(summary.farms ?? []);
	if (farms) out.push(farms);
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
		return farms.length === 1 ? `${farms[0].name} got at least ${target} of its demand.` : `Every hydrological unit got at least ${target} of its demand.`;
	}
	// The lowest; on a tie, the first in the run's farm order.
	const lowest = short.reduce((a, b) => (b.fractionSupplied < a.fractionSupplied ? b : a));
	const at = `${lowest.name} at ${fmtPct(lowest.fractionSupplied)}`;
	if (farms.length === 1) return `${lowest.name} got ${fmtPct(lowest.fractionSupplied)} of its demand, less than ${target}.`;
	if (short.length === 1) return `1 of ${fmtNum(farms.length)} hydrological units got less than ${target} of its demand: ${at}.`;
	const count = short.length === farms.length ? `All ${fmtNum(farms.length)}` : `${fmtNum(short.length)} of ${fmtNum(farms.length)}`;
	return `${count} hydrological units got less than ${target} of their demand; the lowest was ${at}.`;
}
