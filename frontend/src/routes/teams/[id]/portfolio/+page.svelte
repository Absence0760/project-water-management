<script lang="ts">
	// The team portfolio moved into the project list as its team filter (issue
	// #176, docs/ui.md § Project list): an old link (a bookmark, an email, the
	// help) lands there, with its sort and direction, in place of this address.
	// The list itself sends a farmer to their farm and says so when the team
	// isn't yours.
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { base } from '$app/paths';
	import { page } from '$app/state';
	import { portfolioListHref } from '$lib/components/projects/grouping';

	onMount(() => {
		const q = page.url.searchParams;
		void goto(`${base}/${portfolioListHref(page.params.id ?? '', q.get('sort'), q.get('dir'))}`, { replaceState: true });
	});
</script>

<svelte:head><title>Projects · Water Management</title></svelte:head>

<main class="page"><p class="muted">Opening the team's projects…</p></main>
