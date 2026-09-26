// Every word on the farmer view's main page (docs/design/farmer-view.md §3,
// §5, §6.1), as pure functions of a FarmView. The components only lay these
// out. The design's boards (docs/design/farmer-view-prototype/Main.dc.html)
// are the reference; cards.test.ts pins the strings to them.
//
// Never says (§5.1): gain, entitlement, allocation, target, EWR, shortfall,
// charge, attribution, binding, natural, simulated. The tests scan for them.
import { DEMAND_PCT_FLOOR_M3_DAY, type FarmProjection, type FarmView, type ModelBand, type RestrictionLevel } from '@water-management/engine';
import { STALE_DAYS } from '$lib/components/series/freshness';
import {
	daysBetween,
	fmtDay,
	fmtDayMonth,
	fmtMonthShort,
	fmtPct,
	fmtStampDay,
	fmtStampTime,
	fmtVolume,
	joinAnd,
	plural,
	type VolumeUnit
} from './format';
import type { Rich } from './rich';

// ---- The dates line (§2, §6.1 item 2) ---------------------------------------

export interface DatesLine {
	text: string;
	/** Amber, with a clock icon. */
	stale: boolean;
}

/**
 * "Published by the WUA on 12 Jan 2024. Data up to 10 Jan 2024." Stale when
 * the server said so or the data is now older than STALE_DAYS (a saved copy
 * ages on the phone): then it adds how old, and to ask the WUA.
 */
export function datesLine(view: FarmView, today: string): DatesLine {
	const until = view.farm.dataUntil;
	const age = daysBetween(until, today);
	const stale = view.stale || age > STALE_DAYS;
	let text = `Published by the WUA on ${fmtStampDay(view.publication.publishedAt)}. Data up to ${fmtDay(until)}`;
	text += stale ? `, ${plural(age, 'day')} ago. Ask your WUA if newer figures are coming.` : '.';
	if (view.publication.nextExpectedOn) text += ` Next update expected around ${fmtDay(view.publication.nextExpectedOn)}.`;
	return { text, stale };
}

// ---- The WUA's answer (§3 Q2, §6.1 item 3) -----------------------------------

export const LEVEL_WORD: Record<RestrictionLevel, string> = {
	none: 'No restriction',
	advisory: 'Advisory',
	restricted: 'Restriction'
};

export interface NoticeVm {
	level: RestrictionLevel;
	/** "Notice from the WUA · Advisory", above the heading; null when it is the heading. */
	label: string | null;
	heading: string;
	body: string | null;
	/** The published percentage, only when the WUA gave no text to carry it. */
	pctLine: string | null;
	/** "Example WUA, 12 Jan 2024". */
	byline: string;
	/** The notice's first line (its title), for the "Why?" page and the offline view. */
	title: string | null;
}

/**
 * The WUA writes the notice; the app never writes restriction wording of its
 * own. A notice's first line is its title when more follows (or when it's
 * short enough to be one), the rest its text.
 */
export function splitNotice(notice: string | null): { title: string | null; body: string | null } {
	const lines = (notice ?? '')
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter(Boolean);
	if (!lines.length) return { title: null, body: null };
	if (lines.length === 1) return lines[0]!.length <= 80 ? { title: lines[0]!, body: null } : { title: null, body: lines[0]! };
	return { title: lines[0]!, body: lines.slice(1).join('\n') };
}

/** null for level `none` (the page shows "No restriction from the WUA"). */
export function noticeCard(view: FarmView): NoticeVm | null {
	const r = view.publication.restriction;
	if (r.level === 'none') return null;
	const { title, body } = splitNotice(r.notice);
	const label = `Notice from the WUA · ${LEVEL_WORD[r.level]}`;
	return {
		level: r.level,
		label: title ? label : null,
		heading: title ?? label,
		body,
		// pct is the published percentage, 0–100 (022_publication.sql), not a fraction.
		pctLine: !title && !body && r.pct != null ? `Set by the WUA: ${fmtPct(r.pct / 100)} of registered use.` : null,
		byline: `${view.publication.publishedBy}, ${fmtStampDay(view.publication.publishedAt)}`,
		title
	};
}

