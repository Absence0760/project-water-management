<script lang="ts">
	// A line of format text (./formatHelp.ts FileFormat) with its markup:
	// `code` in a monospace face, **bold**, *italics*. Never {@html}.
	import { formatInline } from './formatHelp';

	let { text }: { text: string } = $props();
</script>

{#each formatInline(text) as p, i (i)}{#if p.kind === 'code'}<code>{p.text}</code>{:else if p.kind === 'strong'}<strong>{p.text}</strong>{:else if p.kind === 'em'}<em>{p.text}</em>{:else}{p.text}{/if}{/each}
