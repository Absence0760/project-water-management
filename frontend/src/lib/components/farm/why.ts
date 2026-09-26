// The "Why about 83 %?" page (docs/design/farmer-view.md §5, §6.4, board 4):
// the three steps, what the WUA decided and what this is not. Pure wording.
//
// Rules this page keeps (§1, §5.2, §5.3):
// - the even share is a fairness check, never water the farm has or could get;
// - the pump figure is per day the river needed it, with the season average after;
// - the dam part is information, not an instruction (no release-works flag yet, E9).
import { DEMAND_PCT_FLOOR_M3_DAY, type FarmProjection, type FarmView } from '@water-management/engine';
import { LEVEL_WORD, pumpLessAsked, seasonSpan, splitNotice } from './cards';
import { fmtDay, fmtM3Day, fmtNumber, fmtPct, joinAnd, litresPerSecond, NBSP, plural, roundAbout } from './format';
import type { Rich } from './rich';

/** "Why about 83 %?", or a plainer title when there's no headline. */
export function whyTitle(farm: FarmProjection): string {
	return farm.river.headline == null ? 'What the model found' : `Why about ${fmtPct(farm.river.headline)}?`;
}

/** "Looking back over 1 Oct 2023 to 10 Jan 2024, the model checks two things: …" */
export function whyIntro(farm: FarmProjection): string {
	return `Looking back over ${fmtDay(farm.season.from)} to ${fmtDay(farm.season.to)}, the model checks two things: was water shared fairly between farms, and did the river keep enough water flowing?`;
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

export const K_HIDDEN = 'Not shown: with so few farms in the catchment, it could reveal a neighbour’s figures.';

/** "a little less than an even share (about 118 m³ a day)". Never "gain", never "you may take". */
export function shareComparison(n: number): string {
	if (Math.abs(n) < DEMAND_PCT_FLOOR_M3_DAY) return 'about an even share';
	return `a little ${n > 0 ? 'less' : 'more'} than an even share (about ${fmtM3Day(Math.abs(n))})`;
}

export function step1(farm: FarmProjection): Step1 {
	const r = farm.river;
	const you = farm.season.fraction;
	if (r.equitableFraction == null || r.aboveBelowShareM3Day == null || you == null) return { shown: false, text: K_HIDDEN };
	const share = fmtPct(r.equitableFraction);
	const mine = fmtPct(you);
	const notPart = r.headline == null ? 'It isn’t part of the model’s look back.' : `It isn’t part of the ${fmtPct(r.headline)}.`;
	const pos = (f: number) => Math.round(Math.min(Math.max(f, 0), 1) * 100);
	return {
		shown: true,
		catchment: ['Across the catchment, farms received ', { b: share }, ' of what they needed. We call that the ', { b: 'even share' }, '.'],
		sharePct: pos(r.equitableFraction),
		youPct: pos(you),
		shareLabel: `even share ${share}`,
		youLabel: `you ${mine}`,
		you: ['You received ', { b: mine }, `: ${shareComparison(r.aboveBelowShareM3Day)}.`],
		check: [
			{ b: 'This is a fairness check, not extra water for you.' },
			` Whether more water can reach your farm depends on where you are on the river and what is in your dam. ${notPart}`
		]
	};
}

// ---- Step 2: did the river keep flowing? -------------------------------------

export const RESERVE_INTRO: Rich = [
	'The law keeps some water in the river so it stays healthy for everyone downstream. This is the river’s ',
	{ b: 'reserve' },
	'.'
];

export const SHARE_RULE =
	'Farms upstream are asked to make that up in proportion to the water each one used up or stored. Water that flows back to the river doesn’t count against you.';

export const CUT_BEYOND_SHARE =
	'The river’s share of your water is more than an even share of the catchment’s supply. The WUA may need to look at this.';

export interface Step2 {
	intro: Rich;
	/** "The river was below its reserve at Sandspruit Outlet on 52 days and at Middel Gauge on 44 days." */
	sites: Rich;
	/** Whether upstream water was part of the reason; null when the reserve was always kept. */
	reason: string | null;
	/** SHARE_RULE when any day had a charged part. */
	rule: string | null;
	/** "You were asked to help on 56 of the 102 days. On those days:" */
	asked: string;
	/** The pump-less line (per charged day, then the season average); null when not asked to pump less. */
	pump: Rich | null;
	/** The dam line; null under the 1 m³/day floor. */
	dam: Rich | null;
	/** CUT_BEYOND_SHARE when it applies. */
	beyondShare: string | null;
}

export function step2(farm: FarmProjection): Step2 {
	const r = farm.river;
	const met = r.sites.filter((s) => s.daysNotMet > 0);
	let sites: Rich;
	let reason: string | null = null;
	if (!met.length) {
		sites = ['The river kept its reserve every day this season, at every point below your farm.'];
	} else {
		const parts: Rich = ['The river was below its reserve '];
		met.forEach((s, i) => {
			if (i > 0) parts.push(i === met.length - 1 ? ' and ' : ', ');
			parts.push(`at ${s.name} on `, { b: plural(s.daysNotMet, 'day') });
		});
		parts.push('.');
		sites = parts;
		const natural = met.filter((s) => s.daysOnlyNatural > 0);
		if (!natural.length) {
			reason = met.length === 1 && met[0]!.daysNotMet === 1
				? 'On that day, water taken upstream was part of the reason, not only low rain.'
				: 'On every one of those days, water taken upstream was part of the reason, not only low rain.';
		} else if (natural.every((s) => s.daysOnlyNatural >= s.daysNotMet) && natural.length === met.length) {
			reason = 'It was only because of low rain: water taken upstream wasn’t part of the reason.';
		} else {
			const list = joinAnd(natural.map((s) => `${plural(s.daysOnlyNatural, 'day')} at ${s.name}`));
			reason = `Water taken upstream was part of the reason on the other days; on ${list} it was only because of low rain.`;
		}
	}
	const charged = r.chargedDays > 0;
	const perDayPump = r.perChargedDaySupplyCutM3;
	let pump: Rich | null = null;
	if (charged && pumpLessAsked(farm) && perDayPump != null) {
		const ls = litresPerSecond(perDayPump);
		pump = [
			{ b: `Pump about ${fmtNumber(roundAbout(perDayPump))}${NBSP}m³ a day less` },
			`${ls ? ` (${ls})` : ''}. Averaged over all ${plural(r.windowDays, 'day')} that is ${fmtM3Day(r.supplyCutM3Day)}.`
		];
	}
	let dam: Rich | null = null;
	if (charged && r.storageM3Day >= DEMAND_PCT_FLOOR_M3_DAY && r.perChargedDayStorageM3 != null) {
		dam = [
			`Your dam ${pump ? 'also ' : ''}held back about `,
			{ b: `${fmtNumber(roundAbout(r.perChargedDayStorageM3))}${NBSP}m³ a day` },
			' the river needed. If your dam has an outlet or a bypass, letting that through helps. If it doesn’t, the WUA may talk to you about it.'
		];
	}
	return {
		intro: RESERVE_INTRO,
		sites,
		reason,
		rule: charged ? SHARE_RULE : null,
		asked: charged
			? `You were asked to help on ${r.chargedDays} of the ${plural(r.windowDays, 'day')}.${pump || dam ? ' On those days:' : ''}`
			: 'You weren’t asked to help on any day this season.',
		pump,
		dam,
		beyondShare: r.cutBeyondShare ? CUT_BEYOND_SHARE : null
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

export const DAM_NOT_IN_SUM =
	'Holding back less in the dam doesn’t come off today’s pumping, so it isn’t in this sum. But it leaves less in your dam for later in the season.';

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
		heading: `3. Where ${pct} comes from`,
		caption: `Daily averages over ${seasonSpan(farm)}`,
		rows: [
			{ label: 'You received', value: fmtM3Day(got) },
			{ label: 'Pump less for the river', value: `−${NBSP}${fmtM3Day(cut)}` },
			{ label: 'Leaves', value: fmtM3Day(leaves) },
			{ label: 'You needed', value: fmtM3Day(need) }
		],
		sum: [`${fmtNumber(leaves)} is about `, { b: pct }, ` of the ${fmtNumber(need)} you needed.`],
		damNote: r.storageM3Day >= DEMAND_PCT_FLOOR_M3_DAY ? DAM_NOT_IN_SUM : null
	};
}

// ---- What the WUA decided; what this is not ----------------------------------

export function wuaDecided(view: FarmView): Rich {
	const r = view.publication.restriction;
	const head = 'Only a notice from your WUA is a restriction. Right now: ';
	if (r.level === 'none') return [head, { b: 'no restriction' }, '.'];
	const { title } = splitNotice(r.notice);
	return [head, { b: LEVEL_WORD[r.level] }, `.${title ? ` ${title.replace(/[.!]?$/, '.')}` : ''}`];
}

export function whatThisIsNot(farm: FarmProjection): string[] {
	return [
		'Not your allocation or licence. It doesn’t know your registered water use.',
		`Not a forecast. It looks back over ${seasonSpan(farm)}.`,
		'Not measured. It comes from a model of the catchment, which can be wrong.'
	];
}
