<script lang="ts">
	// The workbook part of the import review (WP-1.31): the gauge-as-reference
	// option, the importer's notes with their severity, and the unmapped
	// report (plan.md 1b: what couldn't be carried across as the workbook
	// meant, with sheet, cell and element). Everything here comes from the
	// file (farm names, formula text), so it is rendered as text only: plain
	// interpolation, never {@html}.
	import { location, type WorkbookReport } from './workbookFile';

	let {
		report,
		gaugeAsReference = $bindable(false),
		scalingFrom = $bindable(''),
		scaleFactor = $bindable(''),
		optionsError = null,
		updating = false,
		disabled = false,
		onoptions
	}: {
		report: WorkbookReport;
		gaugeAsReference?: boolean;
		scalingFrom?: string;
		scaleFactor?: string;
		/** Why the gauge options don't go together, or the importer refused them. */
		optionsError?: string | null;
		/** Re-extracting with new options. */
		updating?: boolean;
		disabled?: boolean;
		/** The options changed (a checkbox toggled, a field committed). */
		onoptions: () => void;
	} = $props();

	const warnings = $derived(report.notes.filter((n) => n.severity === 'warning').length);
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

<section class="report" aria-labelledby="wb-notes-h">
	<h3 id="wb-notes-h">Importer notes</h3>
	{#if report.notes.length}
		<p class="hint muted">
			{report.notes.length === 1 ? 'One note' : `${report.notes.length} notes`}{warnings ? `, ${warnings} of them ${warnings === 1 ? 'a warning' : 'warnings'}` : ''}. Read them before relying on a run.
		</p>
		<ul class="notes">
			{#each report.notes as note, i (i)}
				<li>
					<span class="badge" class:badge-warn={note.severity === 'warning'}>{note.severity === 'warning' ? 'Warning' : 'Note'}</span>
					<span class="msg">{note.message.replace(/^WARNING: /, '')}</span>
					{#if location(note)}<span class="where muted">({location(note)})</span>{/if}
				</li>
			{/each}
		</ul>
	{:else}
		<p class="hint muted">None.</p>
	{/if}
</section>

<section class="report" aria-labelledby="wb-unmapped-h">
	<h3 id="wb-unmapped-h">Unmapped report: not carried across as the workbook meant</h3>
	{#if report.unmapped.length}
		<p class="hint muted">
			The importer couldn't map {report.unmapped.length === 1 ? 'this' : `these ${report.unmapped.length} items`} onto the app's model exactly.
			It never changes a value on its own: check each against the workbook, and fix the project after importing if needed.
		</p>
		<div class="table-wrap">
			<table class="data compact">
				<caption class="visually-hidden">Unmapped items</caption>
				<thead>
					<tr><th scope="col">Where</th><th scope="col">Element</th><th scope="col">What</th><th scope="col">In the workbook</th></tr>
				</thead>
				<tbody>
					{#each report.unmapped as item, i (i)}
						<tr>
							<td class="nowrap">{location(item) || '—'}</td>
							<td>{item.element ?? '—'}</td>
							<td>{item.message}</td>
							<td>{#if item.text}<code>{item.text}</code>{:else}—{/if}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{:else}
		<p class="hint muted">Nothing: everything in the workbook was mapped.</p>
	{/if}
</section>

<style>
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
	.report h3 {
		font-size: 0.9rem;
		margin: 0.75rem 0 0.3rem;
	}
	.notes {
		list-style: none;
		padding: 0;
		margin: 0 0 0.5rem;
		display: grid;
		gap: 0.35rem;
	}
	.notes li {
		overflow-wrap: anywhere;
		font-size: 0.85rem;
	}
	.notes .badge {
		margin-right: 0.35rem;
	}
	.where {
		margin-left: 0.25rem;
	}
	.table-wrap {
		overflow-x: auto;
		margin-bottom: 0.5rem;
	}
	table {
		width: 100%;
		font-size: 0.85rem;
	}
	td {
		overflow-wrap: anywhere;
		vertical-align: top;
	}
	.nowrap {
		white-space: nowrap;
	}
	code {
		font-family: var(--font-mono, ui-monospace, monospace);
		font-size: 0.85em;
		overflow-wrap: anywhere;
	}
	.hint,
	.small {
		font-size: 0.8rem;
	}
</style>
