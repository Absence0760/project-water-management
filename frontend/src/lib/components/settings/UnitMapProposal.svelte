<!--
	Settings → Rain for each unit → "MAP from the grid" (issue #482 follow-up;
	docs/ui.md § Settings, docs/maps.md § MAP for each unit). Each land unit's
	area-weighted MAP over its parcel from one MAP grid, beside what its form
	holds, with the grid cited. One grid for the whole project: the finest real
	grid that covers every unit, else the real grid covering the most (the
	synthetic grid only when no real one covers any), and the units it misses
	are listed, never filled from another grid. Use
	(editors) asks first, then writes every unit's MAP and source into the
	model as one change in History; it waits while the model has unsaved
	changes, since it saves straight to the project. Nothing is applied by
	itself.
-->
<script lang="ts">
	import { untrack } from 'svelte';
	import { api, type UnitMapProposal } from '$lib/api';
	import { confirmDialog } from '$lib/components/common/confirm.svelte';
	import ProposalNoDataset from '$lib/components/proposals/ProposalNoDataset.svelte';
	import ProposalPanel from '$lib/components/proposals/ProposalPanel.svelte';
	import ProposalSource from '$lib/components/proposals/ProposalSource.svelte';
	import ProposalSynthetic from '$lib/components/proposals/ProposalSynthetic.svelte';
	import { fmtNum } from '$lib/format/number';
	import { appliedNotice, candidateLabel, coverageLine, currentText, pctText, toChange, unitMapView, useMessage } from './unitMapProposal';

	let {
		projectId,
		modelDirty,
		onModelChanged
	}: {
		projectId: string;
		/** Unsaved model edits: Use waits until they are saved or discarded (it saves straight to the project). */
		modelDirty: boolean;
		/** The model changed on the server: the workspace takes it as it now is. */
		onModelChanged: () => Promise<void> | void;
	} = $props();

	const uid = $props.id();
	const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

	let data = $state.raw<UnitMapProposal | null>(null);
	let loading = $state(false);
	let error = $state<string | null>(null);
	let busy = $state(false);
	let useError = $state<string | null>(null);
	let notice = $state<string | null>(null);
	let frame = $state<ProposalPanel | null>(null);
	/** The grid last asked for (Try again retries it). */
	let wanted = $state<string | undefined>(undefined);
	let seq = 0;

	async function load(dataset?: string) {
		wanted = dataset;
		const mine = ++seq;
		loading = true;
		error = null;
		try {
			const d = await api.map.unitMap(projectId, dataset);
			if (mine === seq) data = d;
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

	const view = $derived(data ? unitMapView(data) : null);
	const changing = $derived(data ? toChange(data) : []);
	const placed = $derived(data ? data.units.length + data.uncovered.length : 0);

	async function use() {
		if (!data?.dataset) return;
		const d = data.dataset;
		const ok = await confirmDialog({ title: 'Use these MAPs for the units?', message: useMessage(data), confirmLabel: 'Use these MAPs' });
		if (!ok) return;
		busy = true;
		useError = null;
		try {
			const r = await api.map.applyUnitMap(projectId, d.label);
			notice = appliedNotice(r, `${d.label} ${d.version}`);
			await Promise.all([load(d.label), onModelChanged()]);
			// The Use button is gone (the units hold the MAPs now): keep the keyboard here, on what happened.
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
	testid="unit-map-proposal"
	prefix="unit-map"
	id="set-unit-map"
	variant="inline"
	title="MAP from the grid"
	helpKey="unit-map"
	what="units’ MAP from the grid"
	bodyGrid
	{notice}
	{loading}
	loaded={data !== null}
	{error}
	onretry={() => load(wanted)}
>
	{#snippet intro()}<p class="hint muted">
		Each unit’s mean annual precipitation, area-weighted over its parcel on the map, from one MAP grid for the whole project: two grids are never mixed,
		and a unit the grid doesn’t cover keeps what it has. Nothing changes until you use it.
	</p>{/snippet}

	{#if data && view}
		{#if view.kind === 'no-dataset'}
			<ProposalNoDataset testid="unit-map-no-dataset" what="MAP grid" consequence="no unit’s MAP is proposed" command="pnpm import:map-grid" />
		{:else}
			{#if data.candidates.length > 1}
				<div class="field">
					<label for="{uid}-ds">Grid</label>
					<select id="{uid}-ds" value={data.dataset?.label ?? ''} disabled={busy} onchange={(e) => load(e.currentTarget.value)}>
						{#if !data.dataset}<option value="" disabled>None covers a unit</option>{/if}
						{#each data.candidates as c (c.label)}<option value={c.label}>{candidateLabel(c, placed)}</option>{/each}
					</select>
				</div>
			{/if}
			{#if data.dataset?.synthetic}
				<ProposalSynthetic testid="unit-map-synthetic" subject="The grid" notWhat="a real MAP surface" forWhat="catchment" />
			{/if}
			{#if view.kind === 'no-units'}
				<p class="alert alert-info slim" data-testid="unit-map-no-units">
					No unit with land has a parcel on the map yet. Draw or import each unit’s parcel and link it on the Map; its MAP is averaged over it.
					<a href="?tab=map">Open the Map</a>
				</p>
			{:else if view.kind === 'none-covered'}
				<p class="alert alert-info slim" data-testid="unit-map-none-covered">
					{data.dataset ? `${data.dataset.label} covers` : 'No loaded MAP grid covers'} none of the units with a parcel: is a grid loaded for this area?
				</p>
			{:else}
				<p class="small" data-testid="unit-map-coverage">{coverageLine(data)}</p>
				<div class="table-wrap">
					<table class="data compact" data-testid="unit-map-rows">
						<caption class="visually-hidden">Each unit’s MAP proposed from the grid, beside its form’s</caption>
						<thead>
							<tr>
								<th scope="col">Unit</th>
								<th scope="col" class="num">Proposed MAP <span class="u">mm</span></th>
								<th scope="col" class="num">Cells</th>
								<th scope="col" class="num">Now <span class="u">mm</span></th>
							</tr>
						</thead>
						<tbody>
							{#each data.units as u (u.nodeId)}
								<tr data-node={u.nodeId} data-same={u.same}>
									<th scope="row"><a href="?tab=network&edit={encodeURIComponent(u.nodeId)}">{u.name}</a></th>
									<td class="num">{fmtNum(u.mapMm)}</td>
									<td class="num">{fmtNum(u.cells)}</td>
									<td class="num" title={u.current.mapSource ?? undefined}>{currentText(u)}{#if u.same}<span class="visually-hidden">, the same</span>{/if}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
				{#if data.uncovered.length}
					<div class="small" data-testid="unit-map-uncovered">
						<p>Not covered by this grid, so left as they are:</p>
						<ul>
							{#each data.uncovered as u (u.nodeId)}<li><strong>{u.name}</strong>: {u.reason}{u.coveredShare > 0 ? ` (${pctText(u.coveredShare)} with values)` : ''}.</li>{/each}
						</ul>
					</div>
				{/if}
				{#if data.otherGrid.length}
					<p class="alert alert-warning slim" data-testid="unit-map-other-grid">
						{data.otherGrid.map((u) => u.name).join(', ')}
						{data.otherGrid.length === 1 ? 'has a MAP' : 'have a MAP'} from another grid, and this grid doesn’t replace it: clear it on the unit’s form, or choose
						the grid that covers every unit, before using these. One project never mixes two grids.
					</p>
				{/if}
				{#if !changing.length}
					<p class="muted small" data-testid="unit-map-same">Every unit listed holds this MAP from this grid.</p>
				{:else}
					<button
						type="button"
						class="btn btn-sm"
						disabled={busy || modelDirty || data.otherGrid.length > 0}
						aria-describedby={modelDirty ? `${uid}-dirty` : undefined}
						onclick={use}>{busy ? 'Saving…' : `Use for ${changing.length === 1 ? '1 unit' : `${changing.length} units`}`}</button
					>
					{#if modelDirty}<p class="hint muted" id="{uid}-dirty">Save or discard your model changes first: MAPs used here are saved straight away.</p>{/if}
				{/if}
				{#if useError}<p class="err small" role="alert">{useError}</p>{/if}
			{/if}
			{#if data.withoutPolygon.length || data.refused.length}
				<p class="hint muted" data-testid="unit-map-without-polygon">
					{#if data.withoutPolygon.length}Without a parcel on the map: {data.withoutPolygon.map((u) => u.name).join(', ')}.{/if}
					{#each data.refused as u (u.nodeId)}{' '}{u.name}: {u.reason}.{/each}
				</p>
			{/if}
			{#if data.dataset}
				<ProposalSource
					testid="unit-map-source"
					citation="{data.dataset.source} ({data.dataset.version}; dataset “{data.dataset.label}”, {fmtNum(data.dataset.cellDeg, 4, true)}° cells). {data.dataset.attribution}"
					method="Each unit’s MAP is the mean of the grid cells its parcel touches, each weighted by the share of the cell inside the parcel × the cell’s area, rounded to whole mm; cells without a value are left out, and a unit with values over less than 90 % of its parcel is not covered. Written as the unit’s MAP with the source “<grid> <version>, area-weighted mean over the unit’s parcel, <n> cells”."
				/>
			{/if}
		{/if}
	{/if}
</ProposalPanel>

<style>
	.field {
		display: grid;
		gap: 0.25rem;
	}
	.field select {
		max-width: 100%;
	}
	.num {
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
		text-align: right;
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
	.small ul {
		margin: 0.25rem 0 0;
		padding-left: 1.25rem;
	}
	.small p {
		margin: 0;
	}
	.table-wrap {
		width: 100%;
		overflow-x: auto;
	}
</style>
