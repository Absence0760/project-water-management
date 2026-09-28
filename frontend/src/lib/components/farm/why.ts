// The "Why about 83 %?" page (docs/design/farmer-view.md §5, §6.4, board 4):
// the three steps, what the WUA decided and what this is not. Pure wording,
// from the message catalogue ($lib/i18n, WP-2.5).
//
// Rules this page keeps (§1, §5.2, §5.3):
// - the even share is a fairness check, never water the farm has or could get;
// - the pump figure is per day the river needed it, with the season average after;
// - the dam part is information, not an instruction (no release-works flag yet, E9).
import { DEMAND_PCT_FLOOR_M3_DAY, type FarmProjection, type FarmView } from '@water-management/engine';
import { i18n, t, tRich } from '$lib/i18n/locale.svelte';
import type { Rich } from '$lib/i18n/rich';
import { levelWord, pumpLessAsked, seasonSpan, splitNotice } from './cards';
import { pickNotice } from './notice';
import { count, DAYS, fmtDay, fmtM3Day, fmtNumber, fmtPct, joinAnd, litresPerSecond, NBSP, roundAbout } from './format';

/** "Why about 83 %?", or a plainer title when there's no headline. */
export function whyTitle(farm: FarmProjection): string {
	// i18n-section: farm.why
	return farm.river.headline == null ? t('What the model found') : t('Why about {pct}?', { pct: fmtPct(farm.river.headline) });
}

