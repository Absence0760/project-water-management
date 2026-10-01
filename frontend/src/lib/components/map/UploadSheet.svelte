<!--
	Upload a GeoJSON file, in a side sheet over the Map (`upload=1`; issue
	#326 E5, docs/ui.md § Map). The form as it was at the foot of the page
	(what the file holds, the file, Upload, a refused file's problems by
	feature), with the files imported so far under it (each SHA-256 cut to 12
	characters, with a copy button). D2's review table goes here later.
-->
<script lang="ts">
	import { api, ApiError, type MapFeatureKind, type MapImportProblem, type MapSource } from '$lib/api';
	import Dialog from '$lib/components/common/Dialog.svelte';
	import { GEO_MAX_BYTES, IMPORT_KINDS, importProblems, KIND_LABEL, problemText } from './mapData';
	import SourceList from './SourceList.svelte';

	let {
		open = $bindable(false),
		projectId,
		sources,
		onimported
	}: {
		open?: boolean;
		projectId: string;
		sources: MapSource[];
		/** The file went in: the tab reloads, closes the sheet and picks the first feature. */
		onimported: (r: { fileName: string; ids: string[] }) => Promise<void> | void;
	} = $props();

	const uid = $props.id();
	const formId = `${uid}-form`;
	let importKind = $state<MapFeatureKind>('catchment_boundary');
	let file = $state<File | null>(null);
	let importing = $state(false);
	let importError = $state<string | null>(null);
	let problems = $state<MapImportProblem[]>([]);
	let fileInput = $state<HTMLInputElement>();

	async function importFile(e: SubmitEvent) {
		e.preventDefault();
		importError = null;
		problems = [];
		if (!file) {
			importError = 'Choose a GeoJSON file (.geojson or .json).';
			return;
		}
		if (file.size > GEO_MAX_BYTES) {
			importError = `The file is larger than ${GEO_MAX_BYTES / 1024 / 1024} MB; simplify it or split it.`;
			return;
		}
		if (/\.(zip|shp)$/i.test(file.name)) {
			importError = 'Shapefiles aren’t read yet: export the layer as GeoJSON in WGS84 (EPSG:4326), e.g. from QGIS, and upload that.';
			return;
		}
		importing = true;
		try {
			const r = await api.map.import(projectId, { fileName: file.name, kind: importKind, text: await file.text() });
			file = null;
			if (fileInput) fileInput.value = '';
			await onimported({ fileName: r.source.fileName, ids: r.features.map((f) => f.id) });
		} catch (err) {
			problems = err instanceof ApiError ? importProblems(err.details) : [];
			importError = err instanceof ApiError && problems.length ? 'The file was not imported. Fix these and upload it again:' : err instanceof Error ? err.message : String(err);
		} finally {
			importing = false;
		}
	}
</script>

<Dialog bind:open title="Upload a GeoJSON file" side>
	<form id={formId} onsubmit={importFile} novalidate>
		<div class="field">
			<label for="{uid}-ikind">The file holds</label>
			<select id="{uid}-ikind" bind:value={importKind} aria-describedby="{uid}-ikind-h">
				{#each IMPORT_KINDS as k (k.kind)}<option value={k.kind}>{KIND_LABEL[k.kind]}</option>{/each}
			</select>
			<span class="hint" id="{uid}-ikind-h">{IMPORT_KINDS.find((k) => k.kind === importKind)?.hint}</span>
		</div>
		<div class="field">
			<label for="{uid}-file">GeoJSON file <span class="u">(WGS84, at most 5 MB)</span></label>
			<input
				id="{uid}-file"
				type="file"
				accept=".geojson,.json,application/geo+json,application/json"
				bind:this={fileInput}
				onchange={(e) => (file = e.currentTarget.files?.[0] ?? null)}
				aria-describedby="{uid}-file-h"
				data-testid="map-file"
			/>
			<span class="hint" id="{uid}-file-h">
				Longitude and latitude in WGS84 (EPSG:4326). A file in a Lo zone or UTM is refused rather than guessed: reproject it first (QGIS: Export → Save Features As, CRS EPSG:4326).
			</span>
		</div>
		{#if importError}
			<div class="alert alert-error" role="alert" data-testid="map-import-error">
				<p>{importError}</p>
				{#if problems.length}
					<ul>
						{#each problems as p, i (i)}<li>{problemText(p)}</li>{/each}
					</ul>
				{/if}
			</div>
		{/if}
	</form>

	{#if sources.length}
		<section class="sources" aria-labelledby="{uid}-src-h">
			<h3 id="{uid}-src-h">Imported files</h3>
			<SourceList {sources} />
		</section>
	{/if}

	{#snippet actions()}
		<button type="button" class="btn" onclick={() => (open = false)}>Close</button>
		<button type="submit" form={formId} class="btn btn-primary" disabled={importing}>{importing ? 'Uploading…' : 'Upload'}</button>
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
	}
	.alert p {
		margin: 0;
	}
	.sources {
		margin-top: 1.25rem;
		border-top: 1px solid var(--border);
		padding-top: 0.75rem;
	}
	.sources h3 {
		margin: 0 0 0.5rem;
		font-size: 1rem;
	}
</style>
