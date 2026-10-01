<!--
	Place a point from typed coordinates, in a side sheet over the Map
	(`place=1`; issue #326 E5, docs/ui.md § Map). The form's fields are as they
	were at the foot of the page: D1 (click to place, coordinates behind a
	disclosure) replaces it later.
-->
<script lang="ts">
	import { api, type MapFeature, type MapFeatureKind, type MapNodeArea } from '$lib/api';
	import Dialog from '$lib/components/common/Dialog.svelte';
	import { KIND_NODES, parseDegrees, POINT_KINDS, KIND_LABEL } from './mapData';

	let {
		open = $bindable(false),
		projectId,
		nodes,
		onplaced
	}: {
		open?: boolean;
		projectId: string;
		nodes: MapNodeArea[];
		/** The point was saved: the tab reloads, closes the sheet and picks it. */
		onplaced: (f: MapFeature) => Promise<void> | void;
	} = $props();

	const uid = $props.id();
	const formId = `${uid}-form`;
	let pointKind = $state<MapFeatureKind>('gauge');
	let pointName = $state('');
	let latText = $state('');
	let lonText = $state('');
	let pointNode = $state('');
	let placing = $state(false);
	let pointError = $state<string | null>(null);
	const lat = $derived(parseDegrees(latText, 'lat'));
	const lon = $derived(parseDegrees(lonText, 'lon'));
	let triedPoint = $state(false);
	const pointNodes = $derived(nodes.filter((n) => KIND_NODES[pointKind].includes(n.kind)));

	async function placePoint(e: SubmitEvent) {
		e.preventDefault();
		triedPoint = true;
		pointError = null;
		if ('error' in lat || 'error' in lon) return;
		placing = true;
		try {
			const f = await api.map.create(projectId, { kind: pointKind, name: pointName.trim(), lat: lat.value, lon: lon.value, nodeId: pointNode || null });
			pointName = '';
			latText = '';
			lonText = '';
			pointNode = '';
			triedPoint = false;
			await onplaced(f);
		} catch (err) {
			pointError = err instanceof Error ? err.message : String(err);
		} finally {
			placing = false;
		}
	}
</script>

<Dialog bind:open title="Place a point" side>
	<form id={formId} onsubmit={placePoint} novalidate>
		<div class="form-row">
			<div class="field">
				<label for="{uid}-pkind">Kind</label>
				<select id="{uid}-pkind" bind:value={pointKind} onchange={() => (pointNode = '')}>
					{#each POINT_KINDS as k (k)}<option value={k}>{KIND_LABEL[k]}</option>{/each}
				</select>
			</div>
			<div class="field">
				<label for="{uid}-pname">Name <span class="u">(optional)</span></label>
				<input id="{uid}-pname" maxlength="100" bind:value={pointName} />
			</div>
		</div>
		<div class="form-row">
			<div class="field">
				<label for="{uid}-lat">Latitude</label>
				<input
					id="{uid}-lat"
					inputmode="decimal"
					placeholder="-33.61"
					bind:value={latText}
					aria-invalid={triedPoint && 'error' in lat ? 'true' : undefined}
					aria-describedby="{uid}-lat-e"
				/>
				<span class="hint" id="{uid}-lat-e">{#if triedPoint && 'error' in lat}<span class="err">{lat.error}</span>{:else}Decimal degrees; south is negative.{/if}</span>
			</div>
			<div class="field">
				<label for="{uid}-lon">Longitude</label>
				<input
					id="{uid}-lon"
					inputmode="decimal"
					placeholder="21.34"
					bind:value={lonText}
					aria-invalid={triedPoint && 'error' in lon ? 'true' : undefined}
					aria-describedby="{uid}-lon-e"
				/>
				<span class="hint" id="{uid}-lon-e">{#if triedPoint && 'error' in lon}<span class="err">{lon.error}</span>{:else}Decimal degrees; east is positive.{/if}</span>
			</div>
		</div>
		{#if pointNodes.length}
			<div class="field">
				<label for="{uid}-pnode">Stands for <span class="u">(optional)</span></label>
				<select id="{uid}-pnode" bind:value={pointNode}>
					<option value="">Nothing</option>
					{#each pointNodes as n (n.id)}<option value={n.id}>{n.name}</option>{/each}
				</select>
			</div>
		{/if}
		{#if pointError}<p class="err" role="alert">{pointError}</p>{/if}
	</form>

	{#snippet actions()}
		<button type="button" class="btn" onclick={() => (open = false)}>Close</button>
		<button type="submit" form={formId} class="btn btn-primary" disabled={placing}>{placing ? 'Placing…' : 'Place the point'}</button>
	{/snippet}
</Dialog>

<style>
	form {
		display: grid;
		gap: 0.75rem;
	}
	.field {
		display: grid;
		gap: 0.25rem;
	}
	.form-row {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(min(100%, 140px), 1fr));
		gap: 0.75rem;
	}
	.hint {
		font-size: 0.85rem;
		color: var(--text-muted);
	}
	.err {
		color: var(--danger);
		margin: 0;
	}
</style>
