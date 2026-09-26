// The portfolio dashboard's rules (roadmap WP-2.14, docs/api.md § Portfolio):
// the EWR traffic light and how old a figure is. Pure, so they're unit-tested
// apart from the query.
import { FARM_VIEW_STALE_DAYS } from '@water-management/engine';
import { toEpochDay } from '@water-management/engine/calendar';

export type EwrStatus = 'green' | 'amber' | 'red' | 'unknown';

/**
 * Why a status is unknown, so the dashboard can say so rather than guess:
 *   no-figures  nothing to read: no run, or none published and no run either
 *   no-ewr      the run the figures come from had no EWR set (every month 0),
 *               so "never short" would be a false green
 *   no-series   the run has no outlet EWR series, or no day in the window
 *               (a run from an older engine)
 */
export type EwrUnknownReason = 'no-figures' | 'no-ewr' | 'no-series';

/**
 * Traffic-light thresholds (roadmap D11), in percent of the window's days
 * with the outlet EWR not met: green below `green`, amber below `amber`, red
 * otherwise. A team may set its own (055_team_settings, teams/settings.ts).
 */
export interface EwrThresholds {
	green: number;
	amber: number;
}

/**
 * The defaults, for a team that has set none: green below 5 %, amber below
 * 20 %. The hydrologist still has to confirm them (plan.md D11).
 */
export const EWR_THRESHOLDS: Readonly<EwrThresholds> = Object.freeze({ green: 5, amber: 20 });

export interface EwrFigure {
	status: EwrStatus;
	/** Days the outlet EWR was not met in the window, and the window's length; null when unknown. */
	daysNotMet30: number | null;
	days30: number | null;
	/** daysNotMet30 ÷ days30; null when unknown. */
	fraction30: number | null;
	/** Set only when status is 'unknown'. */
	reason?: EwrUnknownReason;
}

/** The status for `daysNotMet` of `days` under thresholds `t`. An empty window is unknown, never green. */
export function ewrStatus(daysNotMet: number, days: number, t: EwrThresholds = EWR_THRESHOLDS): Exclude<EwrStatus, 'unknown'> | null {
	if (!(days > 0) || !(daysNotMet >= 0) || daysNotMet > days) return null;
	// daysNotMet ÷ days < pct ÷ 100, cross-multiplied so no division rounds a
	// boundary (7 of 100 days is 7 %, not 7.000000000000001 %).
	const below = (pct: number) => daysNotMet * 100 < pct * days;
	return below(t.green) ? 'green' : below(t.amber) ? 'amber' : 'red';
}

/** The EWR figure from what the query read, with the unknown reason when there's nothing honest to show. */
export function ewrFigure(
	input: { hasFigures: boolean; ewrSet: boolean; daysNotMet: number | null; days: number | null },
	thresholds: EwrThresholds = EWR_THRESHOLDS
): EwrFigure {
	const unknown = (reason: EwrUnknownReason): EwrFigure => ({ status: 'unknown', daysNotMet30: null, days30: null, fraction30: null, reason });
	if (!input.hasFigures) return unknown('no-figures');
	if (!input.ewrSet) return unknown('no-ewr');
	if (input.daysNotMet == null || input.days == null) return unknown('no-series');
	const status = ewrStatus(input.daysNotMet, input.days, thresholds);
	if (!status) return unknown('no-series');
	return { status, daysNotMet30: input.daysNotMet, days30: input.days, fraction30: input.daysNotMet / input.days };
}

/** Whole calendar days from `iso` (YYYY-MM-DD) to `today` (YYYY-MM-DD). */
export const ageDays = (iso: string, today: string): number => toEpochDay(today) - toEpochDay(iso);

/** Figures older than the farm page's freshness rule (7 days) count as stale. */
export const isStale = (iso: string | null, today: string): boolean => iso !== null && ageDays(iso, today) > FARM_VIEW_STALE_DAYS;
