<!--
	Runs & results → Rain for each unit (issue #482, docs/ui.md § Runs &
	results): a run with settings.unitRain `perUnit` ran GR4J once per land
	unit; this lists each unit's rain rule, its factor and where it comes from,
	its rain and runoff over the run, and what to check (units that fell back
	to the catchment rain, held factors, factors outside the 0.5–2 warning
	band, CHIRPS skipped as unusable). The units to look at come first;
	long lists fold. Shown when the summary carries summary.unitRain or
	summary.stations (issue #553: the rainfall stations forcing the catchment
	and the units, shown without rain for each unit too).
	Its own chunk. Helpers in ./unitRain.ts and ./stationRain.ts.
-->
<script lang="ts">
	import HelpTip from '#lib/components/help/HelpTip.svelte';
	import { foldList } from '#lib/components/common/fold.js';
	import { fmtNum } from '#lib/format/number.js';
	import { catchmentMapText, chirpsAtText, correctedByName, pairingFactorsText, pairingPeriodText, ratioText, stationAreas, stationNotes, type StationsResult } from './stationRain';
	import { factorClamped, factorOutsideBand, factorText, periodText, referenceFactorsText, referenceFitText, RULE_LABEL, sortResultUnits, unitRainNotes, type UnitRainResult } from './unitRain';

	/** order: node ids in the run's farm order (summary.farms), which the rows follow within each rank. */
	let { result, stations = null, order = [] }: { result: UnitRainResult | null; stations?: StationsResult | null; order?: string[] } = $props();

	const uid = $props.id();
	const FOLD = 8;
	const NOTES_FOLD = 4;
	const units = $derived(result ? sortResultUnits(result.units, order) : []);
	const notes = $derived(result ? unitRainNotes(result) : []);
	let allUnits = $state(false);
	let allNotes = $state(false);
	const fold = $derived(foldList(units, (u) => u.nodeId, null, allUnits, FOLD));
	const noteFold = $derived(foldList(notes, (n) => n, null, allNotes, NOTES_FOLD));
	const withDays = $derived(units.filter((u) => u.days));
	const refFactors = $derived(result ? referenceFactorsText(result) : null);
	// The rainfall stations (issue #553): the catchment first, then the units.
	const sAreas = $derived(stations ? stationAreas(stations, order) : []);
	const sNotes = $derived(stations ? stationNotes(stations) : []);
	const mapLine = $derived(stations ? catchmentMapText(stations) : null);
	const sourced = $derived(sAreas.filter((a) => a.areaMapSource || a.stationMapSource));
</script>

