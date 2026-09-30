<!--
	Overview → the published baseline (WP-2.3, docs/ui.md § Overview): which
	run stakeholders and farmers see, when and by whom it was published, the
	WUA's notice and the next expected update. Read-only for everyone; an
	editor changes the notice or publishes another run in the Runs tab's
	Publication panel, which this card links to (one notice editor, not two).
	A newer automatic run (WP-2.11) asks the editor "New auto run: publish?",
	with the comparison against the published run.
-->
<script lang="ts">
	import { compareTabHref } from '$lib/components/compare/picker';
	import { onMount } from 'svelte';
	import { autoRunToPublish } from '$lib/components/autorun/autoRun';
	import { api, type Publication, type RunMeta } from '$lib/api';
	import LoadState from '$lib/components/common/LoadState.svelte';
	import { noticeLanguages, restrictionSummary } from '$lib/components/runs/publication';
	import { fmtDate, fmtDay } from '$lib/format/number';
	import { runHref } from './attention';

	let {
		projectId,
		runs,
		canEdit,
		ready = $bindable(false)
	}: {
		projectId: string;
		/** The page's runs list, for the published run's label and period (null if it couldn't be loaded). */
		runs: RunMeta[] | null;
		canEdit: boolean;
		/** True once the publication has loaded or failed (the card has its final height); for the Summary's data-ready. */
		ready?: boolean;
	} = $props();

	let current = $state<Publication | null>(null);
	let loading = $state(true);
	let error = $state<string | null>(null);

	async function load() {
		loading = true;
		error = null;
		try {
			current = (await api.publication.get(projectId)).current;
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			loading = false;
		}
	}
	onMount(load);
	$effect(() => {
		ready = !loading;
	});

	const run = $derived(current ? (runs?.find((r) => r.id === current!.runId) ?? null) : null);
	// The Runs tab on the published run, at its Publication panel.
	const panelHref = $derived(current ? `${runHref(current.runId)}#res-publication` : '?tab=runs');
	// Publication stays a person's act (D5): a newer auto run is offered, never published here.
	const autoRun = $derived(canEdit && current ? autoRunToPublish(runs, current.runId) : null);
	const compareHref = $derived(
		autoRun && current ? compareTabHref({ projectId, runId: current.runId }, { projectId, runId: autoRun.id }) : ''
	);
</script>

<section class="panel baseline" aria-labelledby="baseline-h" aria-busy={loading}>
	<div class="panel-head">
		<h2 id="baseline-h">Published baseline</h2>
		{#if current}<a href={runHref(current.runId)}>Open in Runs</a>{/if}
	</div>
	<LoadState {loading} {error} retry={load}>
		{#if current}
			<dl class="facts">
				<dt>Run</dt>
				<dd>
					<a href={runHref(current.runId)}>{run ? run.label || 'Untitled run' : 'The published run'}</a>
					{#if run}<span class="muted">· {fmtDay(run.startDate)} – {fmtDay(run.endDate)}</span>{/if}
				</dd>
				<dt>Published</dt>
				<dd>{fmtDate(current.publishedAt, true)}{current.publishedBy ? ` by ${current.publishedBy}` : ''}</dd>
				<dt>Notice</dt>
				<dd>{restrictionSummary(current.restriction)}</dd>
				{#each noticeLanguages(current.restriction.notice) as n (n.code)}<dt>{n.name}</dt><dd class="text" lang={n.code}>{n.text}</dd>{/each}
				<dt>Next update</dt>
				<dd>{current.nextExpectedOn ? fmtDay(current.nextExpectedOn) : 'Not set'}</dd>
			</dl>
			{#if autoRun}
				<div class="alert alert-info auto" role="status" data-testid="auto-publish-offer">
					<span><strong>New auto run: publish?</strong> “{autoRun.label || 'Auto'}” is newer than the published run.</span>
					<a href={compareHref}>Compare with the published run</a>
					<a href="{runHref(autoRun.id)}#res-publication">Review and publish</a>
				</div>
			{/if}
			{#if canEdit}
				<p class="small"><a href={panelHref}>Change the notice or publish another run</a> in the Runs tab.</p>
			{/if}
		{:else}
			<p class="muted">
				No run is published yet. Stakeholders and farmers see nothing until you publish one ({#if canEdit}<a href="?tab=runs">Runs tab</a>{:else}Runs tab{/if}).
			</p>
		{/if}
	</LoadState>
</section>

<style>
	/* No margin of its own: the Summary's grids space it (OverviewTab). */
	.baseline {
		margin: 0;
	}
	.facts {
		display: grid;
		grid-template-columns: max-content minmax(0, 1fr);
		gap: 0.25rem 1rem;
		margin: 0 0 0.5rem;
		max-width: 90ch;
	}
	.facts dt {
		color: var(--text-muted);
	}
	.facts dd {
		margin: 0;
		min-width: 0;
	}
	.text {
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
	.small {
		font-size: 0.85rem;
		margin: 0;
	}
	.auto {
		display: flex;
		flex-wrap: wrap;
		gap: 0.25rem 1rem;
		align-items: baseline;
		margin: 0 0 0.5rem;
	}
</style>
