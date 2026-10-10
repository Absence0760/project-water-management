<script lang="ts">
	// "Expected format" beside a file or paste box (issue #456; docs/ui.md §
	// Expected format): a closed disclosure with the box's FileFormat
	// (./formatHelp.ts), the same object the File formats help page
	// (/help/formats, issue #477) shows, so the two can't differ, and a link
	// to that page, which gathers every box's format with its example files.
	// The format is kept beside the box's parser (its tests read the example
	// back through it) and listed in $lib/help/fileFormats.ts; a guard
	// (fileFormats.test.ts) keeps every FormatHelp on one listed there.
	import { base } from '$app/paths';
	import FormatBody from './FormatBody.svelte';
	import { formatPath, type ExampleFile, type FileFormat } from './formatHelp';

	let {
		format,
		extraFiles = [],
		summary = 'Expected format',
		context = ''
	}: {
		format: FileFormat;
		/** The caller's own example files (built from its data), after the format's. */
		extraFiles?: readonly ExampleFile[];
		summary?: string;
		/** Read after the summary by a screen reader only, so two notes on one page differ ("for the rule table at Outlet"). */
		context?: string;
	} = $props();
</script>

<details class="format-help" data-testid="format-help">
	<summary>{summary}{#if context}<span class="visually-hidden">{` ${context}`}</span>{/if}</summary>
	<div class="body">
		<FormatBody {format} {extraFiles} />
		<p class="all small">
			<a href="{base}{formatPath(format.id)}" target="_blank" rel="noopener" data-testid="format-all-link">Every file format, with example files<span class="visually-hidden"> (opens in a new tab)</span></a>
		</p>
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
	}
	.all {
		margin: 0;
	}
</style>
