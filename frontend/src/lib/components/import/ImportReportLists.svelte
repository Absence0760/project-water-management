<script lang="ts">
	// The importer's notes (with their severity) and the unmapped report
	// (plan.md 1b: what couldn't be carried across as the workbook meant, with
	// sheet, cell and element). Shared by the import review (WorkbookReview)
	// and the Project page's import record (project/ImportReportPanel), so what a
	// reviewer reads later is what the importer showed. Everything here comes
	// from the file (farm names, formula text), so it is rendered as text only:
	// plain interpolation, never {@html}.
	import HelpTip from '$lib/components/help/HelpTip.svelte';
	import type { ImportNote, UnmappedItem } from '$lib/spreadsheet/import/report';
	import { location } from './workbookFile';

	let {
		notes,
		unmapped,
		idPrefix = 'wb',
		collapsible = false,
		notesOmitted = 0,
		unmappedOmitted = 0,
		showUnmapped = true
	}: {
		notes: ImportNote[];
		unmapped: UnmappedItem[];
		/** Prefix for the headings' ids, unique per instance on a page. */
		idPrefix?: string;
		/** Each list behind a disclosure, closed at first (the Overview's record). */
		collapsible?: boolean;
		/** Items the importer found beyond what was kept. */
		notesOmitted?: number;
		unmappedOmitted?: number;
		/** The unmapped report is a workbook's; a project file's record leaves it out. */
		showUnmapped?: boolean;
	} = $props();

	const warnings = $derived(notes.filter((n) => n.severity === 'warning').length);
</script>

{#snippet noteList()}
	<ul class="notes">
		{#each notes as note, i (i)}
			<li>
				<span class="badge" class:badge-warn={note.severity === 'warning'}>{note.severity === 'warning' ? 'Warning' : 'Note'}</span>
				<span class="msg">{note.message.replace(/^WARNING: /, '')}</span>
				{#if location(note)}<span class="where muted">({location(note)})</span>{/if}
			</li>
		{/each}
	</ul>
	{#if notesOmitted}<p class="hint muted">And {notesOmitted} more {notesOmitted === 1 ? 'note' : 'notes'}, not kept.</p>{/if}
{/snippet}

{#snippet unmappedTable()}
	<div class="table-wrap">
		<table class="data compact">
			<caption class="visually-hidden">Unmapped items</caption>
			<thead>
				<tr><th scope="col">Where</th><th scope="col">Element</th><th scope="col">What</th><th scope="col">In the workbook</th></tr>
			</thead>
			<tbody>
				{#each unmapped as item, i (i)}
					<tr>
						<td class="nowrap">{location(item) || '—'}</td>
						<td>{item.element ?? '—'}</td>
						<td>{item.message}</td>
						<td>{#if item.text}<code>{item.text}</code>{:else}—{/if}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
	{#if unmappedOmitted}<p class="hint muted">And {unmappedOmitted} more {unmappedOmitted === 1 ? 'item' : 'items'}, not kept.</p>{/if}
{/snippet}

<section class="report" aria-labelledby="{idPrefix}-notes-h">
	<h3 id="{idPrefix}-notes-h">Importer notes <HelpTip key="workbook-import" label="About the import and its report" /></h3>
	{#if notes.length}
		<p class="hint muted">
			{notes.length === 1 ? 'One note' : `${notes.length} notes`}{warnings ? `, ${warnings} of them ${warnings === 1 ? 'a warning' : 'warnings'}` : ''}. Read them before relying on a run.
		</p>
		{#if collapsible}
			<details>
				<summary>Show the {notes.length === 1 ? 'note' : `${notes.length} notes`}</summary>
				{@render noteList()}
			</details>
		{:else}
			{@render noteList()}
		{/if}
	{:else}
		<p class="hint muted">None.</p>
	{/if}
</section>

{#if showUnmapped}
	<section class="report" aria-labelledby="{idPrefix}-unmapped-h">
		<h3 id="{idPrefix}-unmapped-h">Unmapped report: not carried across as the workbook meant</h3>
		{#if unmapped.length}
			<p class="hint muted">
				The importer couldn't map {unmapped.length === 1 ? 'this' : `these ${unmapped.length} items`} onto the app's model exactly.
				It never changes a value on its own: check each against the workbook, and fix the project after importing if needed.
			</p>
			{#if collapsible}
				<details>
					<summary>Show the {unmapped.length === 1 ? 'item' : `${unmapped.length} items`}</summary>
					{@render unmappedTable()}
				</details>
			{:else}
				{@render unmappedTable()}
			{/if}
		{:else}
			<p class="hint muted">Nothing: everything in the workbook was mapped.</p>
		{/if}
	</section>
{/if}

<style>
	.report h3 {
		font-size: 0.9rem;
		margin: 0.75rem 0 0.3rem;
	}
	.notes {
		list-style: none;
		padding: 0;
		margin: 0 0 0.5rem;
		display: grid;
		gap: 0.35rem;
	}
	.notes li {
		overflow-wrap: anywhere;
		font-size: 0.85rem;
	}
	.notes .badge {
		margin-right: 0.35rem;
	}
	.where {
		margin-left: 0.25rem;
	}
	.table-wrap {
		overflow-x: auto;
		margin-bottom: 0.5rem;
	}
	table {
		width: 100%;
		font-size: 0.85rem;
	}
	td {
		overflow-wrap: anywhere;
		vertical-align: top;
	}
	.nowrap {
		white-space: nowrap;
	}
	code {
		font-family: var(--font-mono, ui-monospace, monospace);
		font-size: 0.85em;
		overflow-wrap: anywhere;
	}
	.hint {
		font-size: 0.8rem;
	}
	summary {
		cursor: pointer;
		font-size: 0.85rem;
		margin-bottom: 0.35rem;
	}
</style>
