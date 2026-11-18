// The scenario page's "EWR months met: base against a run" (ScenarioEwrMonths.svelte, docs/ui.md § Scenarios):
// the EWR page's months-met panel for the daily EWR in use (ewr/EwrDailyMonthsPanel.svelte) twice, the scenario's
// base run on the left and a run picked on the right, so the two read side by side. Pure helpers.
import type { RunSummary } from '@water-management/engine';
import type { RunMeta } from '#lib/api/types.js';
import { dailyEwrName } from '#lib/components/ewr/notMet.js';

const created = (r: Pick<RunMeta, 'createdAt'>) => {
	const t = Date.parse(r.createdAt);
	return Number.isNaN(t) ? -Infinity : t;
};

/** The right side's choices: every run of the project but the base (a run against itself tells nothing), newest first. */
export function rightChoices<R extends Pick<RunMeta, 'id' | 'createdAt'>>(runs: readonly R[], baseRunId: string): R[] {
	return runs.filter((r) => r.id !== baseRunId).sort((a, b) => created(b) - created(a));
}

/**
 * The run on the right: the one picked while it is still a choice, else the
 * default (the scenario's latest run), else the newest choice. null when the
 * base is the project's only run.
 */
export function rightRun(choices: readonly Pick<RunMeta, 'id'>[], picked: string | null, fallback: string | null): string | null {
	const has = (id: string | null): id is string => !!id && choices.some((r) => r.id === id);
	if (has(picked)) return picked;
	if (has(fallback)) return fallback;
	return choices[0]?.id ?? null;
}

type Judged = Pick<RunSummary, 'catchment' | 'ewrDailyMonths'>;

/**
 * Which daily EWR both sides are judged by, as the EWR page names it ("the
 * pragmatic EWR", "the daily EWR from the DRM TAB file", …), or, when the two
 * runs judged different ones, a sentence saying so for above the charts.
 * A side without months (made before engine 1.116.0) doesn't count: it says so
 * itself. null until a side has months.
 */
export function judgedBy(base: Judged | null, right: Judged | null): { same: true; name: string } | { same: false; text: string } | null {
	const a = base?.ewrDailyMonths ? dailyEwrName(base.catchment.outletEwr) : null;
	const b = right?.ewrDailyMonths ? dailyEwrName(right.catchment.outletEwr) : null;
	if (!a && !b) return null;
	if (!a || !b || a === b) return { same: true, name: (a ?? b)! };
	return { same: false, text: `The two runs are judged by different daily EWRs: the base by ${a}, the other run by ${b}. Their months met measure different things.` };
}
