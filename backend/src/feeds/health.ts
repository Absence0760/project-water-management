// A feed's health, as the status panel shows it: one state and the reason for
// it, a code with its facts (the client writes the sentence and formats the
// days, so no date is baked into server text). Pure, from the feed's health
// columns, today and the project's time zone: every day it reports or counts
// to (today, when it was checked, attached or last grew) is the calendar day
// where the catchment is (project.time_zone, 058), not UTC's, which is a day
// behind a South African reader from 22:00 to 24:00 UTC. The source's own
// days (lastDataDate, a staged record's from/through) are the source's dates
// and pass through as they are.
//
//   disabled  switched off by an owner
//   failing   the last fetch failed (consecutive_failures > 0)
//   stale     no failure, but the newest day is older than the source's usual
//             lag allows (config.ts feedStaleAfterDays: the feed's own
//             staleAfterDays, else its source's or product's): the source stopped publishing, or the fetch
//             keeps finding nothing new
//   pending   not fetched yet, or not since a new place or series was saved
//             (018_feeds.sql clears the data, success and failures then), or
//             a confirmed replacement still backfilling (feed_stage, 032)
//   copy-behind  a CHIRPS feed read from our own copy (CHIRPS_SOURCE=mirror,
//             issue #604) whose copy is late: the feed is fine, our copy
//             hasn't caught up with CHC (rainCopyStatus, below). Not the
//             feed's own error, so it never counts a failure or backs off;
//             the feed fills the days once the copy holds them
//   ok        otherwise
//
// `stale` is also reported on its own, so a failing feed that is out of date
// says both.
import { toEpochDay } from '@water-management/engine/calendar';
import { localDate } from '../projects/timeZone.js';
import { chirpsProduct, type FeedConfig, type FeedSource, feedStaleAfterDays } from './config.js';

export const FEED_STATES = ['ok', 'stale', 'failing', 'pending', 'disabled', 'copy-behind'] as const;
export type FeedState = (typeof FEED_STATES)[number];

/**
 * Why the feed is in its state. Days are calendar days (YYYY-MM-DD): the
 * source's own for `newest`, `from` and `through`, the project's time zone's
 * for `checked` and `since`.
 *
 *   off           switched off; `newest` is the newest day, or null
 *   failing       `failures` fetches in a row failed, the last with `error`
 *   old-forecast  the forecast reaches only `newest`, fewer than
 *                 -staleAfterDays days ahead
 *   old-data      the newest day, `newest`, is more than staleAfterDays old
 *   no-data       fetches succeed but have found nothing yet
 *   not-fetched   not fetched since it was attached / changed on `since`
 *   waiting       waiting for its first fetch
 *   ok            `newest` (or null), last checked on `checked`
 *   rebuilding    a confirmed replacement backfilling: the new record runs
 *                 `from` … `through` so far; the live series is unchanged
 *                 until it is caught up
 *   rebuild-stalled  the same, but it hasn't grown since `since` (over a
 *                 day): the stage waits, the live series is unchanged
 *   copy-behind   our copy of the feed's CHIRPS `product` is late: it holds
 *                 final days to `final` and (sat only, else null)
 *                 preliminary days to `preliminary`, either null when it
 *                 holds none; `newest` is the feed's own newest day
 */
export type HealthReason =
	| { code: 'off'; newest: string | null }
	| { code: 'failing'; failures: number; error: string | null; newest: string | null }
	| { code: 'old-forecast'; newest: string }
	| { code: 'old-data'; newest: string }
	| { code: 'no-data' }
	| { code: 'not-fetched'; since: string; after: 'attached' | 'changed' }
	| { code: 'waiting' }
	| { code: 'ok'; newest: string | null; checked: string }
	| { code: 'rebuilding'; from: string; through: string }
	| { code: 'rebuild-stalled'; from: string; through: string; since: string }
	| { code: 'copy-behind'; product: 'sat' | 'rnl'; final: string | null; preliminary: string | null; newest: string | null };

export interface FeedHealth {
	state: FeedState;
	stale: boolean;
	staleAfterDays: number;
	reason: HealthReason;
}

export interface HealthInput {
	source: FeedSource;
	config: FeedConfig;
	enabled: boolean;
	createdAt: Date | string;
	/** The last save; a feed with no data counts its grace from here. */
	updatedAt?: Date | string;
	lastAttemptAt: Date | string | null;
	lastSuccessAt: Date | string | null;
	lastDataDate: string | null;
	consecutiveFailures: number;
	lastError: string | null;
	/** A staged replacement (FeedMeta.rebuilding), or null/absent. */
	rebuilding?: { startDate: string; through: string; updatedAt: Date | string } | null;
}

