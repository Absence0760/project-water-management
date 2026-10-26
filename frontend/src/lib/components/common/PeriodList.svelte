<!--
	An editable list of dated periods, each a whole water year or a date range
	with a required reason (the engine's CalibrationExclusion shape). Used for
	settings.calibrationExclusions and settings.zeroRainRuns' keep-dry and
	missing periods. Bind the list; `error` is set while it is invalid, so the
	parent form can block saving. The list's name and its two add buttons share its
	head row, so the buttons sit with the list they fill (a group named by the
	head, as a fieldset by its legend; ui-playbook.md § 2).
	calibration/LowFlowPeriods.svelte mirrors this layout with more fields.
-->
<script lang="ts">
	import { fmtDay, localIsoDate } from '#lib/format/number.js';
	import DayInput from '#lib/components/common/DayInput.svelte';
	import { exclusionsError, exclusionRange, waterYearLabel, type CalibrationExclusion } from '@water-management/engine';
	import NumberInput from '#lib/components/common/NumberInput.svelte';
	import HelpTip from '#lib/components/help/HelpTip.svelte';

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
		// The viewer's own day: the UTC one turns the water year two hours late in South Africa.
		const [year, month] = localIsoDate().split('-').map(Number);
		const current = year - (month >= 10 ? 0 : 1);
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

<div class="excl" role="group" aria-labelledby="{uid}-l" aria-describedby="{uid}-hint">
	<div class="head">
		<span class="legend"><span id="{uid}-l">{legend}</span> <HelpTip key={helpKey} label={helpLabel} /></span>
		{#if !readonly}
			<span class="add">
				<button type="button" class="btn btn-sm" onclick={addYear}>{addYearLabel}</button>
				<button type="button" class="btn btn-sm" onclick={addRange}>{addRangeLabel}</button>
			</span>
		{/if}
	</div>
	<p class="hint explain" id="{uid}-hint">{hint}</p>
	{#if list.length}
		<ol class="rows">
			{#each list as x, i (i)}
				<li class="row">
					{#if 'waterYear' in x}
						<div class="field year">
							<label for="{uid}-y{i}">Water year <span class="u">(starts Oct)</span></label>
							<NumberInput id="{uid}-y{i}" min={1800} max={2200} step={1} disabled={readonly} value={x.waterYear} onchange={(v) => setYear(i, v)} aria-describedby="{uid}-y{i}-h" />
							<span class="hint" id="{uid}-y{i}-h">WY {waterYearLabel(x.waterYear)}: <span class="day">{fmtDay(exclusionRange(x).start)}</span> – <span class="day">{fmtDay(exclusionRange(x).end)}</span></span>
						</div>
					{:else}
						<div class="field">
							<label for="{uid}-s{i}">From</label>
							<DayInput id="{uid}-s{i}" readonly={readonly} value={x.start} onchange={(v) => setDate(i, 'start', v)} />
						</div>
						<div class="field">
							<label for="{uid}-e{i}">To</label>
							<DayInput id="{uid}-e{i}" readonly={readonly} value={x.end} onchange={(v) => setDate(i, 'end', v)} />
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
	{#if error}<p class="err" role="alert">{error}.</p>{/if}
</div>

<style>
	/* A day never breaks inside itself ("30 / Sep 2022" on a phone). */
	.day {
		white-space: nowrap;
	}
	.excl {
		min-width: 0;
	}
	.head {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.25rem 0.75rem;
		margin-bottom: 0.2rem;
	}
	.legend {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		font-weight: 500;
		font-size: 0.85rem;
		color: var(--text-2);
	}
	.hint {
		font-size: var(--font-sm);
		color: var(--text-muted);
		max-width: 75ch;
		margin: 0 0 0.4rem;
	}
	.u {
		font-weight: 400;
		color: var(--text-muted);
		font-size: var(--font-sm);
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
	}
	.err {
		color: var(--danger);
		font-size: var(--font-sm);
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
