// The daily EWR months-met panel at a hydrological unit instead of the outlet (ewr/EwrDailyMonthsAt.svelte, on the
// EWR page and the scenario page's base-against-a-run pair; docs/ui.md § EWR). The outlet's figures are the run's
// own (RunSummary.ewrDailyMonths, engine ≥ 1.116.0, docs/model.md §2.9h); a unit's are worked out here, by the
// engine's same test (assessDailyEwrMonths), from two series every run stores per unit: `ewr_cumulative` (Z, the
// daily EWR in use times the unit's share plus the shares of the units above it, §2.5 and §2.7) and `outflow` (U,
// the river leaving the unit, after its abstractions). So it needs no re-run, and a month at a unit is met when
// Σ U ≥ Σ Z over its days, as the outlet's is when the outflow covers the daily EWR. Pure helpers.
import { assessDailyEwrMonths, type DailySeries, type EwrDailyMonths, type RunSummary } from '@water-management/engine';

/** One place the panel can be judged at besides the outlet. */
export interface UnitChoice {
	nodeId: string;
	name: string;
}

type WithUnits = Pick<RunSummary, 'unitEwr'>;

/**
 * The units the picker offers: those with an EWR share at or above them (Σ Z > 0) in any of the runs given, in
 * the first run's order, then any only a later run has (a unit a scenario added). Runs made before engine 1.116.0
 * have no `unitEwr` and add none.
 */
export function unitChoices(...summaries: (WithUnits | null | undefined)[]): UnitChoice[] {
	const out: UnitChoice[] = [];
	const seen = new Set<string>();
	for (const s of summaries) {
		for (const u of s?.unitEwr ?? []) {
			if (u.requiredM3 > 0 && !seen.has(u.nodeId)) {
				seen.add(u.nodeId);
				out.push({ nodeId: u.nodeId, name: u.name });
			}
		}
	}
	return out;
}

/** Whether the run has the unit (its summary lists it); a unit a scenario added isn't in its base run. */
export const unitInRun = (summary: WithUnits, nodeId: string): boolean => !!summary.unitEwr?.some((u) => u.nodeId === nodeId);

/** The picked unit while it is still a choice, else null (the outlet). */
export function pickedUnit(choices: readonly UnitChoice[], nodeId: string | null): UnitChoice | null {
	return (nodeId && choices.find((c) => c.nodeId === nodeId)) || null;
}

/**
 * A unit's months met: its outflow against the EWR required at it, per complete calendar month, as the outlet's.
 * `historyDays`: a forecast run's recorded days (RunSummary.historyDays), so a month the forecast tail starts
 * inside isn't assessed, as at the outlet. A missing value counts as 0, as the engine's own sum does.
 */
export function unitMonths(outflow: DailySeries, required: DailySeries, historyDays?: number): EwrDailyMonths {
	if (outflow.startDate !== required.startDate) throw new Error(`the unit's outflow starts ${outflow.startDate} and its EWR ${required.startDate}`);
	const days = Math.min(outflow.values.length, required.values.length);
	const num = (v: (number | null)[]) => Float64Array.from(v.slice(0, days), (x) => x ?? 0);
	return assessDailyEwrMonths(outflow.startDate, days, num(required.values), num(outflow.values), Math.min(historyDays ?? days, days));
}

/** Fetch the unit's two series (through the caller's cache) and judge them. */
export async function loadUnitMonths(
	get: (key: 'outflow' | 'ewr_cumulative', nodeId: string) => Promise<DailySeries>,
	nodeId: string,
	historyDays?: number
): Promise<EwrDailyMonths> {
	const [outflow, required] = await Promise.all([get('outflow', nodeId), get('ewr_cumulative', nodeId)]);
	return unitMonths(outflow, required, historyDays);
}

/** What the panel's explanation and verdict call the place: "the outlet" or the unit's name. */
export function placeWords(unit: UnitChoice | null): { where: string; flow: string; requirement: (daily: string) => string } {
	if (!unit) return { where: 'the outlet', flow: 'the simulated outflow', requirement: (daily) => daily };
	return {
		where: unit.name,
		flow: `the flow leaving ${unit.name} (after its abstractions)`,
		requirement: (daily) => `its share of ${daily} (with the shares of the units above it)`
	};
}
