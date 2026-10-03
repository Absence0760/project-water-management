<!--
	Dams → "Proposed from the register and the map" (issue #326 B-dams;
	docs/ui.md § Dams, docs/maps.md § Dams from the register and the map).
	For one hydrological unit's dam: the registered dams within 1 km of its dam
	on the map, each proposing its capacity, and the dam polygon proposing its
	area as the full-supply area. Each row shows the source and what the saved
	model holds now; Use (editors) asks first, then saves that one value to the
	model as a revision naming the source. Nothing is applied by itself.
-->
<script lang="ts">
	import { untrack } from 'svelte';
	import { api, type DamProposals } from '$lib/api';
	import { confirmDialog } from '$lib/components/common/confirm.svelte';
	import ProposalNoDataset from '$lib/components/proposals/ProposalNoDataset.svelte';
	import ProposalPanel from '$lib/components/proposals/ProposalPanel.svelte';
	import ProposalSynthetic from '$lib/components/proposals/ProposalSynthetic.svelte';
	import { mapNodeHref } from '$lib/workspace/mapLinks';
	import { fmtNum } from '$lib/format/number';
	import { confirmWords, damProposalRows, fmtDamArea, searchedFrom, type DamProposalRow } from './damProposals';
	import { fmtVolume } from './dams';

	let {
		id,
		projectId,
		units,
		initial,
		follow = null,
		readonly,
		dirty,
		onModelChanged
	}: {
		/** The panel's anchor (a card's Proposals link scrolls to it). */
		id?: string;
		projectId: string;
		/** The hydrological units to choose from, dams first; never empty (DamsTab draws the panel only when there is one). */
		units: { id: string; name: string }[];
		/** The unit shown first (the page's picked dam). */
		initial: string | null;
		/** The page's picked dam (`dam=`): the box moves to it whenever it changes, so a card click and a fresh load of the same URL agree. */
		follow?: string | null;
		readonly: boolean;
		/** Unsaved model changes: Use waits until they are saved or discarded (it saves straight to the model). */
		dirty: boolean;
		onModelChanged: () => Promise<void> | void;
	} = $props();

	const uid = $props.id();
	const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

	let unitId = $state(untrack(() => initial ?? units[0]?.id ?? ''));
	// Follow the picked dam; Dam of still picks any unit until the page's pick changes again.
	$effect(() => {
		const f = follow;
		untrack(() => {
			if (f && f !== unitId && units.some((u) => u.id === f)) unitId = f;
		});
	});
	let data = $state.raw<DamProposals | null>(null);
	let loading = $state(false);
	let error = $state<string | null>(null);
	let busy = $state<string | null>(null);
	let rowError = $state<{ key: string; text: string } | null>(null);
	let notice = $state<string | null>(null);
	let seq = 0;
	let frame = $state<ProposalPanel | null>(null);

	async function load(id: string) {
		const mine = ++seq;
		loading = true;
		error = null;
		try {
			const d = await api.damProposals.get(projectId, id);
			if (mine === seq) data = d;
		} catch (e) {
			if (mine === seq) {
				data = null;
				error = msg(e);
			}
		} finally {
			if (mine === seq) loading = false;
		}
	}
	$effect(() => {
		const id = unitId;
		untrack(() => {
			notice = null;
			rowError = null;
			if (id) void load(id);
		});
	});

	const rows = $derived(data ? damProposalRows(data) : []);
	const capacityRows = $derived(rows.filter((r) => r.kind === 'capacity'));
	const synthetic = $derived(rows.some((r) => r.synthetic));

	async function use(r: DamProposalRow) {
		if (!data) return;
		const d = data;
		if (!(await confirmDialog(confirmWords(d, r)))) return;
		busy = r.key;
		rowError = null;
		try {
			if (r.kind === 'capacity') {
				const res = await api.damProposals.capacityFromRegister(projectId, d.nodeId, r.registerNo);
				notice = `${d.nodeName}’s dam capacity is now ${fmtVolume(res.damCapacityM3)}, from the register of dams (${res.registerNo}). Run the model to see its effect.`;
			} else {
				const res = await api.damProposals.areaFromMap(projectId, d.nodeId, r.featureId);
				notice = `${d.nodeName}’s full-supply area is now ${fmtDamArea(res.damAreaFullM2)}, from the map. Run the model to see its effect.`;
			}
			await Promise.all([load(d.nodeId), onModelChanged()]);
			await frame?.focusNotice();
		} catch (e) {
			rowError = { key: r.key, text: msg(e) };
		} finally {
			busy = null;
		}
	}
