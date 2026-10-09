<script lang="ts">
	// "Expected format" beside a file or paste box (issue #456; docs/ui.md §
	// Expected format): a closed disclosure with the file types the box takes,
	// the structure and units as the caller's own list (the words must match
	// what that box's parser accepts, so they stay with the caller), a short
	// example and, when it helps, the example as a file to download (built
	// here from its text, ./formatHelp.ts). One per box; the series upload,
	// the allocations import, the farmer invite, the GeoJSON upload, Load crop
	// factors and the project import use it.
	import type { Snippet } from 'svelte';
	import { exampleHref, type ExampleFile } from './formatHelp';

	let {
		accepts,
		example = '',
		exampleFile = null,
		summary = 'Expected format',
		children
	}: {
		/** The file types (and limits) the box takes, as a sentence: "CSV (.csv), at most 2 MB." */
		accepts: string;
		/** A few lines of a valid file, shown as they would be typed. */
		example?: string;
		/** The example as a file to download (a fuller one than `example`, or the same). */
		exampleFile?: ExampleFile | null;
		summary?: string;
		/** The structure: columns, units, what is read as a gap, what is refused. */
		children?: Snippet;
	} = $props();

	const exampleUrl = $derived(exampleFile ? exampleHref(exampleFile) : '');
</script>

<details class="format-help" data-testid="format-help">
	<summary>{summary}</summary>
	<div class="body">
		<p class="accepts" data-testid="format-accepts">{accepts}</p>
		{#if children}{@render children()}{/if}
		{#if example}
			<p class="ex-h">Example</p>
			<pre class="mono" data-testid="format-example">{example}</pre>
		{/if}
		{#if exampleFile}
			<p><a class="btn btn-sm" href={exampleUrl} download={exampleFile.name} data-testid="format-example-file">Download an example file</a></p>
		{/if}
	</div>
</details>

<style>
	.format-help {
		margin-bottom: 0.75rem;
		font-size: 0.85rem;
	}
	summary {
		cursor: pointer;
		font-weight: 600;
		color: var(--accent);
		min-height: 32px;
		/* As wide as its words, so its focus ring hugs them (it takes focus first in the Add data dialog). */
		width: fit-content;
		display: flex;
		align-items: center;
	}
	.body {
		display: grid;
		gap: 0.4rem;
		color: var(--text-2);
	}
	.body p {
		margin: 0;
	}
	.accepts {
		color: var(--text);
	}
	.ex-h {
		font-weight: 600;
		color: var(--text);
	}
	pre {
		background: var(--surface-2);
		color: var(--text);
		padding: 0.5rem 0.75rem;
		border-radius: var(--radius-sm);
		margin: 0;
		/* Wrapped, not scrolled: a long example line never makes the sheet scroll sideways. */
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
	.body :global(ul) {
		margin: 0;
		padding-left: 1.1rem;
	}
	.body :global(li + li) {
		margin-top: 0.15rem;
	}
</style>
