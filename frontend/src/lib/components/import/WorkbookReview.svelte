<script lang="ts">
	// The workbook part of the import review (WP-1.31): the gauge-as-reference
	// option, then the importer's notes and the unmapped report
	// (ImportReportLists, shared with the Overview's import record).
	// Everything here comes from the file (farm names, formula text), so it is
	// rendered as text only: plain interpolation, never {@html}.
	import { CHIRPS_CHOICES } from '$lib/series/provenance';
	import ImportReportLists from './ImportReportLists.svelte';
	import { DEFAULT_CHIRPS_KEY, type WorkbookReport } from './workbookFile';

	let {
		report,
		gaugeAsReference = $bindable(false),
		scalingFrom = $bindable(''),
		scaleFactor = $bindable(''),
		chirpsKey = $bindable(DEFAULT_CHIRPS_KEY),
		optionsError = null,
		updating = false,
		disabled = false,
		onoptions
	}: {
		report: WorkbookReport;
		gaugeAsReference?: boolean;
		scalingFrom?: string;
		scaleFactor?: string;
		/** The CHIRPS column's product and version, as a provenance key ('' = not known). */
		chirpsKey?: string;
		/** Why the gauge options don't go together, or the importer refused them. */
		optionsError?: string | null;
		/** Re-extracting with new options. */
		updating?: boolean;
		disabled?: boolean;
		/** The options changed (a checkbox toggled, a field committed). */
		onoptions: () => void;
	} = $props();
</script>

{#if report.hasGauge}
	<fieldset class="gauge" {disabled}>
		<legend>Gauge column</legend>
		<label class="check">
			<input type="checkbox" bind:checked={gaugeAsReference} onchange={onoptions} aria-describedby="wb-gauge-hint" />
			It's a gauge on another river: import it as a reference gauge
		</label>
		<p class="hint muted" id="wb-gauge-hint">
			A reference gauge is shown for comparison but never calibrated against. Leave this off if the gauge measures this catchment's outflow.
		</p>
		{#if gaugeAsReference}
			<div class="scaling">
				<div class="field">
					<label for="wb-scale-from">Scaling starts on (optional)</label>
					<input id="wb-scale-from" type="date" bind:value={scalingFrom} onchange={onoptions} aria-describedby="wb-scale-hint" />
				</div>
				<div class="field">
					<label for="wb-scale-factor">Scale factor (optional)</label>
					<input
						id="wb-scale-factor"
						inputmode="decimal"
						bind:value={scaleFactor}
						onchange={onoptions}
						aria-describedby="wb-scale-hint"
						placeholder="e.g. 0.8"
					/>
				</div>
			</div>
			<p class="hint muted" id="wb-scale-hint">
				If the workbook's gauge values were scaled (by catchment area, say) from a date on, give the date and the factor and the
				values from then on are divided by it.
			</p>
		{/if}
		{#if optionsError}<p class="options-error" role="alert">{optionsError}</p>{/if}
		<p class="muted small" role="status">{updating ? 'Updating the preview…' : ''}</p>
	</fieldset>
{/if}

{#if report.hasChirps}
	<div class="field chirps">
		<label for="wb-chirps">CHIRPS column</label>
		<select id="wb-chirps" bind:value={chirpsKey} {disabled} aria-describedby="wb-chirps-hint">
			{#each CHIRPS_CHOICES as c (c.value)}<option value={c.value}>{c.label}{c.value === DEFAULT_CHIRPS_KEY ? ' (usual for b023)' : ''}</option>{/each}
			<option value="">Not known</option>
		</select>
		<p class="hint muted" id="wb-chirps-hint">
			Which CHIRPS the workbook holds. b023 workbooks were built on v2.0; the CHIRPS data feed writes v3.0, and the two differ by an amount
			that changes over the years, so the feed won’t add to this series without asking.
		</p>
	</div>
{/if}

<ImportReportLists notes={report.notes} unmapped={report.unmapped} />

<style>
	.chirps {
		margin: 0.75rem 0;
	}
	.gauge {
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: 0.5rem 0.75rem 0.25rem;
		margin: 0.75rem 0;
		min-width: 0;
	}
	legend {
		font-weight: 600;
		font-size: 0.9rem;
		padding: 0 0.25rem;
	}
	.check {
		display: flex;
		align-items: flex-start;
		gap: 0.5rem;
		font-weight: 500;
	}
	.check input {
		margin-top: 0.2rem;
	}
	.scaling {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr));
		gap: 0 1rem;
		margin-top: 0.5rem;
	}
	.options-error {
		color: var(--danger, var(--text));
		font-size: 0.85rem;
		margin: 0.25rem 0 0;
	}
	.hint,
	.small {
		font-size: 0.8rem;
	}
</style>
