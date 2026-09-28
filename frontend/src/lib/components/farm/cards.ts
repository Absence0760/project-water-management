// Every word on the farmer view's main page (docs/design/farmer-view.md §3,
// §5, §6.1), as pure functions of a FarmView. The components only lay these
// out. The design's boards (docs/design/farmer-view-prototype/Main.dc.html)
// are the reference; cards.test.ts pins the strings to them.
//
// Never says (§5.1): gain, entitlement, allocation, target, EWR, shortfall,
// charge, attribution, binding, natural, simulated. The tests scan for them.
//
// The words come from the message catalogue ($lib/i18n, WP-2.5), so every
// function here reads the active language: call them where they render and
// they follow a language switch. Fixed sentences are functions, not
// constants, for the same reason.
import { DEMAND_PCT_FLOOR_M3_DAY, type FarmProjection, type FarmView, type ModelBand, type RestrictionLevel } from '@water-management/engine';
import { STALE_DAYS } from '$lib/components/series/freshness';
import { i18n, msg, t, tRich, type Msg } from '$lib/i18n/locale.svelte';
import type { Rich } from '$lib/i18n/rich';
import { languageName, LEVEL_WORDS, pickNotice, splitNotice, WRITTEN_ONLY_IN, type NoticeVm } from './notice';
import { count, DAYS, daysBetween, FARMS, fmtDay, fmtDayMonth, fmtMonthShort, fmtPct, fmtStampDay, fmtStampTime, fmtVolume, joinAnd, POINTS, type VolumeUnit, WEEKS } from './format';

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
	const v = { published: fmtStampDay(view.publication.publishedAt), until: fmtDay(until), age: count(DAYS, age) };
	// i18n-section: farm.dates
	let text = t(stale ? 'Published by the WUA on {published}. Data up to {until}, {age} ago. Ask your WUA if newer figures are coming.' : 'Published by the WUA on {published}. Data up to {until}.', v);
	if (view.publication.nextExpectedOn) text += ` ${t('Next update expected around {date}.', { date: fmtDay(view.publication.nextExpectedOn) })}`;
	return { text, stale };
}

// ---- The WUA's answer (§3 Q2, §6.1 item 3) -----------------------------------

/** The restriction level in words: "No restriction", "Advisory", "Restriction". */
export const levelWord = (level: RestrictionLevel) => t(LEVEL_WORDS[level]);

export { splitNotice, type NoticeVm } from './notice';

/**
 * null for level `none` (the page shows "No restriction from the WUA"). The
 * WUA's words in the language the reader chose, else in English, else in
 * another it wrote, with a line saying so (design §7): the chosen language, not the page's words,
 * since the WUA's Afrikaans is real even while our own isn't translated yet.
 */
export function noticeCard(view: FarmView): NoticeVm | null {
	const r = view.publication.restriction;
	if (r.level === 'none') return null;
	const picked = pickNotice(r.notice, i18n.locale);
	const { title, body } = splitNotice(picked?.text ?? null);
	// i18n-section: farm.notice
	const label = t('Notice from the WUA · {level}', { level: levelWord(r.level) });
	return {
		level: r.level,
		label: title ? label : null,
		heading: title ?? label,
		body,
		// pct is the published percentage, 0–100 (022_publication.sql), not a fraction.
		pctLine: !title && !body && r.pct != null ? t('Set by the WUA: {pct} of registered use.', { pct: fmtPct(r.pct / 100) }) : null,
		byline: `${view.publication.publishedBy}, ${fmtStampDay(view.publication.publishedAt)}`,
		title,
		lang: picked?.lang ?? null,
		langNote: picked && picked.lang !== i18n.locale ? t(WRITTEN_ONLY_IN, { language: languageName(picked.lang) }) : null
	};
}

export const noRestriction = () => t('No restriction from the WUA');

// ---- Water you received this season (§3 Q1) ---------------------------------

const SYSTEMS: [number, Msg][] = [
	// i18n-section: farm.system
	[0.9, msg('drip')],
	[0.85, msg('micro or centre pivot')],
	[0.75, msg('sprinklers')],
	[0.65, msg('flood')]
];

/** The irrigation system nearest an efficiency (§3 Q1: drip 0.90, micro/pivot 0.85, sprinkler 0.75, flood 0.65). */
export function systemName(efficiency: number): string {
	let best = SYSTEMS[0]!;
	for (const s of SYSTEMS) if (Math.abs(s[0] - efficiency) < Math.abs(best[0] - efficiency)) best = s;
	return t(best[1]);
}

// i18n-section: farm.supply
export const littleNeed = () => t('Your hydrological unit needed very little water this season.');

