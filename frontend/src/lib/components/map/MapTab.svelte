<script module lang="ts">
	// The map itself is a chunk of its own, and MapLibre one more below it
	// (CatchmentMap.svelte imports it when it mounts): the list and forms here
	// load with the tab; the map library only once the map is drawn.
	const loadMap = () => import('./CatchmentMap.svelte');
</script>

<script lang="ts">
	// Catchment map (?tab=map, issue #288, roadmap WP-3.12; docs/ui.md §
	// Catchment map, docs/maps.md). The catchment boundary, farm parcels,
	// dams, gauges and rivers over a self-hosted basemap, beside a list that
	// does everything the map does (the map is never the only way): select a
	// feature to frame it, link it to a node, accept a polygon's area into a
	// hydrological unit (a model change, recorded in History with the feature
	// named; never automatic), delete it. Editors import a GeoJSON file
	// (checked and measured on the server, its problems listed per feature) or
	// place a point from typed coordinates. Viewers read. The quaternary lookup
	// that proposes the WR2012 check's values is in Settings → WR2012 check.
	import { untrack } from 'svelte';
	import { PUBLIC_TILES_URL } from '$env/static/public';
	import { api, ApiError, type MapFeature, type MapFeatureKind, type MapFeatureList, type MapImportProblem } from '$lib/api';
	import { confirmDialog } from '$lib/components/common/confirm.svelte';
	import Lazy from '$lib/components/common/Lazy.svelte';
	import LoadState from '$lib/components/common/LoadState.svelte';
	import { fmtDate, fmtNum } from '$lib/format/number';
	import type { ModelEditor } from '$lib/model/editor.svelte';
	import {
		alreadyAccepted,
		areaTargets,
		areaText,
		featureSummary,
		GEO_MAX_BYTES,
		IMPORT_KINDS,
		importProblems,
		isPolygon,
		KIND_LABEL,
		KIND_NODES,
		parseDegrees,
		POINT_KINDS,
		problemText
	} from './mapData';

	let {
		projectId,
		editor,
		canEdit,
		onModelChanged
	}: {
		projectId: string;
		editor: ModelEditor;
		canEdit: boolean;
		/** An area was accepted into the model: the page reloads its inputs. */
		onModelChanged: () => Promise<void> | void;
	} = $props();

	const uid = $props.id();
	const tilesUrl = PUBLIC_TILES_URL?.trim() || null;
	const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

	let data = $state<MapFeatureList | null>(null);
	let loading = $state(true);
	let error = $state<string | null>(null);
	let notice = $state<string | null>(null);
	let selectedId = $state<string | null>(null);

	async function load() {
		loading = !data;
		error = null;
		try {
			data = await api.map.list(projectId);
		} catch (e) {
			error = msg(e);
		} finally {
			loading = false;
		}
	}
	$effect(() => {
		void projectId;
		untrack(load);
	});

	const features = $derived(data?.features ?? []);
	const boundary = $derived(features.find((f) => f.kind === 'catchment_boundary') ?? null);
	const nodes = $derived(data?.nodes ?? []);
	const farms = $derived(areaTargets(nodes));
	const featureById = $derived(new Map(features.map((f) => [f.id, f])));
	const fromMap = $derived(farms.filter((n) => n.areaSource === 'map'));

	function select(id: string) {
		selectedId = id;
		document.getElementById(`${uid}-row-${id}`)?.scrollIntoView({ block: 'nearest' });
	}

	// --- import a GeoJSON file ---
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
			notice = `Imported ${r.features.length} ${r.features.length === 1 ? 'feature' : 'features'} from ${r.source.fileName}.`;
			file = null;
			if (fileInput) fileInput.value = '';
			await load();
			if (r.features[0]) selectedId = r.features[0].id;
		} catch (err) {
			problems = err instanceof ApiError ? importProblems(err.details) : [];
			importError = err instanceof ApiError && problems.length ? 'The file was not imported. Fix these and upload it again:' : msg(err);
		} finally {
			importing = false;
		}
	}

	// --- place a point from coordinates ---
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
			notice = `Placed ${KIND_LABEL[f.kind].toLowerCase()} ${f.name ? `“${f.name}”` : ''} on the map.`;
			pointName = '';
			latText = '';
			lonText = '';
			pointNode = '';
			triedPoint = false;
			await load();
			selectedId = f.id;
		} catch (err) {
			pointError = msg(err);
		} finally {
			placing = false;
		}
	}

	// --- per feature: link, area, delete ---
	let busy = $state<string | null>(null);
	let rowError = $state<{ id: string; text: string } | null>(null);
	/** The unit each polygon's area would go to: the linked farm, else the one picked. */
	let areaTarget = $state<Record<string, string>>({});
	const targetOf = (f: MapFeature) => areaTarget[f.id] ?? (f.nodeId && farms.some((n) => n.id === f.nodeId) ? f.nodeId : '');

	async function link(f: MapFeature, nodeId: string) {
		busy = f.id;
		rowError = null;
		try {
			await api.map.update(projectId, f.id, { nodeId: nodeId || null });
			await load();
		} catch (err) {
			rowError = { id: f.id, text: msg(err) };
		} finally {
			busy = null;
		}
	}

	async function acceptArea(f: MapFeature) {
		const nodeId = targetOf(f);
		const n = farms.find((x) => x.id === nodeId);
		if (!n || f.areaM2 === null) return;
		const ok = await confirmDialog({
			title: `Set ${n.name}’s area from the map?`,
			message: `${n.name}’s catchment area changes from ${fmtNum(n.areaKm2, 3)} km² to ${fmtNum(f.areaM2 / 1e6, 3)} km², the area of ${f.name ? `“${f.name}”` : 'this polygon'} computed on the server. The change is saved to the model now and recorded in History; the next run uses it.`,
			confirmLabel: 'Use this area'
		});
		if (!ok) return;
		busy = f.id;
		rowError = null;
		try {
			const r = await api.map.areaFromMap(projectId, nodeId, f.id);
			notice = `${n.name}’s area is now ${fmtNum(r.areaKm2, 3)} km², from the map. Run the model to see its effect.`;
			await Promise.all([load(), onModelChanged()]);
		} catch (err) {
			rowError = { id: f.id, text: msg(err) };
		} finally {
			busy = null;
		}
	}

	async function remove(f: MapFeature) {
		const used = farms.filter((n) => n.areaFeatureId === f.id);
		const ok = await confirmDialog({
			title: `Delete ${f.name ? `“${f.name}”` : KIND_LABEL[f.kind].toLowerCase()}?`,
			message: `It goes from the map.${used.length ? ` ${used.map((n) => n.name).join(', ')} keep${used.length === 1 ? 's' : ''} the area taken from it.` : ''}`,
			confirmLabel: 'Delete',
			danger: true
		});
		if (!ok) return;
		busy = f.id;
		try {
			await api.map.remove(projectId, f.id);
			if (selectedId === f.id) selectedId = null;
			await load();
		} catch (err) {
			rowError = { id: f.id, text: msg(err) };
		} finally {
			busy = null;
		}
	}

	let mapRef = $state<{ showAll: () => void }>();
