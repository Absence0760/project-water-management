<script lang="ts">
	// Paste a block from a spreadsheet into a model grid (issue #285): the node
	// table and the planted-areas grid. The block goes in the box (pasted into the
	// grid itself, typed here, or read from a CSV file), the preview lists every
	// value it would change, and Apply writes them into the editor, unsaved, like
	// typing them in. The grid's own file says what the columns mean
	// (network/nodePaste.ts, crops/areaPaste.ts).
	import Dialog from '$lib/components/common/Dialog.svelte';
	import { fmtNum } from '$lib/format/number';
	import type { PastePlan } from '$lib/spreadsheet/paste/grid';

	let {
		open = $bindable(false),
		text = $bindable(''),
		title,
		layout,
		where = null,
		plan,
		onapply,
		csv,
		csvName
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
	} = $props();

	const uid = `gp-${Math.random().toString(36).slice(2, 8)}`;
	const result = $derived(text.trim() ? plan(text) : null);
	const ok = $derived(result && !('error' in result) ? result : null);
	const count = $derived(ok?.changes.length ?? 0);
	// Built when the dialog opens, so it holds the grid as it is then (with a BOM, so Excel reads m³ and ² as UTF-8).
	const csvHref = $derived(open ? `data:text/csv;charset=utf-8,${encodeURIComponent('﻿' + csv())}` : '');
	let fileNote = $state('');

	async function loadFile(e: Event & { currentTarget: HTMLInputElement }) {
		const f = e.currentTarget.files?.[0];
		e.currentTarget.value = '';
		if (!f) return;
		text = await f.text();
		fileNote = `Read ${f.name}.`;
	}

	function apply() {
		if (!ok || !ok.changes.length) return;
		onapply(ok);
		text = '';
		fileNote = '';
		open = false;
	}

	const error = $derived(result && 'error' in result ? result.error : null);
	const summary = $derived(
		!result
			? 'Paste or load a block to see what it changes.'
			: error
				? error
				: `${count ? `${count} ${count === 1 ? 'value changes' : 'values change'}` : 'Nothing changes'}${ok!.unchanged ? `; ${ok!.unchanged} already ${ok!.unchanged === 1 ? 'has' : 'have'} the pasted value` : ''}.`
	);

	const val = (v: number | null) => (v === null ? '–' : fmtNum(v, 4, true));
</script>

<Dialog bind:open {title} wide>
	<div class="paste">
		<p class="small muted">{layout} A blank cell or a dash leaves a value as it is. Commas in numbers are read as the block shows them: 12,5 as a decimal comma, 1,500,000 as thousands.</p>
		<p class="small" data-testid="paste-where">
			{#if where}Pasted into <strong>{where}</strong>: a block without names or headings starts there.{:else}A block without names or headings starts at the table's first row and column.{/if}
		</p>
		<label for="{uid}-text">Cells copied from a spreadsheet</label>
		<textarea id="{uid}-text" rows="6" spellcheck="false" bind:value={text} oninput={() => (fileNote = '')}></textarea>
		<div class="row">
			<label class="btn btn-sm file">
				Load a CSV file
				<input type="file" accept=".csv,.tsv,.txt,text/csv,text/plain" onchange={loadFile} />
			</label>
			<a class="btn btn-sm" href={csvHref} download={csvName}>Download the table as CSV</a>
			<span class="small muted" role="status">{fileNote}</span>
		</div>
	</div>

	<section class="preview" aria-labelledby="{uid}-pv">
		<h3 id="{uid}-pv">Preview</h3>
		<!-- One status line that stays in the page, its text changing, so a screen reader reads each new result. -->
		<p class="small" class:alert={!!error} class:alert-error={!!error} class:muted={!result} role="status" data-testid="paste-summary">{summary}</p>
		{#if ok}
			{#if ok.notes.length}
				<ul class="small muted notes">
					{#each ok.notes as n (n)}<li>{n}</li>{/each}
				</ul>
			{/if}
			{#if count}
				<!-- Focusable, so the list scrolls from the keyboard too (axe scrollable-region-focusable). -->
				<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
				<div class="table-wrap" role="region" aria-label="Changes" tabindex="0">
					<table class="data compact">
						<thead>
							<tr><th scope="col">Row</th><th scope="col">Column</th><th scope="col" class="num">Now</th><th scope="col" class="num">Pasted</th></tr>
						</thead>
						<tbody>
							{#each ok.changes as c (c.rowId + c.key)}
								<tr>
									<th scope="row">{c.rowName}</th>
									<td>{c.column} <span class="u">{c.unit}</span></td>
									<td class="num">{val(c.from)}</td>
									<td class="num"><strong>{val(c.to)}</strong></td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{/if}
		{/if}
	</section>

	{#snippet actions()}
		<button type="button" class="btn" onclick={() => (open = false)}>Cancel</button>
		<button type="button" class="btn btn-primary" disabled={!count} onclick={apply}>
			Apply {count} {count === 1 ? 'change' : 'changes'}
		</button>
	{/snippet}
</Dialog>

<style>
	.paste {
		display: grid;
		gap: 0.4rem;
	}
	.paste p {
		margin: 0;
	}
	.paste textarea {
		width: 100%;
		font-family: var(--font-mono);
		font-size: 0.8125rem;
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
	.notes {
		margin: 0.25rem 0 0.5rem;
		padding-left: 1.1rem;
	}
	.table-wrap {
		max-height: 18rem;
		overflow: auto;
	}
	.u {
		color: var(--text-muted);
		font-size: 0.75rem;
	}
</style>