export const NO_RESTRICTION = 'No restriction from the WUA';

// ---- Water you received this season (§3 Q1) ---------------------------------

const SYSTEMS: [number, string][] = [
	[0.9, 'drip'],
	[0.85, 'micro or centre pivot'],
	[0.75, 'sprinklers'],
	[0.65, 'flood']
];

/** The irrigation system nearest an efficiency (§3 Q1: drip 0.90, micro/pivot 0.85, sprinkler 0.75, flood 0.65). */
export function systemName(efficiency: number): string {
	let best = SYSTEMS[0]!;
	for (const s of SYSTEMS) if (Math.abs(s[0] - efficiency) < Math.abs(best[0] - efficiency)) best = s;
	return best[1];
}

export const LITTLE_NEED = 'Your farm needed very little water this season.';

/** "Short on 16 days in Nov and Dec, all when your dam was down to its stop level." */
export function shortLine(farm: FarmProjection): string {
	const s = farm.season;
	if (s.shortDays <= 0) return "You weren't short of water on any day this season.";
	const months = joinAnd(s.shortMonths.map(fmtMonthShort));
	const head = `Short on ${plural(s.shortDays, 'day')}${months ? ` in ${months}` : ''}`;
	const one = s.shortDays === 1;
	if (farm.damCapacityM3 <= 0) return `${head}, ${one ? '' : 'all '}when the river was too low to take from.`;
	const where = farm.damMinPct > 0 ? 'your dam was down to its stop level' : 'your dam was empty';
	if (s.shortDaysAtStopLevel >= s.shortDays) return `${head}, ${one ? '' : 'all '}when ${where}.`;
	if (s.shortDaysAtStopLevel > 0) return `${head}, ${s.shortDaysAtStopLevel} of them when ${where}.`;
	return `${head}.`;
}

export interface SupplyVm {
	/** "86 %", or null under the demand floor. */
	pct: string | null;
	/** 0–100, for the decorative bar. */
	barPct: number;
	/** "324.2 ML of 376.5 ML since 1 Oct". */
	volumes: string;
	short: string;
	last30: Rich;
	efficiency: string;
}

export function supplyCard(farm: FarmProjection, unit: VolumeUnit): SupplyVm {
	const s = farm.season;
	const l = farm.last30;
	const eff = farm.irrigationEfficiency;
	return {
		pct: s.fraction == null ? null : fmtPct(s.fraction),
		barPct: s.fraction == null ? 0 : Math.round(Math.min(Math.max(s.fraction, 0), 1) * 100),
		volumes: `${fmtVolume(s.suppliedM3, unit)} of ${fmtVolume(s.demandM3, unit)} since ${fmtDayMonth(s.from)}`,
		short: shortLine(farm),
		last30:
			l.fraction == null
				? ['Last 30 days: very little water needed']
				: ['Last 30 days: ', { b: fmtPct(l.fraction) }, ` · ${fmtVolume(l.suppliedM3, unit)} of ${fmtVolume(l.demandM3, unit)}`],
		efficiency: `Worked out by the model, not read from your meter. It assumes ${fmtPct(eff)} of the water you pump reaches the crop (${systemName(eff)}). Wrong? Tell your WUA.`
	};
}

// ---- Your dam (§3 Q3) --------------------------------------------------------

/** How long the usable water lasts: whole days under 14, then weeks. */
export function lastsFor(days: number): string {
	if (days < 1) return 'less than a day';
	if (days < 14) return `about ${plural(Math.max(1, Math.round(days)), 'day')}`;
	return `about ${plural(Math.round(days / 7), 'week')}`;
}

