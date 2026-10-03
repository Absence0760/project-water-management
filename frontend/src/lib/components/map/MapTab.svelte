<script module lang="ts">
	// The map itself is a chunk of its own, and MapLibre one more below it
	// (CatchmentMap.svelte imports it when it mounts): the list and card here
	// load with the tab; the map library only once the map is drawn. The
	// small sheets stay in the tab's chunk (a chunk of their own costs more
	// in overhead than it saves, ui-playbook § 6); Start from the map, the
	// largest, opened on few visits (an empty model), loads when opened,
	// which keeps the tab under its 60 KB budget (61 → 57 KB, issue #374;
	// splitting Divide the model too saved 2 KB more for 3 KB of overhead).
	// Upload GeoJSON (the sheet and its review table, importReview.ts) loads
	// when opened too: round 3's delineation work took the tab back to 62 KB,
	// and the split brought it to 58 KB for ~1.8 KB of overhead in the total.
	const loadMap = () => import('./CatchmentMap.svelte');
	const loadStartSheet = () => import('./StartSheet.svelte');
	const loadUploadSheet = () => import('./UploadSheet.svelte');
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
	// the list, each in the URL. Viewers read. Editors draw on the map
	// (#326 C1, D1, D4): Draw a shape and Place a point put the map in a
	// drawing mode with a draw bar over it (draw/), and a drawing is saved only
	// through its sheet's confirm. Anyone can Measure (measure/, the drawing
	// mode with nothing saved) and Download GeoJSON (mapExport.ts, built from
	// the loaded list); the Layers box turns on the quaternary outlines
	// (`layers=quaternaries`, #326 A6, A7), the river network (`layers=rivers`,
	// #345, an editor adding its reaches as rivers one at a time) and, with a
	// DEM configured, the relief (`layers=relief`, docs/maps.md § Relief).
	// With a DEM on the server, editors can Delineate (`delineate=1`, #326
	// B-delineate, docs/design/delineation.md): click the river, and the
	// catchment above it is proposed, drawn dashed, until they accept or reject it.
	// With the same DEM, Sub-catchments (ClickBar, clickPieces.svelte.ts) makes
	// each click on a river an outlet: the map draws every click's incremental
	// catchment, numbered by click, and Save keeps them as areas.
	// On an empty model, editors can Start the model from the map (`start=1`,
	// #326 C3, docs/design/start-from-map.md): units at the dams and
	// abstraction points, their sub-catchments and order proposed and ticked
	// value by value; the empty map leads with Delineate and Draw (D4).
	import { tick, untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { PUBLIC_TERRAIN_URL, PUBLIC_TILES_GLYPHS_URL, PUBLIC_TILES_URL } from '$env/static/public';
	import { api, type DamTraceProposal, type DamTraceState, type MinOccurrence, type DelineationState, type MapFeature, type MapFeatureList, type Role, type RunMeta, type StartState } from '$lib/api';
	import { confirmDialog } from '$lib/components/common/confirm.svelte';
	import Dialog from '$lib/components/common/Dialog.svelte';
	import Lazy from '$lib/components/common/Lazy.svelte';
	import DivideSheet from './DivideSheet.svelte';
	import LoadState from '$lib/components/common/LoadState.svelte';
	import { fillHeader } from '$lib/components/workspace/headerSlot.svelte';
	import { saveBlob } from '$lib/export/download';
	import { fmtNum, localIsoDate } from '$lib/format/number';
	import type { ModelEditor } from '$lib/model/editor.svelte';
	import { TAB_GRIDS, withParam, withoutParam } from '$lib/workspace/overlays';
	import { appIsDark, watchAppTheme } from './appTheme';
	import FeatureList from './FeatureList.svelte';
	import MapChecks from './MapChecks.svelte';
	import { mapChecks } from './mapChecks';
	import { alreadyAccepted, areaTargets, areaText, featureSummary, isPolygon, KIND_LABEL, KIND_NODES, takesArea } from './mapData';
	import { areaSourceOf, featureName, headerLine, inListOrder, keyGroups, pickedFeature } from './mapList';
	import { channelColour, glyphsUrl, overlayColours, riverNetworkColour } from './mapStyle';
	import { exportFileName, geoJsonText } from './mapExport';
	import { layersOn } from './mapLayers';
	import MapLayers from './MapLayers.svelte';
	import { QuaternaryLayer } from './quaternaryLayer.svelte';
	import { RiverLayer } from './riverLayer.svelte';
	import MeasureBar from './measure/MeasureBar.svelte';
	import { MeasureDraft } from './measure/measureDraft.svelte';
	import MapKeyRow from './MapKeyRow.svelte';
	import { featureResult, viewLabel } from './mapResults';
	import { MapResults } from './mapResults.svelte';
	import { BAND_WORD } from './mapStatus';
	import PlaceSheet from './PlaceSheet.svelte';
	import DelineateSheet from './DelineateSheet.svelte';
	import ClickBar from './ClickBar.svelte';
	import { ClickDivider, clickShape } from './clickPieces.svelte';
	import { ChannelLayer } from './channelLayer.svelte';
	import { openProposal } from './delineation';
	import { openDivide, openStart, type StartDraft } from './startFlow';
	import type { DivideDraft } from './divideFlow';
	import { emptyPlacement } from './placement';
	import { litPieces, piecesShape } from './pieces';
	import type { MapGeometry, MapPosition } from '$lib/api/types';
	import { Draft } from './draw/draft.svelte';
	import DraftSheet from './draw/DraftSheet.svelte';
	import DrawBar from './draw/DrawBar.svelte';
	import PasteSheet from './draw/PasteSheet.svelte';
	import SplitSheet from './draw/SplitSheet.svelte';
	import TraceSheet from './draw/TraceSheet.svelte';
	import { DRAW_CHOICES, editableCorners } from './draw/shape';
	import MapRainLink from './MapRainLink.svelte';
	import SourceList from './SourceList.svelte';

	let {
		projectId,
		editor,
		canEdit,
		runs = null,
		role = null,
		projectName = null,
		onModelChanged
	}: {
		projectId: string;
		editor: ModelEditor;
		canEdit: boolean;
		/** The project's runs, newest first (null = not loaded): the results on the map read one (#326 A1). */
		runs?: RunMeta[] | null;
		/** The caller's role: below editor the map shows the published run only. */
		role?: Role | null;
		/** The project's name, for the GeoJSON download's file name. */
		projectName?: string | null;
		/** An area was accepted into the model: the page reloads its inputs. */
		onModelChanged: () => Promise<void> | void;
	} = $props();

	const uid = $props.id();
	const tilesUrl = PUBLIC_TILES_URL?.trim() || null;
	/** The labels' glyphs (#326 A6): empty = no labels, nothing fetched (docs/maps.md § Labels). */
	const glyphs = glyphsUrl(PUBLIC_TILES_GLYPHS_URL, typeof location === 'undefined' ? '' : location.origin);
	/** The relief's DEM (docs/maps.md § Relief): empty = no Relief layer offered, nothing fetched. */
	const terrainUrl = PUBLIC_TERRAIN_URL?.trim() || null;
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
	// Until the state is in, a `delineate=1` link is kept (a reload, a deep link), so the param isn't dropped before it can be judged.
	const delineateSheet = overlay('delineate', '1', () => canEdit && (!delineationLoaded || !!delineation?.available));
	// Trace a dam from typed coordinates (#326 C2): a sheet in the URL like Place and Delineate, kept until the state is in.
	const traceSheet = overlay('trace', '1', () => canEdit && (!damTraceLoaded || !!damTrace?.available));
	const grid = overlay('grid', GRID_ID, () => true);
	// Until the state is in, a `start=1` link is kept (a reload, a deep link), as Delineate's is.
	const startSheet = overlay('start', '1', () => canEdit && (!startLoaded || !!startInfo));
	// Divide a model that has nodes (#326 C3's follow-up): the same state, its own sheet.
	const divideSheet = overlay('divide', '1', () => canEdit && (!startLoaded || !!startInfo));
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
		draft.cancel();
		await load();
		await pickInPlace(f.id, 'place');
		await returnToStart();
	}

	// --- delineation (#326 B-delineate): on when the server has a DEM; one open proposal, drawn on the map ---
	let delineation = $state<DelineationState | null>(null);
	let delineationLoaded = $state(false);
	async function loadDelineation() {
		if (!canEdit) return;
		try {
			delineation = await api.delineation.get(projectId);
		} catch {
			// Unavailable is the same as off: the tool isn't offered.
			delineation = null;
		} finally {
			delineationLoaded = true;
		}
	}
	$effect(() => {
		void projectId;
		untrack(loadDelineation);
	});
	const pendingProposal = $derived(openProposal(delineation));
	/** The point placed is a delineation's outlet, not a feature: the draw bar asks to delineate. */
	let delineating = $state(false);
	function startDelineate() {
		dividing = false;
		backToSheet = null;
		measure.cancel();
		tracing = false;
		draft.place('gauge');
		delineating = true;
		void afterStart();
	}
	$effect(() => {
		if (!draft.active) delineating = false;
	});
	/** Where the delineation's point was clicked, kept for the sheet once the draft is gone. */
	let delineateAt = $state<MapPosition | null>(null);
	/** Which step the sheet opens at: asking for a point (from the header's mode), else deciding a waiting proposal (Review it, a link). */
	let delineateStep = $state<'ask' | 'decide'>('decide');
	let delineateWasOpen = false;
	$effect(() => {
		if (!delineateSheet.open) {
			delineateAt = null;
			delineateStep = 'decide';
			if (delineateWasOpen) void untrack(focusAfterDelineate);
		}
		delineateWasOpen = delineateSheet.open;
	});
	/**
	 * The sheet closed. Its opener (the draw bar's Delineate…, the Review it link) is
	 * usually gone by then, so the dialog had nothing to hand focus back to: the
	 * Delineate button takes it, else the map, never <body> (WCAG 2.4.3). A focus
	 * already placed (Accept picks the new feature's card) is left where it is.
	 */
	async function focusAfterDelineate() {
		await tick();
		const at = document.activeElement;
		if (at && at !== document.body) return;
		const btn = document.querySelector<HTMLButtonElement>('[data-testid="map-start-delineate"]');
		if (btn) btn.focus();
		else mapRef?.focusMap();
	}
	async function openDelineate(at: MapPosition | null) {
		delineateAt = at;
		delineateStep = 'ask';
		await goto(withParam(page.url, 'delineate', '1'), { noScroll: true, keepFocus: true });
	}
	/** A proposal came back: the drawing mode ends and the sheet (still open) shows it from the reloaded state. */
	async function proposed() {
		draft.cancel();
		delineateAt = null;
		delineateStep = 'decide';
		await loadDelineation();
	}
	async function delineationAccepted(f: MapFeature, summary: string) {
		notice = `Saved ${summary} on the map.`;
		await Promise.all([load(), loadDelineation()]);
		await pickInPlace(f.id, 'delineate');
		await returnToStart();
	}
	async function delineationRejected() {
		backToSheet = null;
		notice = 'Rejected the delineated catchment; nothing on the map changed.';
		await loadDelineation();
		delineateSheet.open = false;
	}

	// --- start the model from the map (#326 C3): editors, while the model is empty (or just started from it) ---
	let startInfo = $state<StartState | null>(null);
	let startLoaded = $state(false);
	async function loadStart() {
		if (!canEdit) return;
		try {
			startInfo = await api.start.get(projectId);
		} catch {
			// Unavailable: the flow isn't offered; the Network and the per-feature tools still are.
			startInfo = null;
		} finally {
			startLoaded = true;
		}
	}
	$effect(() => {
		void projectId;
		untrack(loadStart);
	});
	const pendingStart = $derived(openStart(startInfo));
	/** The flow is offered while the model is empty. */
	const canStart = $derived(canEdit && !!startInfo?.modelEmpty);
	/** A tool opened from the Start sheet (Delineate, Draw, Place): once it saves, the sheet opens again where it was. */
	let backToSheet: 'start' | 'divide' | null = null;
	async function returnToStart() {
		const sheet = backToSheet;
		if (!sheet) return;
		backToSheet = null;
		await goto(withParam(page.url, sheet, '1'), { noScroll: true, keepFocus: true });
	}
	/**
	 * Leave the sheet for one of the map's own tools (the sheet's param goes first, in place). Every tool
	 * clears the flag as it starts, so it is set after: a tool started any other way, or a rejected
	 * delineation, never brings the sheet back.
	 */
	async function fromStart(start: () => unknown, back = true, sheet: 'start' | 'divide' = 'start') {
		await goto(withoutParam(page.url, sheet), { replaceState: true, noScroll: true, keepFocus: true });
		await start();
		backToSheet = back ? sheet : null;
	}
	/** What the editor chose and ticked in the sheet: kept here, so closing it or leaving for a tool loses nothing. */
	let startDraft = $state<StartDraft>({ picked: {}, outlet: null, pointsAsked: false, ticks: {}, placement: emptyPlacement() });
	async function startApplied() {
		notice = 'Started the model from the map. Its nodes are on the Network now, and each unit’s point and parcel stand for it on the map.';
		await Promise.all([load(), loadStart(), onModelChanged()]);
	}
	async function startDiscarded() {
		notice = 'Discarded the proposed model; nothing in the model changed.';
		await loadStart();
	}

	// --- divide a model that has nodes from the map (#326 C3's follow-up): editors, with a DEM on the server ---
	const pendingDivide = $derived(openDivide(startInfo));
	const canDivide = $derived(canEdit && !!startInfo && !startInfo.modelEmpty && startInfo.elevation);
	let divideDraft = $state<DivideDraft>({ picked: {}, outlet: null, ticks: {}, placement: emptyPlacement() });
	async function divideApplied() {
		notice = 'Divided the model from the map. The ticked areas, order and gauges are in the model, each area saved as its unit’s parcel.';
		await Promise.all([load(), loadStart(), onModelChanged()]);
	}
	async function divideDiscarded() {
		notice = 'Discarded the proposed division; nothing in the model changed.';
		await loadStart();
	}

	// --- each proposed unit's piece told apart (pieces.ts): a card lights its piece, a piece picked on the map opens its card ---
	/** The piece lit on the map (a card has the focus or the pointer, or the pointer is over the piece). */
	let pieceLit = $state<string | null>(null);
	/** The card to bring into view when its sheet opens: a piece clicked on the map. */
	let pieceFocus = $state<string | null>(null);
	// Worked out once per proposal; lighting a piece (a hover) only swaps `highlight` (litPieces), so the map redraws the proposal alone.
	const pieceShapes = $derived(piecesShape(pendingStart ?? pendingDivide));
	const pieces = $derived(litPieces(pieceShapes, pieceLit));

	// --- sub-catchments from clicks: each click on a river an outlet, its incremental catchment drawn numbered by click ---
	const divider = new ClickDivider(
		(clicks) => api.subcatchments.pieces(projectId, clicks),
		(clicks) => api.subcatchments.save(projectId, clicks)
	);
	/** The mode is on: each point placed is an outlet, added at once, and the draw bar gives way to the click bar. */
	let dividing = $state(false);
	/** The page's width: from 56rem (784 px at the 14 px root, the side column's breakpoint) the click panel sits beside the map, else above it. */
	let pageWidth = $state(0);
	const wide = $derived(pageWidth >= 784);
	let clickLit = $state<string | null>(null);
	const clickPieces = $derived(dividing ? clickShape(divider.result, clickLit) : null);
	function startDividing() {
		if (dividing) return void doneDividing();
		backToSheet = null;
		measure.cancel();
		delineating = false;
		tracing = false;
		draft.place('other');
		draft.snapOn = false;
		dividing = true;
		void afterStart();
	}
	// A point placed (a click, Enter at the crosshair) is an outlet straight away; the draft is ready for the next one.
	$effect(() => {
		const g = draft.geometry;
		if (!dividing || draft.mode !== 'place' || g?.type !== 'Point') return;
		untrack(() => {
			draft.place('other');
			draft.snapOn = false;
			void divider.add(g.coordinates);
		});
	});
	// Another tool took the map (Draw, Place, Cancel in a sheet): the mode ends, its clicks kept until it is opened again.
	$effect(() => {
		if (dividing && draft.mode !== 'place') untrack(() => (dividing = false));
	});
	async function doneDividing() {
		if (divider.unsaved) {
			const ok = await confirmDialog({
				title: 'Drop these clicks?',
				message: 'The sub-catchments from your clicks haven’t been saved.',
				confirmLabel: 'Drop them',
				cancelLabel: 'Keep clicking',
				danger: true
			});
			if (!ok) return;
		}
		divider.clear();
		dividing = false;
		clickLit = null;
		draft.cancel();
		await tick();
		document.querySelector<HTMLButtonElement>('[data-testid="map-start-delineate"]')?.focus();
	}
	/** The panel's "One catchment, above a point": leave the clicks (asking first if unsaved) for Delineate's point. */
	async function toOneCatchment() {
		if (divider.unsaved) {
			const ok = await confirmDialog({
				title: 'Drop these clicks?',
				message: 'The sub-catchments from your clicks haven’t been saved.',
				confirmLabel: 'Drop them',
				cancelLabel: 'Keep clicking',
				danger: true
			});
			if (!ok) return;
		}
		divider.clear();
		dividing = false;
		clickLit = null;
		startDelineate();
	}
	async function saveClicks() {
		const r = await divider.save();
		if (!r) return;
		notice = `Saved ${r.summary} on the map as areas. Link each to its unit and Use its area, or rename it on its card.`;
		dividing = false;
		clickLit = null;
		draft.cancel();
		await load();
		if (r.features[0]) await pickInPlace(r.features[0].id);
	}
	async function pickPiece(key: string) {
		pieceFocus = key;
		await goto(withParam(page.url, pendingStart ? 'start' : 'divide', '1'), { noScroll: true, keepFocus: true });
	}
	$effect(() => {
		// A sheet closed: nothing is lit or waiting to be focused.
		if (!startSheet.open && !divideSheet.open) untrack(() => ((pieceLit = null), (pieceFocus = null)));
	});

	// --- drawing (#326 C1, D1): the draft, the draw bar over the map, and the sheets that save it ---
	const draft = new Draft();
	let mapState = $state<'loading' | 'ready' | 'failed'>('loading');
	let drawSaving = $state(false);
	let drawError = $state<string | null>(null);
	let draftSheetOpen = $state(false);
	let pasteOpen = $state(false);
	/** The features the map draws: the one being edited is drawn as the draft instead. */
	const mapFeatures = $derived(draft.mode === 'edit' && draft.feature ? features.filter((f) => f.id !== draft.feature!.id) : features);
	// What a corner can snap to (#326 C2): every feature on the map (the draft leaves out the one being edited).
	// Not while placing a trace's point: snapping would pull a click inside the water onto a shoreline drawn already.
	$effect(() => {
		draft.snapFeatures = tracing ? [] : features;
	});

	async function afterStart() {
		drawError = null;
		await tick();
		// The map takes the keyboard focus, so Enter adds a corner at once; its label says how.
		if (mapState === 'ready') mapRef?.focusMap();
	}
	/** Draw a shape: the boundary when there is none yet (D4), else a parcel, or the choice given. */
	function startDraw(choiceId?: string) {
		backToSheet = null;
		measure.cancel();
		delineating = false;
		tracing = false;
		const id = choiceId ?? (boundary ? 'farm_parcel' : 'catchment_boundary');
		draft.draw(DRAW_CHOICES.find((c) => c.id === id));
		void afterStart();
	}
	function startPlace() {
		backToSheet = null;
		measure.cancel();
		delineating = false;
		tracing = false;
		dividing = false;
		draft.place('gauge');
		void afterStart();
	}
	function startEdit(f: MapFeature) {
		backToSheet = null;
		measure.cancel();
		delineating = false;
		tracing = false;
		if (draft.edit(f)) void afterStart();
	}
	// --- split a polygon along a drawn line (#326 C2): the cut is drawn as a line, the parts previewed, saved together ---
	let splitOpen = $state(false);
	function startSplit(f: MapFeature) {
		measure.cancel();
		delineating = false;
		tracing = false;
		if (draft.split(f)) void afterStart();
	}
	async function splitDone(parts: [MapFeature, MapFeature]) {
		notice = `Split ${featureName(draft.feature ?? parts[0])} in two: ${parts.map((f) => (f.name ? `“${f.name}”` : KIND_LABEL[f.kind].toLowerCase())).join(' and ')}.`;
		splitOpen = false;
		draft.cancel();
		await load();
		await pickInPlace(parts[0].id);
	}

	// --- trace a dam (#326 C2): on when the server has water occurrence data; a point inside the water, then the outline as a drawing ---
	let damTrace = $state<DamTraceState | null>(null);
	let damTraceLoaded = $state(false);
	async function loadDamTrace() {
		if (!canEdit) return;
		try {
			damTrace = await api.map.damTraceState(projectId);
		} catch {
			// Unavailable is the same as off: the tool isn't offered.
			damTrace = null;
		} finally {
			damTraceLoaded = true;
		}
	}
	$effect(() => {
		void projectId;
		untrack(loadDamTrace);
	});
	/** The point placed is inside a dam's water, not a feature: the draw bar asks to trace. */
	let tracing = $state(false);
	let minOccurrence = $state<MinOccurrence>(25);
	function startTrace() {
		measure.cancel();
		delineating = false;
		dividing = false;
		draft.place('dam');
		tracing = true;
		void afterStart();
	}
	$effect(() => {
		if (!draft.active || draft.mode !== 'place') tracing = false;
	});
	/** The server's outline becomes the drawing: a dam, to adjust and save. */
	async function traced(t: DamTraceProposal) {
		traceSheet.open = false;
		tracing = false;
		draft.trace(t.geometry, t);
		mapRef?.frameGeometry(t.geometry);
		// The control that asked (Trace the outline, or the sheet's Trace) is gone: the next step is Save….
		await tick();
		document.querySelector<HTMLElement>('[data-testid="map-draft-save"]')?.focus();
	}
	async function traceAt(at: MapPosition) {
		drawSaving = true;
		drawError = null;
		try {
			await traced(await api.map.traceDam(projectId, { lon: at[0], lat: at[1], minOccurrence }));
		} catch (err) {
			drawError = msg(err);
		} finally {
			drawSaving = false;
		}
	}
	/** Save: a new shape opens its sheet, a new point the Place sheet (with its position); an edit saves at once. */
	async function saveDraft() {
		const g = draft.geometry;
		if (!g) return;
		if (draft.mode === 'draw') {
			draftSheetOpen = true;
			return;
		}
		if (draft.mode === 'split') {
			splitOpen = true;
			return;
		}
		if (draft.mode === 'place' && tracing) {
			if (g.type === 'Point') await traceAt(g.coordinates);
			return;
		}
		if (draft.mode === 'place' && delineating) {
			await openDelineate(g.type === 'Point' ? g.coordinates : null);
			return;
		}
		if (draft.mode === 'place') {
			await goto(withParam(page.url, 'place', '1'), { noScroll: true, keepFocus: true });
			return;
		}
		const f = draft.feature;
		if (!f) return;
		drawSaving = true;
		drawError = null;
		try {
			await api.map.update(projectId, f.id, g.type === 'Point' ? { lon: g.coordinates[0], lat: g.coordinates[1] } : { geometry: g });
			notice = `Saved the new ${g.type === 'Point' ? 'position' : 'shape'} of ${featureName(f)}.`;
			draft.cancel();
			await load();
			await pickInPlace(f.id);
		} catch (err) {
			drawError = msg(err);
		} finally {
			drawSaving = false;
		}
	}
	async function drafted(f: MapFeature) {
		notice = `Saved ${KIND_LABEL[f.kind].toLowerCase()} ${f.name ? `“${f.name}”` : ''} on the map.`;
		draftSheetOpen = false;
		draft.cancel();
		await load();
		await pickInPlace(f.id);
		await returnToStart();
	}
	function pasted(g: MapGeometry) {
		draft.replace(g);
		pasteOpen = false;
		mapRef?.frameGeometry(g);
	}
	function located(at: MapPosition) {
		mapRef?.frameGeometry({ type: 'Point', coordinates: at });
	}

	// --- measure (#326 A7): the drawing mode with a MeasureDraft, nothing saved; anyone may measure ---
	const measure = new MeasureDraft();
	function startMeasure() {
		if (measure.active) return endMeasure();
		draft.cancel();
		measure.start();
		void afterStart();
	}
	function endMeasure() {
		measure.cancel();
		if (mapState === 'ready') mapRef?.focusMap();
	}
	/** What the map is drawing with: the measurement, else the editor's draft. */
	const mapDraft = $derived(measure.active ? measure : canEdit ? draft : null);

	// --- Download GeoJSON (#326 A7): the loaded features as a file, built here (no route) ---
	function downloadGeoJson() {
		const name = exportFileName(projectName, localIsoDate());
		saveBlob(new Blob([geoJsonText(features)], { type: 'application/geo+json' }), name);
		notice = `Downloaded ${features.length} ${features.length === 1 ? 'feature' : 'features'} as ${name}.`;
	}

	// --- layers (#326 A6): the quaternary outlines, on while `layers=quaternaries` ---
	const quaternaries = new QuaternaryLayer({
		projectId: () => projectId,
		on: () => layersOn(params).has('quaternaries'),
		features: () => features,
		load: api.map.quaternaries
	});

	// --- the river network (#345): its reaches around the catchment, on while `layers=rivers` ---
	/** The map's view, for the River network layer while the project has no features. */
	let mapView = $state<[number, number, number, number] | null>(null);
	const rivers = new RiverLayer({
		projectId: () => projectId,
		on: () => layersOn(params).has('rivers'),
		features: () => features,
		view: () => mapView,
		load: api.map.rivers,
		add: api.map.addRiver
	});
	/** A reach clicked on the map: picked, and its facts and Add brought into view (as a feature pick shows its card). */
	async function reachFromMap(key: string) {
		rivers.picked = key;
		rivers.addError = null;
		await tick();
		document.querySelector('[data-testid="map-reach-picked"]')?.scrollIntoView({ block: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
	}
	async function riverAdded(f: MapFeature) {
		notice = `Added “${f.name}” to the map as a river, from the river network.`;
		await load();
	}

	// --- the elevation model's channels (issue #374): drawn while Delineate or Sub-catchments is on, where a click goes ---
	const channels = new ChannelLayer({
		projectId: () => projectId,
		on: () => canEdit && !!delineation?.available && (delineating || dividing),
		view: () => mapView,
		load: api.delineation.channels
	});

	// --- the relief: the land shaded from the DEM, on while `layers=relief` (and a DEM is configured) ---
	const relief = $derived(!!terrainUrl && layersOn(params).has('relief'));
	let reliefFailed = $state(false);

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

	let mapRef = $state<{ showAll: () => void; frameGeometry: (g: MapGeometry) => void; focusMap: () => void }>();

	// --- the key: the map's own colours (mapStyle.ts), in the app's theme, following it when it changes ---
	let dark = $state(appIsDark());
	$effect(() => watchAppTheme(() => (dark = appIsDark())));
	const key = $derived(keyGroups(overlayColours(dark), { riverNetwork: layersOn(params).has('rivers') ? riverNetworkColour(dark) : null }));

	// --- results on the map (#326 A1): the measure and run from the URL, each unit's and gauge's figure, the fills ---
	const results = new MapResults({
		projectId: () => projectId,
		runs: () => runs,
		role: () => role,
		nodes: () => editor.model.nodes,
		features: () => features,
		params: () => params,
		dark: () => dark
	});

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

{#snippet divideLink()}
	<a class="btn btn-sm" href={withParam(page.url, 'divide', '1')} title="Each unit’s own area and order, proposed from its point on the map" data-testid="map-divide-open">Divide the model</a>
{/snippet}
{#snippet headerContext()}<span data-testid="map-summary">{data ? headerLine(features, nodes) : 'Loading the map…'}</span>{/snippet}
{#snippet headerActions()}
	{#if mapState !== 'failed'}
		<button type="button" class="btn" onclick={startMeasure} aria-pressed={measure.active} disabled={draft.active} data-testid="map-start-measure">Measure</button>
	{/if}
	{#if canEdit}
		<button type="button" class="btn" onclick={() => startDraw()} aria-pressed={draft.mode === 'draw'} data-testid="map-start-draw">Draw a shape</button>
		<button type="button" class="btn" onclick={startPlace} aria-pressed={draft.mode === 'place' && !delineating && !tracing} data-testid="map-start-place">Place a point</button>
		{#if delineation?.available}
			<button type="button" class="btn" onclick={() => (dividing ? doneDividing() : startDelineate())} aria-pressed={delineating || dividing} data-testid="map-start-delineate">Delineate</button>
		{/if}
		{#if damTrace?.available}
			<button type="button" class="btn" onclick={startTrace} aria-pressed={tracing} data-testid="map-start-trace">Trace a dam</button>
		{/if}
		<a class="btn" href={withParam(page.url, 'upload', '1')} data-testid="map-open-upload">Upload GeoJSON</a>
		{#if canStart}
			<a class="btn" href={withParam(page.url, 'start', '1')} data-testid="map-start-open">{pendingStart ? 'Review the proposed model' : 'Start from the map'}</a>
		{/if}
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

<!-- The picked feature's figure from the run the map shows (#326 A1): the measure's, or a gauge's EWR, in words with its band. -->
{#snippet resultFacts(f: MapFeature)}
	{@const r = results.ready ? featureResult(f, results.unitBy, results.ewrBy) : null}
	{#if r}
		<dt>{r.measure === 'ewr' ? 'EWR' : viewLabel(results.view)}</dt>
		<dd data-testid="map-card-result" data-band={r.band}>{r.label} · {BAND_WORD[r.band].toLowerCase()}</dd>
		{#if r.measure !== 'ewr' && results.ewrBy.get(f.nodeId ?? '')}
			{@const e = results.ewrBy.get(f.nodeId ?? '')!}
			<dt>EWR</dt>
			<dd data-testid="map-card-ewr" data-band={e.band}>{e.label} · {BAND_WORD[e.band].toLowerCase()}</dd>
		{/if}
	{/if}
{/snippet}

<!-- The unit's area, typed or from the map (E6), in words. -->
{#snippet unitArea(f: MapFeature)}
	{@const s = areaSourceOf(f, nodes)}
	{#if s}
		{s.node.name}: {fmtNum(s.node.areaKm2, 3)} km² ·
		{#if s.source === 'this'}<span class="badge">From the map</span> this {KIND_LABEL[f.kind].toLowerCase()}{#if s.earlier}’s earlier outline{/if}
		{:else if s.source === 'other'}
			{@const other = s.node.areaFeatureId ? featureById.get(s.node.areaFeatureId) : undefined}
			<span class="badge">From the map</span> {other ? `“${featureName(other)}”` : 'a feature since deleted'}
		{:else}typed{/if}
	{/if}
{/snippet}

<div class="map-page" data-ready={data ? 'true' : undefined} bind:clientWidth={pageWidth}>
	{#if notice}
		<p class="alert alert-info slim" role="status" data-testid="map-notice">
			{notice}
			<button type="button" class="btn btn-sm btn-ghost" onclick={() => (notice = null)}>Dismiss</button>
		</p>
	{/if}
	{#if pendingProposal && canEdit && !delineateSheet.open}
		<p class="alert alert-info slim" data-testid="map-delineation-pending">
			A delineated catchment ({fmtNum(pendingProposal.areaM2 / 1e6, 2)} km²) is drawn dashed on the map, waiting for your decision.
			<a class="btn btn-sm" href={withParam(page.url, 'delineate', '1')}>Review it</a>
		</p>
	{/if}
	{#if (pendingStart || pendingDivide) && canEdit && !startSheet.open && !divideSheet.open}
		<!-- An open start or division is drawn piece by piece: say so in words, and how to read it (the sheet's cards are its key). -->
		<p class="alert alert-info slim" data-testid="map-pieces-pending">
			{pendingStart ? 'A proposed model' : 'A proposed division of the model'} is drawn on the map piece by piece, each piece tinted and numbered as its card in the sheet (R: the rest of the catchment), waiting for your decision.
			<a class="btn btn-sm" href={withParam(page.url, pendingStart ? 'start' : 'divide', '1')} data-testid="map-pieces-review">Review it</a>
		</p>
	{/if}
	{#if canEdit && !tilesUrl}
		<p class="alert alert-info slim" data-testid="map-no-tiles">No basemap is configured, so the features are drawn on a plain background (docs/maps.md says how to serve one).</p>
	{/if}
	{#if data && features.length && !boundary}
		<p class="alert alert-info slim" data-testid="map-no-boundary">
			No catchment boundary yet.{canEdit ? ' Draw it on the map, or upload it as a GeoJSON file (WGS84).' : ''}
			{#if canEdit && draft.mode !== 'draw'}<button type="button" class="btn btn-sm" onclick={() => startDraw('catchment_boundary')}>Draw the boundary</button>{/if}
		</p>
	{/if}
	<!-- The rain feed from the boundary (#326 B-rain): a line when no CHIRPS feed reads it yet. -->
	{#if data && boundary && canEdit}<MapRainLink {projectId} {boundary} />{/if}

	<LoadState {loading} {error} retry={load}>
		{#if data}
			<div class="map-layout" class:empty={!features.length} bind:this={layoutEl} style:--layout-top="{layoutTop}px">
				<section class="panel map-card" aria-label="Map">
					{#if measure.active}
						<MeasureBar {measure} ondone={endMeasure} />
					{/if}
					{#if canEdit && dividing && !wide}
						<ClickBar {divider} pieces={clickPieces?.pieces ?? []} placement="above" mapReady={mapState === 'ready'} ondone={doneDividing} onsave={saveClicks} onlit={(k) => (clickLit = k)} onone={toOneCatchment} />
					{:else if canEdit && draft.active && !dividing}
						<DrawBar
							{draft}
							mapReady={mapState === 'ready'}
							saving={drawSaving}
							error={drawError}
							onsave={saveDraft}
							onpaste={() => (pasteOpen = true)}
							oncoords={() =>
								tracing ? goto(withParam(page.url, 'trace', '1'), { noScroll: true, keepFocus: true }) : delineating ? openDelineate(draft.coords[0] ?? null) : goto(withParam(page.url, 'place', '1'), { noScroll: true, keepFocus: true })}
							onlocated={located}
							{delineating}
							{tracing}
							onsubcatchments={startDividing}
							bind:minOccurrence
						/>
					{/if}
					<div class="map-body" data-channel-tiles={channels.on ? channels.tileCount : undefined}>
						{#if features.length && mapState === 'ready'}
							<!-- On the map, not the header: the map's own view action, and the header keeps one row at 1440. -->
							<button type="button" class="btn btn-sm map-fit" onclick={() => mapRef?.showAll()} data-testid="map-show-everything">Show everything</button>
						{/if}
						{#if dividing && divider.busy === 'pieces'}
							<p class="map-pill small" aria-hidden="true" data-testid="map-click-busy">Working out the sub-catchments…</p>
						{:else if channels.on && (channels.noView || channels.zoomIn || channels.error || channels.loading)}
							<!-- Only what needs saying: the bars already say the red lines are where a click goes. -->
							<p class="map-pill channel-note small" role="status" data-testid="map-channels-note">
								<span class="swatch" aria-hidden="true" style:background={channelColour(dark)}></span>
								{#if channels.noView}
									The elevation model’s channels are drawn on the map, which isn’t showing here.
								{:else if channels.zoomIn}
									Zoom in to see the elevation model’s channels.
								{:else if channels.error}
									<span class="err">The elevation model’s channels couldn’t be drawn: {channels.error}</span>
								{:else}
									Drawing the elevation model’s channels…
								{/if}
							</p>
						{/if}
						<Lazy load={loadMap}>
							{#snippet children(CatchmentMap)}
								<CatchmentMap
									bind:this={mapRef}
									features={mapFeatures}
									{selectedId}
									onselect={select}
									{tilesUrl}
									label="Map of the catchment"
									fills={results.fills}
									fill
									draft={mapDraft}
									{glyphs}
									quaternaries={quaternaries.outlines}
									pickedQuaternary={quaternaries.picked}
									onquaternary={(code) => (quaternaries.picked = code)}
									rivers={rivers.reaches}
									channels={channels.lines}
									riversCredit={rivers.credited}
									pickedReach={rivers.picked}
									onreach={reachFromMap}
									{terrainUrl}
									{relief}
									onreliefError={() => (reliefFailed = true)}
									onstatus={(s) => (mapState = s)}
									onview={(b) => (mapView = b)}
									proposal={clickPieces ?? pendingProposal ?? pieces}
									onpiecehover={(k) => (dividing ? (clickLit = k) : (pieceLit = k))}
									onpiecepick={canEdit && !dividing ? pickPiece : undefined}
								/>
							{/snippet}
						</Lazy>
					</div>
					<!-- The key row: what the areas are coloured by, which run, and the key (#326 E7, A1). -->
					<!-- Divide the model (#326 C3's follow-up) at the end of the key row's first line: not in the header (a second row of actions)
					     nor the side column (the list's room); its title says what it does. -->
					<MapKeyRow {results} {key} {features} {canEdit} {dark} end={canDivide && !pendingDivide ? divideLink : undefined} />
				</section>

				<aside class="map-side" aria-label="Features">
					{#if canEdit && dividing && wide}
						<!-- Beside the map: the clicks' key in the picked feature's place, so the map keeps its height. -->
						<div class="panel side-box card click-panel">
							<ClickBar {divider} pieces={clickPieces?.pieces ?? []} placement="side" mapReady={mapState === 'ready'} ondone={doneDividing} onsave={saveClicks} onlit={(k) => (clickLit = k)} onone={toOneCatchment} />
						</div>
					{:else}
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
								{@render resultFacts(picked)}
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
							{#if canEdit}
								<div class="card-actions">
									{#if editableCorners(picked.geometry) && !(draft.mode === 'edit' && draft.feature?.id === picked.id)}
										{@const target = picked}
										<button type="button" class="btn btn-sm" onclick={() => startEdit(target)} data-testid="map-edit-shape">
											{picked.geometry.type === 'Point' ? 'Move the point' : 'Edit the shape'}
										</button>
									{/if}
									{#if editableCorners(picked.geometry)?.shape === 'polygon' && draft.mode !== 'split'}
										{@const target = picked}
										<button type="button" class="btn btn-sm" onclick={() => startSplit(target)} data-testid="map-split-shape">Split along a line</button>
									{/if}
									{@render deleteButton(picked)}
								</div>
							{/if}
						{:else if features.length}
							<p class="muted small pick-hint">Select a feature on the map or in the list to see it here.</p>
						{:else}
							<!-- The empty state leads with drawing (#326 D4); uploading a file is the other way in. -->
							<div class="pick-hint" data-testid="map-no-boundary">
								<p class="empty-line">
									Nothing on the map yet.{canEdit && delineationLoaded
										? delineation?.available
											? ' Start with the catchment: delineate it from its outlet on the river, or draw its boundary.'
											: ' Start with the catchment boundary: draw it on the map.'
										: ''}
								</p>
								{#if canEdit && delineationLoaded}
									<p class="empty-line ways">
										{#if delineation?.available}
											<button type="button" class="btn btn-primary" onclick={startDelineate} data-testid="map-empty-delineate">Delineate from the outlet</button>
										{/if}
										<button type="button" class={delineation?.available ? 'btn' : 'btn btn-primary'} onclick={() => startDraw('catchment_boundary')} data-testid="map-draw-boundary">Draw the boundary</button>
									</p>
									<p class="empty-line small muted">Or <a href={withParam(page.url, 'upload', '1')}>upload it as a GeoJSON file</a> (WGS84), or place a point.</p>
									{#if canStart}
										<p class="empty-line small">
											<a href={withParam(page.url, 'start', '1')} data-testid="map-empty-start">Start the model from the map</a>: the boundary, then your dams and abstraction points, and the app proposes the units, their areas and their order.
										</p>
									{/if}
								{/if}
							</div>
						{/if}
					</section>
					{/if}

					{#if features.length}
						<section class="panel side-box list-box" aria-labelledby="{uid}-list-h">
							<div class="list-head">
								<h2 class="list-h" id="{uid}-list-h">Features</h2>
								<span class="list-actions">
									<button type="button" class="btn btn-sm" onclick={downloadGeoJson} data-testid="map-download-geojson">Download GeoJSON</button>
									<a class="btn btn-sm" href={withParam(page.url, 'grid', GRID_ID)} data-testid="map-open-grid">Every feature</a>
								</span>
							</div>
							<FeatureList {features} {nodes} {selectedId} onselect={selectFromList} labelledby="{uid}-list-h" />
						</section>
					{/if}

					<!-- The optional layers (#326 A6): the quaternary outlines, their codes listed; the river network (#345), its reaches listed; the relief when a DEM is configured. -->
					<div class="panel side-box layers-box">
						<MapLayers
							{quaternaries}
							{rivers}
							{dark}
							{canEdit}
							onriveradded={riverAdded}
							onshowfeature={(id) => void selectFromList(id)}
							relief={terrainUrl ? { on: relief, failed: reliefFailed } : null}
						/>
					</div>

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
				<Lazy load={loadUploadSheet}>
					{#snippet children(UploadSheet)}
						<UploadSheet bind:open={upload.open} {projectId} sources={data!.sources} onimported={imported} />
					{/snippet}
				</Lazy>
			{/if}
			{#if checksSheet.open}
				<Dialog bind:open={checksSheet.open} title="Map checks" side>
					<MapChecks {features} {nodes} onpick={pickFromCheck} heading={false} />
					{#snippet actions()}
						<button type="button" class="btn" onclick={() => (checksSheet.open = false)}>Close</button>
					{/snippet}
				</Dialog>
			{/if}
			{#if delineateSheet.open && delineation}
				<DelineateSheet
					bind:open={delineateSheet.open}
					{projectId}
					info={delineation}
					at={delineateAt}
					step={delineateStep}
					{boundary}
					onproposed={proposed}
					onaccepted={delineationAccepted}
					onrejected={delineationRejected}
				/>
			{/if}
			{#if startSheet.open && startInfo}
				<Lazy load={loadStartSheet}>
					{#snippet children(StartSheet)}
				<StartSheet
					bind:open={startSheet.open}
					{projectId}
					{features}
					info={startInfo!}
					bind:draft={startDraft}
					onupload={() => fromStart(() => goto(withParam(page.url, 'upload', '1'), { noScroll: true, keepFocus: true }), false)}
					ondelineate={delineation?.available ? () => fromStart(startDelineate) : null}
					ondraw={() => fromStart(() => startDraw('catchment_boundary'))}
					onplace={() => fromStart(startPlace)}
					onproposed={loadStart}
					onapplied={startApplied}
					ondiscarded={startDiscarded}
					onhighlight={(k) => (pieceLit = k)}
					focusKey={pieceFocus}
				/>
					{/snippet}
				</Lazy>
			{/if}
			{#if divideSheet.open && startInfo}
				<DivideSheet
					bind:open={divideSheet.open}
					{projectId}
					{features}
					nodes={editor.model.nodes}
					info={startInfo!}
					bind:draft={divideDraft}
					onplace={() => fromStart(startPlace, true, 'divide')}
					onproposed={loadStart}
					onapplied={divideApplied}
					ondiscarded={divideDiscarded}
					onhighlight={(k) => (pieceLit = k)}
					focusKey={pieceFocus}
				/>
			{/if}
			{#if place.open}
				<PlaceSheet
					bind:open={place.open}
					{projectId}
					{nodes}
					at={draft.mode === 'place' ? (draft.coords[0] ?? null) : null}
					kind={draft.mode === 'place' ? draft.kind : 'gauge'}
					onplaced={placed}
				/>
			{/if}
			{#if draftSheetOpen && draft.geometry}
				<DraftSheet
					bind:open={draftSheetOpen}
					{projectId}
					{nodes}
					geometry={draft.geometry}
					kind={draft.kind}
					hasBoundary={!!boundary}
					traced={draft.traced ? { lon: draft.traced.click[0], lat: draft.traced.click[1], minOccurrence: draft.traced.minOccurrence, edited: draft.tracedEdited } : null}
					onsaved={drafted}
				/>
			{/if}
			{#if splitOpen && draft.mode === 'split' && draft.feature && draft.splitResult && 'parts' in draft.splitResult}
				<SplitSheet bind:open={splitOpen} {projectId} feature={draft.feature} parts={draft.splitResult.parts} onsaved={splitDone} />
			{/if}
			{#if traceSheet.open && damTrace}
				<TraceSheet bind:open={traceSheet.open} {projectId} info={damTrace} at={draft.mode === 'place' ? (draft.coords[0] ?? null) : null} bind:minOccurrence ontraced={traced} />
			{/if}
			{#if pasteOpen && draft.active}
				<PasteSheet bind:open={pasteOpen} shape={draft.shape} onpasted={pasted} />
			{/if}
			{#if grid.open}
				<Dialog bind:open={grid.open} title={TAB_GRIDS[GRID_ID].title} full>
					<div class="grid-body" data-testid="map-grid">
						{#if features.length}
							<p class="muted small grid-note">
									Areas are computed on the server from each polygon (geodesic, WGS84).
									{#if results.ready}Result and Band: {viewLabel(results.view).toLowerCase()} for what each area stands for, and the EWR at gauges, from the run the map shows.{/if}
								</p>
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
											{#if results.ready}<th scope="col">Result</th><th scope="col">Band</th>{/if}
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
												{#if results.ready}
													{@const r = featureResult(f, results.unitBy, results.ewrBy)}
													<td data-testid="map-grid-result"><span class="cell-label" aria-hidden="true">Result{' '}</span>{#if r}{r.label}{:else}<span class="muted">–</span>{/if}</td>
													<td data-testid="map-grid-band" data-band={r?.band}><span class="cell-label" aria-hidden="true">Band{' '}</span>{#if r}{BAND_WORD[r.band]}{:else}<span class="muted">–</span>{/if}</td>
												{/if}
												{#if canEdit}
													<td class="area-cell"><span class="cell-label" aria-hidden="true">Area into the model </span>{@render areaInto(f)}</td>
													<td class="row-actions">{@render deleteButton(f)}</td>
												{/if}
											</tr>
											{#if rowError?.id === f.id}
												<tr><td colspan={(canEdit ? 7 : 5) + (results.ready ? 2 : 0)}><p class="err" role="alert">{rowError.text}</p></td></tr>
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
	/* Stacked with nothing on the map, the empty state's ways in (Delineate, Draw, Start) come before the blank map. */
	.map-layout.empty .map-side {
		order: -1;
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
	.map-fit {
		position: absolute;
		z-index: 2;
		left: 0.6rem;
		bottom: 0.6rem;
		box-shadow: var(--shadow-sm, none);
	}
	/* Over the map's top middle (the picked name is top-left, the zoom top-right): the channels' key and status, or the busy line. */
	.map-pill {
		position: absolute;
		z-index: 2;
		top: 0.5rem;
		left: 50%;
		transform: translateX(-50%);
		max-width: min(30rem, calc(100% - 6rem));
		margin: 0;
		padding: 0.25rem 0.7rem;
		border-radius: 1rem;
		background: var(--surface);
		border: 1px solid var(--border-strong);
		box-shadow: var(--shadow-sm, none);
		pointer-events: none;
	}
	.list-actions {
		display: inline-flex;
		flex: none;
		gap: 0.4rem;
		white-space: nowrap;
	}
	.channel-note {
		display: flex;
		gap: 0.45rem;
		align-items: center;
		margin: 0;
		color: var(--text-muted);
	}
	.channel-note .swatch {
		flex: none;
		width: 1.25rem;
		height: 3px;
		border-radius: 2px;
	}
	.channel-note .err {
		color: var(--danger);
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
		/* Beside the map, the side column keeps its place. */
		.map-layout.empty .map-side {
			order: 0;
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
			/* The picked feature's card scrolls in its box and gives way with the layers (each in proportion to
			   its size) so the column always fits: the list keeps its 8rem and the checks line its height. As
			   `flex: none` (before 2026-10-02) a full card held its 55% and pushed the column past a 1280×800
			   window once a reach was picked too (map-layers.spec.ts › the side column still fits). */
			.card {
				flex: 0 1 auto;
				min-height: 0;
				max-height: 55%;
				overflow-y: auto;
			}
			/* A picked feature's card keeps room for its heading and first facts (the hint alone is shorter). */
			.card:has(:global(.card-h)) {
				min-height: 6rem;
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
			/* The layers (a river network's reaches can run long) scroll in their own box and give way before the list does. */
			.layers-box {
				flex: 0 1 auto;
				min-height: 2.75rem;
				max-height: 35%;
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
		flex-wrap: wrap;
		gap: 0.4rem;
		justify-content: flex-end;
	}
	.empty-line {
		margin: 0 0 0.5rem;
	}
	.ways {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
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
