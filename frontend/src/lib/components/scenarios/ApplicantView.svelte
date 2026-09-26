<script lang="ts">
	// The Applicant view (WP-3.3, docs/ui.md § Applications): what the
	// workspace shows a contributor (a licence applicant or their consultant)
	// instead of its tabs, which all refuse them. The published baseline (its
	// date and the WUA's notice), their own farms if they have links (the farm
	// view, as a farmer sees it), and their applications (the Scenarios tab in
	// applicant mode). Nothing unpublished, no other farm's inputs, no other
	// applicant's drafts: the API enforces all three.
	import { untrack } from 'svelte';
	import { base } from '$app/paths';
	import { api, type ProjectSummary, type Publication } from '$lib/api';
	import LoadState from '$lib/components/common/LoadState.svelte';
	import { fmtDate } from '$lib/format/number';
	import ScenariosTab from './ScenariosTab.svelte';

	let { project }: { project: ProjectSummary } = $props();

	let publication = $state<Publication | null>(null);
	let farms = $state<{ nodeId: string; name: string }[]>([]);
	let loading = $state(true);
	let error = $state<string | null>(null);

	async function load() {
		loading = true;
		error = null;
		try {
			const [pub, farm] = await Promise.all([api.publication.get(project.id), api.farm.index(project.id).catch(() => null)]);
			publication = pub.current;
			farms = farm?.farms ?? [];
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			loading = false;
		}
	}
	$effect(() => {
		void project.id;
		untrack(load);
	});
</script>

<div class="head">
	<nav class="crumbs" aria-label="Breadcrumb"><a href="{base}/">Projects</a> <span aria-hidden="true">/</span></nav>
	<h1>{project.name}</h1>
	<span class="badge" data-testid="applicant-view">Applicant view</span>
</div>

<LoadState {loading} {error} retry={load}>
	<section class="panel intro" aria-labelledby="baseline-h">
		<h2 id="baseline-h">The published baseline</h2>
		{#if publication}
			<p>
				Your applications start on the baseline the assessors published on <strong>{fmtDate(publication.publishedAt, true)}</strong>{publication.publishedBy
					? ` (${publication.publishedBy})`
					: ''}. You see your own farms in full and every other farm only by an anonymous name.
			</p>
		{:else}
			<p>Nothing is published yet. You can start an application once the assessors publish a baseline.</p>
		{/if}
		{#if farms.length}
			<p>
				Your farm{farms.length === 1 ? '' : 's'}:
				{#each farms as f, i (f.nodeId)}{i ? ', ' : ''}<a href="{base}/farm/{encodeURIComponent(project.id)}?node={encodeURIComponent(f.nodeId)}">{f.name}</a>{/each}.
			</p>
		{/if}
	</section>

	<ScenariosTab projectId={project.id} runs={null} canEdit={false} applicant publishedRunId={publication?.runId ?? null} onRunsChange={() => {}} />
</LoadState>

<style>
	.head {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		flex-wrap: wrap;
		margin-bottom: 0.75rem;
	}
	.head h1 {
		margin: 0;
		min-width: 0;
		overflow-wrap: anywhere;
	}
	.intro {
		margin-bottom: 1rem;
	}
	.intro h2 {
		margin: 0 0 0.4rem;
		font-size: 1.05rem;
	}
	.intro p {
		margin: 0 0 0.4rem;
		max-width: 75ch;
	}
</style>
