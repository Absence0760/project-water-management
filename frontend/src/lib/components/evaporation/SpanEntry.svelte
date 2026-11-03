<!--
	Model settings → Demand → Where the A-pan row comes from → "Typed or pasted
	S-pan, converted" (docs/ui.md § Demand, docs/model.md §2.3a). 12 Symons-pan
	(S-pan) months, typed or pasted from a spreadsheet row, become the A-pan
	row only through the inverted equation the user picks (WR90 or Taljaard
	2023), with Taljaard's warning beside the choice and an equation that
	can't be used disabled with its reason (the engine's floors, as for a
	Symons station). Use (editors, "Saves now") asks first, then saves straight
	to the project as one settings revision giving the S-pan months, the note
	and the equation; it waits while the form has unsaved changes. Lazy: only
	loaded when this source is picked.
-->
<script lang="ts">
	import { apanMonthlyFromSpan, SPAN_CONVERSIONS, SPAN_INVERSION_CAVEAT } from '@water-management/engine';
	import { api, type SpanConversionId } from '#lib/api/index.js';
	import { confirmDialog } from '#lib/components/common/confirm.svelte.js';
	import NumberInput from '#lib/components/common/NumberInput.svelte';
	import { fmtNum } from '#lib/format/number.js';
	import { WATER_YEAR_MONTHS } from '#lib/format/months.js';
	import { parseSpanRow } from './spanEntry';

	let {
		projectId,
		readonly,
		formDirty,
		savedApanMm,
		onApplied
	}: {
		projectId: string;
		readonly: boolean;
		/** Unsaved settings: Use waits until they are saved or discarded (it saves straight to the project). */
		formDirty: boolean;
		/** The saved A-pan row, shown beside the proposal. */
		savedApanMm: readonly number[];
		/** The settings changed on the server: the form takes them as they now are. */
		onApplied: () => Promise<void> | void;
	} = $props();

	const uid = $props.id();
	let span = $state<(number | null)[]>(new Array(12).fill(null));
	let pasted = $state('');
	let pasteError = $state<string | null>(null);
	let note = $state('');
	let conversion = $state<SpanConversionId | null>(null);
	let busy = $state(false);
	let useError = $state<string | null>(null);
	let notice = $state<string | null>(null);
	let noticeEl = $state<HTMLParagraphElement | null>(null);

	const full = $derived(span.every((v) => v !== null && Number.isFinite(v)) ? (span as number[]) : null);
	const results = $derived(full ? SPAN_CONVERSIONS.map((c) => ({ ...c, result: apanMonthlyFromSpan(full, c.id) })) : null);
	const chosen = $derived(results?.find((r) => r.id === conversion) ?? null);
	const apan = $derived(chosen?.result.ok ? chosen.result.values : null);
	const total = (row: readonly number[]) => fmtNum(Math.round(row.reduce((a, b) => a + b, 0)));

	function fill() {
		const r = parseSpanRow(pasted);
		if (!r.ok) {
			pasteError = r.reason;
			return;
		}
		pasteError = null;
		span = r.values;
		pasted = '';
	}

	async function use() {
		if (!full || !apan || !chosen) return;
		const ok = await confirmDialog({
			title: 'Use these S-pan months as the A-pan?',
			message: `The A-pan row becomes ${total(apan)} mm a year, from ${total(full)} mm of S-pan${note.trim() ? ` (${note.trim()})` : ''}, converted by the ${chosen.label}. Irrigation demand, dam evaporation and, under pan coefficient × A-pan, GR4J read it.`,
			confirmLabel: 'Use the converted S-pan'
		});
		if (!ok) return;
		busy = true;
		useError = null;
		try {
			const r = await api.evaporationSpan.use(projectId, { spanMm: full, conversion: chosen.id, ...(note.trim() ? { note: note.trim() } : {}) });
			notice = `The A-pan row is now ${total(r.apanMm)} mm a year, converted from your S-pan, saved as a settings revision giving the months and the equation.`;
			await onApplied();
			noticeEl?.focus();
		} catch (e) {
			useError = e instanceof Error ? e.message : String(e);
		} finally {
			busy = false;
		}
	}
</script>

