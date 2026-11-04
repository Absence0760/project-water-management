<!--
	Model settings → Demand → Where the A-pan row comes from → "WR2012 Pitman
	configuration, per quaternary" (docs/ui.md § Demand, docs/maps.md § WR2012
	evaporation by quaternary). Lazy: loaded only when that source is picked.
	For each quaternary the catchment boundary overlaps: its share of the
	catchment, WR2012's MAE and evaporation zone (context), and the monthly
	S-pan (runoff modules) and A-pan (irrigation modules) of WR2012's WRSM2000
	network configurations, with how the modules agree (flagged where they
	don't). The catchment's rows are the area-weighted means. The A-pan is the
	model's own input, so Use (editors, "Saves now") writes it as it stands, as
	one settings revision naming the dataset, quaternaries, shares and module
	files; it asks first and waits while the form has unsaved changes. A
	quaternary with S-pan only proposes no A-pan and says so: its S-pan can be
	converted under "Typed or pasted S-pan, converted".
-->
<script lang="ts">
	import { untrack } from 'svelte';
	import { api, type Wr2012EvaporationProposal } from '#lib/api/index.js';
	import { confirmDialog } from '#lib/components/common/confirm.svelte.js';
	import ProposalNoDataset from '#lib/components/proposals/ProposalNoDataset.svelte';
	import ProposalPanel from '#lib/components/proposals/ProposalPanel.svelte';
	import ProposalSource from '#lib/components/proposals/ProposalSource.svelte';
	import ProposalSynthetic from '#lib/components/proposals/ProposalSynthetic.svelte';
	import { fmtNum } from '#lib/format/number.js';
	import { WATER_YEAR_MONTHS } from '#lib/format/months.js';
	import { sameAsSaved } from './stationProposal';
	import { agreementText, annualMm, meanText, ratioText, shareText, useMessage } from './wr2012Evaporation';

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

	let data = $state.raw<Wr2012EvaporationProposal | null>(null);
	let loading = $state(false);
	let error = $state<string | null>(null);
	let busy = $state(false);
	let useError = $state<string | null>(null);
	let notice = $state<string | null>(null);
	let frame = $state<ProposalPanel | null>(null);
	let seq = 0;

	async function load() {
		const mine = ++seq;
		loading = true;
		error = null;
		try {
			const d = await api.evaporationWr2012.get(projectId);
			if (mine !== seq) return;
			data = d;
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

	const ev = $derived(data?.evaporation ?? null);
	const withApan = $derived(ev ? ev.quaternaries.filter((q) => q.apanMm) : []);
	const same = $derived(!!ev?.apanMm && !!data && sameAsSaved(data.settings.apanMm, ev.apanMm));
	const fmtRow = (row: readonly number[]) => row.map((v) => fmtNum(v, 1, true));

	async function use() {
		if (!data || !ev?.apanMm) return;
		const ok = await confirmDialog({ title: 'Use WR2012’s A-pan for the catchment?', message: useMessage(ev, data.settings.dailyApan), confirmLabel: 'Use WR2012’s A-pan' });
		if (!ok) return;
		busy = true;
		useError = null;
		try {
			const r = await api.evaporationWr2012.use(projectId);
			notice = `The A-pan row is now ${fmtNum(annualMm(r.apanMm))} mm a year from WR2012’s irrigation modules for ${r.quaternaries.join(', ')}, saved as a settings revision citing the quaternaries and the module files.`;
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
	testid="wr2012-evaporation-proposal"
	prefix="wr2012-evaporation"
	id="apan-wr2012"
	variant="inline"
	title="WR2012 evaporation by quaternary"
	level={3}
	what="WR2012 evaporation"
	bodyGrid
	{notice}
	{loading}
	loaded={data !== null}
	{error}
	onretry={load}
>
	{#snippet actions()}
		{#if ev?.apanMm && !same && !readonly}
			<span class="saves-now" id="{uid}-now">Saves now</span>
			<button
				type="button"
				class="btn btn-sm"
				data-testid="wr2012-evaporation-use"
				disabled={busy || formDirty}
				aria-describedby={formDirty ? `${uid}-now ${uid}-dirty` : `${uid}-now`}
				onclick={use}>{busy ? 'Saving…' : 'Use as the A-pan'}</button
			>
		{/if}
	{/snippet}
	{#snippet intro()}<p class="hint muted explain">
		WR2012’s own monthly pan evaporation for each quaternary under the catchment boundary, from its WRSM2000 (Pitman) network configurations: the
		irrigation modules’ Class-A pan, which the model reads as it stands, and the runoff modules’ Symons pan (S-pan) beside it. Nothing changes
		until you use it.
	</p>{/snippet}

	{#if data}
		{#if !data.datasets.length}
			<ProposalNoDataset testid="wr2012-evaporation-no-dataset" what="quaternary dataset" consequence="no evaporation can be proposed" instead="Enter the A-pan by hand, or use an evaporation station." />
		{:else if !data.boundary || !ev}
			<p class="alert alert-info slim" data-testid="wr2012-evaporation-no-boundary">
				There is no catchment boundary on the map yet. Draw or import it on the Map; the quaternaries are found under it. <a href="?tab=map">Open the Map</a>
			</p>
		{:else}
			{#if ev.quaternaries.some((q) => q.synthetic)}
				<ProposalSynthetic testid="wr2012-evaporation-synthetic" subject="The quaternaries’ evaporation" notWhat="WR2012’s values" forWhat="catchment" />
			{/if}
			{#if ev.problem}
				<p class="alert alert-info slim" data-testid="wr2012-evaporation-problem">WR2012’s A-pan can’t be proposed for “{data.boundary.name}”: {ev.problem}.</p>
			{/if}
			{#if ev.quaternaries.length}
				<div class="table-wrap">
					<table class="data compact" data-testid="wr2012-evaporation-quaternaries">
						<caption class="visually-hidden">The quaternaries under the catchment boundary, with WR2012’s evaporation for each</caption>
						<thead>
							<tr>
								<th scope="col">Quaternary</th>
								<th scope="col" class="num">Share</th>
								<th scope="col">Zone</th>
								<th scope="col" class="num">MAE <span class="u">mm</span></th>
								<th scope="col" class="num">S-pan <span class="u">mm</span></th>
								<th scope="col" class="num">A-pan <span class="u">mm</span></th>
								<th scope="col" class="num">A ÷ S</th>
								<th scope="col">Runoff modules</th>
								<th scope="col">Irrigation modules</th>
							</tr>
						</thead>
						<tbody>
							{#each ev.quaternaries as q (q.code)}
								<tr data-code={q.code} data-disagree={q.disagree}>
									<th scope="row">{q.code}</th>
									<td class="num">{shareText(q.share)}</td>
									<td>{q.zone ?? '–'}</td>
									<td class="num">{q.maeMm === null ? '–' : fmtNum(Math.round(q.maeMm))}</td>
									<td class="num">{q.spanMm ? fmtNum(annualMm(q.spanMm)) : '–'}</td>
									<td class="num">{q.apanMm ? fmtNum(annualMm(q.apanMm)) : '–'}</td>
									<td class="num">{ratioText(q)}</td>
									<td class:flag={!!q.span && q.span.agree < q.span.modules}>{agreementText(q.span)}</td>
									<td class:flag={!!q.apan && q.apan.agree < q.apan.modules}>{q.why && !q.apanMm ? `None: ${q.why}` : agreementText(q.apan)}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
				{#if ev.quaternaries.some((q) => q.disagree)}
					<p class="hint" data-testid="wr2012-evaporation-disagree">
						Where a quaternary’s modules disagree, the row most of them give is used, and the others’ annual totals are listed: check them against the
						MAE before using the row.
					</p>
				{/if}
			{/if}
			{#if ev.apanMm}
				<p class="hint muted" data-testid="wr2012-evaporation-mean">{meanText(ev)}</p>
				<div class="table-wrap">
					<table class="data compact monthly" data-testid="wr2012-evaporation-rows">
						<caption class="visually-hidden">Monthly A-pan for each quaternary and the catchment, the catchment’s S-pan and the saved A-pan</caption>
						<thead>
							<tr>
								<th scope="col" class="sticky">Month</th>
								{#each WATER_YEAR_MONTHS as m (m)}<th scope="col" class="num">{m}</th>{/each}
								<th scope="col" class="num">Year</th>
							</tr>
						</thead>
						<tbody>
							{#if withApan.length > 1}
								{#each withApan as q (q.code)}
									<tr data-row="quaternary" data-code={q.code}>
										<th scope="row" class="sticky">{q.code} A-pan <span class="u">mm</span></th>
										{#each fmtRow(q.apanMm!) as v, i (i)}<td class="num">{v}</td>{/each}
										<td class="num">{fmtNum(annualMm(q.apanMm!))}</td>
									</tr>
								{/each}
							{/if}
							{#if ev.spanMm}
								<tr data-row="span">
									<th scope="row" class="sticky">Catchment S-pan <span class="u">mm</span></th>
									{#each fmtRow(ev.spanMm) as v, i (i)}<td class="num">{v}</td>{/each}
									<td class="num">{fmtNum(annualMm(ev.spanMm))}</td>
								</tr>
							{/if}
							<tr data-row="proposed">
								<th scope="row" class="sticky">Proposed A-pan <span class="u">mm</span></th>
								{#each fmtRow(ev.apanMm) as v, i (i)}<td class="num">{v}</td>{/each}
								<td class="num">{fmtNum(annualMm(ev.apanMm))}</td>
							</tr>
							<tr data-row="saved">
								<th scope="row" class="sticky">Saved A-pan <span class="u">mm</span></th>
								{#each fmtRow(data.settings.apanMm) as v, i (i)}<td class="num">{v}</td>{/each}
								<td class="num">{fmtNum(annualMm(data.settings.apanMm))}</td>
							</tr>
						</tbody>
					</table>
				</div>
				<p class="hint muted explain">
					Dam evaporation’s WR90 lake-factor presets (below) start from the A-pan row and turn it back into S-pan with the WR90 or Taljaard (2023)
					equation, not with the runoff modules’ S-pan shown here, so the S-pan they assume differs from this row by those equations’ fit.
				</p>
				{#if data.settings.dailyApan.length}
					<p class="small" data-testid="wr2012-evaporation-daily-now">
						The daily A-pan series “{data.settings.dailyApan[0]!.name}” ({data.settings.dailyApan[0]!.from} to {data.settings.dailyApan[0]!.to}) replaces the monthly row on every day it covers.
					</p>
				{/if}
				{#if same}
					<p class="muted small" data-testid="wr2012-evaporation-same">The saved settings hold these values.</p>
				{:else if readonly}
					<p class="hint muted">Only an editor can use these values.</p>
				{:else if formDirty}
					<p class="hint muted" id="{uid}-dirty">Save or discard your settings changes first: values used here are saved straight away.</p>
				{/if}
				{#if useError}<p class="err small" role="alert">{useError}</p>{/if}
			{/if}
			{#if ev.quaternaries.some((q) => q.source)}
				<ProposalSource
					testid="wr2012-evaporation-source"
					citation="{[...new Set(ev.quaternaries.flatMap((q) => (q.source ? [q.source] : [])))].join(' ')} (dataset {[...new Set(ev.quaternaries.flatMap((q) => (q.evaporationDataset ? [`“${q.evaporationDataset}”`] : [])))].join(', ')})."
					method="Per quaternary, the monthly A-pan of its WRSM2000 irrigation modules and the monthly S-pan of its runoff modules, the row most modules give where they disagree. The catchment’s rows are their means weighted by the share of the catchment’s area in each quaternary (found on a grid of 128 cells along the boundary’s longer side), over the quaternaries that have each row."
				/>
			{/if}
		{/if}
	{/if}
</ProposalPanel>

<style>
	.num {
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
		text-align: right;
	}
	td.flag {
		font-weight: 600;
		background: var(--warning-soft);
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
