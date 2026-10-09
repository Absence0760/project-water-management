// The seasonal outlook screen's view model (issue #53 R5, docs/ui.md
// § Seasonal outlook): the request an editor's demand levels (and monthly
// plan) make, where a stored outlook stands, and its result in words. The
// numbers are the engine's (outlook/outlook.ts summariseOutlook, run by the
// backend's outlook job, docs/api.md § Seasonal outlooks) and the planning
// figure its describePlanningFigure; this module only formats them. It
// reports what the analogue years did at each level; it never picks one.
import {
	DEFAULT_OUTLOOK_SEASON,
	DEMAND_SCALE_MAX,
	describePlanningFigure,
	OUTLOOK_MIN_YEARS,
	type OutlookStat,
	type ScenarioOp
} from '@water-management/engine';
import type { Outlook, OutlookExcludedYear, OutlookRequest, OutlookResult, OutlookSeasonSetting } from '$lib/api/types';
import { monthName } from '$lib/format/months';
import { fmtDay, fmtNum } from '$lib/format/number';
import { dailyEwrName, type DailyEwrSource } from '$lib/components/ewr/notMet';

/** The demand levels a new outlook starts with, % of today's demand (planning-outputs.md S3). */
export const DEFAULT_OUTLOOK_LEVELS: readonly number[] = Object.freeze([100, 85, 70]);
/** Most levels an outlook may have, a monthly plan included (backend outlooks/schema.ts OUTLOOK_LEVELS_MAX). */
export const OUTLOOK_LEVELS_MAX = 6;
/** Most analogue years an outlook runs (backend OUTLOOK_YEARS_MAX): the newest. */
export const OUTLOOK_YEARS_MAX = 40;
/** Highest level, %: demand.scale's factor cap × 100. */
export const LEVEL_MAX_PCT = DEMAND_SCALE_MAX * 100;

/** "85" → "85 %", "92.5" → "92.5 %". */
export const levelLabel = (pct: number) => `${fmtNum(pct, 1, true)} %`;
const pct = (v: number) => `${fmtNum(v * 100, 0)} %`;
/** 2012 → "2012/13". */
export const waterYearLabel = (wy: number) => `${wy}/${String((wy + 1) % 100).padStart(2, '0')}`;

/** Parse the demand-levels field ("100, 85, 70"): 1–`room` distinct levels, each 0–200 %, in the order typed. */
export function parseLevels(text: string, room = OUTLOOK_LEVELS_MAX): { levels: number[]; error: null } | { levels: null; error: string } {
	const parts = text
		.split(/[\s,;]+/)
		.map((p) => p.replace(/%$/, ''))
		.filter((p) => p !== '');
	if (!parts.length) return { levels: null, error: 'Enter at least one demand level, e.g. 100, 85, 70.' };
	const levels: number[] = [];
	for (const p of parts) {
		const v = Number(p);
		if (!Number.isFinite(v) || v < 0 || v > LEVEL_MAX_PCT) return { levels: null, error: `“${p}” is not a level from 0 to ${LEVEL_MAX_PCT} %.` };
		const r = Math.round(v * 10) / 10;
		if (levels.includes(r)) return { levels: null, error: `${levelLabel(r)} is listed twice.` };
		levels.push(r);
	}
	if (levels.length > room) return { levels: null, error: `An outlook has at most ${OUTLOOK_LEVELS_MAX} demand levels${room < OUTLOOK_LEVELS_MAX ? ', the monthly plan included' : ''}.` };
	return { levels, error: null };
}

/** The calendar months a season setting touches, in season order: 1 October – 30 April → [10, 11, 12, 1, 2, 3, 4]. */
export function seasonMonths(setting: OutlookSeasonSetting | null): number[] {
	const s = setting ?? DEFAULT_OUTLOOK_SEASON;
	// Ending in its own month before its start day, it goes round the year.
	const wraps = s.endMonth === s.startMonth && s.endDay < s.startDay;
	const out: number[] = [];
	for (let i = 0, m = s.startMonth; i < 12; i++, m = (m % 12) + 1) {
		out.push(m);
		if (m === s.endMonth && !(i === 0 && wraps)) break;
	}
	return out;
}