</script>

<ProposalPanel
	bind:this={frame}
	{id}
	testid="dam-proposals"
	prefix="dam-proposals"
	variant="page"
	title="Proposed from the register and the map"
	what="proposals"
	{notice}
	{loading}
	loaded={data !== null}
	{error}
	onretry={() => load(unitId)}
>
	{#snippet intro()}
		<p class="hint muted">
			A dam’s capacity from the register of dams (the registered dams within 1 km of its dam on the map) and its area when full from
			the dam’s polygon on the map. Each value shows its source; nothing changes until you use it.
		</p>
	{/snippet}
	{#snippet controls()}
		<div class="field">
			<label for="{uid}-unit">Dam of</label>
			<select id="{uid}-unit" bind:value={unitId}>
				{#each units as u (u.id)}<option value={u.id}>{u.name || '(unnamed)'}</option>{/each}
			</select>
		</div>
	{/snippet}
		{#if data}
			{#if !data.dam}
				<p class="alert alert-info slim" data-testid="dam-proposals-no-dam">
					No dam on the map is linked to {data.nodeName}. Draw its dam (or place it as a point) on the Map and link it to {data.nodeName}; the register is searched from there.
					<a href="?tab=map">Open the Map</a>
				</p>
			{:else}
				<p class="small">
					{searchedFrom(data.dam)} · <a href={mapNodeHref(data.nodeId)}>Show on map</a>
				</p>
				{#if !data.datasets.length}
					<ProposalNoDataset testid="dam-proposals-no-register" what="register of dams" consequence="no capacity is proposed" command="pnpm import:dam-register" />
				{:else if capacityRows.length === 0}
					<p class="muted small" data-testid="dam-proposals-none">No registered dam within {fmtNum(data.radiusM / 1000)} km of the dam on the map.</p>
				{/if}
				{#if synthetic}
					<ProposalSynthetic testid="dam-proposals-synthetic" subject="The register" notWhat="the DWS list" forWhat="dam" />
				{/if}
				{#if rows.length}
					<div class="table-wrap">
						<table class="data compact" data-testid="dam-proposals-rows">
							<caption class="visually-hidden">Values proposed for {data.nodeName}’s dam, beside the saved model’s</caption>
							<thead>
								<tr>
									<th scope="col">Value</th>
									<th scope="col">Saved now</th>
									<th scope="col">Proposed</th>
									<th scope="col">Source</th>
									<th scope="col"><span class="visually-hidden">Use</span></th>
								</tr>
							</thead>
							<tbody>
								{#each rows as r (r.key)}
									<tr data-key={r.key}>
										<th scope="row">{r.label}<span class="detail muted">{r.detail}</span></th>
										<td class="num">{r.now}</td>
										<td class="num">{r.proposed}</td>
										<td class="src small" data-testid="dam-proposal-source">{r.source}</td>
										<td>
											{#if r.missing}
												<span class="muted small">Nothing to use</span>
											{:else if r.same}
												<span class="muted small">Saved</span>
											{:else if !readonly}
												<button
													type="button"
													class="btn btn-sm"
													disabled={busy !== null || dirty}
													aria-describedby={dirty ? `${uid}-dirty` : undefined}
													aria-label="Use {r.kind === 'capacity' ? `the capacity of ${r.registerNo}` : 'the map’s area'}"
													onclick={() => use(r)}>{busy === r.key ? 'Saving…' : 'Use'}</button
												>
											{/if}
											{#if rowError?.key === r.key}<p class="err small" role="alert">{rowError.text}</p>{/if}
										</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
				{/if}
				{#if !readonly && dirty}
					<p class="hint muted" id="{uid}-dirty">Save or discard your model changes first: a value used here is saved to the model straight away.</p>
				{/if}
				<p class="hint muted">
					The register’s wall height and completion year are shown for reference; the model has no field for them.
					{#if readonly}Only an editor can use a value.{/if}
				</p>
			{/if}
		{/if}
</ProposalPanel>

<style>
	.field {
		display: grid;
		gap: 0.25rem;
		justify-items: start;
	}
	.field select {
		max-width: 100%;
	}
	.detail {
		display: block;
		font-weight: 400;
		font-size: 0.8rem;
		overflow-wrap: anywhere;
	}
	th[scope='row'] {
		min-width: 12rem;
	}
	.num {
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}
	.src {
		max-width: 22rem;
		overflow-wrap: anywhere;
		color: var(--text-2);
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
	}
</style>
