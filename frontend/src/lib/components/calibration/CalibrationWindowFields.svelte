<!--
	Settings fields for the outlet location's calibration window
	(settings.calibrationStart/End) and the flow record it is fitted on
	(settings.calibrationFlowKind). Where calibration fits is the locations
	table's (CalibrationLocationsTable.svelte, issue #659: the outlet and every
	gauge with a record, each ticked or not), so there is no "Scored at" here.
	Bind the values; `error` is set when the window is invalid so the parent
	form can block saving.
-->
<script lang="ts">
	import DayInput from '#lib/components/common/DayInput.svelte';
	import type { CalibrationFlowKind } from '@water-management/engine';
	import { FLOW_KIND_LABEL, windowError } from './metrics';

	let {
		start = $bindable(null),
		end = $bindable(null),
		flowKind = $bindable(null),
		error = $bindable(null),
		readonly = false,
		availableKinds = null,
		atGauges = false,
		dataHref = null
	}: {
		start: string | null;
		end: string | null;
		flowKind: CalibrationFlowKind | null;
		error?: string | null;
		readonly?: boolean;
		/** Series kinds the project has at the outlet; limits the flow options when given. */
		availableKinds?: string[] | null;
		/** A gauge inside the network has a record of its own, so the locations table lists it. */
		atGauges?: boolean;
		/**
		 * A flow record on the Data tab (`?tab=series&series=<id>#data-chart`), whose row says where it was
		 * measured: a record placed at a gauge inside the network makes that gauge a calibration location.
		 */
		dataHref?: string | null;
	} = $props();

	const uid = $props.id();
	const KINDS: CalibrationFlowKind[] = ['flow_observed_m3s', 'flow_logger_m3s'];
	// The outlet's records (a gauge's record is its row's, in the locations table).
	const options = $derived(KINDS.filter((k) => !availableKinds || availableKinds.includes(k) || k === flowKind));

	$effect(() => {
		error = windowError(start, end);
	});
</script>

<!-- id: the Warnings page lands on the field (`?field=fld-cal-window`, issue #611). -->
<fieldset class="plain cal-window" id="fld-cal-window" aria-describedby="{uid}-hint">
	<legend class="label">Calibration window</legend>
	<!-- The window and the record on one row (issue #521). -->
	<div class="form-row">
		<div class="field">
			<label for="{uid}-start">From</label>
			<DayInput
				id="{uid}-start"
				{readonly}
				value={start ?? ''}
				aria-invalid={error ? 'true' : undefined}
				onchange={(v) => (start = v || null)}
			/>
		</div>
		<div class="field">
			<label for="{uid}-end">To</label>
			<DayInput
				id="{uid}-end"
				{readonly}
				value={end ?? ''}
				aria-invalid={error ? 'true' : undefined}
				onchange={(v) => (end = v || null)}
			/>
		</div>
		<div class="field">
			<label for="{uid}-kind">Compare with</label>
			<select id="{uid}-kind" disabled={readonly} bind:value={flowKind}>
				<option value={null}>Default (observed gauge, else logger)</option>
				{#each options as k (k)}<option value={k}>{FLOW_KIND_LABEL[k]}</option>{/each}
			</select>
		</div>
	</div>
	{#if !atGauges && dataHref && !readonly}
		<!-- No gauge has a record of its own yet: say where one is placed, or no gauge location ever appears. -->
		<p class="hint muted explain" data-testid="calibration-site-how">
			To calibrate at a gauge inside the network too, set its flow record's <strong>Measured at</strong> in Series details on the <a href={dataHref}>Data tab</a> (the gauge has to be in the network, above the outlet).
		</p>
	{/if}
	<p class="hint muted explain" id="{uid}-hint">
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
		font-size: var(--font-sm);
		max-width: 75ch;
		margin: 0 0 0.5rem;
	}
	/* A field never wider than its row: "Compare with"'s longest option would push it past a 320 px screen. */
	.form-row .field {
		margin-bottom: 0.5rem;
		max-width: 100%;
	}
	.form-row select {
		max-width: 100%;
	}
	.err {
		color: var(--danger);
		font-size: 0.85rem;
	}
</style>