</script>

<div class="map-tab">
	{#if notice}
		<p class="alert alert-info slim" role="status" data-testid="map-notice">
			{notice}
			<button type="button" class="btn btn-sm btn-ghost" onclick={() => (notice = null)}>Dismiss</button>
		</p>
	{/if}

	<LoadState {loading} {error} retry={load}>
		{#if data}
			{#if !boundary}
				<p class="alert alert-info slim" data-testid="map-no-boundary">
					No catchment boundary yet.{canEdit ? ' Upload a catchment boundary (GeoJSON, in WGS84) below to draw it and frame the map.' : ''}
				</p>
			{/if}

			<div class="layout">
				<section class="panel map-panel" aria-labelledby="{uid}-map-h">
					<div class="panel-head">
						<h2 id="{uid}-map-h">Map of the catchment</h2>
						<span class="muted small">
							{features.length ? `${features.length} feature${features.length === 1 ? '' : 's'}` : 'Nothing on the map yet'}{boundary ? ` · catchment ${areaText(boundary.areaM2)}` : ''}
						</span>
						{#if features.length}<button type="button" class="btn btn-sm" onclick={() => mapRef?.showAll()}>Show everything</button>{/if}
					</div>
					<Lazy load={loadMap}>
						{#snippet children(CatchmentMap)}
							<CatchmentMap bind:this={mapRef} {features} {selectedId} onselect={select} {tilesUrl} label="Map of the catchment" />
						{/snippet}
					</Lazy>
					{#if !tilesUrl}
						<p class="small muted" data-testid="map-no-tiles">
							No basemap is configured, so the features are drawn on a plain background (docs/maps.md says how to serve one).
						</p>
					{/if}
					<p class="small muted key" aria-hidden="true">
						<span class="k k-boundary"></span>catchment boundary (dashed) <span class="k k-parcel"></span>parcel <span class="k k-river"></span>river ▲ gauge ● dam ◆ other
					</p>
				</section>

				<section class="panel list-panel" aria-labelledby="{uid}-list-h">
					<div class="panel-head">
						<h2 id="{uid}-list-h">Features</h2>
					</div>
					{#if features.length}
						<ul class="features" data-testid="map-feature-list">
							{#each features as f (f.id)}
								<li id="{uid}-row-{f.id}" class:picked={f.id === selectedId} data-kind={f.kind}>
									<button type="button" class="link name" aria-pressed={f.id === selectedId} onclick={() => select(f.id)}>
										{f.name || KIND_LABEL[f.kind]}
									</button>
									<span class="small muted">{KIND_LABEL[f.kind]} · {featureSummary(f)}{f.nodeName ? ` · ${f.nodeName}` : ''}</span>
								</li>
							{/each}
						</ul>
					{:else}
						<p class="muted">Nothing on the map yet.</p>
					{/if}
				</section>
			</div>

			{#if features.length}
				<section class="panel" aria-labelledby="{uid}-table-h">
					<div class="panel-head">
						<h2 id="{uid}-table-h">Every feature</h2>
						<span class="muted small">Areas are computed on the server from each polygon (geodesic, WGS84).</span>
					</div>
					<div class="table-wrap">
						<table class="data" data-testid="map-feature-table">
							<caption class="visually-hidden">Map features, what each stands for, and its area</caption>
							<thead>
								<tr>
									<th scope="col">Feature</th>
									<th scope="col">Kind</th>
									<th scope="col" class="num">Area or position</th>
									<th scope="col">Stands for</th>
									{#if canEdit}<th scope="col">Area into the model</th><th scope="col"><span class="visually-hidden">Actions</span></th>{/if}
								</tr>
							</thead>
							<tbody>
								{#each features as f (f.id)}
									{@const nodeKinds = KIND_NODES[f.kind]}
									<tr class:picked={f.id === selectedId} data-feature={f.id}>
										<th scope="row"><button type="button" class="link" onclick={() => select(f.id)}>{f.name || KIND_LABEL[f.kind]}</button></th>
										<td>{KIND_LABEL[f.kind]}</td>
										<td class="num">{featureSummary(f)}</td>
										<td>
											{#if canEdit && nodeKinds.length}
												<select
													aria-label="What {f.name || KIND_LABEL[f.kind]} stands for"
													value={f.nodeId ?? ''}
													disabled={busy === f.id}
													onchange={(e) => link(f, e.currentTarget.value)}
												>
													<option value="">Nothing</option>
													{#each nodes.filter((n) => nodeKinds.includes(n.kind)) as n (n.id)}<option value={n.id}>{n.name}</option>{/each}
												</select>
											{:else}
												{f.nodeName ?? '–'}
											{/if}
										</td>
										{#if canEdit}
											<td class="area-cell">
												{#if isPolygon(f.geometry) && farms.length}
													{@const target = farms.find((n) => n.id === targetOf(f))}
													<select aria-label="Hydrological unit to take {f.name || 'this polygon'}’s area" bind:value={() => targetOf(f), (v) => (areaTarget[f.id] = v)} disabled={busy === f.id}>
														<option value="">Choose a unit…</option>
														{#each farms as n (n.id)}<option value={n.id}>{n.name} ({fmtNum(n.areaKm2, 3)} km²)</option>{/each}
													</select>
													<button
														type="button"
														class="btn btn-sm"
														disabled={!target || busy === f.id || editor.dirty || (target && alreadyAccepted(target, f))}
														aria-describedby={editor.dirty ? `${uid}-dirty` : undefined}
														onclick={() => acceptArea(f)}
													>
														{target && alreadyAccepted(target, f) ? 'In use' : `Use ${areaText(f.areaM2)}`}
													</button>
												{:else}
													<span class="muted">–</span>
												{/if}
											</td>
											<td class="row-actions">
												<button type="button" class="btn btn-sm btn-ghost" disabled={busy === f.id} onclick={() => remove(f)} aria-label="Delete {f.name || KIND_LABEL[f.kind]}">Delete</button>
											</td>
										{/if}
									</tr>
									{#if rowError?.id === f.id}
										<tr><td colspan={canEdit ? 6 : 4}><p class="err" role="alert">{rowError.text}</p></td></tr>
									{/if}
								{/each}
							</tbody>
						</table>
					</div>
					{#if canEdit && editor.dirty}
						<p class="hint muted" id="{uid}-dirty">Save or discard your model changes first: an area from the map is saved to the model straight away.</p>
					{/if}
				</section>
			{/if}

			{#if farms.length}
				<section class="panel" aria-labelledby="{uid}-areas-h">
					<div class="panel-head">
						<h2 id="{uid}-areas-h">Where each hydrological unit’s area came from</h2>
						<span class="muted small">{fromMap.length} of {farms.length} from the map</span>
					</div>
					<ul class="areas" data-testid="map-area-sources">
						{#each farms as n (n.id)}
							{@const src = n.areaFeatureId ? featureById.get(n.areaFeatureId) : undefined}
							<li data-node={n.id}>
								<strong>{n.name}</strong>: {fmtNum(n.areaKm2, 3)} km² ·
								{#if n.areaSource === 'map'}
									<span class="badge">From the map</span>
									{src ? `“${src.name || KIND_LABEL[src.kind]}”` : 'a feature since deleted'}
								{:else}
									typed
								{/if}
							</li>
						{/each}
					</ul>
					<p class="hint muted">Typing a new area on the Network replaces one from the map. The WR2012 check can propose its quaternary’s values from the map: <a href="?tab=settings#set-wr2012">Settings → WR2012 check</a>.</p>
				</section>
			{/if}

			{#if canEdit}
				<div class="forms">
					<section class="panel" aria-labelledby="{uid}-import-h">
						<h2 id="{uid}-import-h">Upload a GeoJSON file</h2>
						<form onsubmit={importFile} novalidate>
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
							<button type="submit" class="btn btn-primary" disabled={importing}>{importing ? 'Uploading…' : 'Upload'}</button>
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
					</section>

					<section class="panel" aria-labelledby="{uid}-point-h">
						<h2 id="{uid}-point-h">Place a point</h2>
						<form onsubmit={placePoint} novalidate>
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
							<button type="submit" class="btn btn-primary" disabled={placing}>{placing ? 'Placing…' : 'Place the point'}</button>
							{#if pointError}<p class="err" role="alert">{pointError}</p>{/if}
						</form>
					</section>
				</div>
			{/if}

			{#if data.sources.length}
				<section class="panel" aria-labelledby="{uid}-src-h">
					<h2 id="{uid}-src-h">Imported files</h2>
					<ul class="sources">
						{#each data.sources as s (s.id)}
							<li>
								<strong>{s.fileName}</strong> · {s.features} feature{s.features === 1 ? '' : 's'} · {fmtDate(s.importedAt, true)}{s.importedBy ? ` by ${s.importedBy}` : ''}
								<span class="mono small" title="SHA-256 of the file">{s.sha256}</span>
							</li>
						{/each}
					</ul>
				</section>
			{/if}
		{/if}
	</LoadState>
</div>

<style>
	.map-tab {
		display: grid;
		gap: 1rem;
	}
	.layout {
		display: grid;
		grid-template-columns: minmax(0, 3fr) minmax(0, 1fr);
		gap: 1rem;
		align-items: start;
	}
	@media (max-width: 900px) {
		.layout {
			grid-template-columns: minmax(0, 1fr);
		}
	}
	.panel-head {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem 1rem;
		align-items: baseline;
	}
	.features {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 0.15rem;
		max-height: min(60vh, 560px);
		overflow: auto;
	}
	.features li {
		display: grid;
		padding: 0.35rem 0.5rem;
		border-radius: 6px;
	}
	.features li.picked,
	tr.picked {
		background: var(--accent-soft);
	}
	.link {
		background: none;
		border: none;
		padding: 0;
		color: var(--accent);
		text-decoration: underline;
		cursor: pointer;
		font: inherit;
		text-align: left;
		min-height: 24px;
	}
	.area-cell {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
		align-items: center;
	}
	.areas,
	.sources {
		margin: 0;
		padding-left: 1.1rem;
		display: grid;
		gap: 0.3rem;
	}
	.sources .mono {
		display: block;
		word-break: break-all;
	}
	.forms {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(min(100%, 340px), 1fr));
		gap: 1rem;
		align-items: start;
	}
	form {
		display: grid;
		gap: 0.75rem;
		justify-items: start;
	}
	form .field {
		display: grid;
		gap: 0.25rem;
		width: 100%;
	}
	.form-row {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(min(100%, 140px), 1fr));
		gap: 0.75rem;
		width: 100%;
	}
	.key {
		display: flex;
		flex-wrap: wrap;
		gap: 0.3rem 0.6rem;
		align-items: center;
	}
	.k {
		display: inline-block;
		width: 1.4rem;
		height: 0;
		border-top: 3px solid;
		vertical-align: middle;
	}
	.k-boundary {
		border-top-style: dashed;
		border-color: #7a3e00;
	}
	.k-parcel {
		border-color: #0b5a73;
	}
	.k-river {
		border-color: #0b4fa0;
	}
	.slim {
		padding: 0.5rem 0.75rem;
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		align-items: center;
		margin: 0;
	}
	.err {
		color: var(--danger);
		margin: 0;
	}
	.hint {
		font-size: 0.85rem;
	}
	@media (prefers-color-scheme: dark) {
		.k-boundary {
			border-color: #f2c14e;
		}
		.k-parcel {
			border-color: #7fd5e8;
		}
		.k-river {
			border-color: #8ec7ff;
		}
	}
</style>
