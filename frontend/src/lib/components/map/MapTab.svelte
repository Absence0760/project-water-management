<script module lang="ts">
	// The map itself is a chunk of its own, and MapLibre one more below it
	// (CatchmentMap.svelte imports it when it mounts): the list and card here
	// load with the tab; the map library only once the map is drawn. The
	// sheets stay in the tab's chunk: they are small, and a chunk of their
	// own cost more in overhead than it saved (ui-playbook § 6).
	const loadMap = () => import('./CatchmentMap.svelte');
</script>

<script lang="ts">
	// Catchment map (?tab=map, issue #288, roadmap WP-3.12; laid out as a
	// Network-style workspace in #326 E3–E6; docs/ui.md § Map, docs/maps.md).
	// The map on the left, fitted to the window; on the right the picked
	// feature's card over a compact list grouped by kind. The list does
	// everything the map does (the map is never the only way). The pick is in
	// the URL (`feature=<id>`, or `node=<nodeId>` for a node's parcel) so Back
	// undoes it; Upload (`upload=1`), Place a point (`place=1`) and Every
	// feature (`grid=map-features`) open over the page from the header and
	// the list, each in the URL. Viewers read.
	import { tick, untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { PUBLIC_TILES_URL } from '$env/static/public';
	import { api, type MapFeature, type MapFeatureList } from '$lib/api';
	import { confirmDialog } from '$lib/components/common/confirm.svelte';
	import Dialog from '$lib/components/common/Dialog.svelte';
	import Lazy from '$lib/components/common/Lazy.svelte';
	import LoadState from '$lib/components/common/LoadState.svelte';
	import { fillHeader } from '$lib/components/workspace/headerSlot.svelte';
	import { fmtNum } from '$lib/format/number';
	import type { ModelEditor } from '$lib/model/editor.svelte';
	import { TAB_GRIDS, withParam, withoutParam } from '$lib/workspace/overlays';
	import { appIsDark, watchAppTheme } from './appTheme';
	import FeatureList from './FeatureList.svelte';
	import MapChecks from './MapChecks.svelte';
	import { mapChecks } from './mapChecks';
	import { alreadyAccepted, areaTargets, areaText, featureSummary, isPolygon, KIND_LABEL, KIND_NODES, takesArea } from './mapData';
	import { areaSourceOf, featureName, headerLine, inListOrder, keyGroups, pickedFeature } from './mapList';
	import { overlayColours } from './mapStyle';
	import PlaceSheet from './PlaceSheet.svelte';
	import SourceList from './SourceList.svelte';
	import UploadSheet from './UploadSheet.svelte';

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
	const GRID_ID = 'map-features';

	let data = $state<MapFeatureList | null>(null);
	let loading = $state(true);
	let error = $state<string | null>(null);
	let notice = $state<string | null>(null);

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
	const ordered = $derived(inListOrder(features));
	const boundary = $derived(features.find((f) => f.kind === 'catchment_boundary') ?? null);
	const nodes = $derived(data?.nodes ?? []);
	const farms = $derived(areaTargets(nodes));
	const featureById = $derived(new Map(features.map((f) => [f.id, f])));
	const fromMap = $derived(farms.filter((n) => n.areaSource === 'map'));
	const sourceName = $derived(new Map((data?.sources ?? []).map((s) => [s.id, s.fileName])));

	// --- the pick, in the URL (`feature=<id>`; `node=<nodeId>` picks that node's parcel) ---
	const params = $derived(page.url.searchParams);
	const picked = $derived(pickedFeature(features, params.get('feature'), params.get('node')));
	const selectedId = $derived(picked?.id ?? null);
	/** Picks a feature: a history entry, so Back goes to the one before. A node link's `node` gives way to it. */
	function select(id: string): Promise<void> {
		if (id === selectedId && params.get('feature') === id) return Promise.resolve();
		const q = new URLSearchParams(page.url.search);
		q.set('feature', id);
		q.delete('node');
		return goto(`?${q}`, { noScroll: true, keepFocus: true });
	}
	/**
	 * A pick from the list. Stacked (a phone, a narrow column) the card sits above the list, so bring
	 * it into view once it shows the pick; beside the list it is already in view.
	 */
	let cardEl: HTMLElement | undefined = $state();
	async function selectFromList(id: string) {
		await select(id);
		if (!layoutEl || getComputedStyle(layoutEl).gridTemplateColumns.trim().split(/\s+/).length > 1) return;
		await tick();
		cardEl?.scrollIntoView({ block: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
	}
	/** The URL with `drop` closed and `id` picked, in place (after a save in a sheet, or a pick from the grid). */
	function pickInPlace(id: string | null, ...drop: string[]) {
		const q = new URLSearchParams(page.url.search);
		for (const d of drop) q.delete(d);
		q.delete('node');
		if (id) q.set('feature', id);
		else q.delete('feature');
		return goto(`?${q}`, { replaceState: true, noScroll: true, keepFocus: true });
	}

	// --- the sheets and the grid: open while the URL names them; closing drops the param in place ---
	function overlay(name: string, value: string, allowed: () => boolean) {
		let open = $state(false);
		const asked = $derived(params.get(name) === value && allowed());
		$effect(() => {
			open = asked;
		});
		$effect(() => {
			if (!open && untrack(() => params.has(name))) void goto(withoutParam(page.url, name), { replaceState: true, noScroll: true, keepFocus: true });
		});
		return {
			get open() {
				return open;
			},
			set open(v: boolean) {
				open = v;
			}
		};
	}
	const upload = overlay('upload', '1', () => canEdit);
	const place = overlay('place', '1', () => canEdit);
	const grid = overlay('grid', GRID_ID, () => true);
	// The consistency checks (#326 A4): a one-line count in the side column, the warnings in a sheet (`checks=1`), so a big catchment's list keeps its room.
	const checksSheet = overlay('checks', '1', () => true);
	const checks = $derived(mapChecks(features, nodes));
	async function pickFromCheck(id: string) {
		await pickInPlace(id, 'checks');
	}

	async function imported(r: { fileName: string; ids: string[] }) {
		notice = `Imported ${r.ids.length} ${r.ids.length === 1 ? 'feature' : 'features'} from ${r.fileName}.`;
		await load();
		await pickInPlace(r.ids[0] ?? selectedId, 'upload');
	}
	async function placed(f: MapFeature) {
		notice = `Placed ${KIND_LABEL[f.kind].toLowerCase()} ${f.name ? `“${f.name}”` : ''} on the map.`;
		await load();
		await pickInPlace(f.id, 'place');
	}

	// --- per feature: link, area, delete (from the card and from Every feature) ---
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
		// Read before the reload: once it's gone, nothing in the list is picked, but the URL still names it.
		const wasPicked = selectedId === f.id;
		try {
			await api.map.remove(projectId, f.id);
			await load();
			if (wasPicked) await pickInPlace(null);
		} catch (err) {
			rowError = { id: f.id, text: msg(err) };
		} finally {
			busy = null;
		}
	}

	let mapRef = $state<{ showAll: () => void }>();

	// --- the key: the map's own colours (mapStyle.ts), in the app's theme, following it when it changes ---
	let dark = $state(appIsDark());
	$effect(() => watchAppTheme(() => (dark = appIsDark())));
	const key = $derived(keyGroups(overlayColours(dark)));

	// --- the window fit: the layout is the height left below its top edge (ui-playbook § 2, as the Network) ---
	let layoutEl: HTMLDivElement | undefined = $state();
	let layoutTop = $state(0);
	$effect(() => {
		if (!layoutEl) return;
		const measure = () => {
			if (layoutEl) layoutTop = layoutEl.getBoundingClientRect().top + window.scrollY;
		};
		measure();
		const ro = new ResizeObserver(measure);
		ro.observe(document.body);
		return () => ro.disconnect();
	});

	// --- the section header: the context line and the actions ---
	$effect(() => fillHeader({ context: headerContext, actions: headerActions }));
</script>

{#snippet headerContext()}<span data-testid="map-summary">{data ? headerLine(features, nodes) : 'Loading the map…'}</span>{/snippet}
{#snippet headerActions()}
	{#if features.length}<button type="button" class="btn" onclick={() => mapRef?.showAll()}>Show everything</button>{/if}
	{#if canEdit}
		<a class="btn" href={withParam(page.url, 'upload', '1')} data-testid="map-open-upload">Upload GeoJSON</a>
		<a class="btn" href={withParam(page.url, 'place', '1')} data-testid="map-open-place">Place a point</a>
	{/if}
{/snippet}

<!-- What a feature stands for: a select of fitting nodes for editors, else the node's name. -->
{#snippet standsFor(f: MapFeature)}
	{@const nodeKinds = KIND_NODES[f.kind]}
	{#if canEdit && nodeKinds.length}
		<select class="cap" aria-label="What {featureName(f)} stands for" value={f.nodeId ?? ''} disabled={busy === f.id} onchange={(e) => link(f, e.currentTarget.value)}>
			<option value="">Nothing</option>
			{#each nodes.filter((n) => nodeKinds.includes(n.kind)) as n (n.id)}<option value={n.id}>{n.name}</option>{/each}
		</select>
	{:else}
		{f.nodeName ?? '–'}
	{/if}
{/snippet}

<!-- Area into the model: a unit and Use, for a parcel or an "other" polygon only (never a dam or the boundary). -->
{#snippet areaInto(f: MapFeature)}
	{#if takesArea(f) && farms.length}
		{@const target = farms.find((n) => n.id === targetOf(f))}
		<span class="area-into">
			<select class="cap" aria-label="Hydrological unit to take {f.name || 'this polygon'}’s area" bind:value={() => targetOf(f), (v) => (areaTarget[f.id] = v)} disabled={busy === f.id}>
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
		</span>
	{:else}
		<span class="muted">–</span>
	{/if}
{/snippet}

{#snippet deleteButton(f: MapFeature)}
	<button type="button" class="btn btn-sm btn-ghost" disabled={busy === f.id} onclick={() => remove(f)} aria-label="Delete {featureName(f)}">Delete</button>
{/snippet}

{#snippet dirtyHint()}
	{#if canEdit && editor.dirty}
		<p class="hint muted" id="{uid}-dirty">Save or discard your model changes first: an area from the map is saved to the model straight away.</p>
	{/if}
{/snippet}

<!-- The unit's area, typed or from the map (E6), in words. -->
{#snippet unitArea(f: MapFeature)}
	{@const s = areaSourceOf(f, nodes)}
	{#if s}
		{s.node.name}: {fmtNum(s.node.areaKm2, 3)} km² ·
		{#if s.source === 'this'}<span class="badge">From the map</span> this {KIND_LABEL[f.kind].toLowerCase()}
		{:else if s.source === 'other'}
			{@const other = s.node.areaFeatureId ? featureById.get(s.node.areaFeatureId) : undefined}
			<span class="badge">From the map</span> {other ? `“${featureName(other)}”` : 'a feature since deleted'}
		{:else}typed{/if}
	{/if}
{/snippet}

<div class="map-page" data-ready={data ? 'true' : undefined}>
	{#if notice}
		<p class="alert alert-info slim" role="status" data-testid="map-notice">
			{notice}
			<button type="button" class="btn btn-sm btn-ghost" onclick={() => (notice = null)}>Dismiss</button>
		</p>
	{/if}
	{#if canEdit && !tilesUrl}
		<p class="alert alert-info slim" data-testid="map-no-tiles">No basemap is configured, so the features are drawn on a plain background (docs/maps.md says how to serve one).</p>
	{/if}
	{#if data && features.length && !boundary}
		<p class="alert alert-info slim" data-testid="map-no-boundary">
			No catchment boundary yet.{canEdit ? ' Upload one (GeoJSON, in WGS84) to draw it and frame the map.' : ''}
		</p>
	{/if}

	<LoadState {loading} {error} retry={load}>
		{#if data}
			<div class="map-layout" bind:this={layoutEl} style:--layout-top="{layoutTop}px">
				<section class="panel map-card" aria-label="Map">
					<div class="map-body">
						<Lazy load={loadMap}>
							{#snippet children(CatchmentMap)}
								<CatchmentMap bind:this={mapRef} {features} {selectedId} onselect={select} {tilesUrl} label="Map of the catchment" fill />
							{/snippet}
						</Lazy>
					</div>
					<!-- The key, from the map's own colours. A1's measure picker goes beside it, in this row. -->
					<div class="key-row">
						<div class="key small" role="group" aria-label="Key" data-testid="map-key">
							{#each key as g (g.label)}
								<span class="key-group">
									<span class="key-h">{g.label}</span>
									{#each g.items as k (g.label + k.label)}
										<span class="key-item"><span class="sw sw-{k.swatch}" style:--c={k.colour} aria-hidden="true"></span>{k.label}</span>
									{/each}
								</span>
							{/each}
						</div>
					</div>
				</section>

				<aside class="map-side" aria-label="Features">
					<section class="panel side-box card" aria-label="Picked feature" data-testid="map-feature-card" bind:this={cardEl}>
						{#if picked}
							<h2 class="card-h">{featureName(picked)}</h2>
							<dl class="facts">
								<dt>Kind</dt>
								<dd>{KIND_LABEL[picked.kind]}</dd>
								<dt>{picked.geometry.type === 'Point' ? 'Position' : isPolygon(picked.geometry) ? 'Area' : 'Shape'}</dt>
								<dd>{featureSummary(picked)}</dd>
								{#if KIND_NODES[picked.kind].length}
									<dt>Stands for</dt>
									<dd>{@render standsFor(picked)}</dd>
								{/if}
								{#if areaSourceOf(picked, nodes)}
									<dt>Unit’s area</dt>
									<dd data-testid="map-card-area-source">{@render unitArea(picked)}</dd>
								{/if}
								{#if canEdit && takesArea(picked) && farms.length}
									<dt>Area into the model</dt>
									<dd>{@render areaInto(picked)}</dd>
								{/if}
								{#if picked.sourceId && sourceName.get(picked.sourceId)}
									<dt>From</dt>
									<dd class="file">{sourceName.get(picked.sourceId)}</dd>
								{/if}
							</dl>
							{@render dirtyHint()}
							{#if rowError?.id === picked.id}<p class="err" role="alert">{rowError.text}</p>{/if}
							{#if canEdit}<div class="card-actions">{@render deleteButton(picked)}</div>{/if}
						{:else if features.length}
							<p class="muted small pick-hint">Select a feature on the map or in the list to see it here.</p>
						{:else}
							<!-- The one empty-state line (D4 makes it lead with drawing, with C1). -->
							<p class="pick-hint" data-testid="map-no-boundary">
								Nothing on the map yet.{canEdit ? ' Upload a catchment boundary (GeoJSON, in WGS84) to draw it and frame the map, or place a point.' : ''}
							</p>
						{/if}
					</section>

					{#if features.length}
						<section class="panel side-box list-box" aria-labelledby="{uid}-list-h">
							<div class="list-head">
								<h2 class="list-h" id="{uid}-list-h">Features</h2>
								<a class="btn btn-sm" href={withParam(page.url, 'grid', GRID_ID)} data-testid="map-open-grid">Every feature</a>
							</div>
							<FeatureList {features} {nodes} {selectedId} onselect={selectFromList} labelledby="{uid}-list-h" />
						</section>
					{/if}

					<!-- The map's consistency checks (#326 A4): warnings only; the count here, the warnings in a sheet. -->
					{#if features.length}
						<p class="panel side-box checks-line small" data-testid="map-checks-line">
							{#if checks.length}
								<span><strong>{checks.length} {checks.length === 1 ? 'warning' : 'warnings'}</strong> from the map’s checks</span>
								<a class="btn btn-sm" href={withParam(page.url, 'checks', '1')} data-testid="map-checks-open">Show the checks</a>
							{:else}
								<span class="muted">The map’s checks found no problems.</span>
							{/if}
						</p>
					{/if}
				</aside>
			</div>

			{#if upload.open}
				<UploadSheet bind:open={upload.open} {projectId} sources={data.sources} onimported={imported} />
			{/if}
			{#if checksSheet.open}
				<Dialog bind:open={checksSheet.open} title="Map checks" side>
					<MapChecks {features} {nodes} onpick={pickFromCheck} heading={false} />
					{#snippet actions()}
						<button type="button" class="btn" onclick={() => (checksSheet.open = false)}>Close</button>
					{/snippet}
				</Dialog>
			{/if}
			{#if place.open}
				<PlaceSheet bind:open={place.open} {projectId} {nodes} onplaced={placed} />
			{/if}
			{#if grid.open}
				<Dialog bind:open={grid.open} title={TAB_GRIDS[GRID_ID].title} full>
					<div class="grid-body" data-testid="map-grid">
						{#if features.length}
							<p class="muted small grid-note">Areas are computed on the server from each polygon (geodesic, WGS84).</p>
							<div class="table-wrap">
								<table class="data map-table" data-testid="map-feature-table">
									<caption class="visually-hidden">Map features, what each stands for, and its area</caption>
									<thead>
										<tr>
											<th scope="col">Feature</th>
											<th scope="col">Kind</th>
											<th scope="col" class="num">Area or position</th>
											<th scope="col">Stands for</th>
											<th scope="col">Unit’s area</th>
											{#if canEdit}<th scope="col">Area into the model</th><th scope="col"><span class="visually-hidden">Actions</span></th>{/if}
										</tr>
									</thead>
									<tbody>
										{#each ordered as f (f.id)}
											<tr class:picked={f.id === selectedId} data-feature={f.id}>
												<th scope="row">
													<button type="button" class="link" onclick={() => pickInPlace(f.id, 'grid')}>{featureName(f)}</button>
												</th>
												<td><span class="cell-label" aria-hidden="true">Kind </span>{KIND_LABEL[f.kind]}</td>
												<td class="num"><span class="cell-label" aria-hidden="true">Area or position </span>{featureSummary(f)}</td>
												<td><span class="cell-label" aria-hidden="true">Stands for </span>{@render standsFor(f)}</td>
												<td><span class="cell-label" aria-hidden="true">Unit’s area </span>{#if areaSourceOf(f, nodes)}{@render unitArea(f)}{:else}<span class="muted">–</span>{/if}</td>
												{#if canEdit}
													<td class="area-cell"><span class="cell-label" aria-hidden="true">Area into the model </span>{@render areaInto(f)}</td>
													<td class="row-actions">{@render deleteButton(f)}</td>
												{/if}
											</tr>
											{#if rowError?.id === f.id}
												<tr><td colspan={canEdit ? 7 : 5}><p class="err" role="alert">{rowError.text}</p></td></tr>
											{/if}
										{/each}
									</tbody>
								</table>
							</div>
							{@render dirtyHint()}
						{:else}
							<p class="muted">Nothing on the map yet.</p>
						{/if}

						{#if farms.length}
							<section class="grid-section" aria-labelledby="{uid}-areas-h">
								<h2 id="{uid}-areas-h">Where each hydrological unit’s area came from <span class="muted small">{fromMap.length} of {farms.length} from the map</span></h2>
								<ul class="areas" data-testid="map-area-sources">
									{#each farms as n (n.id)}
										{@const src = n.areaFeatureId ? featureById.get(n.areaFeatureId) : undefined}
										<li data-node={n.id}>
											<strong>{n.name}</strong>: {fmtNum(n.areaKm2, 3)} km² ·
											{#if n.areaSource === 'map'}
												<span class="badge">From the map</span>
												{src ? `“${featureName(src)}”` : 'a feature since deleted'}
											{:else}
												typed
											{/if}
										</li>
									{/each}
								</ul>
								<p class="hint muted">Typing a new area on the Network replaces one from the map. The WR2012 check can propose its quaternary’s values from the map: <a href="?tab=settings#set-wr2012">Settings → WR2012 check</a>.</p>
							</section>
						{/if}

						{#if data.sources.length}
							<section class="grid-section" aria-labelledby="{uid}-src-h">
								<h2 id="{uid}-src-h">Imported files</h2>
								<SourceList sources={data.sources} />
							</section>
						{/if}
					</div>
					{#snippet actions()}
						<button type="button" class="btn" onclick={() => (grid.open = false)}>Close</button>
					{/snippet}
				</Dialog>
			{/if}
		{/if}
	</LoadState>
</div>

<style>
	/* The page's container: the layout's columns follow its width, not the window's (the sidebar takes 240 px). */
	.map-page {
		container: map-page / inline-size;
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 0.75rem;
	}
	.slim {
		padding: 0.5rem 0.75rem;
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		align-items: center;
		margin: 0;
	}
	/* Stacked by default (a phone, a narrow column): the map, then the card, the list. */
	.map-layout {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 1rem;
	}
	.map-card,
	.side-box {
		margin: 0;
		min-width: 0;
	}
	/* One line, never growing: the warnings themselves are in the checks sheet. */
	.checks-line {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
		flex: 0 0 auto;
	}
	.map-card {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}
	.map-body {
		position: relative;
		min-height: 0;
	}
	.map-side {
		display: grid;
		gap: 0.75rem;
		align-content: start;
		min-width: 0;
	}
	/* 56rem = 784 px at the 14 px root: the side column from about a 1030 px window with the sidebar. */
	@container map-page (min-width: 56rem) {
		.map-layout {
			grid-template-columns: minmax(0, 1fr) clamp(18rem, 30%, 24rem);
			align-items: start;
		}
	}
	/* Window fit (a dashboard, as the Network): with the side column and a window at least 620 px high,
	   the layout is the height left below its top, less the gutter and the save bar while it shows.
	   The map fills its card; the list scrolls inside its own; the page doesn't scroll. */
	@media (min-height: 620px) {
		@container map-page (min-width: 56rem) {
			.map-layout {
				height: max(30rem, calc(100vh - var(--layout-top, 0px) - var(--dock-h, 0px) - 1rem));
				align-items: stretch;
			}
			.map-card {
				min-height: 0;
			}
			.map-body {
				flex: 1;
				display: flex;
				flex-direction: column;
			}
			/* The lazy loader's box passes the card's height on to CatchmentMap (`fill`). */
			.map-body > :global(*) {
				flex: 1;
				display: flex;
				flex-direction: column;
				min-height: 0;
			}
			.map-side {
				display: flex;
				flex-direction: column;
				min-height: 0;
			}
			.card {
				flex: none;
				max-height: 55%;
				overflow-y: auto;
			}
			.list-box {
				flex: 1;
				min-height: 8rem;
				display: flex;
				flex-direction: column;
			}
			.list-box :global(.list-scroll) {
				flex: 1;
				min-height: 0;
				overflow-y: auto;
			}
		}
	}
	.card-h {
		margin: 0 0 0.5rem;
		font-size: 1.05rem;
		overflow-wrap: break-word;
	}
	.facts {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr);
		gap: 0.35rem 0.75rem;
		margin: 0;
		align-items: baseline;
	}
	.facts dt {
		color: var(--text-muted);
		font-size: 0.85rem;
	}
	.facts dd {
		margin: 0;
		min-width: 0;
		overflow-wrap: break-word;
	}
	.card-actions {
		margin-top: 0.6rem;
		display: flex;
		justify-content: flex-end;
	}
	.pick-hint {
		margin: 0;
	}
	.list-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
		margin-bottom: 0.4rem;
	}
	.list-h {
		margin: 0;
		font-size: 0.95rem;
	}
	/* A select in a card or a cell stops at ~16rem, not the column's whole width. */
	.cap {
		max-width: min(100%, 16rem);
	}
	.area-into {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
		align-items: center;
	}
	.key-row {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem 1rem;
		align-items: center;
	}
	.key {
		display: flex;
		flex-wrap: wrap;
		gap: 0.3rem 1rem;
		margin: 0;
		color: var(--text-2);
	}
	.key-group {
		display: inline-flex;
		flex-wrap: wrap;
		gap: 0.3rem 0.6rem;
		align-items: center;
	}
	.key-h {
		font-weight: 600;
		color: var(--text);
	}
	.key-item {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
	}
	/* Each swatch drawn as the map draws its kind, in the colour mapStyle gives it (--c). */
	.sw {
		display: inline-block;
		flex: none;
	}
	.sw-dashed,
	.sw-line,
	.sw-dotted {
		width: 1.4rem;
		height: 0;
		border-top: 3px solid var(--c);
	}
	.sw-dashed {
		border-top-style: dashed;
	}
	.sw-dotted {
		border-top-style: dotted;
	}
	.sw-area {
		width: 1rem;
		height: 0.75rem;
		border: 2px solid var(--c);
		background: color-mix(in srgb, var(--c) 25%, transparent);
	}
	.sw-gauge,
	.sw-dam,
	.sw-other {
		width: 0.85rem;
		height: 0.85rem;
		background: var(--c);
	}
	.sw-gauge {
		clip-path: polygon(50% 0, 100% 100%, 0 100%);
	}
	.sw-dam {
		border-radius: 50%;
	}
	.sw-other {
		clip-path: polygon(50% 0, 100% 50%, 50% 100%, 0 50%);
	}
	.err {
		color: var(--danger);
		margin: 0.4rem 0 0;
	}
	.hint {
		font-size: 0.85rem;
		margin: 0.5rem 0 0;
	}
	/* Every feature (grid=map-features): the table, then the units' areas and the imported files. */
	.grid-body {
		container: map-grid / inline-size;
		flex: 1;
		min-height: 0;
		overflow: auto;
	}
	.grid-note {
		margin: 0 0 0.5rem;
	}
	.grid-section {
		margin-top: 1.25rem;
	}
	.grid-section h2 {
		font-size: 1rem;
		margin: 0 0 0.5rem;
	}
	.areas {
		margin: 0;
		padding-left: 1.1rem;
		display: grid;
		gap: 0.3rem;
	}
	.grid-body .table-wrap {
		max-height: none;
	}
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
	.cell-label {
		display: none;
	}
	/* A narrow modal (a phone): each row a card, every cell labelled, rather than a table that scrolls sideways. */
	@container map-grid (max-width: 46rem) {
		.map-table thead {
			display: none;
		}
		.map-table,
		.map-table tbody,
		.map-table tr,
		.map-table th,
		.map-table td {
			display: block;
		}
		.map-table tr {
			padding: 0.5rem 0;
			border-bottom: 1px solid var(--border);
		}
		.map-table th,
		.map-table td {
			border: 0;
			padding: 0.15rem 0;
			text-align: left;
		}
		.cell-label {
			display: inline-block;
			margin-right: 0.4rem;
			color: var(--text-muted);
			font-size: 0.85rem;
		}
	}
</style>
