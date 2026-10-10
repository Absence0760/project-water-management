<script lang="ts">
	// The body of an Expected format (./formatHelp.ts FileFormat, issue #477):
	// what the box takes, the structure as a list, a short example and the
	// example files to download (built here from their text, so nothing is
	// fetched). FormatHelp shows it in a disclosure beside the box; the File
	// formats help page (routes/help/formats) shows every one, open, from the
	// same objects.
	import FormatText from './FormatText.svelte';
	import { exampleHref, type ExampleFile, type FileFormat } from './formatHelp';

	let { format, extraFiles = [] }: { format: FileFormat; /** The caller's own example files, after the format's. */ extraFiles?: readonly ExampleFile[] } = $props();

	const files = $derived([...(format.files ?? []), ...extraFiles]);
</script>

<div class="format-body">
	<p class="accepts" data-testid="format-accepts">{format.accepts}</p>
	{#if format.lead}<p><FormatText text={format.lead} /></p>{/if}
	{#if format.rules.length}
		<ul>
			{#each format.rules as r (r)}<li><FormatText text={r} /></li>{/each}
		</ul>
	{/if}
	{#if format.after}<p><FormatText text={format.after} /></p>{/if}
	{#if format.example}
		<p class="ex-h">Example</p>
		<pre class="mono" data-testid="format-example">{format.example}</pre>
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

<style>
	.format-body {
		display: grid;
		gap: 0.4rem;
		color: var(--text-2);
	}
	.format-body p {
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
	ul {
		margin: 0;
		padding-left: 1.1rem;
	}
	li + li {
		margin-top: 0.15rem;
	}
	code {
		font-family: var(--font-mono);
		font-size: 0.95em;
	}
</style>
