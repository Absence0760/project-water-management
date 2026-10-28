<!--
	The seasonal outlook in past seasons like this one (issue #620, docs/ui.md
	§ Seasonal outlook, docs/model.md §2.15c): this season's ENSO and SAM state,
	what the dams and the river did in the past seasons nearest it beside
	every year, and the years chosen with their ONI and AAO. Shown under the
	ESP table of an outlook run with "Also compare past seasons like this one"
	(method climateState). Words from ./climate.ts; workspace English only.
-->
<script lang="ts">
	import type { ClimateView } from './climate';

	let { view }: { view: ClimateView } = $props();
</script>

<section class="climate" aria-labelledby="outlook-climate-h" data-testid="outlook-climate" data-state={view.kind}>
	<h4 id="outlook-climate-h">Past seasons like this one</h4>
	{#if view.state}<p class="small" data-testid="climate-state">This season: {view.state}</p>{/if}
	{#if view.kind === 'problem'}
		<p class="muted" data-testid="climate-problem">{view.message}</p>
	{:else}
		{#if view.headline}<p data-testid="climate-headline">{view.headline}</p>{/if}
		<div class="scroll">
			<table class="levels" data-testid="climate-table">
				<caption class="visually-hidden">Season-end dam storage and years met by demand level: past seasons like this one beside every year</caption>
				<thead>
					<tr>
						<th scope="col">Demand level</th>
						<th scope="col">Dam storage at season end, seasons like this one</th>
						<th scope="col">Every year</th>
						<th scope="col">Years met in full, seasons like this one</th>
						<th scope="col">Every year</th>
					</tr>
				</thead>
				<tbody>
					{#each view.rows as r (r.id)}
						<tr data-level={r.id}>
							<th scope="row">{r.label}</th>
							<td class="stat"><strong>{r.storage.median}</strong>{#if r.storage.band}<span class="band">10–90 %: {r.storage.band}</span>{/if}</td>
							<td class="stat"><strong>{r.storageAll.median}</strong>{#if r.storageAll.band}<span class="band">10–90 %: {r.storageAll.band}</span>{/if}</td>
							<td class="stat">{r.yearsMet}</td>
							<td class="stat">{r.yearsMetAll}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
		<p class="small" data-testid="climate-planning">In those seasons: {view.planning}</p>
		<p class="hint" data-testid="climate-how">{view.how}</p>
		<div class="scroll">
			<table class="levels years" data-testid="climate-years">
				<caption>The past seasons chosen, nearest first</caption>
				<thead>
					<tr>
						<th scope="col">Water year</th>
						<th scope="col">ONI</th>
						<th scope="col">AAO</th>
						<th scope="col">Distance <span class="u">(standard deviations)</span></th>
					</tr>
				</thead>
				<tbody>
					{#each view.chosen as y (y.label)}
						<tr>
							<th scope="row">{y.label}</th>
							<td class="stat">{y.oni}</td>
							<td class="stat">{y.aao}</td>
							<td class="stat">{y.distance}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
		{#if view.others.length}
			<details class="others">
				<summary>The other past seasons ({view.others.length})</summary>
				<ul class="small" data-testid="climate-others">
					{#each view.others as y (y.label)}<li>{y.label}: ONI {y.oni}, AAO {y.aao}, distance {y.distance}</li>{/each}
				</ul>
			</details>
		{/if}
		{#if view.stepped}<p class="hint" data-testid="climate-stepped">{view.stepped}</p>{/if}
		{#if view.missing}<p class="hint" data-testid="climate-missing">{view.missing}</p>{/if}
		<p class="hint">Past seasons that began in a similar ocean and atmosphere state, not a forecast. ENSO and the SAM explain only part of a season’s rain.</p>
	{/if}
	{#if view.source}<p class="hint" data-testid="climate-source">{view.source}</p>{/if}
</section>

<style>
	.climate {
		margin-top: 0.75rem;
	}
	h4 {
		margin: 0.75rem 0 0.25rem;
	}
	.scroll {
		overflow-x: auto;
	}
	.levels {
		border-collapse: collapse;
		min-width: 100%;
		margin: 0.25rem 0;
	}
	.levels.years {
		min-width: 0;
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
	.stat strong {
		display: block;
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
	.others ul {
		margin: 0.25rem 0;
		padding-left: 1.2rem;
	}
</style>
