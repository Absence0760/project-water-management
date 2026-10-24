<!--
	Settings → Flow generation → Per unit (issue #553 round 3, docs/ui.md § Settings & calibration, docs/model.md §2.4i):
	one row per land unit with its rainfall station (settings.rainStations.units), whether the station's rain is scaled
	to the unit's MAP (the ratio shown beside it), and the station whose monthly factors correct the unit's CHIRPS on
	the station's gaps; then each station in use, once, with its MAP and where its CHIRPS is read (its coordinates, or
	the unit it stands in, settings.rainStations.sites). Satellite rain is never a unit's station: it only fills the
	station's gaps. "No station" keeps the unit on the rule it ran on before stations (§2.4h), so a project from
	before them runs as it did. Several units may share a station; ticking rows sets one station for all of them.
	Bind the setting (null = none). Its own chunk (lazySections.ts): the Settings tab chunk sits at its ceiling.
-->
<script lang="ts">
	import type { RainStationSettings } from '@water-management/engine';
	import { fmtNum } from '#lib/format/number.js';
	import { stationHref } from './unitRain';
	import {
		assignmentLine,
		namesLine,
		stationsInUse,
		unitStationRows,
		withStationSite,
		withUnitCorrectAgainst,
		withUnitScale,
		withUnitStation,
		withUnitsStation,
		type StationOption,
		type UnitNode
	} from './flowGeneration';

	let {
		value = $bindable(),
		readonly = false,
		nodes = [],
		stations
	}: {
		value: RainStationSettings | null | undefined;
		readonly?: boolean;
		nodes?: readonly UnitNode[];
		/** The project's rainfall stations (flowGeneration.ts stationOptions); undefined until the series list loads. */
		stations?: readonly StationOption[];
	} = $props();

	const uid = $props.id();
	const list = $derived(stations ?? []);
	const rows = $derived(unitStationRows(nodes, value, list));
	const inUse = $derived(stationsInUse(rows, list));
	const land = $derived(rows.map((r) => r.unit));
	/** The rows ticked for the select-several action (node ids); forgotten for a unit that is no longer one. */
	let picked = $state<string[]>([]);
	const pickedNow = $derived(picked.filter((id) => rows.some((r) => r.unit.id === id)));
	let bulkStation = $state('');
	const allPicked = $derived(rows.length > 0 && pickedNow.length === rows.length);

	const ratioText = (r: (typeof rows)[number]) => {
		if (!r.station) return '';
		if (!r.scale) return '× 1, as recorded';
		if (r.noRatioWhy) return `× 1: ${r.noRatioWhy}`;
		return `× ${fmtNum(r.ratio.ratio, 3, true)}${r.ratio.clamped ? ` (clamped from ${fmtNum(r.ratio.own ?? 0, 3, true)})` : r.ratio.outsideBand ? ', outside 0.5–2: check the MAPs' : ''}`;
	};
	const mapText = (mm: number | null | undefined, source: string | null | undefined) => (mm == null ? 'No MAP' : `${fmtNum(mm, 1, true)} mm${source ? ` (${source})` : ''}`);

	function togglePick(id: string, on: boolean) {
		picked = on ? [...pickedNow.filter((x) => x !== id), id] : pickedNow.filter((x) => x !== id);
	}
	function assignPicked() {
		value = withUnitsStation(value, pickedNow, bulkStation || null);
		picked = [];
	}
</script>