<div class="span-entry" data-testid="span-entry">
	<p class="hint muted explain">
		Symons-pan (S-pan) evaporation, as WR90 and WR2012 publish it, is not the Class-A pan the model reads. Enter or paste the 12 months, pick the
		equation that converts them, and use the result as the A-pan row. Nothing changes until you use it.
	</p>
	{#if notice}<p class="alert alert-success slim" tabindex="-1" bind:this={noticeEl} data-testid="span-entry-notice">{notice}</p>{/if}
	{#if !readonly}
		<div class="paste">
			<label for="{uid}-paste">Paste the 12 S-pan months from a spreadsheet <span class="u">(mm, October first)</span></label>
			<textarea id="{uid}-paste" rows="2" bind:value={pasted} disabled={busy} aria-describedby={pasteError ? `${uid}-paste-err` : undefined}></textarea>
			<button type="button" class="btn btn-sm" onclick={fill} disabled={busy}>Fill the months</button>
			{#if pasteError}<p class="err small" id="{uid}-paste-err" role="alert">{pasteError}</p>{/if}
		</div>
	{/if}
	<div class="table-wrap">
		<table class="data compact monthly short" data-testid="span-entry-rows">
			<caption class="visually-hidden">S-pan months entered, the A-pan they give and the saved A-pan</caption>
			<thead>
				<tr>
					<th scope="col" class="sticky">Month</th>
					{#each WATER_YEAR_MONTHS as m (m)}<th scope="col" class="num">{m}</th>{/each}
					<th scope="col" class="num">Year</th>
				</tr>
			</thead>
			<tbody>
				<tr data-row="span">
					<th scope="row" class="sticky">S-pan <span class="u">mm</span></th>
					{#each WATER_YEAR_MONTHS as m, i (m)}
						<td><NumberInput label="S-pan evaporation, {m}, mm" min={0} max={1000} decimals={1} disabled={readonly || busy} bind:value={span[i]} /></td>
					{/each}
					<td class="num muted">{full ? total(full) : '–'}</td>
				</tr>
				<tr data-row="proposed">
					<th scope="row" class="sticky">Proposed A-pan <span class="u">mm</span></th>
					{#if apan}
						{#each apan as v, i (i)}<td class="num">{fmtNum(v, 1, true)}</td>{/each}
						<td class="num">{total(apan)}</td>
					{:else}
						<td colspan="13" class="muted small">{full ? 'Pick an equation below' : 'Enter all 12 months'}</td>
					{/if}
				</tr>
				<tr data-row="saved">
					<th scope="row" class="sticky">Saved A-pan <span class="u">mm</span></th>
					{#each savedApanMm as v, i (i)}<td class="num">{fmtNum(v, 1, true)}</td>{/each}
					<td class="num">{total(savedApanMm)}</td>
				</tr>
			</tbody>
		</table>
	</div>
	{#if results}
		<fieldset class="choices" data-testid="span-entry-conversion">
			<legend>Convert the S-pan to A-pan with</legend>
			{#each results as c (c.id)}
				<label class="choice">
					<input type="radio" name="{uid}-conv" value={c.id} checked={conversion === c.id} disabled={busy || readonly || !c.result.ok} onchange={() => (conversion = c.id)} />
					<span>{c.label}{#if !c.result.ok}<span class="muted"> · can’t be used here: {c.result.reason}</span>{/if}</span>
				</label>
			{/each}
			<p class="hint muted">{SPAN_INVERSION_CAVEAT}</p>
		</fieldset>
	{/if}
	{#if !readonly}
		<div class="field">
			<label for="{uid}-note">Where the S-pan comes from <span class="u">(optional, recorded with it)</span></label>
			<input id="{uid}-note" type="text" maxlength="200" bind:value={note} disabled={busy} placeholder="e.g. WR90 Vol. VI, evaporation zone 7A" />
		</div>
		<div class="actions">
			{#if apan}
				<span class="saves-now" id="{uid}-now">Saves now</span>
				<button
					type="button"
					class="btn btn-sm"
					data-testid="span-entry-use"
					disabled={busy || formDirty}
					aria-describedby={formDirty ? `${uid}-now ${uid}-dirty` : `${uid}-now`}
					onclick={use}>{busy ? 'Saving…' : 'Use as the A-pan'}</button
				>
			{/if}
		</div>
		{#if formDirty}<p class="hint muted" id="{uid}-dirty">Save or discard your settings changes first: values used here are saved straight away.</p>{/if}
		{#if useError}<p class="err small" role="alert">{useError}</p>{/if}
	{/if}
</div>

<style>
	.span-entry {
		display: grid;
		gap: 0.6rem;
		margin: 0.5rem 0;
	}
	.paste {
		display: grid;
		gap: 0.3rem;
		max-width: 40rem;
	}
	.paste textarea,
	.field input {
		width: 100%;
	}
	.paste button {
		justify-self: start;
	}
	.field {
		display: grid;
		gap: 0.25rem;
		max-width: 40rem;
	}
	.choices {
		border: 0;
		padding: 0;
		margin: 0;
		display: grid;
		gap: 0.35rem;
	}
	.choices legend {
		font-weight: 600;
		font-size: 0.9rem;
		padding: 0;
		margin-bottom: 0.25rem;
	}
	.choice {
		display: flex;
		gap: 0.5rem;
		align-items: flex-start;
		font-size: 0.9rem;
		min-height: 24px;
	}
	.choice input {
		margin-top: 0.2rem;
		flex: none;
	}
	.actions {
		display: flex;
		gap: 0.5rem;
		align-items: center;
	}
	.num {
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
		text-align: right;
	}
	.saves-now {
		font-size: var(--font-xs);
		font-weight: 600;
		padding: 0.05rem 0.45rem;
		border-radius: 999px;
		background: var(--warning-soft);
	}
	.slim {
		padding: 0.5rem 0.75rem;
		margin: 0;
	}
	.err {
		color: var(--danger);
		margin: 0;
	}
	.hint,
	.small {
		font-size: 0.85rem;
		margin: 0;
	}
	.table-wrap {
		width: 100%;
		overflow-x: auto;
	}
	th.sticky {
		position: sticky;
		left: 0;
		z-index: 2;
		background: var(--surface);
		white-space: nowrap;
	}
	thead th.sticky {
		background: var(--surface-2);
		z-index: 3;
	}
</style>
