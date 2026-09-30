<!--
	Settings fields for the calibration window (settings.calibrationStart/End),
	the flow record it is scored against (settings.calibrationFlowKind) and
	where (settings.calibrationSiteNodeId, engine ≥ 1.41.0: the outlet, or a
	gauge inside the network with a record of its own). Bind the values;
	`error` is set when the window is invalid so the parent form can block
	saving.
-->
<script lang="ts">
	import type { CalibrationFlowKind, CalibrationSite } from '@water-management/engine';
	import { FLOW_KIND_LABEL, windowError } from './metrics';

	let {
		start = $bindable(null),
		end = $bindable(null),
		flowKind = $bindable(null),
		siteNodeId = $bindable(null),
		error = $bindable(null),
		readonly = false,
		availableKinds = null,
		sites = []
	}: {
		start: string | null;
		end: string | null;
		flowKind: CalibrationFlowKind | null;
		/** null = the outlet. */
		siteNodeId?: string | null;
		error?: string | null;
		readonly?: boolean;
		/** Series kinds the project has at the outlet; limits the flow options when given. */
		availableKinds?: string[] | null;
		/** The gauges inside the network with a record (engine calibrationSites): the other places calibration can score. */
		sites?: CalibrationSite[];
	} = $props();

	const uid = $props.id();
	const KINDS: CalibrationFlowKind[] = ['flow_observed_m3s', 'flow_logger_m3s'];
	const site = $derived(siteNodeId ? (sites.find((x) => x.nodeId === siteNodeId) ?? null) : null);
	// The records where calibration scores: the outlet's, or the chosen gauge's.
	const kindsHere = $derived(siteNodeId ? (site?.records ?? []) : availableKinds);
	const options = $derived(KINDS.filter((k) => !kindsHere || kindsHere.includes(k) || k === flowKind));

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
	{#if sites.length || siteNodeId}
		<div class="field">
			<label for="{uid}-site">Scored at</label>
			<select id="{uid}-site" disabled={readonly} bind:value={siteNodeId} aria-describedby="{uid}-site-hint">
				<option value={null}>The outlet</option>
				{#each sites as g (g.nodeId)}<option value={g.nodeId}>{g.name}</option>{/each}
				{#if siteNodeId && !site}<option value={siteNodeId}>A gauge no longer in the model, or with no record</option>{/if}
			</select>
			{#if siteNodeId && !site}
				<p class="warn" role="status" data-testid="calibration-site-gone">
					The saved site's gauge is no longer in the model, or no flow record is attached to it any more. Runs score the outlet's record
					and warn, and Fit automatically refuses the site: pick another gauge, or the outlet.
				</p>
			{/if}
			<p class="hint muted" id="{uid}-site-hint">
				At a gauge inside the network, a fit scores the simulated flow there against that gauge's record. The gauged ranges and gap
				filling below are the outlet records', so they don't apply to it. A run scores its calibration statistics here too; the
				outlet's EWR test stays the outlet's.
			</p>
		</div>
	{/if}
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
	.warn {
		color: var(--warning);
		font-size: 0.85rem;
		margin: 0.4rem 0 0;
		max-width: 75ch;
	}
	.err {
		color: var(--danger);
		font-size: 0.85rem;
	}
</style>