/** "Short on 16 days in Nov and Dec, all when your dam was down to its stop level." */
export function shortLine(farm: FarmProjection): string {
	const s = farm.season;
	// i18n-section: farm.short
	if (s.shortDays <= 0) return t('You weren\'t short of water on any day this season.');
	const months = joinAnd(s.shortMonths.map(fmtMonthShort));
	const days = count(DAYS, s.shortDays);
	const head = months ? t('Short on {days} in {months}', { days, months }) : t('Short on {days}', { days });
	const one = s.shortDays === 1;
	if (farm.damCapacityM3 <= 0) return t(one ? '{head}, when the river was too low to take from.' : '{head}, all when the river was too low to take from.', { head });
	const stop = farm.damMinPct > 0;
	if (s.shortDaysAtStopLevel >= s.shortDays) {
		return t(
			stop
				? one
					? '{head}, when your dam was down to its stop level.'
					: '{head}, all when your dam was down to its stop level.'
				: one
					? '{head}, when your dam was empty.'
					: '{head}, all when your dam was empty.',
			{ head }
		);
	}
	if (s.shortDaysAtStopLevel > 0) return t(stop ? '{head}, {n} of them when your dam was down to its stop level.' : '{head}, {n} of them when your dam was empty.', { head, n: s.shortDaysAtStopLevel });
	return t('{head}.', { head });
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
		// i18n-section: farm.supply
		volumes: t('{got} of {need} since {from}', { got: fmtVolume(s.suppliedM3, unit), need: fmtVolume(s.demandM3, unit), from: fmtDayMonth(s.from) }),
		short: shortLine(farm),
		last30:
			l.fraction == null
				? [t('Last 30 days: very little water needed')]
				: tRich('Last 30 days: **{pct}** · {got} of {need}', { pct: fmtPct(l.fraction), got: fmtVolume(l.suppliedM3, unit), need: fmtVolume(l.demandM3, unit) }),
		efficiency: t('Worked out by the model, not read from your meter. It assumes {pct} of the water you pump reaches the crop ({system}). Wrong? Tell your WUA.', { pct: fmtPct(eff), system: systemName(eff) })
	};
}

// ---- Your dam (§3 Q3) --------------------------------------------------------

/** How long the usable water lasts: whole days under 14, then weeks. */
export function lastsFor(days: number): string {
	// i18n-section: farm.dam
	if (days < 1) return t('less than a day');
	if (days < 14) return t('about {span}', { span: count(DAYS, Math.max(1, Math.round(days))) });
	return t('about {span}', { span: count(WEEKS, Math.round(days / 7)) });
}

export const noStopLevel = () => t('The model assumes your pump can empty the dam. Tell your WUA the level your pump stops at.');
export const atStopLevel = () => t('Your dam is down to the level where irrigation stops. There is no water above it to use until water flows in.');
export const damModelled = () => t('Worked out by the model, not measured at your dam.');

export interface DamVm {
	/** "24 %". */
	pct: string;
	barPct: number;
	/** Where the stop mark sits (0–100), or null without a stop level. */
	stopPct: number | null;
	/** "irrigation stops at 15 %". */
	stopLabel: string | null;
	/** "83.6 ML of 350 ML". */
	volumes: string;
	trend: { dir: 'up' | 'down' | 'flat'; text: string };
	/** The days-left line; null when there's nothing to say (no use in the last 14 days, or no stop level: see `noStop`). */
	daysLeft: Rich | null;
	/** noStopLevel() when damMinPct is 0. */
	noStop: string | null;
}

/** The 30-day change in whole percentage points. */
export function damTrend(pct: number, pct30dAgo: number): DamVm['trend'] {
	const points = Math.round((pct - pct30dAgo) * 100);
	const was = fmtPct(pct30dAgo);
	if (points === 0) return { dir: 'flat', text: t('About the same as 30 days ago ({was})', { was }) };
	const n = count(POINTS, Math.abs(points));
	return points > 0
		? { dir: 'up', text: t('Up {points} in 30 days (was {was})', { points: n, was }) }
		: { dir: 'down', text: t('Down {points} in 30 days (was {was})', { points: n, was }) };
}

/**
 * The days-left sentence. `long` is the dam page's wording ("that lasts …
 * A rough guide: rain and river flow into the dam make it last longer.").
 */
