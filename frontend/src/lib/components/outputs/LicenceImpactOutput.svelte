<!--
	The Outputs page's licence impact by year class (docs/ui.md § Outputs,
	docs/design/planning-outputs.md §3.7): the impact report's board
	(report/LicenceImpactBoard.svelte, built by report/licenceImpact.ts as
	report/ImpactSection.svelte builds it), for a scenario's run against the
	base run its scenario names (outputs.ts licencePair), followed to the base
	the run recorded when the scenario was rebased since, as Scenarios' *Scenario
	against its base* does. Never an invented pairing: on a run of the model it
	links to the scenarios' runs based on it instead, and a run whose scenario
	can't be read says so. The impact report and the evidence report keep the
	board too.
-->
<script lang="ts">
	import { untrack } from 'svelte';
	import { resolve } from '$app/paths';
	import type { EwrRuleTable, NetworkNode } from '@water-management/engine';
	import { api, ApiError, type OutcomeSettings, type RunCompareResponse, type RunMeta } from '#lib/api/index.js';
	import LoadState from '#lib/components/common/LoadState.svelte';
	import { formatRef } from '#lib/components/compare/picker.js';
	import { chooseSite, matrixSites } from '#lib/components/outcomes/matrix.js';
	import LicenceImpactBoard from '#lib/components/report/LicenceImpactBoard.svelte';
	import { loadImpactSeries, type ImpactSeries } from '#lib/components/report/impactSeries.js';
	import { buildLicenceImpactBoard } from '#lib/components/report/licenceImpact.js';
	import { cachedSeries } from '#lib/components/runs/cache.js';
	import { LICENCE_IMPACT_HEADING, licencePair, OUTPUT_ANCHORS, type PairScenario } from './outputs';

	let {
		projectId,
		run,
		outcomes = null,
		nodes = [],
		ewrRules = []
	}: {
		projectId: string;
		/** The run on the page. */
		run: Pick<RunMeta, 'id' | 'label' | 'fromScenario' | 'scenarioId' | 'scenarioName'>;
		/** The project's settings.outcomes: the year-class method and the Reserve site, as the outcome matrix reads them. */
		outcomes?: Partial<OutcomeSettings> | null;
		nodes?: readonly NetworkNode[];
		ewrRules?: readonly Pick<EwrRuleTable, 'siteNodeId'>[];
	} = $props();

	const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
	const ref = (runId: string) => formatRef({ projectId, runId });

	// --- the project's scenarios, once: they say which base a scenario's run is on ---
	let scenarios = $state.raw<PairScenario[] | null>(null);
	let scenariosError = $state<string | null>(null);
	async function loadScenarios() {
		scenariosError = null;
		try {
			scenarios = await api.scenarios.list(projectId);
		} catch (e) {
			scenariosError = msg(e);
		}
	}
	$effect(() => {
		void projectId;
		untrack(loadScenarios);
	});

	const pair = $derived(scenarios ? licencePair(run, scenarios) : null);

	// --- the pair's comparison and the board's three series ---
	let data = $state.raw<RunCompareResponse | null>(null);
	let series = $state.raw<ImpactSeries | null>(null);
	let loading = $state(false);
	let error = $state<string | null>(null);
	let wanted = '';
	async function load(runId: string, baseRunId: string) {
		const key = (wanted = `${runId}|${baseRunId}`);
		loading = true;
		error = null;
		try {
			let d = await api.compare.runs(ref(baseRunId), ref(runId));
			// The scenario was rebased since this run: compare it with the base it was made on.
			const recorded = d.b.scenario?.baseRunId;
			if (recorded && recorded !== d.a.run.id) d = await api.compare.runs(ref(recorded), ref(runId));
			const s = await loadImpactSeries(
				(p, r, k) => cachedSeries(r, k, null, () => api.runs.series(p, r, k, null)),
				{ projectId, runId: d.a.run.id },
				{ projectId, runId }
			);
			if (wanted !== key) return;
			data = d;
			series = s;
		} catch (e) {
			if (wanted !== key) return;
			data = series = null;
			error = e instanceof ApiError && (e.status === 404 || e.status === 400) ? 'The base run of this scenario’s run is no longer stored.' : msg(e);
		} finally {
			if (wanted === key) loading = false;
		}
	}
	$effect(() => {
		const runId = run.id;
		const baseRunId = pair?.kind === 'pair' ? pair.baseRunId : null;
		untrack(() => {
			if (baseRunId) {
				if (wanted !== `${runId}|${baseRunId}`) load(runId, baseRunId);
			} else {
				wanted = '';
				data = series = null;
				loading = false;
				error = null;
			}
		});
	});
	const retry = () => (pair?.kind === 'pair' ? load(run.id, pair.baseRunId) : loadScenarios());

	const site = $derived(chooseSite(outcomes?.siteNodeId, matrixSites(nodes, ewrRules)).site);
	const board = $derived(data && series ? buildLicenceImpactBoard({ data, series, method: outcomes?.yearClassMethod ?? 'auto', site }) : null);
	const shown = $derived(!!board && !loading && !error);
	const stub = $derived(!!scenariosError || (!!pair && (pair.kind !== 'pair' || (!!error && !board))));
	const dataState = $derived(
		scenariosError || (pair?.kind === 'pair' && error) ? 'error' : !pair ? 'loading' : pair.kind !== 'pair' ? pair.kind : shown ? 'complete' : 'loading'
	);
	const runName = (label: string | null | undefined) => label || 'Untitled run';
	const reportHref = (path: string) => resolve(`projects/${encodeURIComponent(projectId)}/report?${path}`);
