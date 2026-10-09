<script lang="ts">
	// "Expected format" beside a file or paste box (issue #456; docs/ui.md §
	// Expected format): a closed disclosure with the file types the box takes,
	// the structure and units as the caller's own list (the words must match
	// what that box's parser accepts, so they stay with the caller), a short
	// example and, when it helps, the example as a file to download (built
	// here from its text, ./formatHelp.ts), or several (`exampleFiles`, each
	// with its own words). One per box; the series upload, the allocations
	// import, the farmer invite, the GeoJSON upload, Load crop factors, the
	// project import and the Reserve's DRM uploads (settings/DrmFormatHelp)
	// use it.
	import type { Snippet } from 'svelte';
	import { exampleHref, type ExampleFile } from './formatHelp';

	let {
		accepts,
		example = '',
		exampleFile = null,
		exampleFiles = [],
		summary = 'Expected format',
		context = '',
		children
	}: {
		/** The file types (and limits) the box takes, as a sentence: "CSV (.csv), at most 2 MB." */
		accepts: string;
		/** A few lines of a valid file, shown as they would be typed. */
		example?: string;
		/** The example as a file to download (a fuller one than `example`, or the same). */
		exampleFile?: ExampleFile | null;
		/** Several example files, each link worded by its `label`. */
		exampleFiles?: readonly ExampleFile[];
		summary?: string;
		/** Read after the summary by a screen reader only, so two notes on one page differ ("for the rule table at Outlet"). */
		context?: string;
		/** The structure: columns, units, what is read as a gap, what is refused. */
		children?: Snippet;
	} = $props();

	const files = $derived(exampleFile ? [exampleFile, ...exampleFiles] : exampleFiles);
</script>

<details class="format-help" data-testid="format-help">
	<summary>{summary}{#if context}<span class="visually-hidden">{` ${context}`}</span>{/if}</summary>
	<div class="body">
		<p class="accepts" data-testid="format-accepts">{accepts}</p>
		{#if children}{@render children()}{/if}
		{#if example}
			<p class="ex-h">Example</p>
			<pre class="mono" data-testid="format-example">{example}</pre>
		{/if}
		{#if files.length}
			<p class="files">
				{#each files as f (f.name)}
					{@const exampleUrl = exampleHref(f)}
					<a class="btn btn-sm" href={exampleUrl} download={f.name} data-testid="format-example-file">{f.label ?? 'Download an example file'}</a>
				{/each}
			</p>
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
	.files {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
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
