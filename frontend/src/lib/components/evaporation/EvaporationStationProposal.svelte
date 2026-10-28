<!--
	Calibration → Flow calibration → "Evaporation stations" (issue #646 item 6;
	docs/ui.md § Set up the fit, docs/maps.md § Evaporation stations), beside
	"Evaporation from the map". The nearest DWS evaporation stations to the
	catchment boundary, each with its pan (Class-A or Symons), distance, record
	span and completeness, and the 12 monthly means of its daily pan record
	proposed as the A-pan row, beside the saved row. A Class-A pan's means are
	the A-pan as they stand, and its daily record can be written as the daily
	A-pan series too. A Symons pan reads S-pan: its means become A-pan only
	through the S→A equation the user picks (none is picked for them), and its
	daily record is never written. Use (editors, in the heading's row, marked
	"Saves now") asks first, then saves as one settings revision citing the
	station, its months and any conversion; it waits while the form has unsaved
	changes. Nothing is applied by itself.
-->
<script lang="ts">
	import { SPAN_INVERSION_CAVEAT } from '@water-management/engine';
	import { untrack } from 'svelte';
	import { api, type EvaporationStationProposals, type SpanConversionId } from '#lib/api/index.js';
	import { confirmDialog } from '#lib/components/common/confirm.svelte.js';
	import ProposalNoDataset from '#lib/components/proposals/ProposalNoDataset.svelte';
	import ProposalPanel from '#lib/components/proposals/ProposalPanel.svelte';
	import ProposalSource from '#lib/components/proposals/ProposalSource.svelte';
	import ProposalSynthetic from '#lib/components/proposals/ProposalSynthetic.svelte';
	import { fmtNum } from '#lib/format/number.js';
	import { WATER_YEAR_MONTHS } from '#lib/format/months.js';
	import { chosenApan, defaultStation, otherDailySeries, PAN_LABEL, recordText, sameAsSaved, useMessage, whereText } from './stationProposal';

	let {
		projectId,
		readonly,
		formDirty,
		onApplied
	}: {
		projectId: string;
		readonly: boolean;
		/** Unsaved settings: Use waits until they are saved or discarded (it saves straight to the project). */
		formDirty: boolean;
		/** The settings changed on the server: the form takes them as they now are. */
		onApplied: () => Promise<void> | void;
	} = $props();

	const uid = $props.id();
	const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

	let data = $state.raw<EvaporationStationProposals | null>(null);
	let loading = $state(false);
	let error = $state<string | null>(null);
	let busy = $state(false);
	let useError = $state<string | null>(null);
	let notice = $state<string | null>(null);
	let frame = $state<ProposalPanel | null>(null);
	let picked = $state<string | null>(null);
	let conversion = $state<SpanConversionId | null>(null);
	let daily = $state(true);
	let seq = 0;

	async function load() {
		const mine = ++seq;
		loading = true;
		error = null;
		try {
			const d = await api.evaporationStations.get(projectId);
			if (mine !== seq) return;
			data = d;
			if (!d.stations.some((s) => s.code === picked)) {
				picked = defaultStation(d);
				conversion = null;
			}
		} catch (e) {
			if (mine === seq) error = msg(e);
		} finally {
			if (mine === seq) loading = false;
		}
	}
	$effect(() => {
		void projectId;
		untrack(() => void load());
	});

	const station = $derived(data?.stations.find((s) => s.code === picked) ?? null);
	const result = $derived(station ? chosenApan(station, conversion) : null);
	const ready = $derived(result?.ok ? result : null);
	const blocker = $derived(data && station?.pan === 'class_a' ? otherDailySeries(data, station) : null);
	const writeDaily = $derived(station?.pan === 'class_a' && daily && !blocker);
	const same = $derived(!!ready && !!data && sameAsSaved(data.settings.apanMm, ready.apanMm) && (!writeDaily || data.settings.dailyApan.some((d) => d.name === station?.seriesName)));
	const conversionLabel = $derived(station?.pan === 'symons' && conversion ? (station.conversions?.find((c) => c.id === conversion)?.label ?? null) : null);
	const total = (row: readonly number[]) => fmtNum(Math.round(row.reduce((a, b) => a + b, 0)));

	function pick(code: string) {
		picked = code;
		conversion = null;
		useError = null;
	}

	async function use() {
		if (!data || !station || !ready) return;
		const s = station;
		const ok = await confirmDialog({
			title: `Use ${s.code}’s record as the A-pan?`,
			message: useMessage(s, ready.apanMm, writeDaily, data, conversionLabel),
			confirmLabel: 'Use this station'
		});
		if (!ok) return;
		busy = true;
		useError = null;
		try {
			const r = await api.evaporationStations.fromStation(projectId, { station: s.code, ...(s.pan === 'symons' && conversion ? { conversion } : {}), ...(s.pan === 'class_a' ? { daily: writeDaily } : {}) });
			notice = `The A-pan row is now ${s.code}’s ${total(r.apanMm)} mm a year${r.series ? `, and its daily record the series “${r.series}”` : ''}, saved as a settings revision citing the station.`;
			await Promise.all([load(), onApplied()]);
			await frame?.focusNotice();
		} catch (e) {
			useError = msg(e);
		} finally {
			busy = false;
		}
	}
