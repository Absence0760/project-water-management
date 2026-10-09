<!--
	An editable list of dated periods, each a whole water year or a date range
	with a required reason (the engine's CalibrationExclusion shape). Used for
	settings.calibrationExclusions and settings.zeroRainRuns' keep-dry and
	missing periods. Bind the list; `error` is set while it is invalid, so the
	parent form can block saving.
-->
<script lang="ts">
	import { exclusionsError, exclusionRange, waterYearLabel, type CalibrationExclusion } from '@water-management/engine';
	import NumberInput from '$lib/components/common/NumberInput.svelte';
	import HelpTip from '$lib/components/help/HelpTip.svelte';

	let {
		list = $bindable([]),
		error = $bindable(null),
		readonly = false,
		legend,
		helpKey,
		helpLabel,
		hint,
		empty,
		addYearLabel,
		addRangeLabel,
		placeholder,
		noun
	}: {
		list: CalibrationExclusion[];
		error?: string | null;
		readonly?: boolean;
		legend: string;
		helpKey: string;
		/** The tip's name, when another tip on the page shares its key (each tip needs its own). */
		helpLabel?: string;
		hint: string;
		/** Shown when the list is empty. */
		empty: string;
		addYearLabel: string;
		addRangeLabel: string;
		placeholder: string;
		/** What one entry is called, lower case: "exclusion", "keep-dry period". */
		noun: string;
	} = $props();

	const uid = $props.id();

	$effect(() => {
		error = exclusionsError(list, noun);
	});

	/** A new water year: the one before the latest listed, else last year. */
	function nextYear(): number {
		const years = list.flatMap((x) => ('waterYear' in x ? [x.waterYear] : []));
		const month = new Date().getUTCMonth() + 1;
		const current = new Date().getUTCFullYear() - (month >= 10 ? 0 : 1);
		return years.length ? Math.min(...years) - 1 : current - 1;
	}

	function addYear() {
		list = [...list, { waterYear: nextYear(), reason: '' }];
	}
	function addRange() {
		const y = nextYear();
		list = [...list, { start: `${y}-10-01`, end: `${y}-12-31`, reason: '' }];
	}
	function remove(i: number) {
		list = list.filter((_, j) => j !== i);
	}
	function setYear(i: number, v: number | null) {
		const x = list[i]!;
		if (v !== null && 'waterYear' in x) list[i] = { ...x, waterYear: v };
	}
	function setDate(i: number, key: 'start' | 'end', v: string) {
		const x = list[i]!;
		if (!('waterYear' in x)) list[i] = { ...x, [key]: v };
	}
	function setReason(i: number, v: string) {
		list[i] = { ...list[i]!, reason: v };
	}
	const blankReason = (x: CalibrationExclusion) => !x.reason.trim();
</script>

<fieldset class="plain excl" aria-describedby="{uid}-hint">
	<legend>{legend} <HelpTip key={helpKey} label={helpLabel} /></legend>
	<p class="hint explain" id="{uid}-hint">{hint}</p>
	{#if list.length}
		<ol class="rows">
			{#each list as x, i (i)}
				<li class="row">
					{#if 'waterYear' in x}
						<div class="field year">
							<label for="{uid}-y{i}">Water year <span class="u">(starts Oct)</span></label>
							<NumberInput id="{uid}-y{i}" min={1800} max={2200} step={1} disabled={readonly} value={x.waterYear} onchange={(v) => setYear(i, v)} aria-describedby="{uid}-y{i}-h" />
							<span class="hint" id="{uid}-y{i}-h">WY {waterYearLabel(x.waterYear)}: {exclusionRange(x).start} – {exclusionRange(x).end}</span>
						</div>
					{:else}
						<div class="field">
							<label for="{uid}-s{i}">From</label>
							<input id="{uid}-s{i}" type="date" readonly={readonly} value={x.start} onchange={(e) => setDate(i, 'start', e.currentTarget.value)} />
						</div>
						<div class="field">
							<label for="{uid}-e{i}">To</label>
							<input id="{uid}-e{i}" type="date" readonly={readonly} value={x.end} onchange={(e) => setDate(i, 'end', e.currentTarget.value)} />
						</div>
					{/if}
					<div class="field reason">
						<label for="{uid}-r{i}">Reason</label>
						<input
							id="{uid}-r{i}"
							maxlength="500"
							readonly={readonly}
							{placeholder}
							value={x.reason}
							aria-invalid={blankReason(x) || undefined}
							class:invalid={blankReason(x)}
							oninput={(e) => setReason(i, e.currentTarget.value)}
						/>
					</div>
					{#if !readonly}
						<button type="button" class="btn btn-icon" aria-label="Remove {noun} {i + 1}" title="Remove" onclick={() => remove(i)}>✕</button>
					{/if}
				</li>
			{/each}
		</ol>
	{:else}
		<p class="muted small">{empty}</p>
	{/if}
	{#if !readonly}
		<div class="add">
			<button type="button" class="btn btn-sm" onclick={addYear}>{addYearLabel}</button>
			<button type="button" class="btn btn-sm" onclick={addRange}>{addRangeLabel}</button>
		</div>
	{/if}
	{#if error}<p class="err" role="alert">{error}.</p>{/if}
</fieldset>

<style>
	.plain {
		border: 0;
		padding: 0;
		margin: 0;
		min-width: 0;
	}
	legend {
		font-weight: 500;
		font-size: 0.85rem;
		color: var(--text-2);
		padding: 0;
		margin-bottom: 0.2rem;
	}
	.hint {
		font-size: 0.8rem;
		color: var(--text-muted);
		max-width: 75ch;
		margin: 0 0 0.4rem;
	}
	.u {
		font-weight: 400;
		color: var(--text-muted);
		font-size: 0.8rem;
	}
	.rows {
		list-style: none;
		padding: 0;
		margin: 0;
		display: grid;
		gap: 0.4rem;
	}
	.row {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-end;
		gap: 0.25rem 0.75rem;
	}
	.row .field {
		margin: 0;
	}
	.year {
		width: 180px;
	}
	.reason {
		flex: 1;
		min-width: min(100%, 240px);
	}
	.reason input {
		width: 100%;
	}
	.add {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		margin-top: 0.5rem;
	}
	.err {
		color: var(--danger);
		font-size: 0.8rem;
	}
	input.invalid {
		border-color: var(--danger);
	}
	@media (max-width: 640px) {
		.btn {
			min-height: 44px;
		}
	}
</style>
