// The portfolio dashboard's rules (roadmap WP-2.14, docs/api.md § Portfolio):
// the EWR and irrigation traffic lights and how old a figure is. Pure, so they're unit-tested
// apart from the query.
import { EWR_TRAFFIC_LIGHT, ewrBand, FARM_VIEW_STALE_DAYS, type EwrTrafficLight } from '@water-management/engine';
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
export type EwrThresholds = EwrTrafficLight;

/**
 * The defaults, for a team that has set none: green below 5 %, amber below
 * 20 %. The hydrologist still has to confirm them (plan.md D11). The engine's
 * constant, so the workspace's EWR compliance by month and the Summary's
 * reserve strip band with the same numbers (reserve/trafficLight.ts).
 */
export const EWR_THRESHOLDS: Readonly<EwrThresholds> = EWR_TRAFFIC_LIGHT;

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
	return ewrBand(daysNotMet, days, t);
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

/**
 * The irrigation traffic light (issue #558: the project list's status column
 * shows irrigation supply instead of the EWR), in percent of the units' demand
 * supplied over the source run: green from `green`, amber from `amber`, red
 * below. Provisional defaults (green ≥ 95 %, the app's supply target; amber
 * ≥ 80 %); there is no team setting for them yet, as there is for the EWR's.
 */
export interface IrrigationThresholds {
	green: number;
	amber: number;
}
export const IRRIGATION_THRESHOLDS: Readonly<IrrigationThresholds> = { green: 95, amber: 80 };

/** A unit below this share of its demand counts as short (the workspace's SUPPLY_TARGET, 95 %). */
export const UNIT_SUPPLY_TARGET = 0.95;

/**
 * Why the irrigation status is unknown:
 *   no-figures  nothing to read: no run
 *   no-units    the source run has no hydrological units
 *   no-demand   its units asked for no water (nothing planted), so a share supplied means nothing
 *   withheld    the source run caps use at, or scales demand to, the registered volumes, and the
 *               reader is kept from each one (portfolio.ts figuresWithheld, #523 I)
 */
export type IrrigationUnknownReason = 'no-figures' | 'no-units' | 'no-demand' | 'withheld';

export interface IrrigationFigure {
	status: EwrStatus;
	/** All units' supply over their demand, over the whole source run (0–1); null when unknown. */
	fractionSupplied: number | null;
	/** The units in the run, and those below UNIT_SUPPLY_TARGET of their demand; null when unknown. */
	units: number | null;
	unitsBelow: number | null;
	/** Set only when status is 'unknown'. */
	reason?: IrrigationUnknownReason;
}

/**
 * The band for a share supplied (0–1). The cut-off is divided, not the share multiplied, so a
 * boundary is exact: 0.95 is green at 95 % (0.95 × 100 is 94.999…).
 */
export function irrigationStatus(fraction: number, t: IrrigationThresholds = IRRIGATION_THRESHOLDS): Exclude<EwrStatus, 'unknown'> | null {
	if (!Number.isFinite(fraction) || fraction < 0) return null;
	return fraction >= t.green / 100 ? 'green' : fraction >= t.amber / 100 ? 'amber' : 'red';
}

/** The irrigation figure from what the query read: the source run's units, their summed mean demand and supply, and how many fell short. */
export function irrigationFigure(
	input: { hasFigures: boolean; withheld?: boolean; units: number; demandM3Day: number; suppliedM3Day: number; unitsBelow: number },
	thresholds: IrrigationThresholds = IRRIGATION_THRESHOLDS
): IrrigationFigure {
	const unknown = (reason: IrrigationUnknownReason): IrrigationFigure => ({ status: 'unknown', fractionSupplied: null, units: null, unitsBelow: null, reason });
	if (!input.hasFigures) return unknown('no-figures');
	if (input.withheld) return unknown('withheld');
	if (!input.units) return unknown('no-units');
	if (!(input.demandM3Day > 0)) return unknown('no-demand');
	const fractionSupplied = Math.min(1, Math.max(0, input.suppliedM3Day / input.demandM3Day));
	return { status: irrigationStatus(fractionSupplied, thresholds)!, fractionSupplied, units: input.units, unitsBelow: input.unitsBelow };
}

/** Whole calendar days from `iso` (YYYY-MM-DD) to `today` (YYYY-MM-DD). */
export const ageDays = (iso: string, today: string): number => toEpochDay(today) - toEpochDay(iso);

/** Figures older than the farm page's freshness rule (7 days) count as stale. */
export const isStale = (iso: string | null, today: string): boolean => iso !== null && ageDays(iso, today) > FARM_VIEW_STALE_DAYS;
