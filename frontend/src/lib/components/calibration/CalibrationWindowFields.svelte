<!--
	Settings fields for the calibration window (settings.calibrationStart/End)
	and the flow record it is scored against (settings.calibrationFlowKind).
	Bind the three values; `error` is set when the window is invalid so the
	parent form can block saving.
-->
<script lang="ts">
	import type { CalibrationFlowKind } from '@water-management/engine';
	import { FLOW_KIND_LABEL, windowError } from './metrics';

	let {
		start = $bindable(null),
		end = $bindable(null),
		flowKind = $bindable(null),
		error = $bindable(null),
		readonly = false,
		availableKinds = null
	}: {
		start: string | null;
		end: string | null;
		flowKind: CalibrationFlowKind | null;
		error?: string | null;
		readonly?: boolean;
		/** Series kinds the project has; limits the flow options when given. */
		availableKinds?: string[] | null;
	} = $props();

	const uid = $props.id();
	const KINDS: CalibrationFlowKind[] = ['flow_observed_m3s', 'flow_logger_m3s'];
	const options = $derived(KINDS.filter((k) => !availableKinds || availableKinds.includes(k) || k === flowKind));

	$effect(() => {
		error = windowError(start, end);
	});
</script>

<fieldset class="plain cal-window" aria-describedby="{uid}-hint">
	<legend class="label">Calibration window</legend>
	<div class="form-row">
		<div class="field">
			<label for="{uid}-start">From</label>
			<input
				id="{uid}-start"
				type="date"
				{readonly}
				value={start ?? ''}
				aria-invalid={error ? 'true' : undefined}
				onchange={(e) => (start = e.currentTarget.value || null)}
			/>
		</div>
		<div class="field">
			<label for="{uid}-end">To</label>
			<input
				id="{uid}-end"
				type="date"
				{readonly}
				value={end ?? ''}
				aria-invalid={error ? 'true' : undefined}
				onchange={(e) => (end = e.currentTarget.value || null)}
			/>
		</div>
	</div>
	<div class="field">
		<label for="{uid}-kind">Compare with</label>
		<select id="{uid}-kind" disabled={readonly} bind:value={flowKind}>
			<option value={null}>Default (observed gauge, else logger)</option>
			{#each options as k (k)}<option value={k}>{FLOW_KIND_LABEL[k]}</option>{/each}
		</select>
	</div>
	<p class="hint muted" id="{uid}-hint">
		Calibration statistics only score days inside this window. Leave blank to use every day with an observation. The
		workbook calibrates on a fixed period (e.g. Oct 2005 – Sep 2012).
	</p>
	{#if error}<p class="err" role="alert">{error}</p>{/if}
</fieldset>

<style>
	.cal-window {
		border: 0;
		padding: 0;
		margin: 0;
		min-width: 0;
	}
	/* The form's own label and hint styles, so the window reads like its neighbours. */
	legend {
		font-weight: 500;
		font-size: 0.85rem;
		color: var(--text-2);
		margin-bottom: 0.35rem;
		padding: 0;
	}
	.hint {
		font-size: 0.8rem;
		max-width: 75ch;
		margin: 0.4rem 0 0.75rem;
	}
	.err {
		color: var(--danger);
		font-size: 0.85rem;
	}
</style>
