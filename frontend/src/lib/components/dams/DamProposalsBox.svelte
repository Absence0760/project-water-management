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
	import { mapNodeHref } from '$lib/workspace/mapLinks';
	import { fmtNum } from '$lib/format/number';
	import { confirmWords, damProposalRows, fmtDamArea, type DamProposalRow } from './damProposals';
	import { fmtVolume } from './dams';

	let {
		projectId,
		units,
		initial,
		readonly,
		dirty,
		onModelChanged
	}: {
		projectId: string;
		/** The hydrological units to choose from, dams first. */
		units: { id: string; name: string }[];
		/** The unit shown first (the page's picked dam). */
		initial: string | null;
		readonly: boolean;
		/** Unsaved model changes: Use waits until they are saved or discarded (it saves straight to the model). */
		dirty: boolean;
		onModelChanged: () => Promise<void> | void;
	} = $props();

	const uid = $props.id();
	const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

	let unitId = $state(untrack(() => initial ?? units[0]?.id ?? ''));
	let data = $state.raw<DamProposals | null>(null);
	let loading = $state(false);
	let error = $state<string | null>(null);
	let busy = $state<string | null>(null);
	let rowError = $state<{ key: string; text: string } | null>(null);
	let notice = $state<string | null>(null);
	let seq = 0;

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
		} catch (e) {
			rowError = { key: r.key, text: msg(e) };
		} finally {
			busy = null;
		}
	}
</script>

<section class="panel proposals" aria-labelledby="{uid}-h" data-testid="dam-proposals">
	<div class="panel-head">
		<h3 id="{uid}-h">Proposed from the register and the map</h3>
	</div>
	<p class="hint muted">
		A dam’s capacity from the register of dams (the registered dams within 1 km of its dam on the map) and its area when full from
		the dam’s polygon on the map. Each value shows its source; nothing changes until you use it.
	</p>
	{#if units.length === 0}
		<p class="muted">No hydrological units yet.</p>
	{:else}
		<div class="field">
			<label for="{uid}-unit">Dam of</label>
			<select id="{uid}-unit" bind:value={unitId}>
				{#each units as u (u.id)}<option value={u.id}>{u.name || '(unnamed)'}</option>{/each}
			</select>
		</div>

		{#if notice}<p class="alert alert-info slim" role="status" data-testid="dam-proposals-notice">{notice}</p>{/if}

		<div aria-busy={loading} data-ready={!loading && (data !== null || error !== null) ? 'true' : undefined} data-testid="dam-proposals-body">
			{#if error}
				<p class="err" role="alert">The proposals couldn’t be loaded ({error}). <button type="button" class="btn btn-sm" onclick={() => load(unitId)}>Try again</button></p>
			{:else if data}
				{#if !data.dam}
					<p class="alert alert-info slim" data-testid="dam-proposals-no-dam">
						No dam on the map is linked to {data.nodeName}. Draw its dam (or place it as a point) on the Map and link it to {data.nodeName}; the register is searched from there.
						<a href="?tab=map">Open the Map</a>
					</p>
				{:else}
					<p class="small">
						Searched from {data.dam.name ? `“${data.dam.name}”` : 'the dam on the map'} ({data.dam.geometryType === 'Point' ? 'a point' : 'its polygon’s centre'},
						{fmtNum(data.dam.point[1], 4)}, {fmtNum(data.dam.point[0], 4)}) · <a href={mapNodeHref(data.nodeId)}>Show on map</a>
					</p>
					{#if !data.datasets.length}
						<p class="alert alert-info slim" data-testid="dam-proposals-no-register">
							No register of dams is loaded, so no capacity is proposed. The operator loads one with <code>pnpm import:dam-register</code> (docs/maps.md).
						</p>
					{:else if capacityRows.length === 0}
						<p class="muted small" data-testid="dam-proposals-none">No registered dam within {fmtNum(data.radiusM / 1000)} km of the dam on the map.</p>
					{/if}
					{#if synthetic}
						<p class="alert alert-warning slim" data-testid="dam-proposals-synthetic">
							<strong>Synthetic test data.</strong> The register loaded here is invented for development and tests, not the DWS list. Never use it for a real dam.
						</p>
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
		</div>
	{/if}
</section>

<style>
	.proposals {
		display: grid;
		/* One column no wider than the page: the table scrolls in its own box on a phone, the page doesn't. */
		grid-template-columns: minmax(0, 1fr);
		gap: 0.6rem;
		margin: 0 0 1rem;
		min-width: 0;
	}
	.panel-head h3 {
		font-size: 1.05rem;
	}
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
