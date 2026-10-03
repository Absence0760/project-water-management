<!--
	Optional FAO-56 Table 5 helper (issue #39, proposal point 2; docs/model.md §2.4a):
	suggests a monthly Class A pan coefficient from monthly mean RH and wind at
	2 m, the pan's siting and fetch, and an optional stated bare-surroundings
	reduction. It stores nothing: Apply hands the 12 values and a provenance
	note to `onapply`, and the parent fills its form with them. The source is
	marked missing only once it has been left, and the
	button's reason is read when it is focused, not announced on every keystroke.
-->
<script lang="ts">
	import { FAO56_REDUCTION_GUIDANCE, FAO56_RH_LABELS, FAO56_SITING_LABELS, FAO56_TABLE5_SOURCE, FAO56_WIND_LABELS } from '@water-management/engine';
	import NumberInput from '$lib/components/common/NumberInput.svelte';
	import HelpTip from '$lib/components/help/HelpTip.svelte';
	import { WATER_YEAR_MONTHS } from '$lib/format/months';
	import { applied, FETCH_OPTIONS, newHelperState, suggest } from './panCoefficientHelper';

	let {
		onapply,
		readonly = false
	}: {
		/** The 12 suggested Kp values (water-year order, Oct–Sep) and a note of where they came from. */
		onapply: (values: number[], note: string) => void;
		readonly?: boolean;
	} = $props();

	const uid = $props.id();
	const SITINGS = ['A', 'B'] as const;
	const form = $state(newHelperState());
	const suggestion = $derived(suggest(form));
	const ready = $derived(applied(form));

	function setFetch(v: string) {
		const f = FETCH_OPTIONS.find((x) => x === Number(v));
		if (f !== undefined) form.fetchM = f;
	}

	// The source is required; it is marked so once left, not the moment the helper opens.
	let sourceLeft = $state(false);
	const sourceBad = $derived(sourceLeft && !form.source.trim());

	function apply() {
		if (ready) onapply(ready.values, ready.note);
	}
</script>

<details class="pan-helper" data-testid="pan-coefficient-helper">
	<summary>Suggest from FAO-56 Table 5 (humidity, wind, siting)</summary>
	<div class="body">
		<p class="hint">
			Looks up the Class A pan coefficient for each month from that month’s mean relative humidity and wind speed at 2 m, the pan’s siting and its windward
			fetch. It only fills the pan-coefficient row, which stays editable. Source: {FAO56_TABLE5_SOURCE}.
		</p>
		<div class="row">
			<fieldset class="plain">
				<legend>Pan siting <HelpTip key="settings.panCoefficient" label="About pan siting" /></legend>
				{#each SITINGS as s (s)}
					<label class="check">
						<input type="radio" name="{uid}-siting" value={s} disabled={readonly} checked={form.siting === s} onchange={() => (form.siting = s)} />
						{FAO56_SITING_LABELS[s]}
					</label>
				{/each}
			</fieldset>
			<div class="field">
				<label for="{uid}-fetch">Windward fetch of {form.siting === 'A' ? 'green crop' : 'dry fallow'} <span class="u">(m)</span></label>
				<select id="{uid}-fetch" disabled={readonly} value={form.fetchM} onchange={(e) => setFetch(e.currentTarget.value)} aria-describedby="{uid}-fetch-h">
					{#each FETCH_OPTIONS as f (f)}<option value={f}>{f}</option>{/each}
				</select>
				<span class="hint" id="{uid}-fetch-h">Table 5’s four distances; no interpolation between them.</span>
			</div>
			<div class="field reduce">
				<label for="{uid}-red">Reduction for bare surroundings <span class="u">(%, 0–20)</span></label>
				<NumberInput id="{uid}-red" nullable min={0} max={20} step={1} disabled={readonly} placeholder="none" bind:value={form.reductionPct} aria-describedby="{uid}-red-h" />
				<span class="hint" id="{uid}-red-h">{FAO56_REDUCTION_GUIDANCE} Applied to every month as stated.</span>
			</div>
		</div>
		<div class="table-wrap">
			<table class="months">
				<thead>
					<tr>
						<th scope="col">Month</th>
						{#each WATER_YEAR_MONTHS as m (m)}<th scope="col">{m}</th>{/each}
					</tr>
				</thead>
				<tbody>
					<tr>
						<th scope="row">Mean RH <span class="u">%</span></th>
						{#each WATER_YEAR_MONTHS as m, i (m)}
							<td><NumberInput label="Mean relative humidity, {m}, %" nullable min={0} max={100} step={1} disabled={readonly} bind:value={form.months[i]!.rhPct} aria-invalid={suggestion.errors[i] ? true : undefined} /></td>
						{/each}
					</tr>
					<tr>
						<th scope="row">Wind at 2 m <span class="u">m/s</span></th>
						{#each WATER_YEAR_MONTHS as m, i (m)}
							<td><NumberInput label="Mean wind speed at 2 m, {m}, m/s" nullable min={0} step={0.1} disabled={readonly} bind:value={form.months[i]!.windMs} aria-invalid={suggestion.errors[i] ? true : undefined} /></td>
						{/each}
					</tr>
					<tr class="out">
						<th scope="row">Suggested Kp</th>
						{#each WATER_YEAR_MONTHS as m, i (m)}
							{@const r = suggestion.results[i]}
							<!-- The Table 5 class behind each value, in words a keyboard, touch or screen-reader user reaches too (not only a title). -->
							<td class="num" data-testid="pan-helper-kp">
								{r ? r.kp : '–'}{#if r}<span class="visually-hidden">{`: RH ${FAO56_RH_LABELS[r.cell.rhClass]}, wind ${FAO56_WIND_LABELS[r.cell.windClass]}, Table 5 ${r.tableKp}`}</span>{/if}
							</td>
						{/each}
					</tr>
				</tbody>
			</table>
		</div>
		<div class="field grow">
			<label for="{uid}-src">Where the RH and wind came from</label>
			<input
				id="{uid}-src"
				maxlength="500"
				readonly={readonly}
				required
				placeholder="e.g. station name, record period, monthly means"
				value={form.source}
				aria-invalid={sourceBad || undefined}
				aria-describedby="{uid}-src-h"
				class:invalid={sourceBad}
				oninput={(e) => (form.source = e.currentTarget.value)}
				onblur={() => (sourceLeft = true)}
			/>
			<span class="hint" id="{uid}-src-h" class:err={sourceBad}>Required: it goes into the source note with the values.</span>
		</div>
		{#if !readonly}
			<div class="row">
				<button type="button" class="btn btn-sm" disabled={!ready} onclick={apply} aria-describedby="{uid}-block">Fill the pan-coefficient row</button>
				<span class="hint" id="{uid}-block">{suggestion.blocker ? `${suggestion.blocker}.` : 'Replaces the 12 values in the row; you can still edit them.'}</span>
			</div>
		{/if}
	</div>
</details>

<style>
	.hint.err {
		color: var(--danger);
	}
	.pan-helper {
		border-top: 1px solid var(--border);
		padding-top: 0.6rem;
		margin: 0.5rem 0;
	}
	summary {
		cursor: pointer;
		font-weight: 600;
		color: var(--accent);
		min-height: 36px;
		display: flex;
		align-items: center;
	}
	.body {
		display: grid;
		gap: 0.5rem;
	}
	.hint {
		font-size: 0.8rem;
		color: var(--text-muted);
		max-width: 75ch;
	}
	.u {
		font-weight: 400;
		color: var(--text-muted);
		font-size: 0.8rem;
	}
	legend {
		font-weight: 500;
		font-size: 0.85rem;
		color: var(--text-2);
		padding: 0;
		margin-bottom: 0.2rem;
	}
	.plain {
		border: 0;
		padding: 0;
		margin: 0;
		min-width: 0;
		display: grid;
		gap: 0.2rem;
	}
	.row {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-end;
		gap: 0.5rem 1rem;
	}
	.field {
		margin: 0;
		display: grid;
		gap: 0.2rem;
	}
	.reduce {
		max-width: 36ch;
	}
	.grow {
		max-width: 60ch;
	}
	.grow input {
		width: 100%;
	}
	.check {
		display: flex;
		gap: 0.4rem;
		align-items: center;
		font-size: 0.85rem;
		min-height: 24px;
	}
	.table-wrap {
		overflow-x: auto;
		max-width: 100%;
	}
	.months {
		border-collapse: collapse;
	}
	.months th {
		font-size: 0.75rem;
		font-weight: 500;
		color: var(--text-muted);
		text-align: left;
		white-space: nowrap;
	}
	.months td :global(input) {
		width: 4.2rem;
	}
	.out td {
		font-variant-numeric: tabular-nums;
		text-align: right;
		padding: 0.2rem 0.4rem;
	}
	input.invalid {
		border-color: var(--danger);
	}
</style>
