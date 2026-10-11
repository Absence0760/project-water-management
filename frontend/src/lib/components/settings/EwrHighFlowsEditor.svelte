<!--
	A rule table's high-flow components (engine ≥ 0.33.0, docs/model.md §2.9d):
	freshets and floods, each a name, the months it may peak in, a peak
	(m³/s), an event duration (days, rise to recession) and the events required per water year. Rows
	are edited in place, or pasted from a spreadsheet or read from a CSV file in
	a dialog (issue #521: it was an always-open box under the rows) that looks
	like the shared grid paste dialog (model/GridPasteDialog.svelte) but
	previews the rows the parser reads, since this is a list of rows, not a
	grid of numbers: the same parser and result as the old Fill, and the
	preview (with what it replaces) is the check before Fill, so it asks no
	confirm. Part of EwrRuleTablesEditor.svelte's chunk; helpers in
	./ewrRules.ts. A "Peaks in" that doesn't read as months is kept as typed,
	said under its field and counted as invalid (common/invalidFields), so it
	blocks the save as an invalid number does.
-->
<script lang="ts">
	import { EWR_HIGH_FLOWS_MAX, highFlowsIssue, type EwrHighFlowEvent } from '@water-management/engine';
	import { untrack } from 'svelte';
	import NumberInput from '$lib/components/common/NumberInput.svelte';
	import Dialog from '$lib/components/common/Dialog.svelte';
	import { fmtNum } from '$lib/format/number';
	import { useInvalidFields } from '$lib/components/common/invalidFields.svelte';
	import { latestFileText } from '$lib/files/latest';
	import { describeMonths } from '$lib/format/months';
	import { blankHighFlow, EXAMPLE_HIGH_FLOWS_CSV, highFlowTyped, parseHighFlows, parseMonths } from './ewrRules';

	let {
		value = $bindable(),
		readonly = false,
		/** The site, for accessible names ("Outlet (…)"). */
		siteLabel
	}: {
		value: EwrHighFlowEvent[];
		readonly?: boolean;
		siteLabel: string;
	} = $props();
	// The nearest owner's registry of invalid fields (the workspace page, or a scenario's override mode).
	const invalidFields = useInvalidFields();

	const uid = $props.id();
	// Months as typed, by row, until they parse.
	let monthsText = $state<Record<number, string>>({});
	let monthsBad = $state<Record<number, boolean>>({});
	let paste = $state('');
	let pasteOpen = $state(false);
	let fileNote = $state('');
	let note = $state<{ ok: boolean; text: string } | null>(null);
	// The dialog's preview: the parser's rows, or its error.
	const parsed = $derived(paste.trim() ? parseHighFlows(paste) : null);
	const rows = $derived(parsed && !('error' in parsed) ? parsed : null);
	const typedNow = $derived(value.filter(highFlowTyped).length);
	const plural = (n: number) => `${n} high flow${n === 1 ? '' : 's'}`;
	const summary = $derived(
		!parsed
			? 'Paste or load the rows to see what they fill.'
			: 'error' in parsed
				? parsed.error
				: `${parsed.length} high-flow component${parsed.length === 1 ? '' : 's'}${typedNow ? `, replacing the ${typedNow === 1 ? '1 component' : `${typedNow} components`} listed` : ''}.`
	);
	const issue = $derived(value.length ? highFlowsIssue(value) : null);
	const exampleHref = `data:text/csv;charset=utf-8,${encodeURIComponent(EXAMPLE_HIGH_FLOWS_CSV)}`;

	function setMonths(k: number, text: string) {
		monthsText[k] = text;
		const m = parseMonths(text);
		monthsBad[k] = m === null;
		if (m) value[k]!.months = m;
	}

	function resetText() {
		monthsText = {};
		monthsBad = {};
	}

	const MONTHS_MESSAGE = 'Enter the months as names or numbers, e.g. Nov-Jan or Nov Dec Jan.';
	const monthsId = (k: number) => `${uid}-m${k}`;
	// A month list that doesn't read is unsaved, invalid work, as a number field's text is: the save bar
	// lists it and blocks the save, and leaving asks. A Discard (invalidFields.reset) puts the text back.
	$effect(() => {
		const bad = Object.entries(monthsBad).filter(([, b]) => b).map(([k]) => Number(k));
		for (const k of bad) invalidFields.set(`${uid}-m${k}`, { id: monthsId(k), label: `High flow ${k + 1} months it may peak in`, message: MONTHS_MESSAGE });
		return () => {
			for (const k of bad) invalidFields.delete(`${uid}-m${k}`);
		};
	});
	let epoch = invalidFields.epoch;
	$effect(() => {
		const e = invalidFields.epoch;
		if (e === epoch) return;
		epoch = e;
		untrack(resetText);
	});

	// The list is replaced, never mutated in place: a table saved before high flows existed binds a fresh [] that only a new value reaches.
	function add() {
		value = [...value, blankHighFlow()];
	}

	function remove(k: number) {
		value = value.filter((_, j) => j !== k);
		resetText();
	}

	/** The dialog's Fill: the parser's rows replace the list, as the old Fill button did. */
	function fill() {
		// Held before the box is cleared, which empties `rows`.
		const filled = rows;
		if (!filled) return;
		value = filled;
		resetText();
		paste = '';
		fileNote = '';
		pasteOpen = false;
		note = { ok: true, text: `Filled ${filled.length} high-flow component${filled.length === 1 ? '' : 's'}.` };
	}

	// The latest file only: a large file still read can't land over one picked after it, or in a closed dialog.
	const fileText = latestFileText();
	$effect(() => {
		if (!pasteOpen) void fileText(null);
	});
	async function load(e: Event & { currentTarget: HTMLInputElement }) {
		const f = e.currentTarget.files?.[0];
		e.currentTarget.value = '';
		if (!f) return;
		const text = await fileText(f);
		if (text === null) return;
		paste = text;
		fileNote = `Read ${f.name}.`;
	}
</script>

<fieldset class="plain" aria-describedby="{uid}-status">
	<legend>High flows: freshets and floods</legend>
	<p class="hint explain">
		Each component is a flood that reaches its peak in one of its months and lasts its duration from rise to recession (counted as at least half the duration at or above half the peak), required that many times each water year. A
		year is asked for no more events than the site’s natural flow had, so a dry year that would have had no flood is not failed for it. The peak is a
		<strong>daily-mean</strong> flow: a gazetted Reserve gives an instantaneous peak, which daily flow rarely reaches, so enter the daily-mean peak the
		hydrologist converts it to (the run warns when natural flow reaches a peak in no more than half the water years).
	</p>
	{#if !readonly}
		<!-- The list's actions above it, in one row (a grid's actions go above it). -->
		<div class="actions">
			<button type="button" class="btn btn-sm" disabled={value.length >= EWR_HIGH_FLOWS_MAX} onclick={add}>Add a high flow</button>
			<button type="button" class="btn btn-sm" aria-haspopup="dialog" onclick={() => (pasteOpen = true)}>Paste or load a CSV…<span class="visually-hidden"> high flows at {siteLabel}</span></button>
		</div>
	{/if}
	{#if value.length}
		<div class="table-wrap">
			<table class="data compact">
				<caption class="sr-only">High-flow components at {siteLabel}</caption>
				<thead>
					<tr>
						<th scope="col">Name</th>
						<th scope="col">Peaks in</th>
						<th scope="col" class="num">Daily-mean peak <span class="u">m³/s</span></th>
						<th scope="col" class="num">Event days</th>
						<th scope="col" class="num">Per year</th>
						{#if !readonly}<th scope="col"><span class="sr-only">Remove</span></th>{/if}
					</tr>
				</thead>
				<tbody>
					{#each value as e, k (k)}
						<tr>
							<td><input aria-label="High flow {k + 1} name" readonly={readonly} maxlength="100" placeholder="Class II freshet" bind:value={e.label} /></td>
							<td>
								<input
									id={monthsId(k)}
									aria-label="High flow {k + 1} months it may peak in"
									readonly={readonly}
									value={monthsText[k] ?? describeMonths(e.months)}
									oninput={(ev) => setMonths(k, ev.currentTarget.value)}
									aria-invalid={monthsBad[k] ? 'true' : undefined}
									aria-describedby={monthsBad[k] ? `${monthsId(k)}-err` : undefined}
									placeholder="Nov-Jan"
								/>
								{#if monthsBad[k]}<span class="err" id="{monthsId(k)}-err">{MONTHS_MESSAGE}</span>{/if}
							</td>
							<td><NumberInput label="High flow {k + 1} daily-mean peak, m³/s" min={0} nullable disabled={readonly} value={Number.isFinite(e.peakM3s) ? e.peakM3s : null} onchange={(v) => (e.peakM3s = v ?? NaN)} /></td>
							<td><NumberInput label="High flow {k + 1} event duration, days" min={1} max={90} step={1} nullable disabled={readonly} value={e.durationDays} onchange={(v) => (e.durationDays = v ?? NaN)} /></td>
							<td><NumberInput label="High flow {k + 1} events per water year" min={1} max={12} step={1} nullable disabled={readonly} value={e.perYear} onchange={(v) => (e.perYear = v ?? NaN)} /></td>
							{#if !readonly}
								<td><button type="button" class="btn btn-sm btn-ghost" onclick={() => remove(k)} aria-label="Remove high flow {k + 1}">Remove</button></td>
							{/if}
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{:else}
		<p class="muted small">None: only the monthly flows are judged.</p>
	{/if}
	{#if issue}<p class="err" role="alert">{issue}</p>{/if}
	<p id="{uid}-status" class="small" class:err={note && !note.ok} role="status" aria-label="High-flow paste result">{note?.text ?? ''}</p>
</fieldset>

{#if !readonly}
	<Dialog bind:open={pasteOpen} title="Paste high flows at {siteLabel}" wide>
		<div class="paste">
			<p class="small muted" id="{uid}-layout">One per row: name, months, daily-mean peak (m³/s), event days, events per year. A heading row is skipped. The rows replace the list.</p>
			<label for="{uid}-paste">Rows copied from a spreadsheet</label>
			<textarea id="{uid}-paste" rows="6" spellcheck="false" bind:value={paste} oninput={() => (fileNote = '')} aria-describedby="{uid}-layout"></textarea>
			<div class="actions">
				<label class="btn btn-sm file">
					Load a CSV file
					<input type="file" accept=".csv,.tsv,.txt,text/csv,text/plain" onchange={load} />
				</label>
				<a class="btn btn-sm" href={exampleHref} download="high-flows-example.csv">Example CSV (synthetic)</a>
				<span class="small muted" role="status">{fileNote}</span>
			</div>
		</div>
		<section class="preview" aria-labelledby="{uid}-pv">
			<h3 id="{uid}-pv">Preview</h3>
			<!-- One status line that stays in the page, its text changing, so a screen reader reads each new result. -->
			<p class="small" class:alert={!!parsed && 'error' in parsed} class:alert-error={!!parsed && 'error' in parsed} class:muted={!parsed} role="status" data-testid="high-flow-paste-summary">{summary}</p>
			{#if rows}
				<!-- Focusable, so the list scrolls from the keyboard too (axe scrollable-region-focusable). -->
				<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
				<div class="table-wrap preview-rows" role="region" aria-label="Pasted high flows" tabindex="0">
					<table class="data compact">
						<thead>
							<tr>
								<th scope="col">Name</th>
								<th scope="col">Peaks in</th>
								<th scope="col" class="num">Daily-mean peak <span class="u">m³/s</span></th>
								<th scope="col" class="num">Event days</th>
								<th scope="col" class="num">Per year</th>
							</tr>
						</thead>
						<tbody>
							{#each rows as r, k (k)}
								<tr>
									<th scope="row">{r.label || `High flow ${k + 1}`}</th>
									<td>{describeMonths(r.months)}</td>
									<td class="num">{fmtNum(r.peakM3s, 4, true)}</td>
									<td class="num">{r.durationDays}</td>
									<td class="num">{r.perYear}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{/if}
		</section>
		{#snippet actions()}
			<button type="button" class="btn" onclick={() => (pasteOpen = false)}>Cancel</button>
			<button type="button" class="btn btn-primary" disabled={!rows} onclick={fill}>{rows ? (typedNow ? `Replace with ${plural(rows.length)}` : `Fill ${plural(rows.length)}`) : 'Fill the high flows'}</button>
		{/snippet}
	</Dialog>
{/if}

<style>
	.hint {
		font-size: 0.8rem;
		max-width: 75ch;
		color: var(--text-muted);
	}
	.plain {
		border: 0;
		padding: 0;
		margin: 0.75rem 0 0.5rem;
		min-width: 0;
	}
	.plain legend {
		font-weight: 600;
		font-size: 0.9rem;
		color: var(--text-2);
		padding: 0;
	}
	td {
		min-width: 90px;
	}
	td input {
		width: 100%;
	}
	/* The paste dialog, in the shared grid paste dialog's look. */
	.paste {
		display: grid;
		gap: 0.4rem;
	}
	.paste p {
		margin: 0;
	}
	.paste > label {
		font-weight: 500;
		font-size: 0.85rem;
	}
	.paste textarea {
		width: 100%;
		font-family: var(--font-mono, monospace);
		font-size: 0.8125rem;
	}
	.preview {
		margin-top: 1rem;
	}
	.preview h3 {
		margin: 0 0 0.4rem;
		font-size: 0.9375rem;
	}
	.preview-rows {
		max-height: 18rem;
		overflow: auto;
	}
	.u {
		color: var(--text-muted);
		font-size: 0.75rem;
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem;
		margin-top: 0.35rem;
	}
	.err {
		color: var(--danger);
		font-size: 0.8rem;
	}
</style>
