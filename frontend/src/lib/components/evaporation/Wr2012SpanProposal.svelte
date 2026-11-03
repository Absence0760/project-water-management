<!--
	Calibration → Flow calibration → "WR2012 S-pan by quaternary" (docs/ui.md §
	Set up the fit, docs/maps.md § WR2012 S-pan), under "Evaporation stations".
	WR2012's Symons-pan (S-pan) evaporation for each quaternary the catchment
	boundary overlaps: its code, zone, MAE and share of the catchment, and its
	12 months of MAE × the zone's monthly % of MAE; then the catchment's S-pan,
	their area-weighted mean (one quaternary: its row). The S-pan rows are the
	deliverable on screen even though the model takes A-pan. They reach the
	A-pan row only through the S→A equation the user picks (none is picked for
	them), with Taljaard's warning beside the choice and an equation that
	can't be used disabled with its reason. Use (editors, in the heading's row,
	marked "Saves now") asks first, then saves as one settings revision citing
	the dataset, quaternaries, zones, MAEs and equation; it waits while the
	form has unsaved changes. Nothing is applied by itself.
-->
<script lang="ts">
	import { SPAN_INVERSION_CAVEAT } from '@water-management/engine';
	import { untrack } from 'svelte';
	import { api, type SpanConversionId, type Wr2012SpanProposal } from '#lib/api/index.js';
	import { confirmDialog } from '#lib/components/common/confirm.svelte.js';
	import ProposalNoDataset from '#lib/components/proposals/ProposalNoDataset.svelte';
	import ProposalPanel from '#lib/components/proposals/ProposalPanel.svelte';
	import ProposalSource from '#lib/components/proposals/ProposalSource.svelte';
	import ProposalSynthetic from '#lib/components/proposals/ProposalSynthetic.svelte';
	import { fmtNum } from '#lib/format/number.js';
	import { WATER_YEAR_MONTHS } from '#lib/format/months.js';
	import { sameAsSaved } from './stationProposal';
	import { annualMm, chosenApan, meanText, shareText, useMessage, withSpan } from './wr2012SpanProposal';

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

	let data = $state.raw<Wr2012SpanProposal | null>(null);
	let loading = $state(false);
	let error = $state<string | null>(null);
	let busy = $state(false);
	let useError = $state<string | null>(null);
	let notice = $state<string | null>(null);
	let frame = $state<ProposalPanel | null>(null);
	let conversion = $state<SpanConversionId | null>(null);
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

	const span = $derived(data?.span ?? null);
	const used = $derived(span ? withSpan(span) : []);
	const apan = $derived(span ? chosenApan(span, conversion) : null);
	const same = $derived(!!apan && !!data && sameAsSaved(data.settings.apanMm, apan));
	const conversionLabel = $derived(conversion ? (span?.conversions.find((c) => c.id === conversion)?.label ?? null) : null);
	const fmtRow = (row: readonly number[]) => row.map((v) => fmtNum(v, 1, true));

	async function use() {
		if (!data || !span || !apan || !conversion || !conversionLabel) return;
		const ok = await confirmDialog({
			title: 'Use WR2012’s S-pan as the A-pan?',
			message: useMessage(span, apan, conversionLabel, data.settings.dailyApan),
			confirmLabel: 'Use WR2012’s S-pan'
		});
		if (!ok) return;
		busy = true;
		useError = null;
		try {
			const r = await api.evaporationWr2012.use(projectId, { conversion });
			notice = `The A-pan row is now ${fmtNum(annualMm(r.apanMm))} mm a year from WR2012’s S-pan for ${r.quaternaries.join(', ')}, saved as a settings revision citing the quaternaries and the equation.`;
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
	testid="wr2012-span-proposal"
	prefix="wr2012-span"
	id="set-evaporation-wr2012"
	variant="inline"
	title="WR2012 S-pan by quaternary"
	level={4}
	what="WR2012 S-pan"
	bodyGrid
	{notice}
	{loading}
	loaded={data !== null}
	{error}
	onretry={load}
>
	{#snippet actions()}
		{#if apan && !same && !readonly}
			<span class="saves-now" id="{uid}-now">Saves now</span>
			<button
				type="button"
				class="btn btn-sm"
				data-testid="wr2012-span-use"
				disabled={busy || formDirty}
				aria-describedby={formDirty ? `${uid}-now ${uid}-dirty` : `${uid}-now`}
				onclick={use}>{busy ? 'Saving…' : 'Use as the A-pan'}</button
			>
		{/if}
	{/snippet}
	{#snippet intro()}<p class="hint muted explain">
		WR2012’s Symons-pan (S-pan) evaporation for each quaternary under the catchment boundary: its mean annual evaporation (MAE) spread over the
		months by its evaporation zone’s monthly percentages. The model takes Class-A pan, so the catchment’s S-pan is converted only with the
		equation you pick. Nothing changes until you use it.
	</p>{/snippet}

	{#if data}
		{#if !data.datasets.length}
			<ProposalNoDataset testid="wr2012-span-no-dataset" what="quaternary dataset" consequence="no S-pan can be proposed" instead="Enter the A-pan by hand, or use an evaporation station." />
		{:else if !data.boundary || !span}
			<p class="alert alert-info slim" data-testid="wr2012-span-no-boundary">
				There is no catchment boundary on the map yet. Draw or import it on the Map; the quaternaries are found under it. <a href="?tab=map">Open the Map</a>
			</p>
		{:else}
			{#if span.quaternaries.some((q) => q.synthetic)}
				<ProposalSynthetic testid="wr2012-span-synthetic" subject="The quaternaries’ evaporation" notWhat="WR2012’s values" forWhat="catchment" />
			{/if}
			{#if span.problem}
				<p class="alert alert-info slim" data-testid="wr2012-span-problem">WR2012’s S-pan can’t be proposed for “{data.boundary.name}”: {span.problem}.</p>
			{/if}
			{#if span.quaternaries.length}
				<div class="table-wrap">
					<table class="data compact" data-testid="wr2012-span-quaternaries">
						<caption class="visually-hidden">The quaternaries under the catchment boundary, with their WR2012 evaporation</caption>
						<thead>
							<tr>
								<th scope="col">Quaternary</th>
								<th scope="col">Zone</th>
								<th scope="col" class="num">MAE <span class="u">mm</span></th>
								<th scope="col" class="num">Share of the catchment</th>
							</tr>
						</thead>
						<tbody>
							{#each span.quaternaries as q (q.code)}
								<tr data-code={q.code}>
									<th scope="row">{q.code}</th>
									<td>{q.zone ?? 'no WR2012 evaporation'}</td>
									<td class="num">{q.maeMm === null ? '–' : fmtNum(Math.round(q.maeMm))}</td>
									<td class="num">{shareText(q.share)}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{/if}
			{#if span.spanMm}
				<p class="hint muted" data-testid="wr2012-span-mean">{meanText(span)}</p>
				<fieldset class="choices" data-testid="wr2012-span-conversion">
					<legend>Convert the S-pan to A-pan with</legend>
					{#each span.conversions as c (c.id)}
						<label class="choice">
							<input type="radio" name="{uid}-conv" value={c.id} checked={conversion === c.id} disabled={busy || !c.result.ok} onchange={() => (conversion = c.id)} />
							<span>{c.label}{#if !c.result.ok}<span class="muted"> · can’t be used here: {c.result.reason}</span>{/if}</span>
						</label>
					{/each}
					<p class="hint muted">{SPAN_INVERSION_CAVEAT} Dam evaporation’s WR90 lake-factor presets convert the A-pan back to S-pan: pick the same equation there for a consistent round trip.</p>
				</fieldset>
				<div class="table-wrap">
					<table class="data compact monthly" data-testid="wr2012-span-rows">
						<caption class="visually-hidden">Monthly S-pan for each quaternary and the catchment, the proposed A-pan and the saved A-pan</caption>
						<thead>
							<tr>
								<th scope="col" class="sticky">Month</th>
								{#each WATER_YEAR_MONTHS as m (m)}<th scope="col" class="num">{m}</th>{/each}
								<th scope="col" class="num">Year</th>
							</tr>
						</thead>
						<tbody>
							{#if used.length > 1}
								{#each used as q (q.code)}
									<tr data-row="quaternary" data-code={q.code}>
										<th scope="row" class="sticky">{q.code} S-pan <span class="u">mm</span></th>
										{#each fmtRow(q.spanMm!) as v, i (i)}<td class="num">{v}</td>{/each}
										<td class="num">{fmtNum(annualMm(q.spanMm!))}</td>
									</tr>
								{/each}
							{/if}
							<tr data-row="span">
								<th scope="row" class="sticky">{used.length === 1 ? `${used[0]!.code} S-pan, the catchment’s` : 'Catchment S-pan, area-weighted'} <span class="u">mm</span></th>
								{#each fmtRow(span.spanMm) as v, i (i)}<td class="num">{v}</td>{/each}
								<td class="num">{fmtNum(annualMm(span.spanMm))}</td>
							</tr>
							<tr data-row="proposed">
								<th scope="row" class="sticky">Proposed A-pan <span class="u">mm</span></th>
								{#if apan}
									{#each fmtRow(apan) as v, i (i)}<td class="num">{v}</td>{/each}
									<td class="num">{fmtNum(annualMm(apan))}</td>
								{:else}
									<td colspan="13" class="muted small">Pick an equation above</td>
								{/if}
							</tr>
							<tr data-row="saved">
								<th scope="row" class="sticky">Saved A-pan <span class="u">mm</span></th>
								{#each fmtRow(data.settings.apanMm) as v, i (i)}<td class="num">{v}</td>{/each}
								<td class="num">{fmtNum(annualMm(data.settings.apanMm))}</td>
							</tr>
						</tbody>
					</table>
				</div>
				{#if data.settings.dailyApan.length}
					<p class="small" data-testid="wr2012-span-daily-now">
						The daily A-pan series “{data.settings.dailyApan[0]!.name}” ({data.settings.dailyApan[0]!.from} to {data.settings.dailyApan[0]!.to}) replaces the monthly row on every day it covers.
					</p>
				{/if}
				{#if same}
					<p class="muted small" data-testid="wr2012-span-same">The saved settings hold these values.</p>
				{:else if readonly}
					<p class="hint muted">Only an editor can use these values.</p>
				{:else if formDirty}
					<p class="hint muted" id="{uid}-dirty">Save or discard your settings changes first: values used here are saved straight away.</p>
				{/if}
				{#if useError}<p class="err small" role="alert">{useError}</p>{/if}
			{/if}
			{#if span.quaternaries.length}
				<ProposalSource
					testid="wr2012-span-source"
					citation="{[...new Set(span.quaternaries.map((q) => q.source))].join(' ')} (dataset{new Set(span.quaternaries.map((q) => q.dataset)).size === 1 ? '' : 's'} {[...new Set(span.quaternaries.map((q) => `“${q.dataset}”`))].join(', ')})."
					method="Each quaternary’s S-pan is its MAE × its evaporation zone’s monthly % of MAE ÷ 100, to 0.1 mm. The catchment’s is their mean weighted by the share of the catchment’s area in each (found on a grid of 128 cells along the boundary’s longer side), over the quaternaries with evaporation only. It becomes A-pan by the inverted S-pan ← A-pan equation picked, refused where a month’s S-pan is below the depths it was fitted on."
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
