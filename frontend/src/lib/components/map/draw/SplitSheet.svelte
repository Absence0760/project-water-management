<!--
	Save a split (issue #326 C2; docs/ui.md § Map): a polygon cut in two
	along the drawn line. The two parts' names (and, for the catchment
	boundary, what its parts are: it stays whole, and its parts become areas
	to link to units, or farm parcels). Nothing is saved until Split: both
	parts go to the server together (`POST …/features/:fid/split`), which
	checks each (closed, non-crossing, limits) and that they make up the
	shape, and records one audit event. A split parcel keeps its id, name and
	link on its first part; the second is a new parcel of the same kind.
-->
<script lang="ts">
	import { cleanName } from '@water-management/engine';
	import { api, type MapFeature, type MapGeometry, type MapPosition } from '$lib/api';
	import Dialog from '$lib/components/common/Dialog.svelte';
	import { areaText, KIND_LABEL } from '../mapData';
	import { shapeAreaM2 } from '../measure/measure';
	import { partSide } from './draft.svelte';

	let {
		open = $bindable(false),
		projectId,
		feature,
		parts,
		onsaved
	}: {
		open?: boolean;
		projectId: string;
		feature: MapFeature;
		/** The two parts' corners (not closed), from draw/split.ts. */
		parts: readonly [MapPosition[], MapPosition[]];
		onsaved: (features: [MapFeature, MapFeature]) => Promise<void> | void;
	} = $props();

	const uid = $props.id();
	const formId = `${uid}-form`;
	const boundary = $derived(feature.kind === 'catchment_boundary');
	// svelte-ignore state_referenced_locally
	const base = feature.name || (feature.kind === 'catchment_boundary' ? 'Catchment' : KIND_LABEL[feature.kind]);
	// svelte-ignore state_referenced_locally
	let names = $state<[string, string]>(feature.kind === 'catchment_boundary' ? [`${base} part 1`, `${base} part 2`] : [feature.name, feature.name ? `${feature.name} (part 2)` : '']);
	let as = $state<'other' | 'farm_parcel'>('other');
	let saving = $state(false);
	let error = $state<string | null>(null);
	const polygon = (c: readonly MapPosition[]): MapGeometry => ({ type: 'Polygon', coordinates: [[...c.map((p) => [p[0], p[1]] as MapPosition), [c[0]![0], c[0]![1]]]] });

	async function save(e: SubmitEvent) {
		e.preventDefault();
		saving = true;
		error = null;
		try {
			const f = await api.map.split(projectId, feature.id, {
				parts: [polygon(parts[0]), polygon(parts[1])],
				names: [cleanName(names[0]), cleanName(names[1])],
				...(boundary ? { as } : {})
			});
			await onsaved(f);
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
		} finally {
			saving = false;
		}
	}
</script>

<Dialog bind:open title="Split the shape" side>
	<form id={formId} onsubmit={save} novalidate data-testid="split-form">
		<p class="lead">
			{#if boundary}The catchment boundary stays as it is; its two parts are saved as new shapes.{:else}“{feature.name || KIND_LABEL[feature.kind]}” becomes the first part; the second is a new {KIND_LABEL[feature.kind].toLowerCase()}.{/if}
		</p>
		{#if boundary}
			<div class="field">
				<label for="{uid}-as">The parts are</label>
				<select id="{uid}-as" bind:value={as}>
					<option value="other">Areas (sub-catchments to link to units)</option>
					<option value="farm_parcel">Farm parcels</option>
				</select>
			</div>
		{/if}
		{#each [0, 1] as const as i (i)}
			<div class="field">
				<label for="{uid}-n{i}">Part {i + 1} <span class="u">(the {partSide(parts, i)} part, about {areaText(shapeAreaM2(parts[i]))})</span></label>
				<input id="{uid}-n{i}" maxlength="100" bind:value={names[i]} />
			</div>
		{/each}
		<p class="hint">Each part’s area is computed on the server when it is saved (geodesic, WGS84). A unit whose area was taken from the shape keeps it until you press Use again.</p>
		{#if error}<p class="err" role="alert" data-testid="split-error">{error}</p>{/if}
	</form>

	{#snippet actions()}
		<button type="button" class="btn" onclick={() => (open = false)}>Back to the map</button>
		<button type="submit" form={formId} class="btn btn-primary" disabled={saving} data-testid="split-submit">{saving ? 'Splitting…' : 'Split'}</button>
	{/snippet}
</Dialog>

<style>
	form {
		display: grid;
		gap: 0.75rem;
	}
	.lead {
		margin: 0;
	}
	.field {
		display: grid;
		gap: 0.25rem;
	}
	.u {
		color: var(--text-muted);
		font-weight: normal;
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