/** "Looking back over 1 Oct 2023 to 10 Jan 2024, the model checks two things: …" */
export function whyIntro(farm: FarmProjection): string {
	return t('Looking back over {from} to {to}, the model checks two things: was water shared fairly between farms, and did the river keep enough water flowing?', { from: fmtDay(farm.season.from), to: fmtDay(farm.season.to) });
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

export const kHidden = () => t('Not shown: with so few farms in the catchment, it could reveal a neighbour’s figures.');

/** "a little less than an even share (about 118 m³ a day)". Never "gain", never "you may take". */
export function shareComparison(n: number): string {
	if (Math.abs(n) < DEMAND_PCT_FLOOR_M3_DAY) return t('about an even share');
	return t(n > 0 ? 'a little less than an even share (about {amount})' : 'a little more than an even share (about {amount})', { amount: fmtM3Day(Math.abs(n)) });
}

export function step1(farm: FarmProjection): Step1 {
	const r = farm.river;
	const you = farm.season.fraction;
	if (r.equitableFraction == null || r.aboveBelowShareM3Day == null || you == null) return { shown: false, text: kHidden() };
	const share = fmtPct(r.equitableFraction);
	const mine = fmtPct(you);
	const notPart = r.headline == null ? t('It isn’t part of the model’s look back.') : t('It isn’t part of the {pct}.', { pct: fmtPct(r.headline) });
	const pos = (f: number) => Math.round(Math.min(Math.max(f, 0), 1) * 100);
	return {
		shown: true,
		catchment: tRich('Across the catchment, farms received **{share}** of what they needed. We call that the **even share**.', { share }),
		sharePct: pos(r.equitableFraction),
		youPct: pos(you),
		shareLabel: t('even share {pct}', { pct: share }),
		youLabel: t('you {pct}', { pct: mine }),
		you: tRich('You received **{pct}**: {comparison}.', { pct: mine, comparison: shareComparison(r.aboveBelowShareM3Day) }),
		check: tRich('**This is a fairness check, not extra water for you.** Whether more water can reach your farm depends on where you are on the river and what is in your dam. {notPart}', { notPart })
	};
}

// ---- Step 2: did the river keep flowing? -------------------------------------

export const reserveIntro = (): Rich => tRich('The law keeps some water in the river so it stays healthy for everyone downstream. This is the river’s **reserve**.');
export const shareRule = () => t('Farms upstream are asked to make that up in proportion to the water each one used up or stored. Water that flows back to the river doesn’t count against you.');
export const cutBeyondShare = () => t('The river’s share of your water is more than an even share of the catchment’s supply. The WUA may need to look at this.');

export interface Step2 {
	intro: Rich;
	/** "The river was below its reserve at Sandspruit Outlet on 52 days and at Melkhout Gauge on 44 days." */
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
		sites = [t('The river kept its reserve every day this season, at every point below your farm.')];
	} else {
		const list: Rich = [];
		met.forEach((s, i) => {
			if (i > 0) list.push(i === met.length - 1 ? ` ${t('and')} ` : ', ');
			list.push(...tRich('at {name} on **{days}**', { name: s.name, days: count(DAYS, s.daysNotMet) }));
		});
		sites = tRich('The river was below its reserve {sites}.', { sites: list });
		const natural = met.filter((s) => s.daysOnlyNatural > 0);
		if (!natural.length) {
			reason = t(met.length === 1 && met[0]!.daysNotMet === 1 ? 'On that day, water taken upstream was part of the reason, not only low rain.' : 'On every one of those days, water taken upstream was part of the reason, not only low rain.');
		} else if (natural.every((s) => s.daysOnlyNatural >= s.daysNotMet) && natural.length === met.length) {
			reason = t('It was only because of low rain: water taken upstream wasn’t part of the reason.');
		} else {
			const rain = joinAnd(natural.map((s) => t('{days} at {name}', { days: count(DAYS, s.daysOnlyNatural), name: s.name })));
			reason = t('Water taken upstream was part of the reason on the other days; on {list} it was only because of low rain.', { list: rain });
		}
	}
	const charged = r.chargedDays > 0;
	const perDayPump = r.perChargedDaySupplyCutM3;
	let pump: Rich | null = null;
	if (charged && pumpLessAsked(farm) && perDayPump != null) {
		const ls = litresPerSecond(perDayPump);
		pump = tRich('**Pump about {amount} a day less**{ls}. Averaged over all {days} that is {average}.', {
			amount: `${fmtNumber(roundAbout(perDayPump))}${NBSP}m³`,
			ls: ls ? ` (${ls})` : '',
			days: count(DAYS, r.windowDays),
			average: fmtM3Day(r.supplyCutM3Day)
		});
	}
	let dam: Rich | null = null;
	if (charged && r.storageM3Day >= DEMAND_PCT_FLOOR_M3_DAY && r.perChargedDayStorageM3 != null) {
		dam = tRich(pump ? 'Your dam also held back about **{amount} a day** the river needed. If your dam has an outlet or a bypass, letting that through helps. If it doesn’t, the WUA may talk to you about it.' : 'Your dam held back about **{amount} a day** the river needed. If your dam has an outlet or a bypass, letting that through helps. If it doesn’t, the WUA may talk to you about it.', { amount: `${fmtNumber(roundAbout(r.perChargedDayStorageM3))}${NBSP}m³` });
	}
	return {
		intro: reserveIntro(),
		sites,
		reason,
		rule: charged ? shareRule() : null,
		asked: charged
			? t(pump || dam ? 'You were asked to help on {n} of the {days}. On those days:' : 'You were asked to help on {n} of the {days}.', { n: r.chargedDays, days: count(DAYS, r.windowDays) })
			: t('You weren’t asked to help on any day this season.'),
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

export const damNotInSum = () => t('Holding back less in the dam doesn’t come off today’s pumping, so it isn’t in this sum. But it leaves less in your dam for later in the season.');

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
		heading: t('3. Where {pct} comes from', { pct }),
		caption: t('Daily averages over {span}', { span: seasonSpan(farm) }),
		rows: [
			{ label: t('You received'), value: fmtM3Day(got) },
			{ label: t('Pump less for the river'), value: `−${NBSP}${fmtM3Day(cut)}` },
			{ label: t('Leaves'), value: fmtM3Day(leaves) },
			{ label: t('You needed'), value: fmtM3Day(need) }
		],
		sum: tRich('{leaves} is about **{pct}** of the {need} you needed.', { leaves: fmtNumber(leaves), pct, need: fmtNumber(need) }),
		damNote: r.storageM3Day >= DEMAND_PCT_FLOOR_M3_DAY ? damNotInSum() : null
	};
}

// ---- What the WUA decided; what this is not ----------------------------------

export function wuaDecided(view: FarmView): Rich {
	const r = view.publication.restriction;
	if (r.level === 'none') return tRich('Only a notice from your WUA or from DWS is a restriction. Right now: **no restriction**.');
	// The same words as the notice card: in the language the reader chose, else English, else another.
	const { title } = splitNotice(pickNotice(r.notice, i18n.locale)?.text ?? null);
	const out = tRich('Only a notice from your WUA or from DWS is a restriction. Right now: **{level}**.', { level: levelWord(r.level) });
	// The WUA's own title, after the level, in the WUA's words.
	return title ? [...out, ` ${title.replace(/[.!]?$/, '.')}`] : out;
}

export function whatThisIsNot(farm: FarmProjection): string[] {
	return [t('Not your allocation or licence. It doesn’t know your registered water use.'), t('Not a forecast. It looks back over {span}.', { span: seasonSpan(farm) }), t('Not measured. It comes from a model of the catchment, which can be wrong.')];
}
