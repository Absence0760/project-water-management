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
import { t, tRich, type MessageKey } from '$lib/i18n/locale.svelte';
import type { Rich } from '$lib/i18n/rich';
import {
	count,
	daysBetween,
	fmtDay,
	fmtDayMonth,
	fmtMonthShort,
	fmtPct,
	fmtStampDay,
	fmtStampTime,
	fmtVolume,
	joinAnd,
	type VolumeUnit
} from './format';

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
	const v = { published: fmtStampDay(view.publication.publishedAt), until: fmtDay(until), age: count('farm.n.day', age) };
	let text = t(stale ? 'farm.dates.stale' : 'farm.dates.fresh', v);
	if (view.publication.nextExpectedOn) text += ` ${t('farm.dates.next', { date: fmtDay(view.publication.nextExpectedOn) })}`;
	return { text, stale };
}

// ---- The WUA's answer (§3 Q2, §6.1 item 3) -----------------------------------

/** The restriction level in words: "No restriction", "Advisory", "Restriction". */
export const levelWord = (level: RestrictionLevel) => t(`farm.level.${level}`);

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
	const label = t('farm.notice.label', { level: levelWord(r.level) });
	return {
		level: r.level,
		label: title ? label : null,
		heading: title ?? label,
		body,
		// pct is the published percentage, 0–100 (022_publication.sql), not a fraction.
		pctLine: !title && !body && r.pct != null ? t('farm.notice.pct', { pct: fmtPct(r.pct / 100) }) : null,
		byline: `${view.publication.publishedBy}, ${fmtStampDay(view.publication.publishedAt)}`,
		title
	};
}

export const noRestriction = () => t('farm.notice.none');

// ---- Water you received this season (§3 Q1) ---------------------------------

const SYSTEMS: [number, MessageKey][] = [
	[0.9, 'farm.system.drip'],
	[0.85, 'farm.system.microPivot'],
	[0.75, 'farm.system.sprinklers'],
	[0.65, 'farm.system.flood']
];

/** The irrigation system nearest an efficiency (§3 Q1: drip 0.90, micro/pivot 0.85, sprinkler 0.75, flood 0.65). */
export function systemName(efficiency: number): string {
	let best = SYSTEMS[0]!;
	for (const s of SYSTEMS) if (Math.abs(s[0] - efficiency) < Math.abs(best[0] - efficiency)) best = s;
	return t(best[1]);
}

export const littleNeed = () => t('farm.supply.littleNeed');

/** "Short on 16 days in Nov and Dec, all when your dam was down to its stop level." */
export function shortLine(farm: FarmProjection): string {
	const s = farm.season;
	if (s.shortDays <= 0) return t('farm.short.never');
	const months = joinAnd(s.shortMonths.map(fmtMonthShort));
	const days = count('farm.n.day', s.shortDays);
	const head = months ? t('farm.short.headIn', { days, months }) : t('farm.short.head', { days });
	const one = s.shortDays === 1;
	if (farm.damCapacityM3 <= 0) return t(one ? 'farm.short.riverOne' : 'farm.short.riverAll', { head });
	const stop = farm.damMinPct > 0;
	if (s.shortDaysAtStopLevel >= s.shortDays) {
		const key = stop ? (one ? 'farm.short.stopOne' : 'farm.short.stopAll') : one ? 'farm.short.emptyOne' : 'farm.short.emptyAll';
		return t(key, { head });
	}
	if (s.shortDaysAtStopLevel > 0) return t(stop ? 'farm.short.stopSome' : 'farm.short.emptySome', { head, n: s.shortDaysAtStopLevel });
	return t('farm.short.plain', { head });
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
		volumes: t('farm.supply.volumes', { got: fmtVolume(s.suppliedM3, unit), need: fmtVolume(s.demandM3, unit), from: fmtDayMonth(s.from) }),
		short: shortLine(farm),
		last30:
			l.fraction == null
				? [t('farm.supply.last30Little')]
				: tRich('farm.supply.last30', { pct: fmtPct(l.fraction), got: fmtVolume(l.suppliedM3, unit), need: fmtVolume(l.demandM3, unit) }),
		efficiency: t('farm.supply.efficiency', { pct: fmtPct(eff), system: systemName(eff) })
	};
}

// ---- Your dam (§3 Q3) --------------------------------------------------------