/** A staged replacement that hasn't grown for this long is stalled (its next window runs a minute after the last). */
export const REBUILD_STALL_DAYS = 1;

/** A feed with no data counts as stale this long after it was attached or last saved. */
const FIRST_DATA_GRACE_DAYS = 2;

/**
 * How far behind CHC our copy's finals (`rnl`, `sat`) may run before they
 * count as late, by default: CHC publishes month M's finals during month M+1,
 * usually by the 25th, so a healthy copy's finals end up to ~56 days back
 * just before a release. 75 is the default of the lag alarm's threshold
 * (infra ingest_lag_alarm_days); production passes the threshold itself to
 * the API as COPY_FINAL_LAG_DAYS (copyFinalLagDays), so the panel and the
 * alarm agree when the operator tunes it. Locally nothing sets it: 75.
 */
export const COPY_FINAL_LAG_DAYS = 75;

/** The bounds COPY_FINAL_LAG_DAYS may take: Terraform's own floor for the alarm (60, below which a healthy copy alarms), and ten years. */
export const COPY_FINAL_LAG_LIMITS = { min: 60, max: 3650 } as const;

/**
 * The problem with a COPY_FINAL_LAG_DAYS value, or null when it is a whole
 * number of days within COPY_FINAL_LAG_LIMITS (or unset: the default). The
 * API's production check refuses to start on one (config/production.ts).
 */
export function copyFinalLagProblem(v: string | undefined): string | null {
	if (v === undefined || v.trim() === '') return null;
	const n = Number(v.trim());
	return Number.isInteger(n) && n >= COPY_FINAL_LAG_LIMITS.min && n <= COPY_FINAL_LAG_LIMITS.max
		? null
		: `must be a whole number of days from ${COPY_FINAL_LAG_LIMITS.min} to ${COPY_FINAL_LAG_LIMITS.max}`;
}

/**
 * How far behind the copy's finals may run here: COPY_FINAL_LAG_DAYS (the
 * lag alarm's threshold, infra/lambda.tf), else COPY_FINAL_LAG_DAYS's default.
 * A value that isn't a whole number of days in bounds throws, naming the
 * setting: production refuses to start on one first.
 */
export function copyFinalLagDays(env: Record<string, string | undefined> = process.env): number {
	const v = env.COPY_FINAL_LAG_DAYS;
	const problem = copyFinalLagProblem(v);
	if (problem) throw new Error(`COPY_FINAL_LAG_DAYS ${problem}`);
	return v === undefined || v.trim() === '' ? COPY_FINAL_LAG_DAYS : Number(v.trim());
}

/**
 * How far behind the copy's preliminary `sat` days may run: CHC publishes a
 * preliminary day two or three days after it (the fixtures' prelimLagDays is
 * 3), so a week means the daily ingest has missed several runs.
 */
export const COPY_PRELIM_LAG_DAYS = 7;

/** One part of the copy: the last day it holds (null: none yet), and whether that is later than the part's usual lag allows. */
export interface CopyPart {
	through: string | null;
	behind: boolean;
}

/**
 * Our CHIRPS copy (issue #604) as the data feeds panel shows it, from the
 * three products' manifests as the worker's tick recorded them (mirror_copy,
 * feeds/rainCopy.ts): `final.sat`/`final.rnl` from each finals
 * manifest's finalThrough, `preliminary` from the prelim manifest's
 * prelimThrough. `asOf` is the day the lags count to: today (UTC, the day
 * the lag alarm counts to) for a real copy, or the committed sample copy's
 * own day when `sample` (it is fixed in time, as a copy current on that day).
 * `readable: false` when the copy hasn't been checked yet (no product
 * recorded): no feed is then marked behind.
 */
export type RainCopy =
	| { readable: true; sample: boolean; asOf: string; final: { sat: CopyPart; rnl: CopyPart }; preliminary: CopyPart }
	| { readable: false };

/** A copy whose manifests were read. */
export type ReadCopy = Extract<RainCopy, { readable: true }>;

/** The manifests' days rainCopyStatus reads (null: that product's manifest isn't in the copy yet). */
export interface CopyDays {
	sat: { finalThrough: string | null } | null;
	rnl: { finalThrough: string | null } | null;
	prelim: { prelimThrough: string | null } | null;
}

const laterOf = (a: string | null, b: string | null) => (a === null ? b : b === null ? a : a > b ? a : b);

/**
 * The copy's parts on `asOf`. A part is behind when it holds nothing, or its
 * last day is more than its usual lag before `asOf` (exactly the lag is still
 * on time). The preliminary part is judged by the later of its own last day
 * and sat's finals: once a month's finals land its preliminary days are
 * dropped, so the finals may be the newest days the copy holds.
 */
