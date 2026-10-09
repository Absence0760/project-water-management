<!--
	Runs & results → Rain for each unit (issue #482, docs/ui.md § Runs &
	results): a run with settings.unitRain `perUnit` ran GR4J once per land
	unit; this lists each unit's rain rule, its factor and where it comes from,
	its rain and runoff over the run, and what to check (units that fell back
	to the catchment rain, held factors). The units to look at come first;
	long lists fold. Shown only when the summary carries summary.unitRain. Its
	own chunk. Helpers in ./unitRain.ts.
-->
<script lang="ts">
	import HelpTip from '$lib/components/help/HelpTip.svelte';
	import { foldList } from '$lib/components/common/fold';
	import { fmtNum } from '$lib/format/number';
	import { factorClamped, factorText, periodText, RULE_LABEL, sortResultUnits, unitRainNotes, type UnitRainResult } from './unitRain';

	let { result }: { result: UnitRainResult } = $props();

	const uid = $props.id();
	const FOLD = 8;
	const NOTES_FOLD = 4;
	const units = $derived(sortResultUnits(result.units));
	const notes = $derived(unitRainNotes(result));
	let allUnits = $state(false);
	let allNotes = $state(false);
	const fold = $derived(foldList(units, (u) => u.nodeId, null, allUnits, FOLD));
	const noteFold = $derived(foldList(notes, (n) => n, null, allNotes, NOTES_FOLD));
	const withDays = $derived(units.filter((u) => u.days));
</script>

<section class="unit-rain" aria-labelledby="{uid}-h" data-testid="run-unit-rain">
	<h3 id="{uid}-h">Rain for each unit <HelpTip key="settings.unitRain" /></h3>
	<p class="muted small">
		GR4J ran once for each unit with land on its own rain. MAP period {periodText(result.mapPeriod)}{#if result.gaugeMapMm !== null}; rain gauge’s MAP {fmtNum(result.gaugeMapMm)} mm{result.gaugeMapSource ? ` (${result.gaugeMapSource})` : ''}{:else}; no rain gauge MAP{/if}.
	</p>
	{#if notes.length}
		<div class="alert alert-warning notes" data-testid="run-unit-rain-notes">
			<ul>
				{#each noteFold.shown as n (n)}<li>{n}</li>{/each}
			</ul>
			{#if allNotes || noteFold.hidden}
				<button type="button" class="btn btn-sm" aria-expanded={allNotes} onclick={() => (allNotes = !allNotes)}>
					{allNotes ? `Show only the first ${NOTES_FOLD} things to check` : `Show all ${notes.length} things to check`}
				</button>
			{/if}
		</div>
	{/if}
	<!-- The wrap takes focus so the keyboard can scroll it (axe scrollable-region-focusable). -->
	<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
	<div class="table-wrap" tabindex="0" role="region" aria-label="Units’ rain and runoff">
		<table class="data compact" aria-labelledby="{uid}-cap">
			<caption id="{uid}-cap">Each unit’s rain and runoff over the run</caption>
			<thead>
				<tr>
					<th scope="col">Unit</th>
					<th scope="col">Rain from, level factor</th>
					<th scope="col" class="num">MAP <span class="u">(mm)</span></th>
					<th scope="col" class="num">Rain <span class="u">(mm)</span></th>
					<th scope="col" class="num">Runoff <span class="u">(mm)</span></th>
					<th scope="col" class="num">Runoff coefficient</th>
				</tr>
			</thead>
			<tbody>
				{#each fold.shown as u (u.nodeId)}
					<tr data-testid="run-unit-rain-row" data-rule={u.rule}>
						<th scope="row">{u.name}</th>
						<td>
							<span class="rule">{RULE_LABEL[u.rule] ?? u.rule}</span>
							<span class="factor">{factorText(u)}{#if factorClamped(u)}{' '}<strong class="tag">held at the bound</strong>{/if}</span>
						</td>
						<td class="num">{u.mapMm === null ? '–' : fmtNum(u.mapMm)}</td>
						<td class="num">{fmtNum(u.rainMm, 0)}</td>
						<td class="num">{fmtNum(u.flowMm, 0)}</td>
						<td class="num">{u.runoffCoefficient === null ? '–' : fmtNum(u.runoffCoefficient, 3)}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
	{#if allUnits || fold.hidden}
		<button type="button" class="btn btn-sm" aria-expanded={allUnits} onclick={() => (allUnits = !allUnits)}>
			{allUnits ? `Show only the first ${FOLD} units` : `Show all ${units.length} units`}
		</button>
	{/if}
	{#if result.units.some((u) => u.mapSource)}
		<details>
			<summary>Where each unit’s MAP comes from</summary>
			<ul class="sources" data-testid="run-unit-rain-sources">
				{#each units.filter((u) => u.mapSource) as u (u.nodeId)}<li><strong>{u.name}</strong>: {u.mapSource}</li>{/each}
			</ul>
		</details>
	{/if}
	{#if withDays.length}
		<details>
			<summary>Days by where the rain came from</summary>
			<!-- The wrap takes focus so the keyboard can scroll it (axe scrollable-region-focusable). -->
			<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
			<div class="table-wrap" tabindex="0" role="region" aria-label="Units’ days by source">
				<table class="data compact" aria-label="Each unit’s run days by where the rain came from">
					<thead>
						<tr>
							<th scope="col">Unit</th>
							<th scope="col" class="num">Own gauge</th>
							<th scope="col" class="num">Gauge × MAP</th>
							<th scope="col" class="num">Own CHIRPS</th>
							<th scope="col" class="num">Catchment</th>
							<th scope="col" class="num">Forecast</th>
							<th scope="col" class="num">None</th>
						</tr>
					</thead>
					<tbody>
						{#each withDays as u (u.nodeId)}
							{@const d = u.days!}
							<tr><th scope="row">{u.name}</th><td class="num">{fmtNum(d.unitGauge)}</td><td class="num">{fmtNum(d.gaugeMap)}</td><td class="num">{fmtNum(d.unitChirps)}</td><td class="num">{fmtNum(d.catchment)}</td><td class="num">{fmtNum(d.forecast)}</td><td class="num">{fmtNum(d.none)}</td></tr>
						{/each}
					</tbody>
				</table>
			</div>
		</details>
	{/if}
</section>

<style>
	/* A disclosure's summary is a full touch target (WCAG 2.5.8; a phone gets --tap). */
	details > summary {
		padding: 0.45rem 0;
		min-height: 36px;
		box-sizing: border-box;
		cursor: pointer;
	}
	@media (pointer: coarse), (max-width: 640px) {
		details > summary {
			min-height: var(--tap);
		}
	}
	h3 {
		margin: 0 0 0.35rem;
	}
	.notes {
		margin: 0.5rem 0;
		max-width: 75ch;
	}
	.notes ul {
		margin: 0 0 0.3rem;
		padding-left: 1.2rem;
	}
	.table-wrap {
		overflow-x: auto;
	}
	table {
		font-variant-numeric: tabular-nums;
	}
	/* The rule over its factor: one column, so the table fits a narrow panel. */
	.rule,
	.factor {
		display: block;
	}
	.factor {
		font-size: 0.85rem;
		color: var(--text-2);
	}
	.tag {
		font-size: 0.75rem;
		white-space: nowrap;
	}
	.sources {
		margin: 0.3rem 0;
		padding-left: 1.2rem;
		max-width: 75ch;
	}
	p {
		max-width: 75ch;
	}
</style>