/** How long the usable water lasts: whole days under 14, then weeks. */
export function lastsFor(days: number): string {
	if (days < 1) return t('farm.dam.lessThanDay');
	if (days < 14) return t('farm.dam.about', { span: count('farm.n.day', Math.max(1, Math.round(days))) });
	return t('farm.dam.about', { span: count('farm.n.week', Math.round(days / 7)) });
}

export const noStopLevel = () => t('farm.dam.noStop');
export const atStopLevel = () => t('farm.dam.atStop');
export const damModelled = () => t('farm.dam.modelled');

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
	/** noStopLevel() when damMinPct is 0. */
	noStop: string | null;
}

/** The 30-day change in whole percentage points. */
export function damTrend(pct: number, pct30dAgo: number): DamVm['trend'] {
	const points = Math.round((pct - pct30dAgo) * 100);
	const was = fmtPct(pct30dAgo);
	if (points === 0) return { dir: 'flat', text: t('farm.dam.trendFlat', { was }) };
	const n = count('farm.n.point', Math.abs(points));
	return points > 0
		? { dir: 'up', text: t('farm.dam.trendUp', { points: n, was }) }
		: { dir: 'down', text: t('farm.dam.trendDown', { points: n, was }) };
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
	return tRich(long ? 'farm.dam.daysLeftLong' : 'farm.dam.daysLeft', { use: fmtVolume(d.use14M3Day, unit), lasts: lastsFor(d.usableDays) });
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
		stopLabel: hasStop ? t('farm.dam.stopsAt', { pct: fmtPct(farm.damMinPct) }) : null,
		volumes: t('farm.dam.volumes', { storage: fmtVolume(d.storageM3, unit), capacity: fmtVolume(farm.damCapacityM3, unit) }),
		trend: damTrend(d.pct, d.pct30dAgo),
		daysLeft: daysLeftLine(farm, unit),
		noStop: hasStop ? null : noStopLevel()
	};
}

// ---- Looking back: the model card (§3 Q2, §6.2) ------------------------------

/** "Model: OK", "Model: watch", "Model: short". */
export const bandChip = (band: ModelBand) => t(`farm.band.${band}`);

export const notOfficial = () => t('farm.back.notOfficial');

export interface LookingBackVm {
	heading: string;
	/** "Model: watch", or null with no headline. */
	chip: string | null;
	text: Rich;
	/** The link to "Why?". */
	link: string;
}

/** "1 Oct to 10 Jan". */
export const seasonSpan = (farm: FarmProjection) => t('farm.span', { from: fmtDayMonth(farm.season.from), to: fmtDayMonth(farm.season.to) });

/** True when the river asked this farm to pump less (a supply cut above the 1 m³/day floor on at least one day). */
export const pumpLessAsked = (farm: FarmProjection) =>
	farm.river.chargedDays > 0 && farm.river.supplyCutM3Day >= DEMAND_PCT_FLOOR_M3_DAY;

export function lookingBack(farm: FarmProjection): LookingBackVm {
	const r = farm.river;
	const heading = t('farm.back.heading', { span: seasonSpan(farm) });
	if (r.headline == null) return { heading, chip: null, text: [littleNeed()], link: t('farm.back.why') };
	const pct = fmtPct(r.headline);
	const text = tRich(pumpLessAsked(farm) ? 'farm.back.pumpLess' : 'farm.back.notAsked', { pct });
	return { heading, chip: r.band ? bandChip(r.band) : null, text, link: t('farm.back.whyPct', { pct }) };
}

