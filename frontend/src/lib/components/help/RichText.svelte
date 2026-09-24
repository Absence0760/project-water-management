<script lang="ts">
	// Guide text with its small markup (**label**, [[glossary-id]],
	// [[guide:id|label]]) rendered as bold text and links, via inline() in
	// $lib/help/guides. Never {@html}.
	import { base } from '$app/paths';
	import { inline } from '$lib/help/guides';

	let { text }: { text: string } = $props();
</script>

{#each inline(text) as part, i (i)}{#if part.kind === 'strong'}<strong>{part.text}</strong
		>{:else if part.kind === 'term'}<a href="{base}/help/glossary#{part.id}">{part.text}</a
		>{:else if part.kind === 'guide'}<a href="{base}/help/guides/{part.id}">{part.text}</a
		>{:else}{part.text}{/if}{/each}