export const NO_STOP_LEVEL = 'The model assumes your pump can empty the dam. Tell your WUA the level your pump stops at.';
export const AT_STOP_LEVEL = 'Your dam is down to the level where irrigation stops. There is no water above it to use until water flows in.';
export const DAM_MODELLED = 'Worked out by the model, not measured at your dam.';

export interface DamVm {
	/** "24 %". */
	pct: string;
	barPct: number;
	/** Where the stop mark sits (0–100), or null without a stop level. */
	stopPct: number | null;
	/** "irrigation stops at 15 %". */
	stopLabel: string | null;
	/** "84.9 ML of 350 ML". */
	volumes: string;
	trend: { dir: 'up' | 'down' | 'flat'; text: string };
	/** The days-left line; null when there's nothing to say (no use in the last 14 days, or no stop level: see `noStop`). */
	daysLeft: Rich | null;
	/** NO_STOP_LEVEL when damMinPct is 0. */
	noStop: string | null;
}

/** The 30-day change in whole percentage points. */
export function damTrend(pct: number, pct30dAgo: number): DamVm['trend'] {
	const points = Math.round((pct - pct30dAgo) * 100);
	const was = fmtPct(pct30dAgo);
	if (points === 0) return { dir: 'flat', text: `About the same as 30 days ago (${was})` };
	const n = plural(Math.abs(points), 'point');
	return points > 0
		? { dir: 'up', text: `Up ${n} in 30 days (was ${was})` }
		: { dir: 'down', text: `Down ${n} in 30 days (was ${was})` };
}

/**
 * The days-left sentence. `long` is the dam page's wording ("that lasts …
 * A rough guide: rain and river flow into the dam make it last longer.").
 */
export function daysLeftLine(farm: FarmProjection, unit: VolumeUnit, long = false): Rich | null {
	const d = farm.dam;
	if (!d || d.usableM3 == null || farm.damMinPct <= 0) return null;
	if (d.usableM3 <= 0) return [AT_STOP_LEVEL];
	if (d.usableDays == null || !(d.use14M3Day > 0)) return null;
	const use = `At your use over the last 14 days (about ${fmtVolume(d.use14M3Day, unit)} a day), `;
	return long
		? [use + 'that lasts ', { b: lastsFor(d.usableDays) }, ' if nothing flows in. A rough guide: rain and river flow into the dam make it last longer.']
		: [use + 'the water above the stop level lasts ', { b: lastsFor(d.usableDays) }, ' if nothing flows in. A rough guide.'];
}

/** null for a farm with no dam: no dam card and no dam page. */
export function damCard(farm: FarmProjection, unit: VolumeUnit): DamVm | null {
	const d = farm.dam;
	if (!d || farm.damCapacityM3 <= 0) return null;
	const hasStop = farm.damMinPct > 0;
	return {
		pct: fmtPct(d.pct),
		barPct: Math.round(Math.min(Math.max(d.pct, 0), 1) * 100),
		stopPct: hasStop ? Math.round(farm.damMinPct * 100) : null,
		stopLabel: hasStop ? `irrigation stops at ${fmtPct(farm.damMinPct)}` : null,
		volumes: `${fmtVolume(d.storageM3, unit)} of ${fmtVolume(farm.damCapacityM3, unit)}`,
		trend: damTrend(d.pct, d.pct30dAgo),
		daysLeft: daysLeftLine(farm, unit),
		noStop: hasStop ? null : NO_STOP_LEVEL
	};
}

// ---- Looking back: the model card (§3 Q2, §6.2) ------------------------------

export const BAND_CHIP: Record<ModelBand, string> = {
	ok: 'Model: OK',
	watch: 'Model: watch',
	short: 'Model: short'
};

export const NOT_OFFICIAL = 'The model’s estimate, not an official restriction.';

export interface LookingBackVm {
	heading: string;
	/** "Model: watch", or null with no headline. */
	chip: string | null;
	text: Rich;
	/** The link to "Why?". */
	link: string;
}