export function rainCopyStatus(days: CopyDays, asOf: string, sample = false, finalLagDays: number = COPY_FINAL_LAG_DAYS): ReadCopy {
	const t = toEpochDay(asOf);
	const part = (through: string | null, lag: number): CopyPart => ({ through, behind: through === null || t - toEpochDay(through) > lag });
	const satFinal = days.sat?.finalThrough ?? null;
	const prelim = days.prelim?.prelimThrough ?? null;
	const preliminary = part(laterOf(prelim, satFinal), COPY_PRELIM_LAG_DAYS);
	return {
		readable: true,
		sample,
		asOf,
		final: { sat: part(satFinal, finalLagDays), rnl: part(days.rnl?.finalThrough ?? null, finalLagDays) },
		preliminary: { through: prelim, behind: preliminary.behind }
	};
}

/**
 * Whether the copy a CHIRPS feed reads is behind, as the feed's reason (null:
 * not CHIRPS, no copy in use, the copy not checked yet, or on time). An rnl feed
 * reads rnl's finals; a sat feed sat's finals and the preliminary days.
 */
export function copyBehind(f: Pick<HealthInput, 'source' | 'config' | 'lastDataDate'>, copy: RainCopy | null | undefined): Extract<HealthReason, { code: 'copy-behind' }> | null {
	if (f.source !== 'chirps' || !copy?.readable) return null;
	const product = chirpsProduct(f.config);
	const final = copy.final[product];
	const behind = product === 'rnl' ? final.behind : final.behind || copy.preliminary.behind;
	if (!behind) return null;
	return { code: 'copy-behind', product, final: final.through, preliminary: product === 'sat' ? copy.preliminary.through : null, newest: f.lastDataDate };
}

/**
 * `f`'s health on `today`, the calendar day in `timeZone` (the caller's
 * localDate(now, project.time_zone)); the instants it reports are dated in
 * that zone too. `copy`: our CHIRPS copy's state when the server reads it
 * (CHIRPS_SOURCE=mirror, feeds/rainCopy.ts), else null or absent.
 */
export function feedHealth(f: HealthInput, today: string, timeZone: string, copy?: RainCopy | null): FeedHealth {
	const iso = (d: Date | string) => localDate(typeof d === 'string' ? new Date(d) : d, timeZone);
	const staleAfterDays = feedStaleAfterDays(f.source, f.config);
	const t = toEpochDay(today);
	const since = f.updatedAt ?? f.createdAt;
	// No outcome recorded for the current place and series (a re-target keeps only last_attempt_at).
	const unfetched = !f.lastSuccessAt && f.consecutiveFailures === 0;
	const stale = f.lastDataDate
		? t - toEpochDay(f.lastDataDate) > staleAfterDays
		: t - toEpochDay(iso(since)) > FIRST_DATA_GRACE_DAYS;
	const newest = f.lastDataDate;
	const out = (state: FeedState, reason: HealthReason): FeedHealth => ({ state, stale, staleAfterDays, reason });
	if (!f.enabled) return out('disabled', { code: 'off', newest });
	if (f.consecutiveFailures > 0) return out('failing', { code: 'failing', failures: f.consecutiveFailures, error: f.lastError, newest });
	// A backfilling replacement reads old days, so "old data" says nothing: say how far it has got, or that it stopped.
	if (f.rebuilding) {
		const r = f.rebuilding;
		const since = iso(r.updatedAt);
		if (t - toEpochDay(since) > REBUILD_STALL_DAYS) return { state: 'stale', stale: true, staleAfterDays, reason: { code: 'rebuild-stalled', from: r.startDate, through: r.through, since } };
		return { state: 'pending', stale: false, staleAfterDays, reason: { code: 'rebuilding', from: r.startDate, through: r.through } };
	}
	// Fetched, but our copy is late: say so rather than "no new data", which reads as the feed's fault.
	const late = unfetched ? null : copyBehind(f, copy);
	if (late) return out('copy-behind', late);
	if (stale) {
		if (newest) return out('stale', staleAfterDays < 0 ? { code: 'old-forecast', newest } : { code: 'old-data', newest });
		if (!unfetched) return out('stale', { code: 'no-data' });
		return out('stale', { code: 'not-fetched', since: iso(since), after: iso(since) === iso(f.createdAt) ? 'attached' : 'changed' });
	}
	if (unfetched || !f.lastAttemptAt) return out('pending', { code: 'waiting' });
	return out('ok', { code: 'ok', newest, checked: iso(f.lastSuccessAt ?? f.lastAttemptAt) });
}
