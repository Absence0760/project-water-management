<script lang="ts">
	// The Applicant view (WP-3.3, docs/ui.md § Applications): what the
	// workspace shows a contributor (a licence applicant or their consultant)
	// instead of its tabs, which all refuse them. One section header, as every
	// workspace section has (issue #17): the catchment, when the baseline was
	// published and their own farms (links to the farm view, as a farmer sees
	// it) on its context line, New application as its action, and a slim
	// notice; under it their applications (the Scenarios tab in applicant
	// mode). Nothing unpublished, no other farm's inputs, no other applicant's
	// drafts: the API enforces all three.
	import { untrack } from 'svelte';
	import { base } from '$app/paths';
	import { page } from '$app/state';
	import { api, type ProjectSummary, type Publication } from '$lib/api';
	import LoadState from '$lib/components/common/LoadState.svelte';
	import SectionHeader from '$lib/components/workspace/SectionHeader.svelte';
	import { withParam } from '$lib/workspace/overlays';
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

{#snippet context()}
	<span data-testid="applicant-project">{project.name}</span>
	{#if publication}
		<span aria-hidden="true">·</span>
		<span data-testid="applicant-baseline">Baseline published <strong>{fmtDate(publication.publishedAt, true)}</strong>{publication.publishedBy ? ` by ${publication.publishedBy}` : ''}</span>
	{/if}
	{#if farms.length}
		<span aria-hidden="true">·</span>
		<span class="yours">
			Your hydrological unit{farms.length === 1 ? '' : 's'}:
			{#each farms as f, i (f.nodeId)}{i ? ', ' : ''}<a href="{base}/farm/{encodeURIComponent(project.id)}?node={encodeURIComponent(f.nodeId)}">{f.name}</a>{/each}
		</span>
	{/if}
{/snippet}
{#snippet badge()}<span class="badge" data-testid="applicant-view">Applicant view</span>{/snippet}
{#snippet actions()}
	{#if publication}<a class="btn btn-primary" href={withParam(page.url, 'new', '1')}>New application</a>{/if}
{/snippet}
{#snippet notices()}
	<!-- Nothing published: the list says so ("Nothing is published yet…"). -->
	{#if publication}
		<p class="note" role="note">
			Your applications start on the published baseline. You see your own hydrological units in full and every other hydrological unit only by an anonymous name.
		</p>
	{/if}
{/snippet}

<SectionHeader title="Applications" {badge} {context} {actions} {notices} />

<LoadState {loading} {error} retry={load}>
	<ScenariosTab projectId={project.id} runs={null} canEdit={false} applicant publishedRunId={publication?.runId ?? null} onRunsChange={() => {}} reloadRuns={async () => {}} />
</LoadState>

<style>
	/* Links inside a line of text are underlined, not told apart by colour alone (WCAG 1.4.1, as app.css does for p a). */
	.yours a {
		text-decoration: underline;
	}
	/* The header's one slim notice line, as the workspace's (routes/projects/[id] .note). */
	.note {
		margin: 0;
		align-self: flex-start;
		padding: 0.2rem 0.6rem;
		border-left: 3px solid var(--accent);
		border-radius: var(--radius-sm);
		background: var(--surface);
		color: var(--text-2);
		font-size: 0.85rem;
	}
</style>
