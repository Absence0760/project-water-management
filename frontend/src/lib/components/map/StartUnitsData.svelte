<!--
	Each unit's data from the map, reviewed together (issue #646 item 2; docs/ui.md
	§ Map, unitsData.ts): in the Start sheet's data step, the MAP grid's MAP and
	the CHIRPS feed over its boundary for every land unit in one table, each
	value with its source and its own tick, unticked until the editor ticks it
	or presses Tick all. Apply the ticked values asks first, then sends the
	ticked units to each proposal's own POST (the MAP saves straight to the
	model; the feeds are an owner's, so an editor sees them without a tick).
	Nothing is applied by itself.
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import { api, type UnitMapProposal, type UnitRainProposal } from '#lib/api/index.js';
	import { confirmDialog } from '#lib/components/common/confirm.svelte.js';
	import { errorText, feedsApi } from '../feeds/feeds';
	import { gridCitation } from '../settings/unitMapProposal';
	import { initialUnitTicks, mapTickable, mmText, rainTickable, tickAllUnits, unitApplyPlan, unitApplySummary, unitDataRows, type UnitTicks } from './unitsData';

	let {
		projectId,
		nodes,
		modelDirty,
		onapplied
	}: {
		projectId: string;
		/** The model's nodes, for the rows' order. */
		nodes: readonly { id: string; name: string }[];
		/** Unsaved model edits: Apply waits (the MAP saves straight to the project). */
		modelDirty: boolean;
		/** Something was applied: the map reloads the model and the to-do list. */
		onapplied: () => Promise<void> | void;
	} = $props();

	const uid = $props.id();
	let map = $state.raw<UnitMapProposal | null>(null);
	let rain = $state.raw<UnitRainProposal | null>(null);
	let mapError = $state<string | null>(null);
	let rainError = $state<string | null>(null);
	let loaded = $state(false);
	let ticks = $state<UnitTicks>({});
	let busy = $state(false);
	let error = $state<string | null>(null);
	let done = $state<string | null>(null);

	const why = $derived({ map: mapError ? `the MAP proposal couldn’t be read (${mapError})` : 'no loaded MAP grid covers it', rain: rainError ? `the rain proposal couldn’t be read (${rainError})` : 'not loaded' });
	const rows = $derived(unitDataRows(nodes, map, rain, why));
	const plan = $derived(unitApplyPlan(rows, ticks));
	const offered = $derived(rows.some((r) => mapTickable(r.map) || rainTickable(r.rain)));
	const editorOnly = $derived(rows.some((r) => r.rain.kind === 'offer' && !r.rain.owner));

	async function load() {
		const calls = feedsApi(api, projectId);
		const [m, r] = await Promise.allSettled([api.map.unitMap(projectId), calls.unitsProposal()]);
		map = m.status === 'fulfilled' ? m.value : null;
		mapError = m.status === 'rejected' ? errorText(m.reason) : null;
		rain = r.status === 'fulfilled' ? r.value : null;
		rainError = r.status === 'rejected' ? errorText(r.reason) : null;
		ticks = initialUnitTicks(unitDataRows(nodes, map, rain, why));
		loaded = true;
	}
	onMount(() => void load());

	async function apply() {
		const p = plan;
		if (!p.map.length && !p.rain.length) return;
		const ok = await confirmDialog({ title: 'Apply the ticked values?', message: unitApplySummary(p, map, rain), confirmLabel: 'Apply' });
		if (!ok) return;
		busy = true;
		error = done = null;
		const said: string[] = [];
		try {
			if (p.map.length && map?.dataset) {
				const r = await api.map.applyUnitMap(projectId, map.dataset.label, p.map);
				said.push(`MAP for ${r.units.length === 1 ? '1 unit' : `${r.units.length} units`}`);
			}
			if (p.rain.length) {
				const r = await feedsApi(api, projectId).applyUnits({ nodeIds: p.rain });
				said.push(`${r.created} ${r.created === 1 ? 'feed' : 'feeds'} created, ${r.updated} updated`);
			}
			done = `Applied: ${said.join('; ')}.`;
		} catch (e) {
			error = said.length ? `Applied ${said.join('; ')}, then: ${errorText(e)}` : errorText(e);
		} finally {
			busy = false;
		}
		await onapplied();
		await load();
	}
</script>

