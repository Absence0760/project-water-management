<!--
	The chance of each restriction level from the seasonal forecasts (issue
	#620 step 7, docs/ui.md § Seasonal outlook, docs/model.md §2.15d): per
	review date, the C3S forecasts' chance of each level beside past
	weather's, the leading side first (the hindcast skill gate: below zero,
	"no better than past weather" and the ESP leads), the systems and members
	used, the line that the chance is of storage only, and the Copernicus
	credit with the contributing centres. Shown under the ESP table of an
	outlook run with "Also give the chance of each restriction level from the
	seasonal forecasts" (method c3s). Words from ./forecast.ts; workspace
	English only.
-->
<script lang="ts">
	import type { ForecastView } from './forecast';

	let { view }: { view: ForecastView } = $props();
</script>

<section class="forecast" aria-labelledby="outlook-forecast-h" data-testid="outlook-forecast" data-state={view.kind} data-leads={view.kind === 'ready' ? view.leads : null}>
	<h4 id="outlook-forecast-h">Chance of each restriction level</h4>
	{#if view.kind === 'off'}
		<p class="muted" data-testid="forecast-off">{view.message}</p>
		{#if view.notes.length}
			<ul class="small notes" data-testid="forecast-notes">
				{#each view.notes as n (n)}<li>{n}</li>{/each}
			</ul>
		{/if}
	{:else}
		<p data-testid="forecast-leads"><strong>{view.leadText}</strong></p>
		<p class="small" data-testid="forecast-skill">{view.skill}</p>
		{#each view.dates as d, i (d.reviewDate)}
			<div class="scroll">
				<table class="levels" data-testid="forecast-table">
					<caption>Review on {d.reviewDate}: {d.basis}</caption>
					<thead>
						<tr>
							<th scope="col">Level</th>
							{#each view.columns as c (c.key)}<th scope="col" data-col={c.key}>{c.label}</th>{/each}
						</tr>
					</thead>
					<tbody>
						{#each d.rows as r (r.id)}
							<tr data-category={r.id}>
								<th scope="row">{r.label}{#if r.range}<span class="band">{r.range}</span>{/if}</th>
								{#each view.columns as c (c.key)}<td class="stat" data-col={c.key}>{c.key === 'forecast' ? r.forecast : r.esp}</td>{/each}
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
			{#if i === view.dates.length - 1}<p class="hint" data-testid="forecast-storage-only">{view.storageOnly}</p>{/if}
		{:else}
			<p class="muted">The season holds no review date, so no chance is given.</p>
		{/each}
		<p class="small" data-testid="forecast-init">{view.init}</p>
		<h5>Systems and members</h5>
		<ul class="small" data-testid="forecast-systems">
			{#each view.systems as s (s)}<li>{s}</li>{/each}
		</ul>
		{#if view.leftOut.length}
			<ul class="small notes" data-testid="forecast-left-out">
				{#each view.leftOut as s (s)}<li>{s}</li>{/each}
			</ul>
		{/if}
		{#if view.area}<p class="hint" data-testid="forecast-area">{view.area}</p>{/if}
		{#if view.warnings.length}
			<details class="warn">
				<summary>Notes from the model ({view.warnings.length})</summary>
				<ul class="small" data-testid="forecast-warnings">
					{#each view.warnings as w (w)}<li>{w}</li>{/each}
				</ul>
			</details>
		{/if}
		<p class="hint">
			A forecast of rain, mapped onto this catchment’s own rain and laid on the days of the nearest past year: an aid to the WUA’s decision, not a
			promise.
		</p>
		<div class="hint credit" data-testid="forecast-credit">
			{#each view.credit as line (line)}<p>{line}</p>{/each}
		</div>
	{/if}
</section>

<style>
	.forecast {
		margin-top: 0.75rem;
	}
	h4 {
		margin: 0.75rem 0 0.25rem;
	}
	h5 {
		margin: 0.5rem 0 0.15rem;
		font-size: var(--font-sm);
	}
	.scroll {
		overflow-x: auto;
	}
	.levels {
		border-collapse: collapse;
		min-width: 0;
		margin: 0.25rem 0;
	}
	.levels caption {
		text-align: left;
		font-size: var(--font-sm);
		color: var(--text-muted);
		padding-bottom: 0.25rem;
	}
	.levels th,
	.levels td {
		border: 1px solid var(--border);
		padding: 0.45rem 0.6rem;
		vertical-align: top;
		text-align: left;
	}
	.stat {
		font-size: 0.85rem;
		font-variant-numeric: tabular-nums;
	}
	.band {
		display: block;
		font-size: var(--font-xs);
		color: var(--text-muted);
	}
	.hint {
		font-size: var(--font-sm);
		color: var(--text-muted);
		max-width: 80ch;
		margin: 0.3rem 0 0;
	}
	.credit p {
		margin: 0.15rem 0 0;
	}
	.notes {
		margin: 0.25rem 0;
		padding-left: 1.2rem;
	}
	ul.small {
		margin: 0.25rem 0;
		padding-left: 1.2rem;
	}
	.warn {
		margin: 0.25rem 0;
	}
</style>