</script>

<section
	class="panel"
	id={OUTPUT_ANCHORS.licence}
	aria-labelledby={stub ? 'out-licence-h' : 'impact-board-h'}
	data-testid="out-licence"
	data-state={dataState}
>
	<!-- Its own heading only where the board won't come: while the pair loads the board's heading is the one to wait for
	     (a `#out-licence` link lands on it, help/anchor.ts), so no heading is swapped out from under the focus. -->
	{#if stub}
		<h3 id="out-licence-h">{LICENCE_IMPACT_HEADING}</h3>
	{/if}
	{#if scenariosError}
		<LoadState loading={false} error="Couldn’t read the project’s scenarios: {scenariosError}" {retry}><span></span></LoadState>
	{:else if !pair}
		<p class="muted" data-loading>Loading…</p>
	{:else if pair.kind === 'base'}
		<!-- A run of the model: the board needs a proposal, and choosing one would be inventing the pairing. -->
		<p class="muted" data-testid="out-licence-empty">
			The board compares a scenario’s run with the run it is based on, and this is a run of the model.
			{#if pair.proposals.length}Pick a scenario’s run:{:else}No scenario based on this run has been run yet: <a href="?tab=scenarios">open Scenarios</a>.{/if}
		</p>
		{#if pair.proposals.length}
			<ul class="proposals">
				{#each pair.proposals as p (p.runId)}
					<li><a href="?tab=outputs&run={encodeURIComponent(p.runId)}#{OUTPUT_ANCHORS.licence}">{p.scenarioName}</a></li>
				{/each}
			</ul>
		{/if}
	{:else if pair.kind === 'unknown'}
		<p class="muted" data-testid="out-licence-empty">
			This run’s scenario was deleted or isn’t shared with you, so its base run isn’t known here. Its
			<a href={reportHref(`run=${encodeURIComponent(run.id)}&evidence`)}>evidence report</a> still names it.
		</p>
	{:else}
		<LoadState loading={loading && !board} error={board ? null : error} {retry}>
			{#if board && data}
				<LicenceImpactBoard view={board} />
				<p class="pair small" data-testid="out-licence-pair">
					The run of the scenario <strong>{pair.scenarioName}</strong> against its base run <strong>“{runName(data.a.run.label)}”</strong>:
					<a href={reportHref(`run=${encodeURIComponent(run.id)}&against=${encodeURIComponent(ref(data.a.run.id))}`)}>Impact report</a> ·
					<a href={reportHref(`run=${encodeURIComponent(run.id)}&evidence`)}>Evidence report</a>
				</p>
			{/if}
		</LoadState>
	{/if}
</section>

<style>
	h3 {
		margin-top: 0;
	}
	.pair {
		max-width: 80ch;
		margin: 0.75rem 0 0;
	}
	.proposals {
		margin: 0.25rem 0 0;
		padding-left: 1.25rem;
	}
	/* The board's own heading leads the section once it shows. */
	section :global([data-testid='licence-impact-board'] h3) {
		margin-top: 0;
	}
</style>