<section class="units-data" aria-labelledby="{uid}-h" aria-busy={!loaded || busy || undefined} data-testid="start-units-data" data-ready={loaded ? 'true' : undefined}>
	<h4 id="{uid}-h">Each unit’s rain and MAP, together</h4>
	{#if !loaded}
		<p class="muted small">Reading the proposals…</p>
	{:else if !rows.length}
		<p class="muted small" data-testid="start-units-data-none">No unit has an area and a boundary on the map yet, so nothing is proposed for the units.</p>
	{:else}
		<p class="hint">
			Each value is proposed over the unit’s boundary on the map and taken only when ticked.
			{#if map?.dataset}MAP: {gridCitation(map.dataset)}{:else}No MAP grid covers the units, so no MAP is proposed.{/if}
			{#if rain}Rain: CHIRPS v3 ({rain.product}), a feed per unit over its boundary’s cells.{/if}
		</p>
		<div class="table-wrap">
			<table class="data compact" data-testid="start-units-data-rows">
				<caption class="visually-hidden">Each unit’s MAP from the grid and its own rain feed, each with a tick</caption>
				<thead>
					<tr>
						<th scope="col">Unit</th>
						<th scope="col">MAP</th>
						<th scope="col">Rain</th>
					</tr>
				</thead>
				<tbody>
					{#each rows as r (r.nodeId)}
						<tr data-node={r.nodeId} data-testid="start-units-data-row">
							<th scope="row">{r.name}</th>
							<td>
								{#if r.map.kind === 'offer'}
									<label class="check">
										<input type="checkbox" bind:checked={ticks[r.nodeId]!.map} data-testid="start-units-tick-map" />
										<span>{mmText(r.map.mapMm)}{r.map.current !== null ? ` (now ${mmText(r.map.current)})` : ''}{r.map.coverage < 1 ? `, ${Math.round(r.map.coverage * 100)} % covered` : ''}</span>
									</label>
								{:else if r.map.kind === 'same'}
									<span class="muted">{mmText(r.map.mapMm)}, in the model</span>
								{:else}
									<span class="muted small">None: {r.map.reason}</span>
								{/if}
							</td>
							<td>
								{#if r.rain.kind === 'offer' && r.rain.owner}
									<label class="check">
										<input type="checkbox" bind:checked={ticks[r.nodeId]!.rain} data-testid="start-units-tick-rain" />
										<span>{r.rain.action === 'create' ? 'A new feed' : 'Its feed, new cells'}: {r.rain.cellsText}</span>
									</label>
								{:else if r.rain.kind === 'offer'}
									<span class="small">{r.rain.cellsText} (an owner sets the feed up)</span>
								{:else if r.rain.kind === 'same'}
									<span class="muted">Its feed reads them: {r.rain.cellsText}</span>
								{:else}
									<span class="muted small">None: {r.rain.reason}</span>
								{/if}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
		{#if editorOnly}<p class="hint">The rain feeds are set up by an owner of the project; you can take the MAPs.</p>{/if}
		{#if offered}
			<p class="actions">
				<button type="button" class="btn btn-sm" disabled={busy} onclick={() => (ticks = tickAllUnits(rows))} data-testid="start-units-tick-all">Tick all</button>
				<button
					type="button"
					class="btn btn-sm btn-primary"
					disabled={busy || modelDirty || (!plan.map.length && !plan.rain.length)}
					aria-describedby={modelDirty ? `${uid}-dirty` : undefined}
					onclick={apply}
					data-testid="start-units-apply">{busy ? 'Applying…' : 'Apply the ticked values'}</button
				>
			</p>
			{#if modelDirty}<p class="hint" id="{uid}-dirty">Save or discard the model’s unsaved changes first: the MAP saves straight to the project.</p>{/if}
		{:else}
			<p class="muted small" data-testid="start-units-data-same">Nothing left to take here: every unit holds what is proposed, or has nothing proposed.</p>
		{/if}
	{/if}
	<div role="status">{#if done}<p class="muted small" data-testid="start-units-data-done">{done}</p>{/if}</div>
	{#if error}<p class="err" role="alert" data-testid="start-units-data-error">{error}</p>{/if}
</section>

<style>
	.units-data {
		margin-top: 0.75rem;
		padding-top: 0.6rem;
		border-top: 1px solid var(--border);
	}
	h4 {
		margin: 0 0 0.3rem;
		font-size: 0.95rem;
	}
	.hint {
		margin: 0.3rem 0;
		font-size: 0.85rem;
		color: var(--text-2);
	}
	.table-wrap {
		overflow-x: auto;
	}
	.check {
		display: flex;
		gap: 0.4rem;
		align-items: flex-start;
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
		margin: 0.5rem 0 0;
	}
	.err {
		color: var(--danger);
		margin: 0.4rem 0 0;
	}
</style>
