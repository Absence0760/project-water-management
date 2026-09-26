<script lang="ts">
	// Compare runs — a baseline and up to two what-ifs, same project or
	// projects you can see. URL: /compare?a=<projectId>:<runId>&b=…[&c=…]
	// (a = baseline, b = what-if 1, c = the optional what-if 2), or
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
	<CompareView
		a={page.url.searchParams.get('a')}
		b={page.url.searchParams.get('b')}
		c={page.url.searchParams.get('c')}
		project={projectParam}
		level={1}
		hrefFor={(a, b, c) => `${base}/compare${compareSearch(a, b, projectParam, c)}`}
		bind:projectA
	>
		{#snippet actions()}
			{#if projectA}<a href="{base}/projects/{projectA}?tab=runs">Back to runs</a>{/if}
		{/snippet}
	</CompareView>
</main>
