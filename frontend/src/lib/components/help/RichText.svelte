<script lang="ts">
	// Guide text with its small markup (**label**, *stress*, [[glossary-id]],
	// [[guide:id|label]]) rendered as bold, italics and links, via inline() in
	// $lib/help/guides. Never {@html}.
	import { resolve } from '$app/paths';
	import { basePath } from '#lib/nav/base.js';
	import { helpFor } from '#lib/help/content.js';
	import { glossaryPath } from '#lib/help/glossaryLinks.js';
	import { inline } from '#lib/help/guides.js';

	let { text }: { text: string } = $props();
</script>

{#each inline(text) as part, i (i)}{#if part.kind === 'strong'}<strong>{part.text}</strong
		>{:else if part.kind === 'em'}<em>{part.text}</em
		>{:else if part.kind === 'term'}<a href="{basePath()}{glossaryPath(helpFor(part.id)!)}">{part.text}</a
		>{:else if part.kind === 'guide'}<a href={resolve(`help/guides/${part.id}`)}>{part.text}</a
		>{:else}{part.text}{/if}{/each}
