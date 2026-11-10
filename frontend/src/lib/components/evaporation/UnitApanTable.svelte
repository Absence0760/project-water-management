<!--
	Model settings → Demand → A-pan from "CCWR A-pan (Hydrological Unit)"
	(docs/ui.md § Demand, docs/maps.md § A-pan for each unit): each
	hydrological unit's 12 monthly A-pan means from the CCWR A-pan grid,
	area-weighted over the unit's outline, beside the catchment average, with
	each unit's year and its difference from the catchment's. Use (editors,
	"Saves now", asks first, waits while the form has other unsaved changes)
	saves each covered unit's row and the option itself (settings.apanUnits,
	apanBasis 'units', engine ≥ 1.117.0) as one settings revision citing the
	grid: the model then runs each unit on its own A-pan. Units the grid covers under 90 %, without an
	outline or with several parcels are listed with the reason, never filled
	from elsewhere. Lazy: its own chunk, loaded only when the option is picked.
-->
<script lang="ts">
	import { untrack } from 'svelte';
	import { api, type UnitApanProposal } from '#lib/api/index.js';
	import { confirmDialog } from '#lib/components/common/confirm.svelte.js';
	import ProposalPanel from '#lib/components/proposals/ProposalPanel.svelte';
	import ProposalSynthetic from '#lib/components/proposals/ProposalSynthetic.svelte';
	import { evaporationGridName } from '#lib/components/evaporation/ccwrApan.js';
	import { fmtNum } from '#lib/format/number.js';
	import { WATER_YEAR_MONTHS } from '#lib/format/months.js';
	import { catchmentRow, diffText, leftOut, savedText, spreadText, useMessage } from './unitApan';

	let {
		projectId,
		dataset,
		readonly = true,
		formDirty = false,
		onApplied
	}: {
		projectId: string;
		/** The A-pan grid's label (the CCWR A-pan grid's). */
		dataset: string;
		readonly?: boolean;
		/** Unsaved settings other than this option: Use waits until they are saved or discarded. */
		formDirty?: boolean;
		/** The settings changed on the server: the form takes them as they now are. */
		onApplied?: () => Promise<void> | void;
	} = $props();

	const uid = $props.id();
	let data = $state.raw<UnitApanProposal | null>(null);
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
			const d = await api.unitApan.get(projectId, dataset);
			if (mine === seq) data = d;
		} catch (e) {
			if (mine === seq) error = e instanceof Error ? e.message : String(e);
		} finally {
			if (mine === seq) loading = false;
		}
	}
	$effect(() => {
		void projectId;
		void dataset;
		untrack(() => void load());
	});

	const catchment = $derived(data ? catchmentRow(data) : null);
	const spread = $derived(data ? spreadText(data) : null);
	const missing = $derived(data ? leftOut(data) : []);
	const name = $derived(evaporationGridName(dataset));
	const canUse = $derived(!!data?.dataset && data.units.length > 0 && !data.same);

	async function use() {
		if (!data?.dataset) return;
		const ok = await confirmDialog({ title: 'Run each unit on its own A-pan?', message: useMessage(data), confirmLabel: 'Use for each unit' });
		if (!ok) return;
		busy = true;
		useError = null;
		try {
			const r = await api.unitApan.use(projectId, data.dataset.label);
			notice = `${r.units.length} unit${r.units.length === 1 ? '' : 's'} now run${r.units.length === 1 ? 's' : ''} on ${r.units.length === 1 ? 'its' : 'their'} own A-pan from the ${name} grid, saved as a settings revision citing ${data.dataset.source.split(':')[0]} (${data.dataset.version}).`;
			await Promise.all([load(), onApplied?.()]);
			await frame?.focusNotice();
		} catch (e) {
			useError = e instanceof Error ? e.message : String(e);
		} finally {
			busy = false;
		}
	}
</script>

<ProposalPanel
	bind:this={frame}
	testid="unit-apan"
	prefix="unit-apan"
	variant="inline"
	title="{name} (Hydrological Unit)"
	level={4}
	what="units’ A-pan"
	bodyGrid
	{notice}
	{loading}
	loaded={data !== null}
	{error}
	onretry={load}
