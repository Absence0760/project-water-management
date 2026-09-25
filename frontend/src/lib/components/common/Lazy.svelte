<script lang="ts" generics="C">
	// Renders a code-split component: the standard loading state while its
	// chunk downloads, an error with "Try again" if the download fails, then
	// children(Component). A chunk already loaded renders at once.
	import type { Snippet } from 'svelte';
	import LoadState from './LoadState.svelte';
	import { loadOnce, peek, type Loader } from './lazy';

	let { load, children }: { load: Loader<C>; children: Snippet<[C]> } = $props();

	let comp = $state.raw<C | undefined>();
	let error = $state<string | null>(null);

	function start(l: Loader<C>) {
		comp = peek(l);
		error = null;
		if (comp !== undefined) return;
		loadOnce(l).then(
			(c) => {
				if (l === load) comp = c;
			},
			() => {
				if (l === load) error = 'This part of the page could not be loaded. Check your connection and try again.';
			}
		);
	}

	$effect.pre(() => {
		start(load);
	});
</script>

<LoadState loading={comp === undefined && !error} {error} retry={() => start(load)}>
	{#if comp !== undefined}{@render children(comp)}{/if}
</LoadState>