/** "1 Oct to 10 Jan". */
export const seasonSpan = (farm: FarmProjection) => `${fmtDayMonth(farm.season.from)} to ${fmtDayMonth(farm.season.to)}`;

/** True when the river asked this farm to pump less (a supply cut above the 1 m³/day floor on at least one day). */
export const pumpLessAsked = (farm: FarmProjection) =>
	farm.river.chargedDays > 0 && farm.river.supplyCutM3Day >= DEMAND_PCT_FLOOR_M3_DAY;

export function lookingBack(farm: FarmProjection): LookingBackVm {
	const r = farm.river;
	const heading = `Looking back: ${seasonSpan(farm)}`;
	if (r.headline == null) return { heading, chip: null, text: [LITTLE_NEED], link: 'Why? What can I do?' };
	const pct = fmtPct(r.headline);
	const text: Rich = pumpLessAsked(farm)
		? ['If you had pumped less on the days the river needed it, you would have had about ', { b: pct }, ' of the water you needed.']
		: ["The river didn't need you to pump less this season. You had about ", { b: pct }, ' of the water you needed.'];
	return { heading, chip: r.band ? BAND_CHIP[r.band] : null, text, link: `Why ${pct}? What can I do?` };
}

/** The one link line that replaces the model card under a `restricted` notice. */
export const LOOKING_BACK_SHORT = 'The model’s look back and what you can do';

// ---- Compared with last season (§3 Q1, E4) -----------------------------------

/** "2023–24" for a season starting in October 2023. */
export function seasonLabel(from: string): string {
	const y = Number(from.slice(0, 4));
	return `${y}–${String((y + 1) % 100).padStart(2, '0')}`;
}

export type CompareVm =
	| {
			available: true;
			/** "1 Oct – 10 Jan". */
			span: string;
			now: string;
			then: string;
			rows: { label: string; now: string; then: string }[];
	  }
	| { available: false; text: string };

export function compareCard(farm: FarmProjection): CompareVm {
	const last = farm.lastSeason;
	if (!last) return { available: false, text: 'Not available: the model’s data doesn’t reach back to the same dates last season.' };
	const pct = (f: number | null) => (f == null ? 'very little needed' : fmtPct(f));
	const rows = [{ label: 'Water received', now: pct(farm.season.fraction), then: pct(last.fraction) }];
	if (farm.dam && farm.damCapacityM3 > 0) {
		rows.push({
			label: `Dam on ${fmtDayMonth(farm.season.to)}`,
			now: fmtPct(farm.dam.pct),
			then: last.damPct == null ? 'not available' : fmtPct(last.damPct)
		});
	}
	return {
		available: true,
		span: `${fmtDayMonth(farm.season.from)} – ${fmtDayMonth(farm.season.to)}`,
		now: seasonLabel(farm.season.from),
		then: seasonLabel(last.from),
		rows
	};
}

// ---- Your farm on the river (§3 Q4) ------------------------------------------

/** The one privacy sentence, the same everywhere (§3 Q4, §11 F5). */
export const PRIVACY =
	'Your farm’s figures are seen by you, anyone else linked to this farm, and the WUA’s staff and modeller. Other farmers can’t see them, and you can’t see theirs.';

/** "1 farm is upstream of you and 2 are downstream, of 8 farms in the catchment. The same rules apply to every farm." */
export function positionLine(view: FarmView): string {
	const { farmsUpstream: up, farmsDownstream: down, farmCount: n } = view.context;
	const upText = up === 0 ? 'No farm is' : up === 1 ? '1 farm is' : `${up} farms are`;
	const downText = down === 0 ? 'none is' : down === 1 ? '1 is' : `${down} are`;
	return `${upText} upstream of you and ${downText} downstream, of ${plural(n, 'farm')} in the catchment. The same rules apply to every farm.`;
}