<div class="flowgen-units" data-testid="flowgen-units">
	<p class="hint state" data-testid="flowgen-assigned">{assignmentLine(rows)}</p>
	{#if stations !== undefined && !list.length}
		<p class="hint" role="note" data-testid="flowgen-no-stations">
			The project has no rainfall station yet. Add one in the Data tab with Add data → Rainfall: station, with its MAP and source.
		</p>
	{/if}
	{#if rows.length}
		{#if !readonly && list.length}
			<div class="bulk" role="group" aria-labelledby="{uid}-bulk-l" data-testid="flowgen-bulk">
				<span class="lbl" id="{uid}-bulk-l">{pickedNow.length ? `${pickedNow.length === 1 ? '1 unit' : `${pickedNow.length} units`} ticked` : 'Tick units to give them one station'}</span>
				<label class="visually-hidden" for="{uid}-bulk">Station for the ticked units</label>
				<select id="{uid}-bulk" bind:value={bulkStation} disabled={!pickedNow.length}>
					<option value="">No station</option>
					{#each list as s (s.id)}<option value={s.id}>{s.name}</option>{/each}
				</select>
				<button type="button" class="btn btn-sm" disabled={!pickedNow.length} onclick={assignPicked}>Assign to the ticked units</button>
			</div>
		{/if}
		<div class="rows-box">
			<div class="table-wrap">
				<table class="data compact" data-testid="flowgen-rows">
					<caption class="visually-hidden">Each land unit’s rainfall station</caption>
					<thead>
						<tr>
							{#if !readonly && list.length}
								<th scope="col" class="pick">
									<label class="visually-hidden" for="{uid}-all">Tick every unit</label>
									<input id="{uid}-all" type="checkbox" checked={allPicked} onchange={(e) => (picked = e.currentTarget.checked ? rows.map((r) => r.unit.id) : [])} />
								</th>
							{/if}
							<th scope="col">Unit and its MAP</th>
							<th scope="col">Station</th>
							<th scope="col">Scale to unit MAP</th>
							<th scope="col">Gaps: CHIRPS corrected against</th>
						</tr>
					</thead>
					<tbody>
						{#each rows as r (r.unit.id)}
							<tr data-testid="flowgen-row" data-unit={r.unit.id}>
								{#if !readonly && list.length}
									<td class="pick">
										<input type="checkbox" aria-label="Tick {r.unit.name}" checked={pickedNow.includes(r.unit.id)} onchange={(e) => togglePick(r.unit.id, e.currentTarget.checked)} />
									</td>
								{/if}
								<th scope="row">
									<span class="name">{r.unit.name}</span>
									<span class="small" data-testid="flowgen-unit-map">MAP: {mapText(r.unit.mapMm, r.unit.mapSource)}</span>
								</th>
								<td data-label="Station">
									<select
										aria-label="Station for {r.unit.name}"
										disabled={readonly}
										value={r.assignment?.stationId ?? ''}
										aria-invalid={r.missing || undefined}
										onchange={(e) => (value = withUnitStation(value, r.unit.id, e.currentTarget.value || null))}
									>
										<option value="">No station: as before stations</option>
										{#if r.missing}<option value={r.assignment?.stationId}>A station the project no longer has</option>{/if}
										{#each list as s (s.id)}<option value={s.id}>{s.name}</option>{/each}
									</select>
									{#if r.missing}<span class="err small" data-testid="flowgen-missing">Its station was deleted: runs keep the unit on the rule before stations until another is picked.</span>{/if}
								</td>
								<td data-label="Scale to unit MAP">
									{#if r.station}
										<label class="check">
											<input
												type="checkbox"
												aria-label="Scale to unit MAP: {r.unit.name}"
												aria-describedby="{uid}-ratio-{r.unit.id}"
												disabled={readonly}
												checked={r.scale}
												onchange={(e) => (value = withUnitScale(value, r.unit.id, e.currentTarget.checked))}
											/>
											<span id="{uid}-ratio-{r.unit.id}" data-testid="flowgen-ratio">{ratioText(r)}</span>
										</label>
									{:else}
										<span class="muted small">–</span>
									{/if}
								</td>
								<td data-label="Gaps: CHIRPS corrected against">
									{#if r.station}
										<select
											aria-label="Station correcting {r.unit.name}’s CHIRPS"
											disabled={readonly}
											value={r.correctAgainst === r.station.id ? '' : (r.correctAgainst ?? '')}
											onchange={(e) => (value = withUnitCorrectAgainst(value, r.unit.id, e.currentTarget.value || null))}
										>
											<option value="">Its station ({r.station.name})</option>
											{#each list.filter((s) => s.id !== r.station?.id) as s (s.id)}<option value={s.id}>{s.name}</option>{/each}
										</select>
									{:else}
										<span class="muted small">–</span>
									{/if}
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		</div>
		<span class="hint explain">
			On a station’s days the unit runs on its rain × unit MAP ÷ station MAP (held between 0.25 and 4), or as recorded with scaling off. On its gaps and
			unreliable days the unit’s own CHIRPS fills in, corrected month by month against the station chosen, as it is: satellite rain is never a unit’s
			station. A unit with no station keeps the rule it ran on before stations (Units without a station, below).
		</span>
	{/if}
	{#if inUse.length}
		<!-- Each station once, however many units share it (issue #553): its MAP and where its CHIRPS is read for the pairing. -->
		<ul class="stations" aria-label="Stations in use" data-testid="flowgen-stations">
			{#each inUse as u (u.station.id)}
				{@const st = u.station.station}
				{@const placed = st?.lat != null && st?.lon != null}
				{@const site = value?.sites?.[u.station.id]?.unitId ?? ''}
				<li data-testid="flowgen-station" data-station={u.station.id}>
					<strong>{u.station.name}</strong>: MAP <span data-testid="flowgen-station-map">{mapText(st?.mapMm, st?.mapSource)}</span>.
					{#if u.units.length}<span class="muted">Runs {namesLine(u.units)}.</span>{/if}
					<a href={stationHref(u.station)}>{readonly ? 'See it in Series details' : st?.mapMm == null ? 'Set its MAP in Series details' : 'Change it in Series details'}</a>
					{#if placed}
						<span class="small block">Its CHIRPS is read at its own place ({fmtNum(st!.lat!, 4, true)}, {fmtNum(st!.lon!, 4, true)}).</span>
					{:else}
						<span class="block site">
							<label for="{uid}-site-{u.station.id}">Stands in</label>
							<select
								id="{uid}-site-{u.station.id}"
								disabled={readonly}
								value={site}
								onchange={(e) => (value = withStationSite(value, u.station.id, e.currentTarget.value || null))}
								aria-describedby="{uid}-site-{u.station.id}-h"
							>
								<option value="">Not set: no place to read its CHIRPS</option>
								{#each land as n (n.id)}<option value={n.id}>{n.name}</option>{/each}
							</select>
							<span class="small" id="{uid}-site-{u.station.id}-h">
								{site ? 'Its pairing compares it with that unit’s CHIRPS.' : 'Without coordinates or a unit, its pairing is refused and its gaps fall back to the catchment rain.'}
							</span>
						</span>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}
</div>

<style>
	.flowgen-units {
		margin-top: 0.5rem;
	}
	.hint {
		display: block;
		font-size: var(--font-sm);
		max-width: 75ch;
	}
	.state {
		margin: 0 0 0.4rem;
	}
	.small {
		font-size: var(--font-sm);
	}
	.block {
		display: block;
	}
	.muted {
		color: var(--text-2);
	}
	.err {
		display: block;
		color: var(--danger);
	}
	.bulk {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.4rem 0.6rem;
		margin: 0.25rem 0 0.5rem;
	}
	.bulk .lbl {
		font-size: var(--font-sm);
		color: var(--text-2);
	}
	.name {
		display: block;
	}
	th[scope='row'] .small {
		display: block;
		font-weight: 400;
		color: var(--text-2);
		overflow-wrap: anywhere;
	}
	td select {
		max-width: 100%;
	}
	.check {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		min-height: 36px;
	}
	.pick {
		width: 2rem;
	}
	.stations {
		margin: 0.5rem 0 0;
		padding-left: 1.1rem;
		max-width: 75ch;
	}
	.stations li + li {
		margin-top: 0.35rem;
	}
	.stations a {
		margin-left: 0.25rem;
	}
	.site {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.25rem 0.5rem;
		margin-top: 0.2rem;
	}
	.site label {
		font-size: var(--font-sm);
		color: var(--text-2);
	}
	@media (pointer: coarse), (max-width: 640px) {
		.check,
		td select,
		.bulk select,
		.bulk .btn,
		.site select {
			min-height: var(--tap);
		}
		.pick input,
		.check input {
			min-width: 24px;
			min-height: 24px;
		}
	}
	/* Narrower than the table (a phone, or the panel beside the side index): each row is a block, the unit on top,
	   its fields under their labels (ui-playbook.md § 2 "Fit a wide table by stacking"). 40rem = 560 px. */
	.rows-box {
		container: flowgen-rows / inline-size;
	}
	@container flowgen-rows (max-width: 40rem) {
		table,
		tbody {
			display: block;
		}
		thead {
			display: none;
		}
		tr {
			display: grid;
			grid-template-columns: auto minmax(0, 1fr);
			gap: 0.4rem 0.75rem;
			padding: 0.6rem 0.25rem;
		}
		tr + tr {
			border-top: 1px solid var(--border);
		}
		table.data th,
		table.data td {
			display: block;
			padding: 0;
			border-bottom: none;
			text-align: left;
			min-width: 0;
		}
		td[data-label] {
			grid-column: 1 / -1;
		}
		td[data-label]::before {
			content: attr(data-label);
			display: block;
			font-size: var(--font-xs);
			color: var(--text-2);
		}
		td select {
			width: 100%;
		}
	}
</style>
