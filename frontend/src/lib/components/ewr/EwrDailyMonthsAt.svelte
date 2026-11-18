<!--
	The daily EWR months-met panel (EwrDailyMonthsPanel.svelte) at the outlet or at a picked hydrological unit, for
	one run. The outlet's months are the run's own summary; a unit's are worked out from its stored `outflow` and
	`ewr_cumulative` series (unitMonths.ts), fetched through the Runs cache, so any run made from engine 1.116.0 shows
	them without a re-run. Used by the EWR page (river/ReserveMonths.svelte) and both sides of the scenario page's
	pair (scenarios/ScenarioEwrMonths.svelte); the picker is the caller's (EwrUnitPick.svelte), so the scenario
	page's one pick moves both sides.
-->
<script lang="ts">
	import type { EwrDailyMonths, RunSummary } from '@water-management/engine';
	import type { Snippet } from 'svelte';
	import { api } from '#lib/api/index.js';
	import { cachedSeries } from '#lib/components/runs/cache.js';
	import { verdictsOnly } from '#lib/components/runs/withheld.js';
	import EwrDailyMonthsPanel from './EwrDailyMonthsPanel.svelte';
	import { dailyMonthsMissing } from './dailyMonths';
	import { loadUnitMonths, unitInRun, type UnitChoice } from './unitMonths';

	let {
		projectId,
		runId,
		summary,
		unit,
		controls,
		compact = false,
		title,
		level = 3,
		missing,
		rerun
	}: {
		projectId: string;
		runId: string;
		summary: Pick<RunSummary, 'ewrDailyMonths' | 'catchment' | 'ewrCompliance' | 'allocations' | 'unitEwr' | 'historyDays'>;
		/** null: the outlet. */
		unit: UnitChoice | null;
		controls?: Snippet;
		compact?: boolean;
		title?: string;
		level?: 3 | 4;
		missing?: Snippet;
		/** The re-run line's words for a run made before engine 1.116.0 (EwrDailyMonthsPanel.svelte). */
		rerun?: string;
	} = $props();

	let result = $state.raw<EwrDailyMonths | null>(null);
	let error = $state<string | null>(null);
	let loadedKey = $state<string | null>(null);

	// A run made before engine 1.116.0 has no unit figures: the panel's own missing line says what to do (a re-run,
	// or the caller's `rerun` words and `missing` steps), as at the outlet.
	const stale = $derived(!!unit && !verdictsOnly(summary) && !summary.unitEwr);
	// Why a unit's months can't be worked out for this run, before any request: kept from this reader (its series
	// are withheld), made before engine 1.116.0 (above), or a unit this run hasn't.
	const blocked = $derived.by(() => {
		if (!unit || stale) return null;
		if (verdictsOnly(summary)) return dailyMonthsMissing(summary);
		if (!unitInRun(summary, unit.nodeId)) return `${unit.name} isn’t in this run.`;
		return null;
	});
	const key = $derived(unit && !blocked && !stale ? `${runId}|${unit.nodeId}` : null);

	$effect(() => {
		const k = key;
		const u = unit;
		if (!k || !u) return;
		result = null;
		error = null;
		loadedKey = null;
		loadUnitMonths((s, nodeId) => cachedSeries(runId, s, nodeId, () => api.runs.series(projectId, runId, s, nodeId)), u.nodeId, summary.historyDays).then(
			(r) => {
				if (k !== key) return;
				result = r;
				loadedKey = k;
			},
			(e: unknown) => {
				if (k !== key) return;
				error = e instanceof Error ? e.message : String(e);
			}
		);
	});

	const unavailable = $derived(
		!unit || stale ? undefined : (blocked ?? (error ? `Couldn’t load ${unit.name}’s flows: ${error}` : loadedKey !== key ? `Working out the months at ${unit.name}…` : undefined))
	);
</script>

<div aria-busy={!!unit && !blocked && !stale && !error && loadedKey !== key}>
	{#if unit}
		<EwrDailyMonthsPanel {summary} {controls} {compact} {title} {level} {missing} {rerun} {unit} result={!stale && loadedKey === key ? result : null} {unavailable} />
	{:else}
		<EwrDailyMonthsPanel {summary} {controls} {compact} {title} {level} {missing} {rerun} />
	{/if}
</div>
