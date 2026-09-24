<!--
	Where a set of parameters came from (issue #4): the fit record Apply
	stored, with how the fit was made and its in-sample score next to its
	validation scores, plus anything that has changed since. Used on the Runs
	page (the run's own snapshot) and under Fit automatically in Settings (the
	form as it stands).
-->
<script lang="ts">
	import { exclusionLabel, fitRecordCaveats, fitRecordStatus, type FitRecord, type ProjectSettings } from '@water-management/engine';
	import { fittedAtText, objectiveName, scoreColumns, waterYearsText } from '$lib/calibration/fit';
	import { FLOW_KIND_LABEL } from '$lib/components/calibration/metrics';
	import HelpTip from '$lib/components/help/HelpTip.svelte';
	import { fmtNum } from '$lib/format/number';
	import { paramLabel } from './provenance';

	let {
		record,
		settings,
		heading = 'Where the parameters came from',
		headingLevel = 3,
		context = 'run'
	}: {
		record: FitRecord | null | undefined;
		/** The settings the record sits in (a run's snapshot, or the form). */
		settings: Partial<ProjectSettings>;
		heading?: string;
		headingLevel?: 3 | 4;
		/** 'run': a stored run; 'form': the unsaved Settings form. */
		context?: 'run' | 'form';
	} = $props();

	const uid = $props.id();
	const status = $derived(record ? fitRecordStatus(settings, record) : null);
	const caveats = $derived(status ? fitRecordCaveats(status, (k) => paramLabel(record!.model, k)) : []);
	// The in-sample fit, then the validation parts: the columns a reader should judge by.
	const columns = $derived(record ? scoreColumns(record).filter((c) => c.id !== 'before' && (c.id === 'fit' || c.validation)) : []);
	const score = (v: number | null | undefined) => (v === null || v === undefined ? '–' : fmtNum(v, 2));
	const windowText = (r: FitRecord) =>
		r.calibrationStart || r.calibrationEnd ? `${r.calibrationStart ?? 'start of record'} – ${r.calibrationEnd ?? 'end of record'}` : 'whole record';
	const exclusions = $derived((settings.calibrationExclusions ?? []) as FitRecord['exclusions']);
</script>

<section class="prov" aria-labelledby="{uid}-h">
	<svelte:element this={`h${headingLevel}`} id="{uid}-h">{heading} <HelpTip key="settings.fitRecord" /></svelte:element>
	{#if !record}
		<p class="muted small">
			No fit record: {context === 'run' ? 'this run’s' : 'these'} parameters were set by hand, imported, or saved before fit records existed. Nothing
			shows how they were validated.
		</p>
	{:else}
		<p class="small">
			<strong>{record.model === 'gr4j' ? 'GR4J' : 'Legacy'} fit of {fittedAtText(record.fittedAt)}</strong>
			{#if status && status.editedParams.length}<span class="badge badge-warn">Parameters edited since fit</span>{/if}
		</p>
		{#each caveats as c (c)}<p class="alert alert-warning small" role="status">{c}</p>{/each}
		<dl class="meta">
			<div><dt>Objective</dt><dd>{objectiveName(record.objective)}</dd></div>
			<div><dt>Bounds</dt><dd>{record.bounds === 'typical' ? 'typical (Perrin et al. 80 %)' : 'wide'}</dd></div>
			<div><dt>Seed</dt><dd>{record.seed}</dd></div>
			<div><dt>Model runs</dt><dd>{fmtNum(record.budget)} per fit, {fmtNum(record.evaluations)} in all{record.cancelled ? ' (cancelled)' : ''}</dd></div>
			<div><dt>Engine</dt><dd>{record.engineVersion}</dd></div>
			<div><dt>Fitted to</dt><dd>{FLOW_KIND_LABEL[record.flowKind] ?? record.flowKind}, {windowText(record)}</dd></div>
			<div>
				<dt>Excluded</dt>
				<dd>
					{#if record.exclusions.length}
						{record.exclusions.map((x) => `${exclusionLabel(x)} (${x.reason})`).join('; ')}
					{:else}none{/if}
				</dd>
			</div>
			{#if record.marPenalty}
				{@const m = record.marPenalty}
				{@const target = m.marLowMm3 !== null && m.marHighMm3 !== null ? `${fmtNum(m.marLowMm3, 3)}–${fmtNum(m.marHighMm3, 3)} Mm³/a band` : 'WR2012'}
				<div>
					<dt>WR2012 MAR penalty</dt>
					<dd>
						weight {fmtNum(m.weight, 2)}: simulated MAR {fmtNum(m.marRatio, 2)} × {target}{m.unpenalised ? ` (${fmtNum(m.unpenalised.marRatio, 2)} × without the penalty)` : ''}
					</dd>
				</div>
			{/if}
			<div><dt>Parameters fitted</dt><dd>{record.free.map((k) => `${paramLabel(record.model, k)} ${fmtNum(record.params[k], 3)}`).join(', ')}</dd></div>
		</dl>
		<div class="table-wrap">
			<table class="data compact">
				<caption>{objectiveName(record.objective)}: the fit to the calibration period (in-sample), and on days it never saw</caption>
				<thead>
					<tr>
						{#each columns as c (c.id)}
							<th scope="col" class="num" class:val={c.validation}>
								{c.id === 'fit' ? 'Calibration period (in-sample)' : c.label}<br /><span class="period">{c.period}</span>
							</th>
						{/each}
					</tr>
				</thead>
				<tbody>
					<tr>
						{#each columns as c (c.id)}
							<td class="num" class:val={c.validation}>{score(c.scores[record.objective])}</td>
						{/each}
					</tr>
				</tbody>
			</table>
		</div>
		{#if columns.length === 1}
			<p class="alert alert-warning small">This fit was not validated: nothing shows how it does on days it wasn’t fitted to.</p>
		{/if}
		{#if record.differential}
			<p class="muted small">Dry → wet: fitted on {waterYearsText(record.differential.dryYears)}, scored on {waterYearsText(record.differential.wetYears)}.</p>
		{/if}
		{#each record.notes as n (n)}<p class="muted small note">{n}</p>{/each}
	{/if}
	{#if context === 'run' && exclusions.length}
		<p class="small">
			This run’s calibration statistics leave out {exclusions.map((x) => `${exclusionLabel(x)} (${x.reason})`).join('; ')}.
		</p>
	{/if}
</section>

<style>
	.prov {
		margin: 0.25rem 0 0.75rem;
	}
	h3,
	h4 {
		margin: 0 0 0.35rem;
	}
	.small {
		font-size: 0.8rem;
	}
	.meta {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
		gap: 0.25rem 1rem;
		margin: 0.4rem 0;
		font-size: 0.8rem;
	}
	.meta dt {
		color: var(--text-muted);
	}
	.meta dd {
		margin: 0;
	}
	caption {
		text-align: left;
		font-weight: 500;
		padding-bottom: 0.25rem;
		font-size: 0.85rem;
	}
	th.val,
	td.val {
		background: var(--accent-soft);
	}
	.period {
		font-weight: 400;
		font-size: 0.72rem;
		color: var(--text-muted);
	}
	.badge {
		margin-left: 0.4rem;
	}
	.note {
		margin: 0.2rem 0;
	}
</style>
