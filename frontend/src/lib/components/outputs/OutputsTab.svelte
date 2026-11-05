<!--
	Outputs (`?tab=outputs`, docs/ui.md § Outputs): the five planning outputs of
	issue #53 (docs/design/planning-outputs.md) on one page, for one run: how
	much irrigation the catchment supports, share the pain, the outcome matrix,
	the seasonal outlook and the licence impact by year class. Each is its own
	component, still where it was as well (EWR has the first, third and fourth,
	Hydrological units the second, the impact and evidence reports the fifth):
	this page only picks the run and lays them out, one section each with an
	`#out-…` anchor, under a short index (common/SectionNav).

	The run is `?run=`, else the newest (river.ts pickRiverRun, as EWR picks it),
	chosen in the header like EWR's. Another run picked keeps the page on
	screen, aria-busy and the editors' controls inert, until its record is in.
	The outputs gate their own editor controls (canEdit) and say in their own
	row why they can't run on this run (a scenario or forecast run, no natural
	flow); Share the pain and the licence impact say it here.
-->
<script lang="ts">
	import { onDestroy, tick, untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { api, type Project, type RunMeta } from '#lib/api/index.js';
	import LoadState from '#lib/components/common/LoadState.svelte';
	import SectionNav from '#lib/components/common/SectionNav.svelte';
	import { runOptionLabel } from '#lib/components/compare/picker.js';
	import ShareThePainBoard from '#lib/components/curtailment/ShareThePainBoard.svelte';
	import IrrigationSupportPanel from '#lib/components/outcomes/IrrigationSupportPanel.svelte';
	import { plantedHaOf } from '#lib/components/outcomes/irrigationSupport.js';
	import type { MatrixShare } from '#lib/components/outcomes/matrix.js';
	import OutcomeMatrixPanel from '#lib/components/outcomes/OutcomeMatrixPanel.svelte';
	import OutlookPanel from '#lib/components/outlook/OutlookPanel.svelte';
	import { runHref } from '#lib/components/overview/attention.js';
	import { pickRiverRun } from '#lib/components/river/river.js';
	import { runDetail, type RunDetail } from '#lib/components/runs/cache.js';
	import { supplyHref } from '#lib/components/supply/links.js';
	import { fillHeader } from '#lib/components/workspace/headerSlot.svelte.js';
	import { fmtWhen } from '#lib/format/number.js';
	import { landOnAnchor } from '#lib/help/anchor.js';
	import type { ModelEditor } from '#lib/model/editor.svelte.js';
	import LicenceImpactOutput from './LicenceImpactOutput.svelte';
	import { isOutputAnchor, OUTPUT_ANCHORS, outputNavGroups, shareState } from './outputs';

	let {
		projectId,
		project,
		editor,
		runs,
		canEdit,
		onProjectChange
	}: {
		projectId: string;
		project: Project;
		editor: ModelEditor;
		/** The page's runs list (null if it couldn't be loaded). */
		runs: RunMeta[] | null;
		canEdit: boolean;
		/** The outcome matrix or the outlook saved a project setting: the page takes the new project. */
		onProjectChange?: (p: Project) => void;
	} = $props();

	const pick = $derived(pickRiverRun(runs, page.url.searchParams.get('run')));
	const ordered = $derived([...(runs ?? [])].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)));

	// A run picked is a new history entry, so Back returns to the run before.
	function choose(id: string) {
		const url = new URL(page.url.href);
		url.searchParams.set('run', id);
		url.hash = '';
		goto(url, { reset: false });
	}

	// --- the run's record, through the run pages' cache. The one on screen stays (busy) until the next is in. ---
	let detail = $state.raw<RunDetail | null>(null);
	let loading = $state(false);
	let error = $state<string | null>(null);
	let wanted = '';
	async function load(runId: string) {
		wanted = runId;
		error = null;
		loading = true;
		try {
			const d = await runDetail(runId, () => api.runs.get(projectId, runId));
			if (wanted === runId) detail = d;
		} catch (e) {
			if (wanted === runId) {
				error = e instanceof Error ? e.message : String(e);
				detail = null;
			}
		} finally {
			if (wanted === runId) loading = false;
		}
	}
	const retry = () => pick && load(pick.run.id);
	$effect(() => {
		const runId = pick?.run.id ?? null;
		untrack(() => {
			if (!runId) {
				wanted = '';
				detail = null;
			} else if (runId !== wanted) load(runId);
		});
	});
	const shown = $derived(detail);
	const busy = $derived(!!pick && (loading || (!!shown && shown.run.id !== pick.run.id)));
	/** The list's entry for the run on screen: the scenario fields the licence pairing reads. */
	const shownMeta = $derived(shown ? (runs?.find((r) => r.id === shown.run.id) ?? null) : null);

	// The outcome matrix's sweep and matrix, for the irrigation support board (one lookup, one set of years, as on EWR).
	let matrixShare = $state.raw<MatrixShare | null>(null);
	let matrixPanel = $state<ReturnType<typeof OutcomeMatrixPanel> | undefined>();
	const farmNames = $derived(Object.fromEntries(editor.model.nodes.map((n) => [n.id, n.name])));

	// --- a link to one of the sections (`#out-matrix`): land once the run's record has drawn them (help/anchor.ts). ---
	let landed = false;
	let release = () => {};
	let destroyed = false;
	$effect(() => {
		if (!shown || landed) return;
		landed = true;
		const hash = untrack(() => page.url.hash.slice(1));
		if (!isOutputAnchor(hash)) return;
		tick().then(() => {
			if (!destroyed) release = landOnAnchor(hash);
		});
	});
	onDestroy(() => {
		destroyed = true;
		release();
	});

	$effect(() => fillHeader({ context: headerContext, actions: headerActions }));
