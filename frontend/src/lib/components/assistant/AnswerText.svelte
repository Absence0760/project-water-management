<!--
	An assistant answer as the sheet shows it (issue #610, docs/ui.md § Assistant):
	answerText.ts parses the text into paragraphs, lists, bold lines and
	preformatted blocks, and every string in that tree renders here as a text
	node, escaped by Svelte. Never {@html}, never a link. `streaming` while the
	answer is still arriving (answerText.ts parseAnswer).
-->
<script lang="ts">
	import { parseAnswer, type Inline } from './answerText';

	let { text, streaming = false }: { text: string; streaming?: boolean } = $props();

	const blocks = $derived(parseAnswer(text, streaming));
</script>

{#snippet inline(parts: Inline[])}{#each parts as part, i (i)}{#if part.kind === 'strong'}<strong>{part.text}</strong
		>{:else if part.kind === 'em'}<em>{part.text}</em
		>{:else if part.kind === 'code'}<code>{part.text}</code
		>{:else}{part.text}{/if}{/each}{/snippet}

<div class="answer-text" data-testid="assistant-text">
	{#each blocks as block, k (k)}
		{#if block.kind === 'p'}
			<p>{#each block.lines as line, j (j)}{#if j > 0}<br />{/if}{@render inline(line)}{/each}</p>
		{:else if block.kind === 'heading'}
			<p class="heading"><strong>{@render inline(block.parts)}</strong></p>
		{:else if block.kind === 'ul'}
			<ul>
				{#each block.items as item, j (j)}<li>{@render inline(item)}</li>{/each}
			</ul>
		{:else if block.kind === 'ol'}
			<ol start={block.start}>
				{#each block.items as item, j (j)}<li>{@render inline(item)}</li>{/each}
			</ol>
		{:else}
			<pre>{block.text}</pre>
		{/if}
	{/each}
</div>

<style>
	.answer-text {
		line-height: 1.55;
	}
	.answer-text > :first-child {
		margin-top: 0;
	}
	.answer-text > :last-child {
		margin-bottom: 0;
	}
	p,
	ul,
	ol,
	pre {
		margin: 0 0 0.6rem;
	}
	ul,
	ol {
		padding-left: 1.25rem;
	}
	li + li {
		margin-top: 0.2rem;
	}
	.heading {
		margin-top: 0.8rem;
	}
	code,
	pre {
		font-family: var(--font-mono);
		font-size: 0.92em;
	}
	pre {
		white-space: pre-wrap;
		overflow-wrap: anywhere;
		padding: 0.5rem 0.6rem;
		border-radius: var(--radius);
		background: var(--surface-2);
	}
</style>