<section class="unit-rain" aria-labelledby="{uid}-h" data-testid="run-unit-rain">
	{#if result}
		<h3 id="{uid}-h">Rain for each unit <HelpTip key="settings.unitRain" /></h3>
		<p class="muted small">
			GR4J ran once for each unit with land on its own rain. MAP period {periodText(result.mapPeriod)}{#if result.gaugeMapMm !== null}; rain gauge’s MAP {fmtNum(result.gaugeMapMm)} mm{result.gaugeMapSource ? ` (${result.gaugeMapSource})` : ''}{:else}; no rain gauge MAP{/if}.
		</p>
		{#if result.reference && refFactors}
			{@const ref = result.reference}
			{@const gauge = ref.gauge === 'rain_catchment_mm' ? 'the catchment rain gauge' : 'a unit’s own gauge'}
			{@const fit = referenceFitText(ref)}
			<p class="muted small" data-testid="run-unit-rain-reference">
				{#if fit}
					Every unit’s CHIRPS is levelled by the reference gauge, {gauge}{ref.pinned ? ', its factors pinned' : ''}: {refFactors}. {fit} Each unit’s level is then rescaled to its own MAP
					(k_unit).
				{:else}
					Every unit’s CHIRPS is levelled by the reference gauge ({gauge}, compared with the CHIRPS cell of {ref.unitName ?? ref.unitId}){ref.pinned ? ', its factors pinned' : ''}: {refFactors}.
				{/if}
			</p>
		{/if}
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
								<span class="factor">{factorText(u)}{#if factorClamped(u)}{' '}<strong class="tag">held at the bound</strong>{:else if factorOutsideBand(u)}{' '}<strong class="tag">outside 0.5–2</strong>{/if}</span>
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
	{:else}
		<h3 id="{uid}-h">Rain from rainfall stations</h3>
	{/if}
	{#if stations}
		{#if result}<h4>Rainfall stations</h4>{/if}
		<p class="muted small">
			Each area’s rain is its station’s × area MAP ÷ station MAP; on the station’s gaps and unreliable days, the area’s own CHIRPS corrected against a station.{#if mapLine}{' '}Catchment MAP {mapLine}.{/if}
		</p>
		{#if sNotes.length}
			<div class="alert alert-warning notes" data-testid="run-station-notes">
				<ul>
					{#each sNotes as n (n)}<li>{n}</li>{/each}
				</ul>
			</div>
		{/if}
		<!-- The wrap takes focus so the keyboard can scroll it (axe scrollable-region-focusable). -->
		<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
		<div class="table-wrap" tabindex="0" role="region" aria-label="Areas’ rainfall stations">
			<table class="data compact" aria-labelledby="{uid}-scap">
				<caption id="{uid}-scap">The station each area ran on, and its days by where the rain came from</caption>
				<thead>
					<tr>
						<th scope="col">Area</th>
						<th scope="col">Station, ratio</th>
						<th scope="col" class="num">Area MAP <span class="u">(mm)</span></th>
						<th scope="col" class="num">Station MAP <span class="u">(mm)</span></th>
						<th scope="col" class="num">Station days</th>
						<th scope="col" class="num">Corrected CHIRPS days</th>
						<th scope="col" class="num">Fallback days</th>
						<th scope="col" class="num">Set aside</th>
					</tr>
				</thead>
				<tbody>
					{#each sAreas as a (a.nodeId ?? '(catchment)')}
						{@const by = correctedByName(stations, a)}
						{@const aside = a.setAside.checks + a.setAside.unreliable}
						<tr data-testid="run-station-row">
							<th scope="row">{a.nodeId === null ? `${a.name} (catchment)` : a.name}</th>
							<td>
								<span class="rule">{a.stationName}</span>
								<span class="factor">{ratioText(a)}{#if a.clamped}{' '}<strong class="tag">held at the bound</strong>{/if}; gaps from CHIRPS {by ? `corrected against ${by}` : 'not corrected (no pairing)'}</span>
							</td>
							<td class="num">{fmtNum(a.areaMapMm)}</td>
							<td class="num">{fmtNum(a.stationMapMm)}</td>
							<td class="num">{fmtNum(a.days.station)}</td>
							<td class="num">{fmtNum(a.days.chirps)}</td>
							<td class="num">{fmtNum(a.days.fallback)}{#if a.days.none}<span class="factor">{fmtNum(a.days.none)} none</span>{/if}</td>
							<td class="num">{fmtNum(aside)}{#if aside}<span class="factor">{fmtNum(a.setAside.checks)} by the checks, {fmtNum(a.setAside.unreliable)} unreliable</span>{/if}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
		{#if sourced.length}
			<details>
				<summary>Where each MAP comes from</summary>
				<ul class="sources" data-testid="run-station-sources">
					{#each sourced as a (a.nodeId ?? '(catchment)')}
						<li><strong>{a.name}</strong>: {a.areaMapSource ?? 'no source noted'}; {a.stationName}: {a.stationMapSource ?? 'no source noted'}</li>
					{/each}
				</ul>
			</details>
		{/if}
		{#if stations.pairings.length}
			<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
			<div class="table-wrap" tabindex="0" role="region" aria-label="Stations’ CHIRPS pairings">
				<table class="data compact" aria-labelledby="{uid}-pcap">
					<caption id="{uid}-pcap">Each station’s CHIRPS pairing: the monthly factors that correct CHIRPS to its level</caption>
					<thead>
						<tr>
							<th scope="col">Station</th>
							<th scope="col">CHIRPS at</th>
							<th scope="col">Fit period</th>
							<th scope="col" class="num">Shared days</th>
							<th scope="col">Monthly factors</th>
						</tr>
					</thead>
					<tbody>
						{#each stations.pairings as p (p.stationId)}
							<tr data-testid="run-station-pairing" data-refused={p.refused !== null}>
								<th scope="row">{p.stationName}</th>
								<td>{chirpsAtText(p)}</td>
								<td>{pairingPeriodText(p)}</td>
								<td class="num">{fmtNum(p.days)}</td>
								<td class="months">{pairingFactorsText(p)}{p.pinned ? ' (pinned)' : ''}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
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
	h4 {
		margin: 0.9rem 0 0.35rem;
	}
	.months {
		min-width: 16rem;
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
		font-size: var(--font-xs);
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