</script>

<ProposalPanel
	bind:this={frame}
	testid="evaporation-station-proposal"
	prefix="evaporation-station"
	id="set-evaporation-station"
	variant="inline"
	title="Evaporation stations"
	level={4}
	what="evaporation stations"
	bodyGrid
	{notice}
	{loading}
	loaded={data !== null}
	{error}
	onretry={load}
>
	{#snippet actions()}
		{#if ready && !same && !readonly}
			<span class="saves-now" id="{uid}-now">Saves now</span>
			<button
				type="button"
				class="btn btn-sm"
				data-testid="evaporation-station-use"
				disabled={busy || formDirty}
				aria-describedby={formDirty ? `${uid}-now ${uid}-dirty` : `${uid}-now`}
				onclick={use}>{busy ? 'Saving…' : 'Use as the A-pan'}</button
			>
		{/if}
	{/snippet}
	{#snippet intro()}<p class="hint muted explain">
		The nearest DWS evaporation stations to the catchment boundary, and the monthly A-pan from each one’s daily pan record. A Class-A pan’s
		record is the A-pan as it stands. A Symons pan reads less, and is converted only with the equation you pick. Nothing changes until you use
		one.
	</p>{/snippet}

	{#if data}
		{#if !data.datasets.length}
			<ProposalNoDataset testid="evaporation-station-no-dataset" what="evaporation station list" consequence="no station can be proposed" instead="Enter the A-pan by hand, or upload a daily pan record on the Data page." />
		{:else if !data.boundary}
			<p class="alert alert-info slim" data-testid="evaporation-station-no-boundary">
				There is no catchment boundary on the map yet. Draw or import it on the Map; the stations are measured from it. <a href="?tab=map">Open the Map</a>
			</p>
		{:else if !data.stations.length}
			<p class="alert alert-info slim" data-testid="evaporation-station-none">No evaporation station is within {fmtNum(data.withinKm)} km of the boundary “{data.boundary.name}”.</p>
		{:else}
			{#if data.stations.some((s) => s.synthetic)}
				<ProposalSynthetic testid="evaporation-station-synthetic" subject="The station list" notWhat="DWS’s stations or any real pan record" forWhat="catchment" />
			{/if}
			<fieldset class="choices">
				<legend>Station, nearest first</legend>
				{#each data.stations as s (s.code)}
					<label class="choice" data-testid="evaporation-station-option" data-code={s.code}>
						<input type="radio" name="{uid}-station" value={s.code} checked={picked === s.code} disabled={busy} onchange={() => pick(s.code)} />
						<span>
							<strong>{s.code}</strong>
							{s.name}
							<span class="muted">· {PAN_LABEL[s.pan]} · {whereText(s)} · {recordText(s)}</span>
						</span>
					</label>
				{/each}
			</fieldset>
			{#if station}
				{#if station.pan === 'symons'}
					<fieldset class="choices" data-testid="evaporation-station-conversion">
						<legend>Convert the S-pan to A-pan with</legend>
						{#each station.conversions ?? [] as c (c.id)}
							<label class="choice">
								<input type="radio" name="{uid}-conv" value={c.id} checked={conversion === c.id} disabled={busy || !c.result.ok} onchange={() => (conversion = c.id)} />
								<span>{c.label}{#if !c.result.ok}<span class="muted"> · can’t be used here: {c.result.reason}</span>{/if}</span>
							</label>
						{/each}
						<p class="hint muted">{SPAN_INVERSION_CAVEAT} The daily S-pan record is not written: the equations are fitted on monthly totals, so only the 12 converted means are used.</p>
					</fieldset>
				{/if}
				{#if result && !result.ok}
					<p class="alert alert-info slim" data-testid="evaporation-station-problem">{station.code}’s record can’t be used: {result.reason}.</p>
				{/if}
				<div class="table-wrap">
					<table class="data compact monthly" data-testid="evaporation-station-rows">
						<caption class="visually-hidden">Monthly pan evaporation from the station, beside the saved A-pan</caption>
						<thead>
							<tr>
								<th scope="col" class="sticky">Month</th>
								{#each WATER_YEAR_MONTHS as m (m)}<th scope="col" class="num">{m}</th>{/each}
								<th scope="col" class="num">Year</th>
							</tr>
						</thead>
						<tbody>
							{#if station.pan === 'symons'}
								<tr data-row="span">
									<th scope="row" class="sticky">Station S-pan <span class="u">mm</span></th>
									{#each station.monthly.meansMm as v, i (i)}<td class="num">{v === null ? '–' : fmtNum(v, 1, true)}</td>{/each}
									<td class="num">{station.monthly.problem ? '–' : total(station.monthly.meansMm as number[])}</td>
								</tr>
							{/if}
							<tr data-row="proposed">
								<th scope="row" class="sticky">Proposed A-pan <span class="u">mm</span></th>
								{#if ready}
									{#each ready.apanMm as v, i (i)}<td class="num">{fmtNum(v, 1, true)}</td>{/each}
									<td class="num">{total(ready.apanMm)}</td>
								{:else}
									<td colspan="13" class="muted small">{station.pan === 'symons' && !conversion ? 'Pick an equation above' : 'None'}</td>
								{/if}
							</tr>
							<tr data-row="saved">
								<th scope="row" class="sticky">Saved A-pan <span class="u">mm</span></th>
								{#each data.settings.apanMm as v, i (i)}<td class="num">{fmtNum(v, 1, true)}</td>{/each}
								<td class="num">{total(data.settings.apanMm)}</td>
							</tr>
						</tbody>
					</table>
				</div>
				<p class="hint muted">
					Each month is the mean of its complete months in the record ({station.monthly.first ?? '–'} to {station.monthly.last ?? '–'}): a month counts with 80 % of its days read, at least 3
					years each.
				</p>
				{#if station.pan === 'class_a' && !readonly}
					{#if blocker}
						<p class="hint muted" data-testid="evaporation-station-daily-blocked">
							The project already has a daily A-pan series, “{blocker.name}”: a run reads one, so only the monthly means are written. Delete or replace it on the Data page to use this record.
						</p>
					{:else}
						<label class="choice">
							<input type="checkbox" bind:checked={daily} disabled={busy} data-testid="evaporation-station-daily" />
							<span>Also write its daily record ({station.recordStart} to {station.recordEnd}) as the daily A-pan series “{station.seriesName}”</span>
						</label>
					{/if}
				{/if}
				{#if data.settings.dailyApan.length}
					<p class="small" data-testid="evaporation-station-daily-now">
						The daily A-pan series “{data.settings.dailyApan[0]!.name}” ({data.settings.dailyApan[0]!.from} to {data.settings.dailyApan[0]!.to}) replaces the monthly row on every day it covers.
					</p>
				{/if}
				{#if same}
					<p class="muted small" data-testid="evaporation-station-same">The saved settings hold this station’s values.</p>
				{:else if readonly}
					<p class="hint muted">Only an editor can use these values.</p>
				{:else if formDirty}
					<p class="hint muted" id="{uid}-dirty">Save or discard your settings changes first: values used here are saved straight away.</p>
				{/if}
				{#if useError}<p class="err small" role="alert">{useError}</p>{/if}
				<ProposalSource
					testid="evaporation-station-source"
					citation="{station.source} (dataset “{station.dataset}”; station {station.code}, {PAN_LABEL[station.pan]}, {station.lat}, {station.lon})."
					method="DWS verified daily pan evaporation, mm a day. Monthly means: each calendar month with at least 80 % of its days read counts, its total being the mean day × its days; each of the 12 means needs at least 3 such years. A Symons pan’s means are converted by the inverted S-pan ← A-pan equation picked, refused where a month’s S-pan is below the depths it was fitted on."
				/>
			{/if}
		{/if}
	{/if}
</ProposalPanel>

<style>
	.choices {
		border: 0;
		padding: 0;
		margin: 0;
		display: grid;
		gap: 0.35rem;
	}
	.choices legend {
		font-weight: 600;
		font-size: 0.9rem;
		padding: 0;
		margin-bottom: 0.25rem;
	}
	.choice {
		display: flex;
		gap: 0.5rem;
		align-items: flex-start;
		font-size: 0.9rem;
		min-height: 24px;
	}
	.choice input {
		margin-top: 0.2rem;
		flex: none;
	}
	.num {
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
		text-align: right;
	}
	.saves-now {
		font-size: var(--font-xs);
		font-weight: 600;
		padding: 0.05rem 0.45rem;
		border-radius: 999px;
		background: var(--warning-soft);
	}
	.slim {
		padding: 0.5rem 0.75rem;
		margin: 0;
	}
	.err {
		color: var(--danger);
		margin: 0;
	}
	.hint,
	.small {
		font-size: 0.85rem;
		margin: 0;
	}
	.table-wrap {
		width: 100%;
		overflow-x: auto;
		container: monthly / inline-size;
	}
	th.sticky {
		position: sticky;
		left: 0;
		z-index: 2;
		background: var(--surface);
		white-space: nowrap;
	}
	thead th.sticky {
		background: var(--surface-2);
		z-index: 3;
	}
	.monthly th.sticky {
		width: 13rem;
		white-space: normal;
	}
	@container monthly (max-width: 30rem) {
		.monthly th.sticky {
			width: 6.5rem;
			min-width: 6.5rem;
		}
		.monthly th.sticky .u {
			display: block;
		}
	}
	.monthly td {
		width: calc(6.5ch + 0.7rem + 2px + 0.4rem);
		padding-left: 0.2rem;
		padding-right: 0.2rem;
	}
</style>
