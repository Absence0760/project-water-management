<!--
	Save a point, in a side sheet over the Map (`place=1`; issue #326 E5, D1,
	docs/ui.md § Map): its kind, name and what it stands for. Clicking the map
	(or Use my location) is the main way to say where it is: the sheet opens
	from the draw bar's Save… with that position (`at`), and the coordinates
	sit behind **Enter coordinates**, filled in from it so they can be corrected
	to a published value. Opened with no position (the bar's Enter
	coordinates, a direct link, a browser without WebGL) the coordinates show
	at once. Typed coordinates stay for three reasons: published positions
	(DWS stations, the register of dams, WARMS) are more exact typed than
	clicked, they are the non-pointer way to place a point (WCAG 2.1.1, 2.5.7),
	and e2e drives the form, never the canvas.
-->
<script lang="ts">
	import { oneLineName } from '@water-management/engine';
	import { api, type MapFeature, type MapFeatureKind, type MapNodeArea } from '$lib/api';
	import Dialog from '$lib/components/common/Dialog.svelte';
	import type { MapPosition } from '$lib/api/types';
	import { KIND_NODES, parseDegrees, POINT_KINDS, KIND_LABEL, positionText } from './mapData';

	let {
		open = $bindable(false),
		projectId,
		nodes,
		at = null,
		kind = 'gauge',
		onplaced
	}: {
		open?: boolean;
		projectId: string;
		nodes: MapNodeArea[];
		/** Where the point was clicked or located (lon, lat), or null: the coordinates are typed. */
		at?: MapPosition | null;
		/** The kind picked in the draw bar. */
		kind?: MapFeatureKind;
		/** The point was saved: the tab reloads, closes the sheet and picks it. */
		onplaced: (f: MapFeature) => Promise<void> | void;
	} = $props();

	const uid = $props.id();
	const formId = `${uid}-form`;
	// Seeded once from the bar (the kind, the clicked position); the fields are the person's after that.
	// svelte-ignore state_referenced_locally
	let pointKind = $state<MapFeatureKind>(kind);
	let pointName = $state('');
	/** Seven decimals: about a centimetre, the server's own rounding. */
	const deg = (v: number) => String(Math.round(v * 1e7) / 1e7);
	// svelte-ignore state_referenced_locally
	let latText = $state(at ? deg(at[1]) : '');
	// svelte-ignore state_referenced_locally
	let lonText = $state(at ? deg(at[0]) : '');
	// svelte-ignore state_referenced_locally
	let showCoords = $state(!at);
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
		if ('error' in lat || 'error' in lon) {
			showCoords = true;
			return;
		}
		placing = true;
		try {
			const f = await api.map.create(projectId, { kind: pointKind, name: oneLineName(pointName), lat: lat.value, lon: lon.value, nodeId: pointNode || null });
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
		{#if at}
			<p class="at" data-testid="map-place-at">Put on the map at {positionText(at)}. To correct it to a published position, enter its coordinates.</p>
		{/if}
		<details class="coords" bind:open={showCoords}>
			<summary>Enter coordinates</summary>
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
		</details>
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
	.at {
		margin: 0;
	}
	.coords summary {
		cursor: pointer;
		min-height: 24px;
		color: var(--accent);
		font-weight: 600;
	}
	.coords[open] summary {
		margin-bottom: 0.5rem;
	}
</style>