/** "River at Sandspruit Outlet: below its reserve on all of the last 30 days." A count, never a flow volume. */
export function outletLine(view: FarmView): Rich {
	const o = view.outlet30;
	const head = `River at ${o.name}: `;
	const last = `the last ${plural(o.days, 'day')}`;
	if (o.daysNotMet <= 0) return [head, 'kept its reserve on every one of ', last, '.'];
	if (o.daysNotMet >= o.days) return [head, 'below its reserve on ', { b: `all of ${last}` }, '.'];
	return [head, 'below its reserve on ', { b: `${o.daysNotMet} of ${last}` }, '.'];
}

/** "Who can see my farm" (§10.2): the people, by name, from GET …/farm/:nodeId/access; the roles alone if that fails. */
export const WHO_CAN_SEE = {
	heading: 'Who can see my farm',
	people: ['You', 'Anyone else linked to this farm', 'The WUA’s staff', 'The WUA’s modeller'],
	not: 'Other farmers can’t see your farm’s figures, and you can’t see theirs.',
	loading: 'Loading the names…',
	failed: 'Couldn’t load the names just now. Your WUA can tell you who these people are.'
};

const ACCESS_ROLE: Record<string, string> = {
	farmer: 'linked to this farm',
	viewer: 'WUA, can read',
	editor: 'WUA, can change the model',
	owner: 'WUA, manages who has access'
};

/** One line of "Who can see my farm": "Jane Smith (you) · linked to this farm". */
export function accessLine(p: { displayName: string; role: string; you: boolean }): string {
	return `${p.displayName}${p.you ? ' (you)' : ''} · ${ACCESS_ROLE[p.role] ?? 'WUA'}`;
}

export const DISCLAIMER =
	'These figures come from a computer model of the catchment. They can be wrong. Only a notice from your WUA is a restriction.';

// ---- Several farms (/farm, board 9) ------------------------------------------

/** "86 % of water needed · dam 24 %", or "· no dam". */
export function farmSummaryLine(farm: FarmProjection): string {
	const got = farm.season.fraction == null ? 'very little water needed' : `${fmtPct(farm.season.fraction)} of water needed`;
	const dam = farm.dam && farm.damCapacityM3 > 0 ? `dam ${fmtPct(farm.dam.pct)}` : 'no dam';
	return `${got} · ${dam}`;
}

export const FARMS_PRIVACY =
	'Each farm’s figures are seen by the people linked to it and the WUA’s staff and modeller. Other farmers can’t see them.';

// ---- States (§6.5, boards 5 to 8) ---------------------------------------------

export const STATES = {
	loading: 'Loading your farm…',
	slow: 'Slow signal? This can take a moment.',
	errorTitle: 'We couldn’t load your farm',
	errorText: 'Check your signal and try again. Your figures are safe; nothing was changed.',
	noPublication: 'Your WUA hasn’t published figures yet',
	noPublicationText: 'When they do, you’ll see the water you received, how your dam is doing, and any restrictions, here.',
	contact: 'Questions? Contact your WUA.',
	removed: 'You no longer have access to this farm. Contact your WUA.',
	needsConnection: 'Charts, “Why?” and downloads need a connection.',
	updating: 'Updating…'
};

/** The contact line after a second failure in a row. */
export function stillFailing(offline: boolean): string {
	return `${offline ? 'Still no connection.' : 'Still not working.'} If this keeps happening, contact your WUA.`;
}

/** The status strip over a saved copy: no signal, or the update failed. */
export function savedStrip(savedAt: number, why: 'offline' | 'failed'): string {
	const at = `These are the figures saved on this phone at ${fmtStampTime(savedAt)}.`;
	return why === 'offline' ? `No signal. ${at} We’ll update them when you’re back online.` : `We couldn’t update your figures. ${at}`;
}

/** "You're previewing Vaalbank as its farmer sees it" (viewer+ only). */
export const previewBanner = (farmName: string) => `You’re previewing ${farmName} as its farmer sees it`;