export function daysLeftLine(farm: FarmProjection, unit: VolumeUnit, long = false): Rich | null {
	const d = farm.dam;
	if (!d || d.usableM3 == null || farm.damMinPct <= 0) return null;
	if (d.usableM3 <= 0) return [atStopLevel()];
	if (d.usableDays == null || !(d.use14M3Day > 0)) return null;
	return tRich(long ? 'At your use over the last 14 days (about {use} a day), that lasts **{lasts}** if nothing flows in. A rough guide: rain and river flow into the dam make it last longer.' : 'At your use over the last 14 days (about {use} a day), the water above the stop level lasts **{lasts}** if nothing flows in. A rough guide.', { use: fmtVolume(d.use14M3Day, unit), lasts: lastsFor(d.usableDays) });
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
		stopLabel: hasStop ? t('irrigation stops at {pct}', { pct: fmtPct(farm.damMinPct) }) : null,
		volumes: t('{storage} of {capacity}', { storage: fmtVolume(d.storageM3, unit), capacity: fmtVolume(farm.damCapacityM3, unit) }),
		trend: damTrend(d.pct, d.pct30dAgo),
		daysLeft: daysLeftLine(farm, unit),
		noStop: hasStop ? null : noStopLevel()
	};
}

// ---- Looking back: the model card (§3 Q2, §6.2) ------------------------------

// i18n-section: farm.band
/** "Model: OK", "Model: watch", "Model: short". */
const BANDS: Record<ModelBand, Msg> = { ok: msg('Model: OK'), watch: msg('Model: watch'), short: msg('Model: short') };
export const bandChip = (band: ModelBand) => t(BANDS[band]);

// i18n-section: farm.back
export const notOfficial = () => t('The model’s estimate, not an official restriction.');

export interface LookingBackVm {
	heading: string;
	/** "Model: watch", or null with no headline. */
	chip: string | null;
	text: Rich;
	/** The link to "Why?". */
	link: string;
}

/** "1 Oct to 10 Jan". */
export const seasonSpan = (farm: FarmProjection) => t('{from} to {to}', { from: fmtDayMonth(farm.season.from), to: fmtDayMonth(farm.season.to) });

/** True when the river asked this farm to pump less (a supply cut above the 1 m³/day floor on at least one day). */
export const pumpLessAsked = (farm: FarmProjection) =>
	farm.river.chargedDays > 0 && farm.river.supplyCutM3Day >= DEMAND_PCT_FLOOR_M3_DAY;

export function lookingBack(farm: FarmProjection): LookingBackVm {
	const r = farm.river;
	const heading = t('Looking back: {span}', { span: seasonSpan(farm) });
	if (r.headline == null) return { heading, chip: null, text: [littleNeed()], link: t('Why? What can I do?') };
	const pct = fmtPct(r.headline);
	const text = tRich(pumpLessAsked(farm) ? 'If you had pumped less on the days the river needed it, you would have had about **{pct}** of the water you needed.' : 'The river didn\'t need you to pump less this season. You had about **{pct}** of the water you needed.', { pct });
	return { heading, chip: r.band ? bandChip(r.band) : null, text, link: t('Why {pct}? What can I do?', { pct }) };
}

