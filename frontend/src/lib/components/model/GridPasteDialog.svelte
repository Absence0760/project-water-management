<script lang="ts">
	// Paste a block from a spreadsheet into a model grid (issue #285): the node
	// table and the planted-areas grid. The block goes in the box (pasted into the
	// grid itself, typed here, or read from a CSV file), the preview lists every
	// value it would change, and Apply writes them into the editor, unsaved, like
	// typing them in. The grid's own file says what the columns mean
	// (network/nodePaste.ts, crops/areaPaste.ts). A grid that takes new rows
	// (crops, irrigation systems: `PastePlan.added`) says how many it adds, and
	// a grid given a `format` shows the shared Expected format note with its
	// example file (issue #477, common/FormatHelp.svelte). A grid whose paste
	// replaces a whole table (the EWR settings' TAB flows and percentile tables,
	// the Reserve rule tables: `wholeTable`) says only its own layout, and a
	// grid that can take the paste in more than one table puts the choice in
	// `target`, above the box (issue #521).
	import type { Snippet } from 'svelte';
	import FormatHelp from '#lib/components/common/FormatHelp.svelte';
	import PasteDialogFrame from './PasteDialogFrame.svelte';
	import { fmtNum } from '#lib/format/number.js';
	import { gridFileFormat, type GridFormat, type PastePlan } from '#lib/spreadsheet/paste/grid.js';

	let {
		open = $bindable(false),
		text = $bindable(''),
		title,
		layout,
		where = null,
		plan,
		onapply,
		csv,
		csvName,
		format = null,
		rowNoun = ['row', 'rows'],
		wholeTable = false,
		target
	}: {
		open?: boolean;
		/** The pasted block (set by the grid when the paste was into a cell). */
		text?: string;
		title: string;
		/** One line on the layout the box reads. */
		layout: string;
		/** The cell the block was pasted into, for a block without names or headings ("Upper farm, Area"). */
		where?: string | null;
		plan: (text: string) => PastePlan | { error: string };
		onapply: (plan: PastePlan) => void;
		/** The grid now, as a CSV to fill in. */
		csv: () => string;
		csvName: string;
		/** The Expected format note: the layout, an example and its file. */
		format?: GridFormat | null;
		/** What a new row is, for "Adds 2 crops" (singular, plural). */
		rowNoun?: readonly [string, string];
		/** The paste replaces a whole table: no blank-cell or start-cell rule, the layout line says how it is read. */
		wholeTable?: boolean;
		/** Which table the paste fills, when there is a choice (radios), above the box. */
		target?: Snippet;
	} = $props();

	const result = $derived(text.trim() ? plan(text) : null);
	const ok = $derived(result && !('error' in result) ? result : null);
	const count = $derived(ok?.changes.length ?? 0);
	const adds = $derived(ok?.added?.length ?? 0);
	// Built when the dialog opens, so it holds the grid as it is then (with a BOM, so Excel reads m³ and ² as UTF-8).
	const csvHref = $derived(open ? `data:text/csv;charset=utf-8,${encodeURIComponent('﻿' + csv())}` : '');

	const error = $derived(result && 'error' in result ? result.error : null);
	const summary = $derived(
		!result
			? 'Paste or load a block to see what it changes.'
			: error
				? error
				: `${[
						adds ? `Adds ${adds} ${rowNoun[adds === 1 ? 0 : 1]}` : '',
						count ? `${count} ${count === 1 ? 'value changes' : 'values change'}` : adds ? '' : 'Nothing changes',
						ok!.unchanged ? `${ok!.unchanged} already ${ok!.unchanged === 1 ? 'has' : 'have'} the pasted value` : ''
					]
						.filter(Boolean)
						.join('; ')}.`
	);

	const val = (v: number | null) => (v === null ? '–' : fmtNum(v, 4, true));
</script>

<PasteDialogFrame
	bind:open
	bind:text
	{title}
	textLabel="Cells copied from a spreadsheet"
	download={{ href: csvHref, name: csvName, label: 'Download the table as CSV' }}
	{summary}
	error={!!error}
	summaryTestid="paste-summary"
	tableLabel="Changes"
	showTable={count > 0}
	applyLabel={!count && adds ? `Add ${adds} ${rowNoun[adds === 1 ? 0 : 1]}` : `Apply ${count} ${count === 1 ? 'change' : 'changes'}`}
	canApply={!!ok && (count > 0 || adds > 0)}
	onapply={() => onapply(ok!)}
>
	{#snippet intro()}
		{#if wholeTable}
			<p class="small muted">{layout}</p>
		{:else}
			<p class="small muted">{layout} A blank cell or a dash leaves a value as it is. Commas in numbers are read as the block shows them: 12,5 as a decimal comma, 1,500,000 as thousands.</p>
		{/if}
		{#if format}<FormatHelp format={gridFileFormat(format)} context={title} />{/if}
		{#if !wholeTable}
			<p class="small" data-testid="paste-where">
				{#if where}Pasted into <strong>{where}</strong>: a block without names or headings starts there.{:else}A block without names or headings starts at the table's first row and column.{/if}
			</p>
		{/if}
		{#if target}{@render target()}{/if}
	{/snippet}
	{#snippet notes()}
		{#if ok?.notes.length}
			<ul class="small muted notes">
				{#each ok.notes as n (n)}<li>{n}</li>{/each}
			</ul>
		{/if}
	{/snippet}
	{#snippet table()}
		<table class="data compact">
			<thead>
				<tr><th scope="col">Row</th><th scope="col">Column</th><th scope="col" class="num">Now</th><th scope="col" class="num">Pasted</th></tr>
			</thead>
			<tbody>
				{#each ok!.changes as c (c.rowId + c.key)}
					<tr>
						<th scope="row">{c.rowName}</th>
						<td>{c.column} <span class="u">{c.unit}</span></td>
						<td class="num">{val(c.from)}</td>
						<td class="num"><strong>{val(c.to)}</strong></td>
					</tr>
				{/each}
			</tbody>
		</table>
	{/snippet}
</PasteDialogFrame>

<style>
	.notes {
		margin: 0.25rem 0 0.5rem;
		padding-left: 1.1rem;
	}
	.u {
		color: var(--text-muted);
		font-size: var(--font-xs);
	}
</style>
