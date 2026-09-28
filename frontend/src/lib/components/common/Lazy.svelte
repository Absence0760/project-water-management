<script lang="ts" generics="C">
	// Renders a code-split component: the standard loading state while its
	// chunk downloads, then children(Component). A chunk already loaded renders
	// at once. A failed download says so and offers a reload (ChunkFailed):
	// the browser remembers the failed fetch, so re-running the import can't
	// recover (lazy.ts).
	import type { Snippet } from 'svelte';
	import ChunkFailed from './ChunkFailed.svelte';
	import LoadState from './LoadState.svelte';
	import { loadOnce, peek, type Loader } from './lazy';

	let { load, children }: { load: Loader<C>; children: Snippet<[C]> } = $props();

	let comp = $state.raw<C | undefined>();
	let failed = $state(false);

	function start(l: Loader<C>) {
		comp = peek(l);
		failed = false;
		if (comp !== undefined) return;
		loadOnce(l).then(
			(c) => {
				if (l === load) comp = c;
			},
			() => {
				if (l === load) failed = true;
			}
		);
	}

	$effect.pre(() => {
		start(load);
	});
</script>

{#if failed}
	<ChunkFailed />
{:else}
	<LoadState loading={comp === undefined}>
		{#if comp !== undefined}{@render children(comp)}{/if}
	</LoadState>
{/if}