/** The one link line that replaces the model card under a `restricted` notice. */
export const lookingBackShort = () => t('The model’s look back and what you can do');

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
	// i18n-section: farm.compare
	if (!last) return { available: false, text: t('Not available: the model’s data doesn’t reach back to the same dates last season.') };
	const pct = (f: number | null) => (f == null ? t('very little needed') : fmtPct(f));
	const rows = [{ label: t('Water received'), now: pct(farm.season.fraction), then: pct(last.fraction) }];
	if (farm.dam && farm.damCapacityM3 > 0) {
		rows.push({
			label: t('Dam on {date}', { date: fmtDayMonth(farm.season.to) }),
			now: fmtPct(farm.dam.pct),
			// i18n-section: farm
			then: last.damPct == null ? t('not available') : fmtPct(last.damPct)
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

// i18n-section: farm.river
/** The one privacy sentence, the same everywhere (§3 Q4, §11 F5). */
export const privacy = () => t('Your hydrological unit’s figures are seen by you, anyone else linked to this hydrological unit, and the WUA’s staff and modeller. Other farmers can’t see them, and you can’t see theirs.');

/** "1 farm is upstream of you and 2 are downstream, of 8 farms in the catchment. The same rules apply to every farm." */
export function positionLine(view: FarmView): string {
	const { farmsUpstream: up, farmsDownstream: down, farmCount: n } = view.context;
	const upText = up === 0 ? t('No hydrological unit is') : up === 1 ? t('1 hydrological unit is') : t('{n} hydrological units are', { n: up });
	const downText = down === 0 ? t('none is') : down === 1 ? t('1 is') : t('{n} are', { n: down });
	return t('{up} upstream of you and {down} downstream, of {count} in the catchment. The same rules apply to every hydrological unit.', { up: upText, down: downText, count: count(FARMS, n) });
}

/** "River at Sandspruit Outlet: below its reserve on all of the last 30 days." A count, never a flow volume. */
export function outletLine(view: FarmView): Rich {
	const o = view.outlet30;
	const v = { name: o.name, days: count(DAYS, o.days), n: o.daysNotMet };
	if (o.daysNotMet <= 0) return tRich('River at {name}: kept its reserve on every one of the last {days}.', v);
	return tRich(o.daysNotMet >= o.days ? 'River at {name}: below its reserve on **all of the last {days}**.' : 'River at {name}: below its reserve on **{n} of the last {days}**.', v);
}

/** "Who can see my farm" (§10.2): the people, by name, from GET …/farm/:nodeId/access; the roles alone if that fails. */
export const whoCanSee = () => ({
	// i18n-section: farm.who
	heading: t('Who can see my hydrological unit'),
	people: [t('You'), t('Anyone else linked to this hydrological unit'), t('The WUA’s staff'), t('The WUA’s modeller')],
	not: t('Other farmers can’t see your hydrological unit’s figures, and you can’t see theirs.'),
	loading: t('Loading the names…'),
	failed: t('Couldn’t load the names just now. Your WUA can tell you who these people are.')
});

const ACCESS_ROLES = {
	farmer: msg('linked to this hydrological unit'),
	viewer: msg('WUA, can read'),
	editor: msg('WUA, can change the model'),
	owner: msg('WUA, manages who has access'),
	unknown: msg('WUA')
};

/** One line of "Who can see my farm": "Jane Smith (you) · linked to this farm". */
export function accessLine(p: { displayName: string; role: string; you: boolean }): string {
	const role = Object.hasOwn(ACCESS_ROLES, p.role) && p.role !== 'unknown' ? ACCESS_ROLES[p.role as keyof typeof ACCESS_ROLES] : ACCESS_ROLES.unknown;
	return `${p.displayName}${p.you ? ` ${t('(you)')}` : ''} · ${t(role)}`;
}

// i18n-section: farm
export const disclaimer = () => t('These figures are worked out by a computer model of the catchment. They are estimates, not measurements or instructions, and they can be wrong. Only a notice from your WUA or from the Department of Water and Sanitation (DWS) is a restriction.');

// ---- Several farms (/farm, board 9) ------------------------------------------

/** "86 % of water needed · dam 24 %", or "· no dam". */
export function farmSummaryLine(farm: FarmProjection): string {
	// i18n-section: farm.list
	const got = farm.season.fraction == null ? t('very little water needed') : t('{pct} of water needed', { pct: fmtPct(farm.season.fraction) });
	const dam = farm.dam && farm.damCapacityM3 > 0 ? t('dam {pct}', { pct: fmtPct(farm.dam.pct) }) : t('no dam');
	return `${got} · ${dam}`;
}

export const farmsPrivacy = () => t('Each hydrological unit’s figures are seen by the people linked to it and the WUA’s staff and modeller. Other farmers can’t see them.');

// ---- States (§6.5, boards 5 to 8) ---------------------------------------------

const STATE_KEYS = {
	// i18n-section: farm.state
	loading: msg('Loading your hydrological unit…'),
	slow: msg('Slow signal? This can take a moment.'),
	errorTitle: msg('We couldn’t load your hydrological unit'),
	errorText: msg('Check your signal and try again. Your figures are safe; nothing was changed.'),
	noPublication: msg('Your WUA hasn’t published figures yet'),
	noPublicationText: msg('When they do, you’ll see the water you received, how your dam is doing, and any restrictions, here.'),
	contact: msg('Questions? Contact your WUA.'),
	removed: msg('You no longer have access to this hydrological unit. Contact your WUA.'),
	needsConnection: msg('Charts, “Why?” and downloads need a connection.'),
	updating: msg('Updating…')
};

/** One of the farm pages' state lines, in the active language. */
export const stateText = (which: keyof typeof STATE_KEYS) => t(STATE_KEYS[which]);

/** The contact line after a second failure in a row. */
export function stillFailing(offline: boolean): string {
	return t(offline ? 'Still no connection. If this keeps happening, contact your WUA.' : 'Still not working. If this keeps happening, contact your WUA.');
}

/** The status strip over a saved copy: no signal, or the update failed. */
export function savedStrip(savedAt: number, why: 'offline' | 'failed'): string {
	// i18n-section: farm.saved
	return t(why === 'offline' ? 'No signal. These are the figures saved on this phone at {time}. We’ll update them when you’re back online.' : 'We couldn’t update your figures. These are the figures saved on this phone at {time}.', { time: fmtStampTime(savedAt) });
}

// i18n-section: farm
/** "You're previewing Vaalbank as its farmer sees it" (viewer+ only). */
export const previewBanner = (farmName: string) => t('You’re previewing {farm} as its farmer sees it', { farm: farmName });