</script>

{#snippet headerContext()}
	<span>The planning outputs for one run: irrigation the catchment supports, share the pain, the outcome matrix, the seasonal outlook and the licence impact.</span>
{/snippet}
{#snippet headerActions()}
	{#if pick}
		<!-- As EWR's picker: the name is for screen readers beside the title, and shows over the select in a phone's More actions list. -->
		<label class="run-pick">
			<span class="visually-hidden">Run</span>
			<select aria-label="Run" value={pick.run.id} onchange={(e) => choose(e.currentTarget.value)}>
				{#each ordered as r, i (r.id)}<option value={r.id}>{runOptionLabel(r, (iso) => fmtWhen(iso), i === 0)}</option>{/each}
			</select>
		</label>
		<a class="btn" href={runHref(pick.run.id)}>Open in Runs &amp; results</a>
	{/if}
{/snippet}

{#if runs === null}
	<p class="alert alert-error" role="alert">The run list couldn’t be loaded, so there is nothing to show yet. Reload the page to try again.</p>
{:else if !pick}
	<section class="panel empty" aria-labelledby="outputs-empty-h" data-testid="outputs-empty">
		<h2 id="outputs-empty-h">No run yet</h2>
		<p class="muted">After a run, this page gathers the planning outputs for it: the irrigation the catchment supports, share the pain, the outcome matrix, the seasonal outlook and the licence impact by year class.</p>
		{#if canEdit}<a class="btn btn-primary" href="?tab=runs">Run the model</a>{:else}<p class="muted small">An editor can run the model.</p>{/if}
	</section>
{:else}
	<SectionNav groups={shown ? outputNavGroups() : []} label="Outputs sections">
		<div class="outputs" data-testid="outputs-body" data-run={shown?.run.id} aria-busy={busy}>
			{#if pick.gone}
				<p class="alert alert-info" role="note">That run no longer exists, so this shows the newest run.</p>
			{/if}
			<LoadState loading={loading && !shown} error={shown ? null : error} {retry}>
				{#if shown}
					{@const run = shown.run}
					{@const summary = run.summary}
					{@const share = shareState(summary.curtailment)}
					<!-- Keyed on the run, as on EWR: each output's own state is the run's. Inert while another run's record loads. -->
					{#key run.id}
						<div class="sections" inert={busy}>
							<!-- Reads the outcome matrix's sweep below (onview); its Run… opens the matrix's form. -->
							<div class="panel" id={OUTPUT_ANCHORS.irrigation}>
								<IrrigationSupportPanel
									source={matrixShare}
									plantedHa={plantedHaOf(run.model)}
									fullAllocation={run.settings?.allocationMode === 'fullAllocation'}
									{canEdit}
									onRun={() => matrixPanel?.open()}
								/>
							</div>
							<div class="panel" id={OUTPUT_ANCHORS.share} data-testid="out-share" data-state={share}>
								{#if share === 'ok'}
									<ShareThePainBoard
										curtailment={summary.curtailment!}
										names={farmNames}
										period="Project window"
										headingLevel={3}
										tableHref={supplyHref(run.id, { hash: 'res-curtailment' })}
									/>
								{:else}
									<section class="share-stub" aria-labelledby="out-share-h">
										<h3 id="out-share-h">Share the pain</h3>
										<p class="muted" data-testid="out-share-empty">
											{#if share === 'none'}
												This run was made before curtailment targets existed, so there is nothing to share.
												{#if canEdit}<a href="?tab=runs">Run the model again</a> to see it.{:else}An editor can run the model again.{/if}
											{:else}
												This run has no hydrological units, so there is no demand to share. <a href="?tab=network">Add them on the Network</a>.
											{/if}
										</p>
									</section>
								{/if}
							</div>
							<div class="panel" id={OUTPUT_ANCHORS.matrix}>
								<OutcomeMatrixPanel
									{projectId}
									{run}
									hasNaturalFlow={shown.series.some((r) => r.nodeId === null && r.key === 'natural_flow')}
									outcomes={project.settings.outcomes}
									nodes={editor.model.nodes}
									ewrRules={project.settings.ewrRules}
									daily={summary.catchment.outletEwr}
									{onProjectChange}
									onview={(v) => (matrixShare = v)}
									bind:this={matrixPanel}
									{canEdit}
								/>
							</div>
							<div class="panel" id={OUTPUT_ANCHORS.outlook}>
								<OutlookPanel
									{projectId}
									{run}
									outlook={project.settings.outlook}
									{canEdit}
									droughtRestriction={project.settings.droughtRestriction ?? null}
									daily={summary.catchment.outletEwr}
									{onProjectChange}
								/>
							</div>
							<LicenceImpactOutput
								{projectId}
								run={shownMeta ?? run}
								outcomes={project.settings.outcomes}
								nodes={editor.model.nodes}
								ewrRules={project.settings.ewrRules}
							/>
						</div>
					{/key}
				{/if}
			</LoadState>
		</div>
	</SectionNav>
{/if}

<style>
	.empty {
		max-width: 44rem;
	}
	.empty h2 {
		margin-top: 0;
		font-size: 1.05rem;
	}
	/* One column of sections, each a card; they stack the same on a phone. */
	.sections {
		display: grid;
		gap: 1rem;
	}
	.sections > :global(.panel) {
		min-width: 0;
		margin: 0;
	}
	/* The page is the one scroll: no table scrolls in a box of its own (as on EWR). */
	.sections :global(div.table-wrap) {
		max-height: none;
	}
	.share-stub h3 {
		margin-top: 0;
	}
	.outputs[aria-busy='true'] {
		cursor: progress;
	}
	.sections[inert] {
		opacity: 0.55;
	}
	.run-pick select {
		max-width: min(34rem, 60vw);
		min-height: 36px;
	}
	@media (max-width: 640px) {
		.run-pick select {
			min-height: 44px;
		}
	}
</style>
