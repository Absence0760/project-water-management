<!--
	EWR → the months-met panel (`#res-reserve`): the months judged by the daily EWR in use (engine ≥ 1.116.0,
	ewr/EwrDailyMonthsPanel.svelte, named for its source: the pragmatic EWR, the DRM TAB file or the DRM percentile
	tables) or by the Reserve rule tables (runs/EwrAssurancePanel.svelte, "Reserve rules met, by month"). A run with
	both offers a "Judged by" switch under the heading; which shows first is river.ts monthsJudge (the reader's pick,
	else the test the results are judged by). Without a rule table in the run, a line under the daily months says how
	to judge them by one too (issue #465: the panel was once simply absent). The parent keeps the pick, so the page's
	menu names the panel as its heading reads (river.ts monthsMetHeading). The daily months can be judged at a
	hydrological unit instead of the outlet ("At", ewr/EwrUnitPick.svelte; ewr/EwrDailyMonthsAt.svelte works them out
	from the unit's stored series).
-->
<script lang="ts">
	import type { RunSummary } from '@water-management/engine';
	import Lazy from '#lib/components/common/Lazy.svelte';
	import { dailyEwrName } from '#lib/components/ewr/notMet.js';
	import EwrUnitPick from '#lib/components/ewr/EwrUnitPick.svelte';
	import { pickedUnit, unitChoices } from '#lib/components/ewr/unitMonths.js';
	import { RESERVE_MONTHS_HEADING, type MonthsJudge } from './river';

	let {
		projectId,
		runId,
		summary,
		judge,
		onjudge,
		stub
	}: {
		projectId: string;
		runId: string;
		summary: Pick<RunSummary, 'ewrDailyMonths' | 'ewrAssurance' | 'catchment' | 'ewrCompliance' | 'allocations' | 'unitEwr' | 'historyDays'>;
		/** What it shows (river.ts monthsJudge). */
		judge: MonthsJudge;
		/** The reader picked the other judgement. */
		onjudge: (j: MonthsJudge) => void;
		/** Without a rule table in the run: what it would take (river.ts reserveStubText). */
		stub: { lead: string; link: string | null };
	} = $props();

	const uid = $props.id();
	const loadAssurancePanel = () => import('#lib/components/runs/EwrAssurancePanel.svelte');
	const loadDailyMonths = () => import('#lib/components/ewr/EwrDailyMonthsAt.svelte');
	const hasRules = $derived(!!summary.ewrAssurance?.length);
	// The unit the daily months are judged at (null: the outlet); the parent keys this component on the run.
	let at = $state<string | null>(null);
	const choices = $derived(unitChoices(summary));
	const unit = $derived(pickedUnit(choices, at));
	const dailyLabel = $derived.by(() => {
		const name = dailyEwrName(summary.catchment.outletEwr).replace(/^the /, '');
		return `${name[0]!.toUpperCase()}${name.slice(1)}`;
	});
</script>

{#snippet controls()}
	{#if hasRules}
		<div class="judge">
			<span class="small muted" id="{uid}-judge">Judged by</span>
			<span class="seg" role="group" aria-labelledby="{uid}-judge" data-testid="months-judge">
				<button type="button" class="btn btn-sm" aria-pressed={judge === 'daily'} onclick={() => onjudge('daily')}>{dailyLabel}</button>
				<button type="button" class="btn btn-sm" aria-pressed={judge === 'rules'} onclick={() => onjudge('rules')}>Reserve rule tables</button>
			</span>
		</div>
	{/if}
{/snippet}

{#snippet dailyControls()}
	{@render controls()}
	<EwrUnitPick {choices} value={unit?.nodeId ?? null} onpick={(id) => (at = id)} />
{/snippet}

{#if judge === 'rules' && hasRules}
	<Lazy load={loadAssurancePanel}>
		{#snippet children(EwrAssurancePanel)}
			<EwrAssurancePanel sites={summary.ewrAssurance ?? []} title={RESERVE_MONTHS_HEADING} headingLevel={2} {controls} />
		{/snippet}
	</Lazy>
{:else}
	<Lazy load={loadDailyMonths}>
		{#snippet children(EwrDailyMonthsAt)}
			<EwrDailyMonthsAt {projectId} {runId} {summary} {unit} controls={dailyControls} />
		{/snippet}
	</Lazy>
	{#if !hasRules}
		<!-- Without a rule table the Reserve's own judgement was simply absent and nothing said why (issue #465). -->
		<p class="muted small stub" data-testid="reserve-stub">
			{stub.lead}{#if stub.link}{' '}<a href="?tab=settings#set-reserve">{stub.link}</a>.{/if}
		</p>
	{/if}
{/if}

<style>
	.judge {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.25rem 0.5rem;
		margin: 0.25rem 0 0.5rem;
	}
	.stub {
		margin-top: 0.75rem;
	}
</style>
