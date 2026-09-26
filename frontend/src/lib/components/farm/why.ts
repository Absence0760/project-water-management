// The "Why about 83 %?" page (docs/design/farmer-view.md §5, §6.4, board 4):
// the three steps, what the WUA decided and what this is not. Pure wording,
// from the message catalogue ($lib/i18n, WP-2.5).
//
// Rules this page keeps (§1, §5.2, §5.3):
// - the even share is a fairness check, never water the farm has or could get;
// - the pump figure is per day the river needed it, with the season average after;
// - the dam part is information, not an instruction (no release-works flag yet, E9).
import { DEMAND_PCT_FLOOR_M3_DAY, type FarmProjection, type FarmView } from '@water-management/engine';
import { t, tRich } from '$lib/i18n/locale.svelte';
import type { Rich } from '$lib/i18n/rich';
import { levelWord, pumpLessAsked, seasonSpan, splitNotice } from './cards';
import { count, fmtDay, fmtM3Day, fmtNumber, fmtPct, joinAnd, litresPerSecond, NBSP, roundAbout } from './format';

/** "Why about 83 %?", or a plainer title when there's no headline. */
export function whyTitle(farm: FarmProjection): string {
	return farm.river.headline == null ? t('farm.why.titlePlain') : t('farm.why.title', { pct: fmtPct(farm.river.headline) });
}

/** "Looking back over 1 Oct 2023 to 10 Jan 2024, the model checks two things: …" */
export function whyIntro(farm: FarmProjection): string {
	return t('farm.why.intro', { from: fmtDay(farm.season.from), to: fmtDay(farm.season.to) });
}

// ---- Step 1: was water shared fairly? ----------------------------------------

export type Step1 =
	| { shown: false; text: string }
	| {
			shown: true;
			catchment: Rich;
			/** 0–100 positions for the decorative bar and its marker. */
			sharePct: number;
			youPct: number;
			shareLabel: string;
			youLabel: string;
			you: Rich;
			/** The fairness-check box (§5.3). */
			check: Rich;
	  };

export const kHidden = () => t('farm.why.kHidden');

/** "a little less than an even share (about 118 m³ a day)". Never "gain", never "you may take". */
export function shareComparison(n: number): string {
	if (Math.abs(n) < DEMAND_PCT_FLOOR_M3_DAY) return t('farm.why.aboutEven');
	return t(n > 0 ? 'farm.why.lessThanEven' : 'farm.why.moreThanEven', { amount: fmtM3Day(Math.abs(n)) });
}

export function step1(farm: FarmProjection): Step1 {
	const r = farm.river;
	const you = farm.season.fraction;
	if (r.equitableFraction == null || r.aboveBelowShareM3Day == null || you == null) return { shown: false, text: kHidden() };
	const share = fmtPct(r.equitableFraction);
	const mine = fmtPct(you);
	const notPart = r.headline == null ? t('farm.why.notPartPlain') : t('farm.why.notPart', { pct: fmtPct(r.headline) });
	const pos = (f: number) => Math.round(Math.min(Math.max(f, 0), 1) * 100);
	return {
		shown: true,
		catchment: tRich('farm.why.catchment', { share }),
		sharePct: pos(r.equitableFraction),
		youPct: pos(you),
		shareLabel: t('farm.why.shareLabel', { pct: share }),
		youLabel: t('farm.why.youLabel', { pct: mine }),
		you: tRich('farm.why.you', { pct: mine, comparison: shareComparison(r.aboveBelowShareM3Day) }),
		check: tRich('farm.why.check', { notPart })
	};
}

// ---- Step 2: did the river keep flowing? -------------------------------------

export const reserveIntro = (): Rich => tRich('farm.why.reserve');
export const shareRule = () => t('farm.why.shareRule');
export const cutBeyondShare = () => t('farm.why.beyondShare');

export interface Step2 {
	intro: Rich;
	/** "The river was below its reserve at Sandspruit Outlet on 52 days and at Middel Gauge on 44 days." */
	sites: Rich;
	/** Whether upstream water was part of the reason; null when the reserve was always kept. */
	reason: string | null;
	/** shareRule() when any day had a charged part. */
	rule: string | null;
	/** "You were asked to help on 56 of the 102 days. On those days:" */
	asked: string;
	/** The pump-less line (per charged day, then the season average); null when not asked to pump less. */
	pump: Rich | null;
	/** The dam line; null under the 1 m³/day floor. */
	dam: Rich | null;
	/** cutBeyondShare() when it applies. */
	beyondShare: string | null;
}