/**
 * A monthly plan as R1's `months` form: one demand.scale op per distinct
 * level, naming its months (in season order). `pcts` is % per calendar month.
 */
export function monthlyPlanOps(pcts: Readonly<Record<number, number>>, months: readonly number[]): { ops: ScenarioOp[]; error: string | null } {
	const byFactor = new Map<number, number[]>();
	for (const m of months) {
		const v = pcts[m];
		if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > LEVEL_MAX_PCT) {
			return { ops: [], error: `${monthName(m)}: enter a level from 0 to ${LEVEL_MAX_PCT} %.` };
		}
		const f = Math.round(v * 10) / 1000;
		byFactor.set(f, [...(byFactor.get(f) ?? []), m]);
	}
	const ops = [...byFactor.entries()].map(([factor, ms]) => ({ op: 'demand.scale' as const, factor, months: ms }));
	return { ops, error: null };
}

/** The request for these levels (and an optional monthly plan) on a base run; the season and share are the project's settings. */
export function outlookRequest(baseRunId: string, levels: readonly number[], plan: { label: string; ops: ScenarioOp[] } | null = null): OutlookRequest {
	const all = [...levels.map((p) => ({ label: levelLabel(p), ops: [{ op: 'demand.scale' as const, factor: p / 100 }] as ScenarioOp[] })), ...(plan ? [plan] : [])];
	return { name: `Seasonal outlook ${all.map((l) => l.label).join(' / ')}`, baseRunId, levels: all };
}

/** Where an outlook stands, from its real status and its job's (never a timer). */
export type OutlookState = { kind: 'pending'; text: string; progress: number | null } | { kind: 'stuck'; text: string } | { kind: 'complete' };

export function outlookState(o: Pick<Outlook, 'status' | 'job'>): OutlookState {
	if (o.status === 'complete') return { kind: 'complete' };
	const j = o.job;
	if (!j) return { kind: 'stuck', text: 'This outlook did not finish, and its job has been cleared. Start a new one.' };
	if (j.status === 'dead') return { kind: 'stuck', text: `This outlook could not run${j.error ? `: ${j.error}` : '.'}` };
	if (j.status === 'running') return { kind: 'pending', text: 'Running every demand level in every analogue year…', progress: j.progress ?? null };
	if (j.status === 'failed') return { kind: 'pending', text: `The outlook failed and will be tried again${j.error ? ` (${j.error})` : ''}.`, progress: null };
	return { kind: 'pending', text: 'Queued: waiting for the background worker.', progress: null };
}

const EXCLUDED: Record<OutlookExcludedYear['reason'], string> = {
	outsideRecord: 'its season is not all in the record',
	missingRain: 'a day of its season has no rain data',
	theSeason: 'it is the season itself',
	duplicate: 'listed twice',
	notAYear: 'not a water year',
	overLimit: `older than the newest ${OUTLOOK_YEARS_MAX} years`,
	memberFailed: 'a demand level’s run failed in it'
};

/** A statistic as "median (10th – 90th)", or a dash when there are too few years. */
function statText(s: OutlookStat | null, f: (v: number) => string): { median: string; band: string } {
	if (!s) return { median: '–', band: '' };
	return { median: f(s.p50), band: `${f(s.p10)} – ${f(s.p90)}` };
}

export interface OutlookLevelRow {
	id: string;
	label: string;
	kind: 'ran' | 'notRun';
	/** Why it didn't run. */
	problems: string[];
	nYears: number;
	storage: { median: string; band: string };
	demandMet: { median: string; band: string };
	ewr: { median: string; band: string };
	/** "met the EWR on every day of the season in 9 of 13 years". */
	yearsMet: string;
	/** The planning figure's level. */
	planning: boolean;
}

export interface OutlookYearRow {
	label: string;
	/** Per level that ran, in the levels' order: the requirement in the year and the season-end storage. */
	cells: { ewr: string; met: boolean; storage: string }[];
}

