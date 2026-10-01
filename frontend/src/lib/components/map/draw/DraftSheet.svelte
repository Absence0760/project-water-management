<!--
	Save a drawn shape (issue #326 C1; docs/ui.md § Map): a side sheet with
	what it is (the kinds its shape can be), its name and what it stands for.
	Nothing is saved until **Save**: the shape goes through the same
	`POST /map/features` as a placed point, with the server's checks (closed,
	non-crossing rings, limits) and its audit event. A refusal shows here and
	the drawing stays on the map.
-->
<script lang="ts">
	import { api, type MapFeature, type MapFeatureKind, type MapGeometry, type MapNodeArea } from '$lib/api';
	import Dialog from '$lib/components/common/Dialog.svelte';
	import { KIND_LABEL, KIND_NODES } from '../mapData';
	import { KINDS_FOR_SHAPE, shapeOf } from './shape';

	let {
		open = $bindable(false),
		projectId,
		nodes,
		geometry,
		kind: initialKind,
		hasBoundary,
		onsaved
	}: {
		open?: boolean;
		projectId: string;
		nodes: MapNodeArea[];
		geometry: MapGeometry;
		kind: MapFeatureKind;
		/** A boundary exists: saving another replaces it, so the sheet says so. */
		hasBoundary: boolean;
		onsaved: (f: MapFeature) => Promise<void> | void;
	} = $props();

	const uid = $props.id();
	const formId = `${uid}-form`;
	const kinds = $derived(KINDS_FOR_SHAPE[shapeOf(geometry)]);
	// Seeded once from the draw bar's choice; the sheet's own select changes it after.
	// svelte-ignore state_referenced_locally
	let kind = $state<MapFeatureKind>(initialKind);
	let name = $state('');
	let nodeId = $state('');
	let saving = $state(false);
	let error = $state<string | null>(null);
	const fitting = $derived(nodes.filter((n) => KIND_NODES[kind].includes(n.kind)));
	const what = $derived(geometry.type === 'Point' ? 'point' : shapeOf(geometry) === 'line' ? 'line' : 'shape');

	async function save(e: SubmitEvent) {
		e.preventDefault();
		saving = true;
		error = null;
		try {
			const f = await api.map.create(projectId, { kind, name: name.trim(), nodeId: nodeId || null, geometry });
			await onsaved(f);
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
		} finally {
			saving = false;
		}
	}
</script>

<Dialog bind:open title="Save the drawing" side>
	<form id={formId} onsubmit={save} novalidate>
		<div class="field">
			<label for="{uid}-kind">This {what} is</label>
			<select id="{uid}-kind" bind:value={kind} onchange={() => (nodeId = '')}>
				{#each kinds as k (k)}<option value={k}>{KIND_LABEL[k]}</option>{/each}
			</select>
			{#if kind === 'catchment_boundary' && hasBoundary}<span class="hint">It replaces the current catchment boundary.</span>{/if}
		</div>
		<div class="field">
			<label for="{uid}-name">Name <span class="u">(optional)</span></label>
			<input id="{uid}-name" maxlength="100" bind:value={name} />
		</div>
		{#if fitting.length}
			<div class="field">
				<label for="{uid}-node">Stands for <span class="u">(optional)</span></label>
				<select id="{uid}-node" bind:value={nodeId}>
					<option value="">Nothing</option>
					{#each fitting as n (n.id)}<option value={n.id}>{n.name}</option>{/each}
				</select>
			</div>
		{/if}
		<p class="hint">Its area is computed on the server when it is saved (geodesic, WGS84).</p>
		{#if error}<p class="err" role="alert" data-testid="map-draft-error">{error}</p>{/if}
	</form>

	{#snippet actions()}
		<button type="button" class="btn" onclick={() => (open = false)}>Back to the map</button>
		<button type="submit" form={formId} class="btn btn-primary" disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
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
	.hint {
		font-size: 0.85rem;
		color: var(--text-muted);
		margin: 0;
	}
	.err {
		color: var(--danger);
		margin: 0;
	}
</style>
