<!--
	A unit's drawer → "Actual ET from satellite:" (issue #623; docs/ui.md § Farm drawer, docs/model.md §2.10o).
	Under the planted areas, folded to one line (etLine): how many dekads of FAO WaPOR actual ET over the unit's
	parcels were compared with the newest run, and which way the model's crop ET and irrigation lean. Opened: the
	summary in words, the observed area when it is far from the planted area, a note that a difference points at the
	inputs (never a correction: the model doesn't read these values), a table per half water year, the dekads
	newest first (DEKADS_SHOWN, "Show all N dekads" for the rest), Download (CSV) with the credit on its first line,
	and the credit. With no observations, the usual case (the fetch is off by default), it says so and nothing else.
	One request per unit (GET …/nodes/:nodeId/et-observed), the run being the project's newest.
-->
<script lang="ts">
	import { untrack } from 'svelte';
	import { api, type EtObserved } from '#lib/api/index.js';
	import Fold from '#lib/components/common/Fold.svelte';
	import { foldList } from '#lib/components/common/fold.js';
	import { saveBlob } from '#lib/export/download.js';
	import { fmtDay, fmtNum } from '#lib/format/number.js';
	import { mapNodeHref } from '#lib/workspace/mapLinks.js';
	import { areaWords, DEKADS_SHOWN, otherSourcesWords, dekadRows, ET_ATTRIBUTION, etCsv, etCsvName, etLine, leadSource, seasonRows, SOURCE_WORDS, summaryWords } from './etObserved';

	let {
		projectId,
		nodeId,
		name,
		dirty = false
	}: {
		projectId: string;
		/** The hydrological unit, saved in the model. */
		nodeId: string;
		name: string;
		/** Unsaved model changes: the planted areas being edited aren't in the run compared with. */
		dirty?: boolean;
	} = $props();

	const uid = $props.id();
	const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

	let data = $state.raw<EtObserved | null>(null);
	let loading = $state(false);
	let error = $state<string | null>(null);
	let attempt = $state(0);
	let open = $state(false);
	let dataKey = '';
	$effect(() => {
		const key = `${projectId}|${nodeId}|${attempt}`;
		untrack(() => {
			if (key === dataKey) return;
			dataKey = key;
			data = null;
			error = null;
			loading = true;
			api
				.etObserved(projectId, nodeId)
				.then((d) => {
					if (dataKey === key) data = d;
				})
				.catch((e) => {
					if (dataKey === key) error = msg(e);
				})
				.finally(() => {
					if (dataKey === key) loading = false;
				});
		});
	});

	const lead = $derived(leadSource(data));
	const line = $derived(etLine(data, loading, error));
	const withinShare = $derived(data?.thresholds.withinShare ?? 0.25);
	const summary = $derived(lead ? summaryWords(lead.summary, withinShare) : null);
	const area = $derived(lead && data ? areaWords(lead, data.plantedAreaM2) : null);
	const seasons = $derived(lead ? seasonRows(lead) : []);
	const rows = $derived(lead ? dekadRows(lead) : []);
	let allDekads = $state(false);
	$effect(() => {
		void nodeId;
		allDekads = false;
	});
	const folded = $derived(foldList(rows, (r) => r.key, null, allDekads, DEKADS_SHOWN));
	const otherSources = $derived(otherSourcesWords(data, lead));
	const minValid = $derived(fmtNum((data?.thresholds.minValidShare ?? 0.8) * 100, 0));

	function download() {
		if (!data) return;
		saveBlob(new Blob(['\ufeff', etCsv(data)], { type: 'text/csv;charset=utf-8' }), etCsvName(data.name));
	}
</script>

<section class="et-observed" aria-label="{name}: actual ET from satellite" data-testid="et-observed" data-ready={loading ? 'false' : 'true'}>
	<Fold name="Actual ET from satellite:" {line} readonly problem={false} body="stack" class="et-fold" lineTestid="et-observed-line" bind:open>
		{#if error}
			<p class="err small" role="alert">
				The satellite actual ET couldn’t be loaded: {error}
				<button type="button" class="btn btn-sm" onclick={() => attempt++}>Try again</button>
			</p>
		{:else if loading}
			<p class="muted small" role="status">Loading the satellite actual ET…</p>
		{:else if !lead}
			<p class="muted small" data-testid="et-observed-empty">
				No satellite actual ET for {name} yet. When it is switched on for this site (it is off by default), it is read each
				dekad from satellite ({ET_ATTRIBUTION.wapor}) over the farm parcels linked to {name} on the Map, and compared
				here with the model’s crop water use.
				<a href={mapNodeHref(nodeId)}>Open the Map</a>
			</p>
		{:else}
			{#if !data?.run}
				<p class="muted small" data-testid="et-observed-run">No run yet, so the dekads are shown without the model’s figures.</p>
			{:else if !data.run.inRun}
				<p class="muted small" data-testid="et-observed-run">{name} isn’t in the newest run, “{data.run.label}”, so the dekads are shown without the model’s figures.</p>
			{:else}
				<p class="small" data-testid="et-observed-run">Compared with the newest run, “{data.run.label}” ({fmtDay(data.run.createdAt)}).</p>
			{/if}
			{#if dirty && data?.run}
				<p class="small note" data-testid="et-observed-dirty">Your unsaved changes to the planted areas aren’t in this run.</p>
			{/if}
			{#if otherSources}<p class="small note" data-testid="et-observed-other">{otherSources}</p>{/if}
			{#if summary}<p class="small" data-testid="et-observed-summary">{summary}</p>{/if}
			{#if area}<p class="small note" data-testid="et-observed-area">{area}</p>{/if}
			<p class="small note">
				Modelled crop ET is the model’s effective rain plus the irrigation the run delivered to the crop (at most the planted
				area × crop factor × A-pan, when the run supplies it all); irrigation seen is the satellite’s ET less that rain. A difference points at the inputs (crops, areas, crop factors, the
				A-pan row, the efficiency); the model never reads these values. Dekads under {minValid}% seen clearly aren’t compared.
			</p>
			{#if seasons.length}
				<div class="table-stack"><div class="table-wrap">
					<table class="data compact" data-testid="et-observed-seasons">
						<caption class="visually-hidden">{name}: satellite and modelled water use by half water year</caption>
						<thead>
							<tr>
								<th scope="col">Season</th>
								<th scope="col" class="num">Dekads compared</th>
								<th scope="col" class="num">ET seen</th>
								<th scope="col" class="num">Crop ET modelled</th>
								<th scope="col" class="num">Crop ET bias</th>
								<th scope="col" class="num">Irrigation seen</th>
								<th scope="col" class="num">Irrigation modelled</th>
								<th scope="col" class="num">Irrigation bias</th>
							</tr>
						</thead>
						<tbody>
							{#each seasons as s (s.key)}
								<tr>
									<th scope="row">{s.label}</th>
									<td class="num" data-label="Dekads compared">{s.dekads}</td>
									<td class="num" data-label="ET seen">{s.observedEt}</td>
									<td class="num" data-label="Crop ET modelled">{s.modelledEt}</td>
									<td class="num" data-label="Crop ET bias">{s.etBias}</td>
									<td class="num" data-label="Irrigation seen">{s.observedIrrigation}</td>
									<td class="num" data-label="Irrigation modelled">{s.modelledIrrigation}</td>
									<td class="num" data-label="Irrigation bias">{s.irrigationBias}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div></div>
			{/if}
			<details class="dekads">
				<summary>The {fmtNum(rows.length)} {SOURCE_WORDS[lead.source]} dekad{rows.length === 1 ? '' : 's'}, newest first</summary>
				<div class="table-stack"><div class="table-wrap">
					<table class="data compact" id="{uid}-dekads" data-testid="et-observed-dekads">
						<caption class="visually-hidden">{name}: each dekad’s satellite actual ET beside the run, newest first</caption>
						<thead>
							<tr>
								<th scope="col">Dekad</th>
								<th scope="col" class="num">ETa</th>
								<th scope="col" class="num">ET seen</th>
								<th scope="col" class="num">Crop ET modelled</th>
								<th scope="col" class="num">Irrigation seen</th>
								<th scope="col" class="num">Irrigation modelled</th>
								<th scope="col">Compared</th>
							</tr>
						</thead>
						<tbody>
							{#each folded.shown as r (r.key)}
								<tr class:outside={r.outside}>
									<th scope="row">{r.dekad}</th>
									<td class="num" data-label="ETa">{r.eta}</td>
									<td class="num" data-label="ET seen">{r.observedEt}</td>
									<td class="num" data-label="Crop ET modelled">{r.modelledEt}</td>
									<td class="num" data-label="Irrigation seen">{r.observedIrrigation}</td>
									<td class="num" data-label="Irrigation modelled">{r.modelledIrrigation}</td>
									<td data-label="Compared">{r.note}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div></div>
				{#if folded.hidden || allDekads}
					<button type="button" class="btn btn-sm more" aria-expanded={allDekads} aria-controls="{uid}-dekads" onclick={() => (allDekads = !allDekads)}>
						{allDekads ? `Show the newest ${fmtNum(DEKADS_SHOWN)} dekads` : `Show all ${fmtNum(rows.length)} dekads`}
					</button>
				{/if}
			</details>
			<p class="csv"><button type="button" class="btn btn-sm" data-testid="et-observed-csv" onclick={download}>Download the dekads (CSV)</button></p>
			{#each data?.sources ?? [] as s (s.source)}
				<p class="fine muted" data-testid="et-observed-credit">Actual ET ({SOURCE_WORDS[s.source]}): {s.attribution}.</p>
			{/each}
		{/if}
	</Fold>
</section>

<style>
	.et-observed {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		min-width: 0;
		margin: 1rem 0 0;
	}
	.et-observed :global(.et-fold .fold-stack) {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 0.6rem;
	}
	.small,
	.fine {
		font-size: 0.85rem;
		margin: 0;
	}
	.note {
		color: var(--text-2);
	}
	.err {
		color: var(--danger);
	}
	.dekads summary {
		cursor: pointer;
		min-height: 24px;
		font-size: 0.85rem;
	}
	.table-wrap {
		max-height: none;
		margin-top: 0.4rem;
	}
	.more,
	.csv {
		margin: 0.4rem 0 0;
	}
	.num {
		font-variant-numeric: tabular-nums;
		text-align: right;
	}
	tr.outside th,
	tr.outside td:last-child {
		color: var(--danger);
	}
	/* The drawer (480 px at most) is under .table-stack's 50rem at every width: each row is a block, its figures under
	   their own labels (ui-playbook.md § 2 "Fit a wide table by stacking"); the note why takes the whole line. */
	@container table-stack (max-width: 50rem) {
		td[data-label='Compared'] {
			grid-column: 1 / -1;
		}
	}
</style>
