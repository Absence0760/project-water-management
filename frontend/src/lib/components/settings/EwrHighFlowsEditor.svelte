<!--
	A rule table's high-flow components (engine ≥ 0.33.0, docs/model.md §2.9d):
	freshets and floods, each a name, the months it may peak in, a peak
	(m³/s), an event duration (days, rise to recession) and the events required per water year. Rows
	are edited in place, pasted from a spreadsheet, or read from a CSV file.
	Part of EwrRuleTablesEditor.svelte's chunk; helpers in ./ewrRules.ts.
-->
<script lang="ts">
	import { EWR_HIGH_FLOWS_MAX, highFlowsIssue, type EwrHighFlowEvent } from '@water-management/engine';
	import NumberInput from '$lib/components/common/NumberInput.svelte';
	import { latestFileText } from '$lib/files/latest';
	import { describeMonths } from '$lib/format/months';
	import { blankHighFlow, EXAMPLE_HIGH_FLOWS_CSV, parseHighFlows, parseMonths } from './ewrRules';

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

	const uid = $props.id();
	// Months as typed, by row, until they parse.
	let monthsText = $state<Record<number, string>>({});
	let monthsBad = $state<Record<number, boolean>>({});
	let paste = $state('');
	let note = $state<{ ok: boolean; text: string } | null>(null);
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

	// The list is replaced, never mutated in place: a table saved before high flows existed binds a fresh [] that only a new value reaches.
	function add() {
		value = [...value, blankHighFlow()];
	}

	function remove(k: number) {
		value = value.filter((_, j) => j !== k);
		resetText();
	}

	function fill(text: string) {
		const r = parseHighFlows(text);
		if ('error' in r) {
			note = { ok: false, text: r.error };
			return;
		}
		value = r;
		resetText();
		paste = '';
		note = { ok: true, text: `Filled ${r.length} high-flow component${r.length === 1 ? '' : 's'}.` };
	}

	// The latest file only: a large file still read can't land over one picked after it.
	const fileText = latestFileText();
	async function load(e: Event & { currentTarget: HTMLInputElement }) {
		const f = e.currentTarget.files?.[0];
		e.currentTarget.value = '';
		if (!f) return;
		const text = await fileText(f);
		if (text !== null) fill(text);
	}
</script>

<fieldset class="plain" aria-describedby="{uid}-status">
	<legend>High flows: freshets and floods</legend>
	<p class="hint">
		Each component is a flood that reaches its peak in one of its months and lasts its duration from rise to recession (counted as at least half the duration at or above half the peak), required that many times each water year. A
		year is asked for no more events than the site’s natural flow had, so a dry year that would have had no flood is not failed for it. The peak is a
		<strong>daily-mean</strong> flow: a gazetted Reserve gives an instantaneous peak, which daily flow rarely reaches, so enter the daily-mean peak the
		hydrologist converts it to (the run warns when natural flow reaches a peak in no more than half the water years).
	</p>
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
									aria-label="High flow {k + 1} months it may peak in"
									readonly={readonly}
									value={monthsText[k] ?? describeMonths(e.months)}
									oninput={(ev) => setMonths(k, ev.currentTarget.value)}
									aria-invalid={monthsBad[k] ? 'true' : undefined}
									placeholder="Nov-Jan"
								/>
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
	{#if Object.values(monthsBad).some(Boolean)}<p class="err">Enter the months as names or numbers, e.g. Nov-Jan or Nov Dec Jan.</p>{/if}
	{#if issue}<p class="err" role="alert">{issue}</p>{/if}
	{#if !readonly}
		<div class="actions">
			<button type="button" class="btn btn-sm" disabled={value.length >= EWR_HIGH_FLOWS_MAX} onclick={add}>Add a high flow</button>
		</div>
		<div class="paste">
			<label for="{uid}-paste">Paste high flows</label>
			<textarea
				id="{uid}-paste"
				rows="3"
				placeholder={'One per row: name, months, daily-mean peak (m³/s), event days, events per year. A heading row is skipped.'}
				bind:value={paste}
				aria-describedby="{uid}-status"
			></textarea>
			<div class="actions">
				<button type="button" class="btn btn-sm" onclick={() => fill(paste)}>Fill the high flows</button>
				<label class="btn btn-sm file">
					Load a CSV file
					<input type="file" accept=".csv,.tsv,.txt,text/csv,text/plain" onchange={load} />
				</label>
				<a class="small" href={exampleHref} download="high-flows-example.csv">Example CSV (synthetic)</a>
			</div>
		</div>
	{/if}
	<p id="{uid}-status" class="small" class:err={note && !note.ok} role="status" aria-label="High-flow paste result">{note?.text ?? ''}</p>
</fieldset>

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
	.paste {
		display: grid;
		gap: 0.35rem;
		margin-top: 0.5rem;
		max-width: 75ch;
	}
	.paste > label {
		font-weight: 500;
		font-size: 0.85rem;
	}
	.paste textarea {
		width: 100%;
		font-family: var(--font-mono, monospace);
		font-size: 0.8rem;
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
