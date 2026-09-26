<script lang="ts">
	import type { Rich } from './rich';

	let { text }: { text: Rich } = $props();
</script>

{#each text as part, i (i)}{#if typeof part === 'string'}{part}{:else}<strong>{part.b}</strong>{/if}{/each}
