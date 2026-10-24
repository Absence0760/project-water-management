<!--
	The frame every paste dialog shares (issue #521): the notes on the layout above the box, the box for cells
	copied from a spreadsheet, Load a CSV file and a download beside it, the Preview with its one status line
	(muted while empty, an error in red) and its table, and Cancel / the apply action at the foot. Apply runs
	`onapply` and then empties the box and closes. The callers say only what is theirs: GridPasteDialog (a
	grid of numbers: the values that change) and EwrHighFlowsEditor (a list of rows: the rows it reads).
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import Dialog from '#lib/components/common/Dialog.svelte';
	import { latestFileText } from '#lib/files/latest.js';

	let {
		open = $bindable(false),
		text = $bindable(''),
		title,
		textLabel,
		describedby,
		download,
		summary,
		error = false,
		summaryTestid,
		tableLabel,
		showTable,
		applyLabel,
		canApply,
		onapply,
		intro,
		notes,
		table
	}: {
		open?: boolean;
		/** What is in the box. */
		text?: string;
		title: string;
		/** The box's label: "Cells copied from a spreadsheet". */
		textLabel: string;
		/** An id in `intro` that describes the box (its layout line). */
		describedby?: string;
		/** The link beside Load a CSV file: the table now, or an example. */
		download: { href: string; name: string; label: string };
		/** The Preview's status line: what the paste does, its error, or what to do first. */
		summary: string;
		/** The summary is an error. */
		error?: boolean;
		summaryTestid: string;
		/** The preview table's region name. */
		tableLabel: string;
		/** There is a preview table to show (`table`). */
		showTable: boolean;
		applyLabel: string;
		canApply: boolean;
		onapply: () => void;
		/** Above the box: the layout line and anything the caller adds. */
		intro: Snippet;
		/** Under the status line, before the table. */
		notes?: Snippet;
		/** The preview table, drawn while `showTable`. */
		table: Snippet;
	} = $props();

	const uid = $props.id();
	let fileNote = $state('');

	// The latest file only: a large file still read can't land over one picked after it, or in a closed dialog.
	const fileText = latestFileText();
	$effect(() => {
		if (!open) void fileText(null);
	});

	async function loadFile(e: Event & { currentTarget: HTMLInputElement }) {
		const f = e.currentTarget.files?.[0];
		e.currentTarget.value = '';
		if (!f) return;
		const read = await fileText(f);
		if (read === null) return;
		text = read;
		fileNote = `Read ${f.name}.`;
	}

	function apply() {
		if (!canApply) return;
		onapply();
		text = '';
		fileNote = '';
		open = false;
	}
</script>

<Dialog bind:open {title} wide>
	<div class="paste">
		{@render intro()}
		<label for="{uid}-text">{textLabel}</label>
		<textarea id="{uid}-text" rows="6" spellcheck="false" bind:value={text} oninput={() => (fileNote = '')} aria-describedby={describedby}></textarea>
		<div class="row">
			<label class="btn btn-sm file">
				Load a CSV file
				<input type="file" accept=".csv,.tsv,.txt,text/csv,text/plain" onchange={loadFile} />
			</label>
			<a class="btn btn-sm" href={download.href} download={download.name}>{download.label}</a>
			<span class="small muted" role="status">{fileNote}</span>
		</div>
	</div>

	<section class="preview" aria-labelledby="{uid}-pv">
		<h3 id="{uid}-pv">Preview</h3>
		<!-- One status line that stays in the page, its text changing, so a screen reader reads each new result. -->
		<p class="small" class:alert={error} class:alert-error={error} class:muted={!text.trim()} role="status" data-testid={summaryTestid}>{summary}</p>
		{@render notes?.()}
		{#if showTable}
			<!-- Focusable, so the list scrolls from the keyboard too (axe scrollable-region-focusable). -->
			<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
			<div class="table-wrap" role="region" aria-label={tableLabel} tabindex="0">{@render table()}</div>
		{/if}
	</section>

	{#snippet actions()}
		<button type="button" class="btn" onclick={() => (open = false)}>Cancel</button>
		<button type="button" class="btn btn-primary" disabled={!canApply} onclick={apply}>{applyLabel}</button>
	{/snippet}
</Dialog>

<style>
	.paste {
		display: grid;
		gap: 0.4rem;
	}
	.paste > :global(p) {
		margin: 0;
	}
	/* The box's label in a field label's weight (the high-flows dialog's; the grid dialog's was unstyled). */
	.paste > label {
		font-weight: 500;
		font-size: 0.85rem;
	}
	.paste textarea {
		width: 100%;
		font-family: var(--font-mono);
		font-size: 0.85rem;
	}
	.row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem;
	}
	.preview {
		margin-top: 1rem;
	}
	.preview h3 {
		margin: 0 0 0.4rem;
		font-size: 0.9375rem;
	}
	.table-wrap {
		max-height: 18rem;
		overflow: auto;
	}
</style>
