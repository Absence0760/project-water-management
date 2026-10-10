<script lang="ts">
	// Import plantings (issue #477; docs/ui.md § Import plantings): a CSV file
	// or rows pasted from a spreadsheet, a row per farm and crop with its
	// planted area (./plantingsImport.ts), for a catchment's hundreds of
	// plantings at once. Farms and crops are matched by name; a crop the
	// project doesn't have is added as a crop type that needs its factors, a
	// farm it doesn't have is listed and added as a new hydrological unit only
	// when asked. The preview counts what happens and lists every row it
	// can't read by its line; nothing changes until Apply, which edits the
	// model like any other edit: the save bar saves it. Its own chunk, loaded
	// when the button is first pressed (CropsTab).
	import Dialog from '$lib/components/common/Dialog.svelte';
	import FormatHelp from '$lib/components/common/FormatHelp.svelte';
	import { latestFileText } from '$lib/files/latest';
	import { fmtNum } from '$lib/format/number';
	import type { ModelEditor } from '$lib/model/editor.svelte';
	import { applyPlantingsImport, planPlantingsImport, plantingsCsv, PLANTINGS_FORMAT, PLANTINGS_MAX_BYTES, type PlantingsApplied } from './plantingsImport';

	let {
		open = $bindable(false),
		editor,
		onapplied
	}: {
		open?: boolean;
		editor: ModelEditor;
		onapplied?: (done: PlantingsApplied) => void;
	} = $props();

	const uid = `ip-${Math.random().toString(36).slice(2, 8)}`;
	/** The most change rows the preview draws; the counts above it cover them all. */
	const SHOWN = 200;

	let text = $state('');
	let createFarms = $state(false);
	let fileNote = $state('');
	let fileError = $state<string | null>(null);

	const result = $derived(text.trim() ? planPlantingsImport(text, editor.model, { createFarms }) : null);
	const error = $derived(result && 'error' in result ? result.error : null);
	const plan = $derived(result && !('error' in result) ? result : null);
	const newCropsUsed = $derived(plan ? plan.newCrops.filter((c) => plan.changes.some((ch) => ch.cropKey === c.key)) : []);
	const farmsLeftOut = $derived(plan && !plan.createFarms ? plan.newFarms : []);
	const canApply = $derived(!!plan && plan.changes.length > 0);

	const n = (k: number, one: string, many: string) => `${fmtNum(k, 0)} ${k === 1 ? one : many}`;
	const summary = $derived(
		!result
			? 'Load a file or paste the rows to see what they change.'
			: error
				? error
				: [
						`${n(plan!.lines, 'row', 'rows')} read`,
						plan!.changes.length ? `${n(plan!.changes.length, 'planted area changes', 'planted areas change')}` : 'no planted area changes',
						plan!.unchanged ? `${fmtNum(plan!.unchanged, 0)} already as listed` : '',
						newCropsUsed.length ? `adds ${n(newCropsUsed.length, 'crop type', 'crop types')}` : '',
						plan!.createFarms ? `adds ${n(plan!.newFarms.length, 'hydrological unit', 'hydrological units')}` : '',
						farmsLeftOut.length ? `${n(farmsLeftOut.length, 'farm', 'farms')} not in the project` : '',
						plan!.errors.length ? `${n(plan!.errors.length, 'row', 'rows')} with a problem` : ''
					]
						.filter(Boolean)
						.join(', ')
						.replace(/^./, (c) => c.toUpperCase()) + '.'
	);

	// Built when the dialog opens: the project's plantings as the list, to edit and load back.
	const currentHref = $derived(open ? `data:text/csv;charset=utf-8,${encodeURIComponent('﻿' + plantingsCsv(editor.model))}` : '');

	// The latest file only: a large file still read can't land over one picked after it, or in a closed dialog.
	const fileText = latestFileText();
	$effect(() => {
		if (!open) void fileText(null);
	});

	async function loadFile(e: Event & { currentTarget: HTMLInputElement }) {
		const f = e.currentTarget.files?.[0];
		e.currentTarget.value = '';
		if (!f) return;
		fileError = null;
		if (/\.xls[xmb]?$/i.test(f.name)) {
			fileError = `${f.name} is an Excel workbook: save the sheet as CSV (UTF-8) and load that, or copy its rows and paste them.`;
			return;
		}
		if (f.size > PLANTINGS_MAX_BYTES) {
			fileError = `${f.name} is ${fmtNum(f.size / 1024 / 1024, 1)} MB; at most ${PLANTINGS_MAX_BYTES / 1024 / 1024} MB is read. Split the list into parts.`;
			return;
		}
		const read = await fileText(f);
		if (read === null) return;
		text = read;
		fileNote = `Read ${f.name}.`;
	}

	function apply() {
		if (!plan || !canApply) return;
		const done = applyPlantingsImport(plan, {
			addCrop: (name, systemId) => editor.addCrop(name, systemId).id,
			addUnit: (name) => editor.addUnit(name)?.id ?? null,
			setPlantings: (list) => editor.setPlantings(list)
		});
		text = '';
		fileNote = '';
		createFarms = false;
		open = false;
		onapplied?.(done);
	}

	const ha = (v: number | null) => (v === null ? '–' : fmtNum(v, 4, true));
