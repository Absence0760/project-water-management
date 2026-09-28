// "This season" on the farm page (issue #53 R5, farmer-view ask E3; docs/ui.md
// § Farmer view): the irrigation level the WUA set for the season, and what
// that level gave this farm in past years' weather (the seasonal outlook's
// analogue years, its own figures only), with the review date. Shown only
// while the WUA has an outlook published and its season hasn't ended. Worded
// as what happened in past years, never as what will happen, and the level
// as the WUA's decision. Words from the message catalogue ($lib/i18n, WP-2.5).
import type { FarmView } from '@water-management/engine';
import { t } from '$lib/i18n/locale.svelte';
import { fmtDayMonth, fmtPct } from './format';

export interface OutlookVm {
	/** "This season". */
	title: string;
	/** "Your WUA set irrigation at 85 % for 1 Oct to 30 Apr." */
	level: string;
	/** What the level gave the farm: the middle and the range, or why there is none. */
	got: string;
	/** The dam at the season's end, or null without a dam (or too few years). */
	dam: string | null;
	/** "Your WUA reviews the level on 1 Jan.", or null. */
	review: string | null;
	fine: string;
}

// i18n-section: farm.outlook
export const outlookFine = () =>
	t('Worked out by the model from past years’ weather: not a forecast, and not a promise. Only a notice from your WUA or from DWS is a restriction.');

/** The card's view model, or null when the WUA has published no outlook or its season has ended (the card is left out). */
export function outlookCard(view: Pick<FarmView, 'outlook'>, today: string): OutlookVm | null {
	const o = view.outlook;
	if (!o || o.seasonEnd < today) return null;
	const range = (s: { p10: number; p50: number; p90: number }) => ({ mid: fmtPct(s.p50), low: fmtPct(s.p10), high: fmtPct(s.p90) });
	const got = o.demandMet
		? t('In {n} past years’ weather, at this level you got about {mid} of the water you needed, and between {low} and {high} in most of them.', { n: o.nYears, ...range(o.demandMet) })
		: o.demandYears === 0
			? t('The model has no irrigation demand for you this season.')
			: t('There are too few past years to give a range for you.');
	return {
		title: t('This season'),
		level: t('Your WUA set irrigation at {level} for {from} to {to}.', { level: o.level.label, from: fmtDayMonth(o.decisionDate), to: fmtDayMonth(o.seasonEnd) }),
		got,
		dam: o.dam?.seasonEndShare ? t('Your dam ended the season about {mid} full, and between {low} and {high} in most of those years.', range(o.dam.seasonEndShare)) : null,
		review: o.reviewDate ? t('Your WUA reviews the level on {date}.', { date: fmtDayMonth(o.reviewDate) }) : null,
		fine: outlookFine()
	};
}