export interface OutlookView {
	season: string;
	/** The planning share. */
	share: string;
	metric: OutlookResult['metric'];
	metricLabel: string;
	/** The requirement column's heading. */
	ewrHeading: string;
	start: string | null;
	nYears: number;
	enoughYears: boolean;
	/** Why there are no percentiles and no planning figure, when so. */
	tooFewYears: string | null;
	rows: OutlookLevelRow[];
	/** describePlanningFigure: counts years, never advice. */
	planning: string;
	/** Level labels that ran, in order, for the per-year table's columns. */
	yearColumns: string[];
	years: OutlookYearRow[];
	excluded: string[];
	failures: string[];
	warnings: string[];
}

/** The measure in words; the days below name the base run's daily EWR (dailyEwrName: the pragmatic EWR, or a DRM table, engine ≥ 1.77.0). */
const metricLabelOf = (metric: OutlookResult['metric'], daily?: DailyEwrSource) =>
	metric === 'reserveMonthsMet' ? 'Reserve months met (the rule table at the outlet)' : `Days below ${dailyEwrName(daily)} at the outlet`;

const dayBefore = (iso: string) => new Date(Date.parse(`${iso}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);

/** A complete outlook's result in words. */
export function buildOutlookView(o: Pick<Outlook, 'decisionDate' | 'seasonEnd'> & { result: OutlookResult }, daily?: DailyEwrSource): OutlookView {
	const r = o.result;
	const reserve = r.metric === 'reserveMonthsMet';
	const m3 = (v: number) => `${fmtNum(v)} m³`;
	const ran = r.levels.filter((l) => !l.problems.length);
	const rows: OutlookLevelRow[] = r.levels.map((l) => ({
		id: l.id,
		label: l.label,
		kind: l.problems.length ? 'notRun' : 'ran',
		problems: l.problems,
		nYears: l.nYears,
		storage: statText(l.seasonEndStorageM3, m3),
		demandMet: statText(l.demandMet, pct),
		ewr: statText(l.ewr, pct),
		yearsMet: reserve
			? `Reserve met in every month in ${l.yearsEwrMet} of ${l.nYears} years`
			: `EWR met on every day in ${l.yearsEwrMet} of ${l.nYears} years`,
		planning: r.planning.reason === 'met' && r.planning.levelId === l.id
	}));
	const years: OutlookYearRow[] = r.analogues.map((a, i) => ({
		label: a.label,
		cells: ran.map((l) => {
			const y = l.years[i]!;
			return {
				ewr: reserve ? `${y.ewr.count} of ${y.ewr.units} months met` : `${y.ewr.count} ${y.ewr.count === 1 ? 'day' : 'days'} below`,
				met: y.ewr.met,
				storage: y.seasonEndStorageM3 === null ? '–' : m3(y.seasonEndStorageM3)
			};
		})
	}));
	return {
		season: `${fmtDay(o.decisionDate)} – ${fmtDay(o.seasonEnd)} (${r.days} days)`,
		share: `${pct(r.planning.share)} of analogue years`,
		metric: r.metric,
		metricLabel: metricLabelOf(r.metric, daily),
		ewrHeading: reserve ? 'Reserve months met' : 'Days below the EWR',
		start:
			r.startStorageM3 === null
				? null
				: `The hydrological units’ dams held ${m3(r.startStorageM3)} of ${m3(r.capacityM3)} at the end of ${fmtDay(dayBefore(o.decisionDate))}: every year starts from there.`,
		nYears: r.nYears,
		enoughYears: r.enoughYears,
		tooFewYears: r.enoughYears
			? null
			: `Only ${r.nYears} analogue ${r.nYears === 1 ? 'year' : 'years'}: at least ${OUTLOOK_MIN_YEARS} are needed for the 10–90 % range and a planning figure, so only each year’s values are shown.`,
		rows,
		planning: describePlanningFigure(r),
		yearColumns: ran.map((l) => l.label),
		years,
		excluded: r.excluded.map((x) => `${waterYearLabel(x.waterYear)} (${EXCLUDED[x.reason] ?? x.reason})`),
		failures: r.failures.map((f) => `${f.label}, ${waterYearLabel(f.waterYear)}: ${f.message}`),
		warnings: r.warnings
	};
}
