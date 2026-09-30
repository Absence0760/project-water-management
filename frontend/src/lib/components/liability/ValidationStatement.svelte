<script lang="ts">
	// The validation statement of a run (WP-3.13, model.md §2.10f): the
	// engine's validationStatement() over the stored summary, so it needs no
	// request. Printed in the report, and on screen in ValidationPanel (the
	// run's Record group, the scenario view); the known limitations are
	// generated from docs/engine-audit.md. The build's invariant suite and soak
	// come from the record CI injects (lib/engineBuild.ts), shown only for a
	// run this engine version made.
	import { validationStatement, type EngineBuild, type RunSummary } from '@water-management/engine';
	import { ENGINE_BUILD } from '$lib/engineBuild';
	import { fmtDay, fmtNum } from '$lib/format/number';

	let {
		summary,
		engineVersion,
		legacy,
		build = ENGINE_BUILD,
		headingLevel = 3
	}: {
		summary: RunSummary;
		engineVersion: string;
		legacy: boolean;
		/** This build's engine test record; the injected one unless a test passes its own. */
		build?: EngineBuild | null;
		/** The level of its own headings (Calibration, Data quality, Known limitations): one below the heading it sits under. */
		headingLevel?: 3 | 4;
	} = $props();
	const h = $derived(`h${headingLevel}`);

	const v = $derived(validationStatement({ summary, engineVersion, legacy }, build));
	const uid = `vs-${Math.random().toString(36).slice(2, 9)}`;
	const metric = (x: number | null, id: string) => (x == null ? '–' : id === 'pbias' ? `${fmtNum(x, 1)} %` : fmtNum(x, 2));
</script>

<div class="validation">
	<dl class="kv">
		<div><dt>Engine version</dt><dd>{v.engineVersion}</dd></div>
		<div>
			<dt>Invariant suite and soak for this build</dt>
			<dd>
				{#if v.build}
					{v.build.invariantsPassed ? 'Passed' : 'FAILED'}, {fmtNum(v.build.soakCases)} random catchments (build {v.build.gitSha.slice(0, 7)})
				{:else}
					Not recorded for this build
				{/if}
			</dd>
		</div>
		<div>
			<dt>Self-checks on this run</dt>
			<dd>
				{#if !v.selfChecks}Not run (made before the self-checks existed){:else if v.selfChecks.passed}All passed{:else}Failed: {v.selfChecks.failed.join('; ')}{/if}
			</dd>
		</div>
		<div>
			<dt>Runoff coefficient (audit W1)</dt>
			<dd>
				{#if !v.runoffCoefficient}–{:else}{fmtNum(v.runoffCoefficient.value, 2)}{#if !v.runoffCoefficient.plausible}<strong> — above 1, physically impossible</strong>{/if}{/if}
			</dd>
		</div>
	</dl>

	{#if v.legacy}
		<p class="alert alert-warning">Legacy runoff model (b023 workbook, removed in engine 1.0.0): it does not conserve water at the event scale (audit H1). Not evidence.</p>
	{/if}

	<svelte:element this={h} id="{uid}-cal">Calibration</svelte:element>
	{#if v.calibration}
		<p class="muted small">
			{fmtNum(v.calibration.days)} days with an observed flow{v.calibration.windowStart
				? `, ${fmtDay(v.calibration.windowStart)} – ${fmtDay(v.calibration.windowEnd ?? v.calibration.windowStart)}`
				: ''}.
		</p>
		<div class="table-wrap">
			<table class="data compact" aria-labelledby="{uid}-cal">
				<thead><tr><th scope="col">Statistic</th><th scope="col" class="num">Value</th><th scope="col">Rating (Moriasi et al. 2007)</th></tr></thead>
				<tbody>
					{#each v.calibration.metrics as m (m.id)}
						<tr><th scope="row">{m.label}</th><td class="num">{metric(m.value, m.id)}</td><td>{m.rating ?? 'no published rating'}</td></tr>
					{/each}
				</tbody>
			</table>
		</div>
		<p class="note small">{v.calibration.caveat}</p>
	{:else}
		<p>Not calibrated: the run had no observed flow inside its calibration window.</p>
	{/if}

	<svelte:element this={h}>Data quality</svelte:element>
	{#if v.flaggedYears.length}
		<p>Water years whose catchment rain reads far below CHIRPS:</p>
		<ul>
			{#each v.flaggedYears as y (y.start)}<li>{fmtDay(y.start)} – {y.end ? fmtDay(y.end) : '…'}: {fmtNum(y.ratio * 100)} % of CHIRPS</li>{/each}
		</ul>
	{/if}
	{#if v.dataQuality.length}
		<ul>
			{#each v.dataQuality as line, i (i)}<li>{line}</li>{/each}
		</ul>
	{:else}
		<p>No data-quality check fired on this run’s inputs.</p>
	{/if}

	<svelte:element this={h} id="{uid}-lim">Known limitations</svelte:element>
	<p class="muted small">
		The engine audit’s open items (docs/engine-audit.md), each still waiting on a hydrologist’s or assessor’s judgement. They apply to every run of
		this engine version.
	</p>
	<div class="table-wrap">
		<table class="data compact" aria-labelledby="{uid}-lim">
			<thead><tr><th scope="col">Item</th><th scope="col">Limitation</th><th scope="col">Where it stands</th></tr></thead>
			<tbody>
				{#each v.limitations as l (l.id)}<tr><th scope="row">{l.id}</th><td>{l.title}</td><td>{l.status}</td></tr>{/each}
			</tbody>
		</table>
	</div>
</div>

<style>
	.kv {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(min(100%, 240px), 1fr));
		gap: 0.5rem 1rem;
		margin: 0 0 1rem;
	}
	dt {
		font-size: 0.75rem;
		color: var(--text-muted);
	}
	dd {
		margin: 0;
	}
	.validation > :global(:is(h3, h4)) {
		margin: 1.25rem 0 0.5rem;
	}
	.note {
		max-width: 72ch;
	}
</style>