/** The one link line that replaces the model card under a `restricted` notice. */
export const lookingBackShort = () => t('farm.back.short');

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
	if (!last) return { available: false, text: t('farm.compare.unavailable') };
	const pct = (f: number | null) => (f == null ? t('farm.compare.littleNeeded') : fmtPct(f));
	const rows = [{ label: t('farm.compare.received'), now: pct(farm.season.fraction), then: pct(last.fraction) }];
	if (farm.dam && farm.damCapacityM3 > 0) {
		rows.push({
			label: t('farm.compare.damOn', { date: fmtDayMonth(farm.season.to) }),
			now: fmtPct(farm.dam.pct),
			then: last.damPct == null ? t('farm.notAvailable') : fmtPct(last.damPct)
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
export const privacy = () => t('farm.river.privacy');

/** "1 farm is upstream of you and 2 are downstream, of 8 farms in the catchment. The same rules apply to every farm." */
export function positionLine(view: FarmView): string {
	const { farmsUpstream: up, farmsDownstream: down, farmCount: n } = view.context;
	const upText = up === 0 ? t('farm.river.upNone') : up === 1 ? t('farm.river.upOne') : t('farm.river.upMany', { n: up });
	const downText = down === 0 ? t('farm.river.downNone') : down === 1 ? t('farm.river.downOne') : t('farm.river.downMany', { n: down });
	return t('farm.river.position', { up: upText, down: downText, count: count('farm.n.farm', n) });
}

/** "River at Sandspruit Outlet: below its reserve on all of the last 30 days." A count, never a flow volume. */
export function outletLine(view: FarmView): Rich {
	const o = view.outlet30;
	const v = { name: o.name, days: count('farm.n.day', o.days), n: o.daysNotMet };
	if (o.daysNotMet <= 0) return tRich('farm.river.outletKept', v);
	return tRich(o.daysNotMet >= o.days ? 'farm.river.outletAll' : 'farm.river.outletSome', v);
}

/** "Who can see my farm" (§10.2): the people, by name, from GET …/farm/:nodeId/access; the roles alone if that fails. */
export const whoCanSee = () => ({
	heading: t('farm.who.heading'),
	people: [t('farm.who.you'), t('farm.who.linked'), t('farm.who.staff'), t('farm.who.modeller')],
	not: t('farm.who.not'),
	loading: t('farm.who.loading'),
	failed: t('farm.who.failed')
});

const ACCESS_ROLES = ['farmer', 'viewer', 'editor', 'owner'] as const;

/** One line of "Who can see my farm": "Jane Smith (you) · linked to this farm". */
export function accessLine(p: { displayName: string; role: string; you: boolean }): string {
	const role = (ACCESS_ROLES as readonly string[]).includes(p.role) ? (p.role as (typeof ACCESS_ROLES)[number]) : 'unknown';
	return `${p.displayName}${p.you ? ` ${t('farm.who.youMark')}` : ''} · ${t(`farm.who.role.${role}`)}`;
}

export const disclaimer = () => t('farm.disclaimer');

// ---- Several farms (/farm, board 9) ------------------------------------------

/** "86 % of water needed · dam 24 %", or "· no dam". */
export function farmSummaryLine(farm: FarmProjection): string {
	const got = farm.season.fraction == null ? t('farm.list.littleNeeded') : t('farm.list.got', { pct: fmtPct(farm.season.fraction) });
	const dam = farm.dam && farm.damCapacityM3 > 0 ? t('farm.list.dam', { pct: fmtPct(farm.dam.pct) }) : t('farm.list.noDam');
	return `${got} · ${dam}`;
}

export const farmsPrivacy = () => t('farm.list.privacy');

// ---- States (§6.5, boards 5 to 8) ---------------------------------------------

const STATE_KEYS = {
	loading: 'farm.state.loading',
	slow: 'farm.state.slow',
	errorTitle: 'farm.state.errorTitle',
	errorText: 'farm.state.errorText',
	noPublication: 'farm.state.noPublication',
	noPublicationText: 'farm.state.noPublicationText',
	contact: 'farm.state.contact',
	removed: 'farm.state.removed',
	needsConnection: 'farm.state.needsConnection',
	updating: 'farm.state.updating'
} as const satisfies Record<string, MessageKey>;

/** One of the farm pages' state lines, in the active language. */
export const stateText = (which: keyof typeof STATE_KEYS) => t(STATE_KEYS[which]);

/** The contact line after a second failure in a row. */
export function stillFailing(offline: boolean): string {
	return t(offline ? 'farm.state.stillOffline' : 'farm.state.stillFailing');
}

/** The status strip over a saved copy: no signal, or the update failed. */
export function savedStrip(savedAt: number, why: 'offline' | 'failed'): string {
	return t(why === 'offline' ? 'farm.saved.offline' : 'farm.saved.failed', { time: fmtStampTime(savedAt) });
}

/** "You're previewing Vaalbank as its farmer sees it" (viewer+ only). */
export const previewBanner = (farmName: string) => t('farm.preview', { farm: farmName });
