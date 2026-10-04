<!--
	"From land cover" in a hydrological unit's planted-areas drawer (issue #326
	B-landcover; docs/ui.md § Farm drawer, docs/maps.md § Cultivated area from
	land cover). The cultivated area a land-cover map shows in each of the
	unit's parcels on the map, their sum, and the catchment's for reference,
	with the dataset, version and method cited. The modeller picks an area (all
	parcels, or one) and the crop it is planted to: the land cover never says
	which crop. Use (editors) asks first, then saves that one value to the model
	as a revision citing the dataset. Nothing is applied by itself.
-->
<script lang="ts">
	import { untrack } from 'svelte';
	import { api, type CroplandProposals } from '$lib/api';
	import { confirmDialog } from '$lib/components/common/confirm.svelte';
	import ProposalNoDataset from '$lib/components/proposals/ProposalNoDataset.svelte';
	import ProposalPanel from '$lib/components/proposals/ProposalPanel.svelte';
	import ProposalSource from '$lib/components/proposals/ProposalSource.svelte';
	import ProposalSynthetic from '$lib/components/proposals/ProposalSynthetic.svelte';
	import { mapNodeHref } from '$lib/workspace/mapLinks';
	import { areaChoices, confirmWords, cropRows, fmtHa, type CropRow } from './croplandProposals';

	let {
		projectId,
		nodeId,
		readonly,
		dirty,
		onModelChanged
	}: {
		projectId: string;
		/** The hydrological unit, saved in the model (an unsaved one has nothing on the server to summarise). */
		nodeId: string;
		readonly: boolean;
		/** Unsaved model changes: Use waits until they are saved or discarded (it saves straight to the model). */
		dirty: boolean;
		onModelChanged: () => Promise<void> | void;
	} = $props();

	const uid = $props.id();
	const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
	/** Crop rows shown before "Show all": a unit rarely plants more, and a 30-crop project shouldn't push the rest away. */
	const CROPS_SHOWN = 6;

	let data = $state.raw<CroplandProposals | null>(null);
	let loading = $state(false);
	let error = $state<string | null>(null);
	let busy = $state<string | null>(null);
	let rowError = $state<{ key: string; text: string } | null>(null);
	let notice = $state<string | null>(null);
	let choiceKey = $state('');
	let allCrops = $state(false);
	let seq = 0;
	let frame = $state<ProposalPanel | null>(null);

	async function load(id: string) {
		const mine = ++seq;
		loading = true;
		error = null;
		try {
			const d = await api.cropland.get(projectId, id);
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
	// A new unit starts clean. Only a change of unit: the prop's expression (the drawer's `node.id`) re-runs this
	// whenever the model reloads, which a saved value does, and that cleared the notice it had just set.
	let shownId: string | null = null;
	$effect(() => {
		const id = nodeId;
		if (id === shownId) return;
		shownId = id;
		untrack(() => {
			notice = null;
			rowError = null;
			choiceKey = '';
			void load(id);
		});
	});

	// Largest cultivated area first.
	const parcels = $derived(data ? [...data.parcels].sort((a, b) => (b.cultivatedM2 ?? -1) - (a.cultivatedM2 ?? -1)) : []);
	const choices = $derived(data ? areaChoices(data) : []);
	// The first choice (the unit's sum) unless the picked one is still on offer.
	const choice = $derived(choices.find((c) => c.key === choiceKey) ?? choices[0] ?? null);
	// The crops planted on this unit first (largest first), then the rest by name, as the server sends them.
	const rows = $derived(data ? cropRows(data, choice).map((r, i) => ({ r, area: data!.crops[i]!.areaM2 })).sort((a, b) => b.area - a.area).map((x) => x.r) : []);
	const shownRows = $derived(allCrops ? rows : rows.slice(0, CROPS_SHOWN));
	const pct = (part: number, whole: number) => (whole > 0 ? `${Math.round((part / whole) * 100)} %` : '–');

	async function use(r: CropRow) {
		if (!data?.dataset || !choice) return;
		const d = data;
		const c = choice;
		if (!(await confirmDialog(confirmWords(d, r, c)))) return;
		busy = r.cropId;
		rowError = null;
		try {
			const res = await api.cropland.cropAreaFromLandCover(projectId, d.nodeId, {
				cropId: r.cropId,
				dataset: d.dataset!.dataset,
				...(c.featureId ? { featureId: c.featureId } : {})
			});
			notice = `${r.name}’s planted area on ${d.nodeName} is now ${fmtHa(res.areaM2)}, from land cover.`;
			await Promise.all([load(d.nodeId), onModelChanged()]);
			await frame?.focusNotice();
		} catch (e) {
			rowError = { key: r.cropId, text: msg(e) };
		} finally {
			busy = null;
		}
	}
</script>

<ProposalPanel
	bind:this={frame}
	testid="cropland-proposals"
	prefix="cropland"
	variant="drawer"
	title="From land cover"
	what="land-cover summary"
	{notice}
	{loading}
	loaded={data !== null}
	{error}
	onretry={() => load(nodeId)}
>
	{#snippet intro()}<p class="hint muted">
		The area a land-cover map shows as cropland in this unit’s parcels on the map. It shows where land is cultivated, not what grows there
		or whether it is irrigated, so you choose the crop. Nothing changes until you use a value.
	</p>{/snippet}

	{#if data}
		{#if !data.dataset}
			<ProposalNoDataset testid="cropland-no-dataset" what="land-cover dataset" consequence="no cultivated area is proposed" command="pnpm import:land-cover" />
		{:else}
			{#if data.dataset.synthetic}
				<ProposalSynthetic testid="cropland-synthetic" subject="The land cover" notWhat="ESA WorldCover" forWhat="catchment" />
			{/if}
			{#if parcels.length === 0}
				<p class="alert alert-info slim" data-testid="cropland-no-parcels">
					No farm parcel on the map is linked to {data.nodeName}. Draw or import its parcel on the Map and link it to {data.nodeName}; its cultivated area is summed from there.
					<a href="?tab=map">Open the Map</a>
				</p>
			{:else}
				<div class="table-wrap">
					<table class="data compact" data-testid="cropland-parcels">
						<caption class="visually-hidden">Cultivated area in {data.nodeName}’s parcels on the map</caption>
						<thead>
							<tr><th scope="col">Parcel</th><th scope="col" class="num">Cultivated</th><th scope="col" class="num">Share</th></tr>
						</thead>
						<tbody>
							{#each parcels as f (f.featureId)}
								<tr>
									<th scope="row">{f.name || 'Unnamed parcel'}</th>
									{#if f.problem}
										<td colspan="2" class="small">Can’t be summarised: {f.problem}</td>
									{:else}
										<td class="num">{fmtHa(f.cultivatedM2 ?? 0)} <span class="muted">of {fmtHa(f.areaM2 ?? 0)}</span></td>
										<td class="num">{pct(f.cultivatedM2 ?? 0, f.areaM2 ?? 0)}</td>
									{/if}
								</tr>
							{/each}
						</tbody>
						{#if data.unit && parcels.length > 1}
							<tfoot>
								<tr>
									<th scope="row">All parcels</th>
									<td class="num">{fmtHa(data.unit.cultivatedM2)} <span class="muted">of {fmtHa(data.unit.areaM2)}</span></td>
									<td class="num">{pct(data.unit.cultivatedM2, data.unit.areaM2)}</td>
								</tr>
							</tfoot>
						{/if}
					</table>
				</div>
			{/if}
			<p class="small catchment" data-testid="cropland-catchment">
				{#if data.catchment}
					{#if 'problem' in data.catchment}
						The catchment boundary can’t be summarised: {data.catchment.problem}.
					{:else}
						The whole catchment: {fmtHa(data.catchment.cultivatedM2)} cultivated of {fmtHa(data.catchment.areaM2)}, for reference.
					{/if}
				{/if}
				<a href={mapNodeHref(data.nodeId)}>Show {data.nodeName} on map</a>
			</p>

			{#if choices.length}
				<div class="field">
					<label for="{uid}-area">Area to use</label>
					<!-- Shows the choice in force (the sum, until another is picked and while it's still on offer), never a blank. -->
					<select id="{uid}-area" value={choice?.key ?? ''} onchange={(e) => (choiceKey = e.currentTarget.value)}>
						{#each choices as c (c.key)}<option value={c.key}>{c.label}</option>{/each}
					</select>
				</div>
				{#if rows.length === 0}
					<p class="muted small">Add a crop first: the area is used as one crop’s planted area.</p>
				{:else}
					<div class="table-wrap">
						<table class="data compact" data-testid="cropland-crops">
							<caption class="visually-hidden">{data.nodeName}’s planted area per crop, and where it came from</caption>
							<thead>
								<tr><th scope="col">Crop</th><th scope="col" class="num">Planted now</th><th scope="col"><span class="visually-hidden">Use</span></th></tr>
							</thead>
							<tbody>
								{#each shownRows as r (r.cropId)}
									<tr data-crop={r.name}>
										<th scope="row">{r.name}{#if r.provenance}<span class="src" data-testid="cropland-provenance">{r.provenance}</span>{/if}</th>
										<td class="num">{r.now}</td>
										<td>
											{#if r.same}
												<span class="muted small">Saved</span>
											{:else if !readonly && choice}
												<button
													type="button"
													class="btn btn-sm use"
													disabled={busy !== null || dirty}
													aria-describedby={dirty ? `${uid}-dirty` : undefined}
													aria-label="Use {fmtHa(choice.areaM2)} as {r.name}’s planted area"
													onclick={() => use(r)}>{busy === r.cropId ? 'Saving…' : 'Use'}</button
												>
											{/if}
											{#if rowError?.key === r.cropId}<p class="err small" role="alert">{rowError.text}</p>{/if}
										</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
					{#if rows.length > CROPS_SHOWN}
						<button type="button" class="btn btn-sm ghost" aria-expanded={allCrops} onclick={() => (allCrops = !allCrops)}
							>{allCrops ? 'Show fewer' : `Show all ${rows.length} crops`}</button
						>
					{/if}
				{/if}
				{#if !readonly && dirty}
					<p class="hint muted" id="{uid}-dirty">Save or discard your model changes first: an area used here is saved to the model straight away.</p>
				{/if}
				{#if readonly}<p class="hint muted">Only an editor can use a value.</p>{/if}
			{:else if parcels.length}
				<p class="muted small" data-testid="cropland-none">The land cover shows no cropland in {data.nodeName}’s parcels.</p>
			{/if}

			<ProposalSource
				testid="cropland-source"
				citation="{data.dataset.source} ({data.dataset.version}; dataset “{data.dataset.dataset}”). {data.dataset.attribution}"
				method={data.dataset.method}
			/>
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
	.num {
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
		text-align: right;
	}
	th[scope='row'] {
		text-align: left;
	}
	.src {
		display: block;
		font-weight: 400;
		font-size: 0.8rem;
		color: var(--text-2);
		overflow-wrap: anywhere;
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
	/* The map link may stand alone on its line (no catchment sum): a 24 px target, not the 0.85rem text's line box (WCAG 2.5.8). */
	.catchment a {
		display: inline-block;
		min-height: 24px;
		line-height: 24px;
	}
	.table-wrap {
		width: 100%;
	}
	/* Phone: the row buttons are 44 px targets, as on the rest of the Crops page. */
	@container (max-width: 30rem) {
		.use {
			min-height: 44px;
			min-width: 44px;
		}
	}
</style>