</script>

<Dialog bind:open title="Import plantings" wide>
	<div class="box">
		<p class="small muted">
			A row per farm and crop with its planted area in hectares. Farms and crops are matched to the project’s by name; capitals and
			spaces don’t matter.
		</p>
		<FormatHelp format={PLANTINGS_FORMAT} />
		<div class="row">
			<label class="btn btn-sm file">
				Load a CSV file
				<input type="file" accept=".csv,.tsv,.txt,text/csv,text/plain,.xlsx,.xlsm,.xls" onchange={loadFile} data-testid="plantings-file" />
			</label>
			<a class="btn btn-sm" href={currentHref} download="plantings.csv">Download the current plantings</a>
			<span class="small muted" role="status">{fileNote}</span>
		</div>
		{#if fileError}<p class="alert alert-error small" role="alert">{fileError}</p>{/if}
		<label for="{uid}-text">…or paste the rows, with their heading row</label>
		<textarea id="{uid}-text" rows="6" spellcheck="false" bind:value={text} oninput={() => ((fileNote = ''), (fileError = null))}></textarea>
	</div>

	<section class="preview" aria-labelledby="{uid}-pv">
		<h3 id="{uid}-pv">Preview</h3>
		<!-- One status line that stays in the page, its text changing, so a screen reader reads each new result. -->
		<p class="small" class:alert={!!error} class:alert-error={!!error} class:muted={!result} role="status" data-testid="plantings-summary">{summary}</p>
		{#if plan}
			{#if plan.notes.length}
				<ul class="small muted notes">
					{#each plan.notes as note (note)}<li>{note}</li>{/each}
				</ul>
			{/if}

			{#if newCropsUsed.length}
				<div class="block" data-testid="plantings-new-crops">
					<h4>New crop types <span class="flag">needs crop factors</span></h4>
					<p class="small muted">Added with crop factors of 0, so they need no water until you fill them in (Edit on the crop, or Load crop factors).</p>
					<p class="names">{newCropsUsed.map((c) => c.name).join(', ')}</p>
				</div>
			{/if}

			{#if plan.newFarms.length}
				<div class="block" data-testid="plantings-new-farms">
					<h4>Farms not in the project{#if plan.createFarms}&nbsp;<span class="flag">needs placing</span>{/if}</h4>
					<p class="names">{plan.newFarms.map((f) => f.name).join(', ')}</p>
					{#if plan.cannotCreate}
						<p class="small alert alert-warning">{plan.cannotCreate} Their rows are left out.</p>
					{:else}
						<label class="check">
							<input type="checkbox" bind:checked={createFarms} />
							Add {plan.newFarms.length === 1 ? 'it' : 'them'} as new hydrological units
						</label>
						<p class="small muted">
							{#if plan.createFarms}Each drains into the outlet, with no catchment area, dam or connections: place it on the Network page (its area and where it drains) before a run.{:else}Left unticked, their rows are left out; the rest apply.{/if}
						</p>
					{/if}
				</div>
			{/if}

			{#if plan.errors.length}
				<div class="block">
					<h4>Rows left out</h4>
					<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
					<div class="errors" role="region" aria-label="Rows left out" tabindex="0">
						<ul class="small" data-testid="plantings-errors">
							{#each plan.errors as e (e.line + e.message)}<li>Line {e.line}: {e.message}</li>{/each}
						</ul>
					</div>
				</div>
			{/if}

			{#if plan.changes.length}
				<!-- Focusable, so the list scrolls from the keyboard too (axe scrollable-region-focusable). -->
				<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
				<div class="table-wrap" role="region" aria-label="Changes" tabindex="0">
					<table class="data compact" data-testid="plantings-changes">
						<thead>
							<tr>
								<th scope="col">Farm</th><th scope="col">Crop</th><th scope="col" class="num">Now, ha</th><th scope="col" class="num">Listed, ha</th><th scope="col">System</th>
							</tr>
						</thead>
						<tbody>
							{#each plan.changes.slice(0, SHOWN) as c (c.nodeKey + '|' + c.cropKey)}
								<tr>
									<th scope="row">{c.farmName}{#if c.nodeKey.startsWith('new-farm:')}&nbsp;<span class="tag">new</span>{/if}</th>
									<td>{c.cropName}{#if c.cropKey.startsWith('new-crop:')}&nbsp;<span class="tag">new</span>{/if}</td>
									<td class="num">{ha(c.fromHa)}</td>
									<td class="num"><strong>{ha(c.toHa)}</strong></td>
									<td>{c.systemText ?? ''}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
				{#if plan.changes.length > SHOWN}<p class="small muted">The first {SHOWN} of {fmtNum(plan.changes.length, 0)} changes; Apply makes them all.</p>{/if}
			{/if}
		{/if}
	</section>

	{#snippet actions()}
		<button type="button" class="btn" onclick={() => (open = false)}>Cancel</button>
		<button type="button" class="btn btn-primary" disabled={!canApply} onclick={apply}>
			Apply {plan ? fmtNum(plan.changes.length, 0) : 0} {plan?.changes.length === 1 ? 'change' : 'changes'}
		</button>
	{/snippet}
</Dialog>

<style>
	.box {
		display: grid;
		gap: 0.4rem;
	}
	.box p {
		margin: 0;
	}
	.box textarea {
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
	.block {
		margin: 0.75rem 0;
	}
	.block h4 {
		margin: 0 0 0.25rem;
		font-size: 0.875rem;
	}
	.block p {
		margin: 0.15rem 0;
	}
	.names {
		font-size: 0.875rem;
	}
	.flag {
		display: inline-block;
		margin-left: 0.35rem;
		padding: 0 0.4rem;
		border-radius: var(--radius-sm);
		background: var(--warning-soft);
		color: var(--text);
		font-size: 0.75rem;
		font-weight: 600;
	}
	.tag {
		color: var(--text-muted);
		font-size: 0.75rem;
	}
	.check {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		min-height: 24px;
		font-size: 0.875rem;
	}
	.notes {
		margin: 0.25rem 0 0.5rem;
		padding-left: 1.1rem;
	}
	.errors {
		max-height: 10rem;
		overflow: auto;
	}
	.errors ul {
		margin: 0;
		padding-left: 1.1rem;
	}
	.table-wrap {
		max-height: 18rem;
		overflow: auto;
	}
</style>
