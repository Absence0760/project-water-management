<script lang="ts">
	// The validation statement of a run (WP-3.13, model.md §2.10f): the
	// engine's validationStatement() over the stored summary, so it needs no
	// request. Printed in the report, and on screen in ValidationPanel (the
	// run's Record group, the scenario view); the known limitations are
	// generated from docs/engine-audit.md, the errata from
	// docs/engine-errata.md, and the methodology statement is cited by version
	// and hash (docs/methodology).
	import { validationStatement, type RunSummary } from '@water-management/engine';
	import { fmtDay, fmtNum } from '$lib/format/number';
	import { ENGINE_BUILD } from './engineBuild';

	let {
		summary,
		engineVersion,
		legacy,
		fitEngineVersion = null,
		headingLevel = 3
	}: {
		summary: RunSummary;
		engineVersion: string;
		legacy: boolean;
		/** The engine of the automatic fit the run's parameters came from (settings.fitRecord); null for entered parameters. */
		fitEngineVersion?: string | null;
		/** The level of its own headings (Calibration, Data quality, Known limitations): one below the heading it sits under. */
		headingLevel?: 3 | 4;
	} = $props();
	const h = $derived(`h${headingLevel}`);

	// The site build's record (release builds only); validationStatement shows it only for its own engine version.
	const v = $derived(validationStatement({ summary, engineVersion, legacy, fitEngineVersion }, ENGINE_BUILD));
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
			<dt>Methodology statement</dt>
			<dd>{v.methodology.version} <span class="muted small">(SHA-256 {v.methodology.sha256.slice(0, 12)}…)</span></dd>
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
			{#each v.flaggedYears as y (`${y.seriesKind}:${y.start}`)}<li>{fmtDay(y.start)} – {y.end ? fmtDay(y.end) : '…'}: {fmtNum(y.ratio * 100)} % of CHIRPS</li>{/each}
		</ul>
		{#if v.flaggedYearsMayBeCut}
			<p class="muted small" data-testid="flagged-years-cut">
				This run was made on engine {v.engineVersion}, which kept only the first {v.flaggedYears.length} flagged years here; the data-quality line
				below names every one. Re-run it on the current engine for the full list.
			</p>
		{/if}
	{/if}
	{#if v.dataQuality.length}
		<ul>
			{#each v.dataQuality as line, i (i)}<li>{line}</li>{/each}
		</ul>
	{:else}
		<p>No data-quality check fired on this run’s inputs.</p>
	{/if}

	<svelte:element this={h} id="{uid}-err">Errata of engine {v.engineVersion}</svelte:element>
	{#if v.errata.length}
		<p class="muted small">
			Known bugs recorded for this engine version, or for the engine of the fit its parameters came from (docs/engine-errata.md): each changes
			results only under the conditions given.
		</p>
		<div class="table-wrap">
			<table class="data compact" aria-labelledby="{uid}-err">
				<thead><tr><th scope="col">Erratum</th><th scope="col">What goes wrong</th><th scope="col">Applies when</th><th scope="col">Fixed in</th></tr></thead>
				<tbody>
					{#each v.errata as e (e.id)}<tr><th scope="row">{e.id}</th><td>{e.summary}</td><td>{e.appliesWhen}</td><td>{e.fixedIn ? `engine ${e.fixedIn}` : 'not yet'}</td></tr>{/each}
				</tbody>
			</table>
		</div>
	{:else}
		<p>None recorded for this engine version in docs/engine-errata.md.</p>
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
