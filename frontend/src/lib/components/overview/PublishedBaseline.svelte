<!--
	Overview → the published baseline (WP-2.3, docs/ui.md § Overview): which
	run stakeholders and farmers see, when and by whom it was published, the
	WUA's notice and the next expected update. Read-only for everyone; an
	editor changes the notice or publishes another run in the Runs tab's
	Publication panel, which this card links to (one notice editor, not two).
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import { api, type Publication, type RunMeta } from '$lib/api';
	import LoadState from '$lib/components/common/LoadState.svelte';
	import { restrictionSummary } from '$lib/components/runs/publication';
	import { fmtDate, fmtDay } from '$lib/format/number';
	import { runHref } from './attention';

	let {
		projectId,
		runs,
		canEdit
	}: {
		projectId: string;
		/** The page's runs list, for the published run's label and period (null if it couldn't be loaded). */
		runs: RunMeta[] | null;
		canEdit: boolean;
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

	const run = $derived(current ? (runs?.find((r) => r.id === current!.runId) ?? null) : null);
	// The Runs tab on the published run, at its Publication panel.
	const panelHref = $derived(current ? `${runHref(current.runId)}#res-publication` : '?tab=runs');
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
				{#if current.restriction.noticeEn}<dt>English</dt><dd class="text">{current.restriction.noticeEn}</dd>{/if}
				{#if current.restriction.noticeAf}<dt>Afrikaans</dt><dd class="text">{current.restriction.noticeAf}</dd>{/if}
				<dt>Next update</dt>
				<dd>{current.nextExpectedOn ? fmtDay(current.nextExpectedOn) : 'Not set'}</dd>
			</dl>
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
	.baseline {
		margin: 0 0 1rem;
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
</style>