export function step2(farm: FarmProjection): Step2 {
	const r = farm.river;
	const met = r.sites.filter((s) => s.daysNotMet > 0);
	let sites: Rich;
	let reason: string | null = null;
	if (!met.length) {
		sites = [t('farm.why.keptReserve')];
	} else {
		const list: Rich = [];
		met.forEach((s, i) => {
			if (i > 0) list.push(i === met.length - 1 ? ` ${t('common.and')} ` : ', ');
			list.push(...tRich('farm.why.site', { name: s.name, days: count('farm.n.day', s.daysNotMet) }));
		});
		sites = tRich('farm.why.belowReserve', { sites: list });
		const natural = met.filter((s) => s.daysOnlyNatural > 0);
		if (!natural.length) {
			reason = t(met.length === 1 && met[0]!.daysNotMet === 1 ? 'farm.why.reasonOneDay' : 'farm.why.reasonEveryDay');
		} else if (natural.every((s) => s.daysOnlyNatural >= s.daysNotMet) && natural.length === met.length) {
			reason = t('farm.why.reasonOnlyRain');
		} else {
			const rain = joinAnd(natural.map((s) => t('farm.why.rainSite', { days: count('farm.n.day', s.daysOnlyNatural), name: s.name })));
			reason = t('farm.why.reasonMixed', { list: rain });
		}
	}
	const charged = r.chargedDays > 0;
	const perDayPump = r.perChargedDaySupplyCutM3;
	let pump: Rich | null = null;
	if (charged && pumpLessAsked(farm) && perDayPump != null) {
		const ls = litresPerSecond(perDayPump);
		pump = tRich('farm.why.pump', {
			amount: `${fmtNumber(roundAbout(perDayPump))}${NBSP}m³`,
			ls: ls ? ` (${ls})` : '',
			days: count('farm.n.day', r.windowDays),
			average: fmtM3Day(r.supplyCutM3Day)
		});
	}
	let dam: Rich | null = null;
	if (charged && r.storageM3Day >= DEMAND_PCT_FLOOR_M3_DAY && r.perChargedDayStorageM3 != null) {
		dam = tRich(pump ? 'farm.why.damAlso' : 'farm.why.dam', { amount: `${fmtNumber(roundAbout(r.perChargedDayStorageM3))}${NBSP}m³` });
	}
	return {
		intro: reserveIntro(),
		sites,
		reason,
		rule: charged ? shareRule() : null,
		asked: charged
			? t(pump || dam ? 'farm.why.askedOnThose' : 'farm.why.asked', { n: r.chargedDays, days: count('farm.n.day', r.windowDays) })
			: t('farm.why.notAsked'),
		pump,
		dam,
		beyondShare: r.cutBeyondShare ? cutBeyondShare() : null
	};
}

// ---- Step 3: where the headline comes from -----------------------------------

export interface Step3 {
	heading: string;
	caption: string;
	rows: { label: string; value: string }[];
	sum: Rich;
	/** The dam part isn't in the sum (§5.2); null without one. */
	damNote: string | null;
}

export const damNotInSum = () => t('farm.why.damNotInSum');

/** null when there's no headline (demand under the floor). */
export function step3(farm: FarmProjection): Step3 | null {
	const r = farm.river;
	if (r.headline == null) return null;
	const got = Math.round(r.suppliedM3Day);
	const cut = Math.round(r.supplyCutM3Day);
	const need = Math.round(r.demandM3Day);
	const leaves = Math.round(r.suppliedM3Day - r.supplyCutM3Day);
	const pct = fmtPct(r.headline);
	return {
		heading: t('farm.why.step3', { pct }),
		caption: t('farm.why.step3Caption', { span: seasonSpan(farm) }),
		rows: [
			{ label: t('farm.why.received'), value: fmtM3Day(got) },
			{ label: t('farm.why.pumpLess'), value: `−${NBSP}${fmtM3Day(cut)}` },
			{ label: t('farm.why.leaves'), value: fmtM3Day(leaves) },
			{ label: t('farm.why.needed'), value: fmtM3Day(need) }
		],
		sum: tRich('farm.why.sum', { leaves: fmtNumber(leaves), pct, need: fmtNumber(need) }),
		damNote: r.storageM3Day >= DEMAND_PCT_FLOOR_M3_DAY ? damNotInSum() : null
	};
}

// ---- What the WUA decided; what this is not ----------------------------------

export function wuaDecided(view: FarmView): Rich {
	const r = view.publication.restriction;
	if (r.level === 'none') return tRich('farm.why.decidedNone');
	const { title } = splitNotice(r.notice);
	const out = tRich('farm.why.decided', { level: levelWord(r.level) });
	// The WUA's own title, after the level, in the WUA's words.
	return title ? [...out, ` ${title.replace(/[.!]?$/, '.')}`] : out;
}

export function whatThisIsNot(farm: FarmProjection): string[] {
	return [t('farm.why.notAllocation'), t('farm.why.notForecast', { span: seasonSpan(farm) }), t('farm.why.notMeasured')];
}
