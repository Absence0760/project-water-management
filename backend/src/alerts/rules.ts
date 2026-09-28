// Alert kinds, their default rules, and the hysteresis that decides when a
// rule fires and when it re-arms (roadmap WP-2.13; 051_alerts.sql,
// docs/data-model.md § Alerts). Pure: no I/O.
//
// A rule fires once when its value crosses the threshold, and fires again
// only after the value has recovered past the threshold plus a margin, so a
// figure hovering at the line sends one mail, not one a day:
//
//   kind                   value                                fires when        re-arms when
//   dam_below              the farm's dam, ÷ capacity           < t               ≥ t + 5 points
//   ewr_forecast_fail      forecast days the outlet EWR fails   ≥ t               ≤ max(0, t − 2)
//   data_stale (per feed)  days the feed is past its usual delay > t               < t
//   feed_failing           fetches in a row that failed         ≥ t               0
//   job_dead               jobs dead in the last 24 hours       ≥ t               0
//   restriction_published  (no value: every change of the WUA's notice is one event)
//
// A value that is gone (the farm isn't in the publication any more, no
// current forecast) clears a firing rule.
import { z } from 'zod';

export const ALERT_KINDS = ['dam_below', 'ewr_forecast_fail', 'data_stale', 'restriction_published', 'job_dead', 'feed_failing'] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];

/** Kinds that watch one farm each (a rule and a subscription carry its node). */
export const FARM_KINDS: readonly AlertKind[] = ['dam_below'];

export const DEFAULT_THRESHOLDS: Readonly<Record<AlertKind, number>> = Object.freeze({
	dam_below: 0.3,
	ewr_forecast_fail: 3,
	// The fallback only: each feed's rule defaults to its source's level (feeds/config.ts staleAlertDays).
	data_stale: 3,
	restriction_published: 0,
	job_dead: 1,
	feed_failing: 3
});

/** dam_below re-arms this far above its threshold (a fraction: 5 percentage points). */
export const DAM_MARGIN = 0.05;

/** Each kind's threshold as an editor may set it (the 051 CHECK, as a schema). */
export const THRESHOLD: Readonly<Record<AlertKind, z.ZodType<number>>> = {
	dam_below: z.number().gt(0).lt(1),
	ewr_forecast_fail: z.number().int().min(1).max(60),
	data_stale: z.number().int().min(1).max(60),
	restriction_published: z.literal(0),
	job_dead: z.number().int().min(1).max(100),
	feed_failing: z.number().int().min(1).max(20)
};

/** Whether `value` is past the threshold (the rule would open an event). */
export function fires(kind: AlertKind, threshold: number, value: number): boolean {
	switch (kind) {
		case 'dam_below':
			return value < threshold;
		case 'data_stale':
			return value > threshold;
		case 'restriction_published':
			return false;
		default:
			return value >= threshold;
	}
}

/** Whether `value` has recovered past the threshold plus the margin (a firing rule clears). */
export function recovered(kind: AlertKind, threshold: number, value: number): boolean {
	switch (kind) {
		case 'dam_below':
			return value >= threshold + DAM_MARGIN;
		case 'ewr_forecast_fail':
			return value <= Math.max(0, threshold - 2);
		case 'data_stale':
			return value < threshold;
		case 'restriction_published':
			return true;
		default:
			return value <= 0;
	}
}

export type Step = 'open' | 'clear' | 'keep';

/** What a rule does with a new value, given whether it is firing now. */
export function step(firing: boolean, kind: AlertKind, threshold: number, value: number | null): Step {
	if (value === null || !Number.isFinite(value)) return firing ? 'clear' : 'keep';
	if (!firing) return fires(kind, threshold, value) ? 'open' : 'keep';
	return recovered(kind, threshold, value) ? 'clear' : 'keep';
}

/** A person's choice for a kind. */
export const ALERT_MODES = ['immediate', 'daily_digest', 'off'] as const;
export type AlertMode = (typeof ALERT_MODES)[number];

/** The project roles as the audience uses them (051 alert_audience). */
export type AudienceRole = 'farmer' | 'contributor' | 'viewer' | 'editor' | 'owner';

/**
 * The kinds a role can get, and the default mode of each (051 alert_audience,
 * which is what decides; this mirrors it for the preferences page, and
 * alerts.db.test.ts holds the two together). A farmer gets dam alerts only
 * for their own farms.
 */
export function defaultMode(role: AudienceRole, kind: AlertKind): AlertMode | null {
	if (role === 'contributor') return null;
	const up = role === 'editor' || role === 'owner';
	switch (kind) {
		case 'dam_below':
			return role === 'farmer' || up ? 'immediate' : 'off';
		case 'ewr_forecast_fail':
			return up ? 'immediate' : role === 'viewer' ? 'off' : null;
		case 'data_stale':
			return up ? 'immediate' : null;
		case 'restriction_published':
			return 'immediate';
		case 'job_dead':
		case 'feed_failing':
			return role === 'owner' ? 'immediate' : role === 'editor' ? 'off' : null;
	}
}
