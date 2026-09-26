<script lang="ts">
	// Each run's fit record side by side (issue #4): which fit produced its
	// parameters, its in-sample score and its validation scores.
	import { fitValidationRows, type FitValidationRow } from './fit';
	import type { ApanDailyFingerprint, FitRecord, ProjectSettings, SeriesProvenance } from '@water-management/engine';

	let {
		a,
		b,
		settingsA = null,
		settingsB = null,
		chirpsA,
		chirpsB,
		apanA,
		apanB
	}: {
		a: FitRecord | null;
		b: FitRecord | null;
		/** Each run's own settings snapshot, so "Forcing changed since fit" can be said for that run. */
		settingsA?: Partial<ProjectSettings> | null;
		settingsB?: Partial<ProjectSettings> | null;
		/** Each run's CHIRPS series product and version (issue #40c); undefined for a run that didn't record it. */
		chirpsA?: SeriesProvenance | null;
		chirpsB?: SeriesProvenance | null;
		/** Each run's daily A-pan series (issue #45); undefined for a run that didn't record it. */
		apanA?: ApanDailyFingerprint | null;
		apanB?: ApanDailyFingerprint | null;
	} = $props();
	const rows = $derived<FitValidationRow[] | null>(fitValidationRows(a, b, settingsA, settingsB, { a: chirpsA, b: chirpsB }, { a: apanA, b: apanB }));
</script>

<h3>Fit and validation</h3>
{#if rows}
	<p class="muted small">
		From each run’s fit record: the score its parameters got on the calibration period they were fitted to (in-sample), and on days they
		never saw. Judge the fit by the validation rows.
	</p>
	<div class="table-wrap">
		<table class="data compact">
			<caption class="visually-hidden">Fit and validation for both runs</caption>
			<thead><tr><th scope="col">Fit record</th><th scope="col">Run A</th><th scope="col">Run B</th></tr></thead>
			<tbody>
				{#each rows as r (r.label)}
					<tr><th scope="row">{r.label}</th><td>{r.a}</td><td>{r.b}</td></tr>
				{/each}
			</tbody>
		</table>
	</div>
{:else}
	<p class="muted small">Neither run’s parameters come from Fit automatically, so there are no validation scores to show.</p>
{/if}

<style>
	h3 {
		margin: 1rem 0 0.25rem;
	}
</style>