>
	{#snippet actions()}
		{#if canUse && !readonly}
			<span class="saves-now" id="{uid}-now">Saves now</span>
			<button type="button" class="btn btn-sm" disabled={busy || formDirty} aria-describedby={formDirty ? `${uid}-now ${uid}-dirty` : `${uid}-now`} onclick={use}
				>{busy ? 'Saving…' : 'Use for each unit'}</button
			>
		{/if}
	{/snippet}
	{#snippet intro()}<p class="hint muted explain" id="{uid}-what">
			Each hydrological unit’s monthly A-pan from the WRC Atlas’s modelled A-pan equivalent grid, area-weighted over the unit’s outline,
			beside the catchment average, so you can judge whether the units differ enough to matter. Use saves them: the model then runs each
			unit on its own A-pan. Nothing changes until you use it.
		</p>{/snippet}

	{#if data}
		{#if !data.dataset}
			<p class="alert alert-info slim" data-testid="unit-apan-not-loaded">There’s no {name} grid on this server yet, so there is nothing to compare.</p>
		{:else}
			{#if data.dataset.synthetic}
				<ProposalSynthetic testid="unit-apan-synthetic" subject="The grid" notWhat="any real evaporation" forWhat="catchment" />
			{/if}
			{#if spread}<p class="small" data-testid="unit-apan-spread">{spread}</p>{/if}
			{#if !data.boundary}
				<p class="hint muted" data-testid="unit-apan-no-boundary">There is no catchment boundary on the map, so there is no catchment average to compare the units with.</p>
			{:else if data.catchment && 'problem' in data.catchment}
				<p class="hint muted" data-testid="unit-apan-no-catchment">The grid can’t be averaged over the boundary “{data.boundary.name}”: {data.catchment.problem}.</p>
			{/if}
			{#if data.units.length || catchment}
				<div class="table-wrap">
					<table class="data compact monthly" data-testid="unit-apan-rows" aria-describedby="{uid}-what">
						<caption class="visually-hidden">Each unit’s monthly A-pan from the {name} grid, beside the catchment average, mm</caption>
						<thead>
							<tr>
								<th scope="col" class="sticky">Unit</th>
								{#each WATER_YEAR_MONTHS as m (m)}<th scope="col" class="num">{m}</th>{/each}
								<th scope="col" class="num">Year</th>
								<th scope="col" class="num">vs catchment</th>
							</tr>
						</thead>
						<tbody>
							{#if catchment}
								<tr data-row="catchment" class="catchment">
									<th scope="row" class="sticky">Catchment average <span class="u">mm</span></th>
									{#each catchment.monthlyMm as v, i (i)}<td class="num">{fmtNum(v)}</td>{/each}
									<td class="num">{fmtNum(catchment.annualMm)}</td>
									<td class="num muted">–</td>
								</tr>
							{/if}
							{#each data.units as u (u.nodeId)}
								<tr data-row="unit" data-node={u.nodeId}>
									<th scope="row" class="sticky">{u.name}</th>
									{#each u.monthlyMm as v, i (i)}<td class="num">{fmtNum(v)}</td>{/each}
									<td class="num">{fmtNum(u.annualMm)}</td>
									<td class="num">{diffText(u.diffPct)}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{:else}
				<p class="hint muted" data-testid="unit-apan-none">The grid covers none of the units.</p>
			{/if}
			{@const savedLine = savedText(data)}
			{#if savedLine}<p class="small" data-testid="unit-apan-saved" data-same={data.same ? 'true' : 'false'}>{savedLine}</p>{/if}
			{#if canUse && readonly}
				<p class="hint muted">Only an editor can use these values.</p>
			{:else if canUse && formDirty}
				<p class="hint muted" id="{uid}-dirty">Save or discard your other settings changes first: Use saves straight away.</p>
			{/if}
			{#if useError}<p class="err small" role="alert">{useError}</p>{/if}
			{#if missing.length}
				<div data-testid="unit-apan-left-out">
					<p class="small">Not in the table (never filled from elsewhere; under this option they run on the covered units’ area-weighted mean):</p>
					<ul class="small">
						{#each missing as u (u.nodeId)}<li><strong>{u.name}</strong>: {u.reason}</li>{/each}
					</ul>
				</div>
			{/if}
		{/if}
	{/if}
</ProposalPanel>

<style>
	.saves-now {
		font-size: var(--font-xs);
		font-weight: 600;
		padding: 0.05rem 0.45rem;
		border-radius: 999px;
		background: var(--warning-soft);
	}
	.err {
		color: var(--danger);
		margin: 0;
	}
	.slim {
		padding: 0.5rem 0.75rem;
		margin: 0;
	}
	.hint,
	.small {
		font-size: 0.85rem;
		margin: 0;
	}
	ul.small {
		padding-left: 1.25rem;
	}
	.num {
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
		text-align: right;
	}
	.catchment th,
	.catchment td {
		font-weight: 600;
	}
	.table-wrap {
		width: 100%;
		overflow-x: auto;
		container: unitapan / inline-size;
	}
	/* The unit names stay put while the months scroll sideways on a phone. */
	th.sticky {
		position: sticky;
		left: 0;
		z-index: 2;
		background: var(--surface);
		width: 11rem;
		white-space: normal;
	}
	thead th.sticky {
		background: var(--surface-2);
		z-index: 3;
	}
	@container unitapan (max-width: 30rem) {
		th.sticky {
			width: 6.5rem;
			min-width: 6.5rem;
		}
		th.sticky .u {
			display: block;
		}
	}
</style>
