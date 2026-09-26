<script lang="ts">
	// Compare two runs — same project or two projects you can see.
	// URL: /compare?a=<projectId>:<runId>&b=<projectId>:<runId>, or
	// /compare?project=<id> to open on that project's latest run against its
	// published baseline (or, with none, the previous run). The workspace's
	// Compare runs tab shows the same view (CompareView) inside a project.
	import { base } from '$app/paths';
	import { page } from '$app/state';
	import CompareView from '$lib/components/compare/CompareView.svelte';
	import { compareSearch } from '$lib/components/compare/picker';

	const projectParam = $derived(page.url.searchParams.get('project'));
	let projectA = $state<string | null>(null);
</script>

<svelte:head><title>Compare runs · Water Management</title></svelte:head>

<main class="page">
	<div class="head">
		<h1>Compare runs</h1>
		{#if projectA}<a href="{base}/projects/{projectA}?tab=runs">Back to runs</a>{/if}
	</div>
	<CompareView
		a={page.url.searchParams.get('a')}
		b={page.url.searchParams.get('b')}
		project={projectParam}
		hrefFor={(a, b) => `${base}/compare${compareSearch(a, b, projectParam)}`}
		bind:projectA
	/>
</main>

<style>
	.head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 1rem;
		flex-wrap: wrap;
	}
</style>
