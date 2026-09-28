<!--
	settings.chirpsFitPeriod (engine ≥ 0.29.0, issue #40, docs/model.md §2.4b):
	which part of the record the CHIRPS factors are fitted on. The whole
	record, or water-year ranges the hydrologist lists, each with a reason.
	`propose` (optional) fills the list from the double-mass breaks for the
	hydrologist to check; nothing is saved until Save. `error` is set while the
	list is invalid, so the parent form can block saving. Switching away from
	the list and back keeps it for the session.
-->
<script lang="ts">
	import { waterYearLabel, type ChirpsFitPeriod, type ChirpsFitRange } from '@water-management/engine';
	import NumberInput from '$lib/components/common/NumberInput.svelte';
	import HelpTip from '$lib/components/help/HelpTip.svelte';
	import { CHIRPS_FIT_OPTIONS, chirpsFitChoice, chirpsFitRangesError, type ChirpsFitChoice } from './rain';
	import type { FitRangeProposal } from './fitRangeProposal';

	let {
		value = $bindable(),
		error = $bindable(null),
		readonly = false,
		inactive = false,
		propose
	}: {
		value: ChirpsFitPeriod;
		error?: string | null;
		readonly?: boolean;
		/** Bias correction is off: the fit period is kept (and still checked) but not used. */
		inactive?: boolean;
		/** Ranges proposed from the double-mass breaks, or why there are none. */
		propose?: () => Promise<FitRangeProposal>;
	} = $props();

	let proposing = $state(false);
	let proposeNote = $state<string | null>(null);
	async function runProposal() {
		if (!propose) return;
		proposing = true;
		proposeNote = null;
		try {
			const r = await propose();
			if ('ranges' in r) {
				if (Array.isArray(value)) kept = value;
				value = r.ranges;
				proposeNote = `Proposed ${r.ranges.length} ranges from the double-mass breaks. Check each against the station history and the CHIRPS version, and rewrite its reason, before saving.`;
			} else proposeNote = r.reason;
		} catch {
			proposeNote = 'Could not load the rain series to propose ranges. Try again.';
		} finally {
			proposing = false;
		}
	}

	const uid = $props.id();
	const choice = $derived(chirpsFitChoice(value));
	const option = $derived(CHIRPS_FIT_OPTIONS.find((o) => o.value === choice));
	const ranges = $derived(Array.isArray(value) ? value : []);
	/** The last list, so switching to another choice and back doesn't lose it. */
	let kept: ChirpsFitRange[] = [];

	$effect(() => {
		error = Array.isArray(value) ? chirpsFitRangesError(value) : null;
	});

	/** Last complete water year. */
	function lastWaterYear(): number {
		const now = new Date();
		return now.getUTCFullYear() - (now.getUTCMonth() + 1 >= 10 ? 1 : 2);
	}

	function choose(c: ChirpsFitChoice) {
		if (Array.isArray(value)) kept = value;
		if (c === 'ranges') {
			const y = lastWaterYear();
			value = kept.length ? kept : [{ fromWaterYear: y - 9, toWaterYear: y, reason: '' }];
		} else value = c;
	}
	function add() {
		const first = Math.min(...ranges.map((r) => r.fromWaterYear));
		const to = Number.isFinite(first) ? first - 1 : lastWaterYear();
		value = [...ranges, { fromWaterYear: to - 9, toWaterYear: to, reason: '' }];
	}
	function remove(i: number) {
		value = ranges.filter((_, j) => j !== i);
	}
	function set(i: number, patch: Partial<ChirpsFitRange>) {
		value = ranges.map((r, j) => (j === i ? { ...r, ...patch } : r));
	}
</script>

<div class="fit-period" data-testid="chirps-fit-period">
	<div class="field mode">
		<span class="lbl"><label for="{uid}-mode">CHIRPS fit period</label><HelpTip key="settings.chirpsFitPeriod" /></span>
		<select
			id="{uid}-mode"
			disabled={readonly}
			value={choice}
			onchange={(e) => choose(e.currentTarget.value as ChirpsFitChoice)}
			aria-describedby="{uid}-h"
		>
			{#each CHIRPS_FIT_OPTIONS as o (o.value)}<option value={o.value}>{o.label}</option>{/each}
		</select>
		<span class="hint" id="{uid}-h">{option?.help}</span>
		{#if inactive}<span class="hint" data-testid="chirps-fit-inactive">Not used while CHIRPS bias correction is off: raw CHIRPS has no factors. The setting is kept for when it is turned back on.</span>{/if}
	</div>
	{#if propose && !readonly}
		<div class="propose">
			<button type="button" class="btn btn-sm" disabled={proposing} onclick={runProposal}>
				{proposing ? 'Proposing…' : 'Propose from the double-mass breaks'}
			</button>
			{#if proposeNote}<p class="hint" role="status" data-testid="chirps-fit-proposal">{proposeNote}</p>{/if}
		</div>
	{/if}
	{#if choice === 'ranges'}
		<fieldset class="plain">
			<legend>Fit ranges</legend>
			<ol class="rows">
				{#each ranges as r, i (i)}
					<li class="row">
						<div class="field year">
							<label for="{uid}-f{i}">From water year <span class="u">(starts Oct)</span></label>
							<NumberInput id="{uid}-f{i}" min={1800} max={2200} step={1} disabled={readonly} value={r.fromWaterYear} onchange={(v) => v !== null && set(i, { fromWaterYear: v })} aria-describedby="{uid}-f{i}-h" />
							<span class="hint" id="{uid}-f{i}-h">WY {waterYearLabel(r.fromWaterYear)}</span>
						</div>
						<div class="field year">
							<label for="{uid}-t{i}">To water year</label>
							<NumberInput id="{uid}-t{i}" min={1800} max={2200} step={1} disabled={readonly} value={r.toWaterYear} onchange={(v) => v !== null && set(i, { toWaterYear: v })} aria-describedby="{uid}-t{i}-h" />
							<span class="hint" id="{uid}-t{i}-h">WY {waterYearLabel(r.toWaterYear)}</span>
						</div>
						<div class="field reason">
							<label for="{uid}-r{i}">Reason</label>
							<input
								id="{uid}-r{i}"
								maxlength="500"
								readonly={readonly}
								placeholder="e.g. new rain-gauge network from 2005; CHIRPS v2 → v3"
								value={r.reason}
								aria-invalid={!r.reason.trim() || undefined}
								class:invalid={!r.reason.trim()}
								oninput={(e) => set(i, { reason: e.currentTarget.value })}
							/>
						</div>
						{#if !readonly && ranges.length > 1}
							<button type="button" class="btn btn-icon" aria-label="Remove fit range {i + 1}" title="Remove" onclick={() => remove(i)}>✕</button>
						{/if}
					</li>
				{/each}
			</ol>
			{#if !readonly}
				<div class="add"><button type="button" class="btn btn-sm" onclick={add}>Add a range</button></div>
			{/if}
			{#if error}<p class="err" role="alert">{error}.</p>{/if}
		</fieldset>
	{/if}
</div>

<style>
	.fit-period {
		display: grid;
		gap: 0.5rem;
		margin-bottom: 0.75rem;
	}
	.mode {
		max-width: 75ch;
	}
	.mode select {
		max-width: 320px;
	}
	.lbl {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
	}
	.lbl label,
	legend {
		font-weight: 500;
		font-size: 0.85rem;
		color: var(--text-2);
	}
	.plain {
		border: 0;
		padding: 0;
		margin: 0;
		min-width: 0;
	}
	legend {
		padding: 0;
		margin-bottom: 0.2rem;
	}
	.hint {
		font-size: 0.8rem;
		color: var(--text-muted);
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
		width: 160px;
	}
	.reason {
		flex: 1;
		min-width: min(100%, 240px);
	}
	.reason input {
		width: 100%;
	}
	.add {
		margin-top: 0.5rem;
	}
	.propose {
		display: grid;
		gap: 0.25rem;
		justify-items: start;
		max-width: 75ch;
	}
	.err {
		color: var(--danger);
		font-size: 0.8rem;
	}
	input.invalid {
		border-color: var(--danger);
	}
</style>
