<script lang="ts">
	import { confirmDialog } from '$lib/components/common/confirm.svelte';
	import { onMount, tick, untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import { base } from '$app/paths';
	import { page } from '$app/state';
	import { flowShares, type NodeKind, type ProjectSettings, type RunSummary } from '@water-management/engine';
	import { api, type RunMeta } from '$lib/api';
	import { cachedSeries, detailCache } from '$lib/components/runs/cache';
	import { damEndPctFromSummary, damInRun, type DamEnd, damLevel, damLevelsFromSummary, damsInRun, loadDamLevels, type DamLevel } from '$lib/components/overview/damLevels';
	import { historyEnd } from '$lib/components/overview/latestRun';
	import { farmPlanting } from '$lib/components/crops/farmDrawer';
	import { fmtDate } from '$lib/format/number';
	import { ranAgo, supplyByNode } from './supplyColour';
	import { damColouring, supplyColouring, type ColourMode, type Colouring } from './farmColour';
	import FlowUnitSelect from './FlowUnitSelect.svelte';
	import NumberInput from '$lib/components/common/NumberInput.svelte';
	import HelpTip from '$lib/components/help/HelpTip.svelte';
	import MoveControls from '$lib/components/model/MoveControls.svelte';
	import { refocusMover, RowReorder } from '$lib/components/model/rowReorder.svelte';
	import { fmtNum, fmtPct } from '$lib/format/number';
	import type { ModelEditor } from '$lib/model/editor.svelte';
	import { findSystem, systemLabel, unitEfficiency } from '$lib/model/systems';
	import { divertMonthsCell } from './supply';
	import { cardLabel, fieldScale, fieldUnused, GROUPS, hasDam, isPct, isVolume, KIND_WORD, NODE_FIELDS, returnFlowHint, setNodeField, TABLE_FIELDS, type NodeField } from './fields';
	import { nodeSections, SECTION_SHORT, sectionId, type NodeSection } from './nodeSections';
	import { keepInView } from './scroll';
	import NetworkSchematic from './NetworkSchematic.svelte';
	import Dialog from '$lib/components/common/Dialog.svelte';
	import ModelSaveRow from '$lib/components/model/ModelSaveRow.svelte';
	import NodeCard from './NodeCard.svelte';
	import NodeDetail from './NodeDetail.svelte';
	import { withParam, withoutParam, type GridId } from '$lib/workspace/overlays';
	import { mapNodeHref } from '$lib/workspace/mapLinks';
	import { MappedNodes } from '$lib/workspace/mappedNodes.svelte';
	import NotesDrawer from '$lib/components/notes/NotesDrawer.svelte';
	import UserFields from './UserFields.svelte';
	import GridPasteDialog from '$lib/components/model/GridPasteDialog.svelte';
	import { applyNodePaste, nodeTableCsv, planNodePaste } from './nodePaste';
	import { gridPasteTarget, type PasteAnchor, type PastePlan } from '$lib/spreadsheet/paste/grid';
	import { describeUser } from './users';
	import { flowPathOrder, makeOutlet, moveTo, renumber } from './reorder';
	import { countByNode, linkedNote, removeMessage } from './farmerLinks';
	import Lazy from '$lib/components/common/Lazy.svelte';
	import { fillHeader } from '$lib/components/workspace/headerSlot.svelte';

	// The Yield panel (WP-3.6) and its chart load only when a farm is focused.
	const loadYield = () => import('$lib/components/yield/YieldPanel.svelte');

	let {
		editor,
		settings,
		readonly,
		projectId = '',
		runs = null,
		only,
		onsave,
		reason = $bindable('')
	}: {
		editor: ModelEditor;
		settings?: ProjectSettings;
		readonly: boolean;
		projectId?: string;
		/** The project's runs, newest first (null = not loaded). Enables "Colour farms by". */
		runs?: RunMeta[] | null;
		/** `table`: the node table alone, as the grid modal shows it (model/GridModal.svelte). */
		only?: 'table';
		/** The page's model save, for the node sheet's save row (the sheet hides the save bar). */
		onsave?: () => void;
		/** The save bar's reason, shared with the sheet's save row. */
		reason?: string;
	} = $props();

	const nodes = $derived(editor.model.nodes);
	/** Each crop a unit plants, on its irrigation system (engine ≥ 1.72.0): "Citrus on Drip, 90 %; Pasture on Flood / furrow, 70 %". */
	function plantingSystemsLine(nodeId: string): string | null {
		const rows = editor.model.cropAreas.filter((a) => a.nodeId === nodeId && a.areaM2 > 0);
		if (!rows.length) return null;
		return rows
			.map((a) => {
				const crop = editor.model.crops.find((c) => c.id === a.cropId);
				const s = findSystem(editor.model, a.irrigationSystemId ?? crop?.irrigationSystemId ?? null);
				return `${crop?.name || 'unnamed crop'} on ${s ? systemLabel(s) : "the unit's own efficiency"}`;
			})
			.join('; ');
	}
	const outletCount = $derived(nodes.filter((n) => n.downstreamNodeId === null).length);
	const farms = $derived(nodes.filter((n) => n.kind === 'farm'));
	const users = $derived(nodes.filter((n) => n.kind === 'user'));
	const gauges = $derived(nodes.filter((n) => n.kind === 'gauge'));
	const method = $derived(settings?.flowShareMethod ?? 'area');
	const shares = $derived(flowShares(nodes, method, settings?.hiLoSplit ?? { hi: 0.5, lo: 0.5 }));
	const shareOf = (i: number) => (nodes[i]?.kind === 'farm' ? (shares.share[i] ?? 0) : null);
	const METHOD_LABEL = { area: 'by area', hiLo: 'high/low MAP split', manual: 'manual shares' } as const;

	// --- colour farms by (view option, component state): the latest run's supply, how full each dam
	// ended it, or the irrigated area as edited (farmColour.ts). Supply by default once there's a run. ---
	// On by default once there is a run (the map answers "who is short?" first, issue #17).
	let colourBy = $state<'none' | ColourMode>(untrack(() => (runs?.length ? 'supply' : 'none')));
	const latestRun = $derived(runs?.[0] ?? null);
	let supplyRun = $state<{ id: string; summary: RunSummary } | null>(null);
	let supplyLoading = $state(false);
	let supplyError = $state(false);
	let supplyFor = '';

	async function loadSupply(id: string) {
		supplyFor = id;
		const hit = detailCache.get(id);
		if (hit) {
			supplyRun = { id, summary: hit.run.summary };
			return;
		}
		supplyLoading = true;
		supplyError = false;
		try {
			const d = await api.runs.get(projectId, id);
			detailCache.set(id, d);
			if (supplyFor === id) supplyRun = { id, summary: d.run.summary };
		} catch {
			if (supplyFor === id) supplyError = true;
		} finally {
			if (supplyFor === id) supplyLoading = false;
		}
	}

	// Fetch when colouring is switched on or a newer run lands; only then, so
	// a failed load doesn't retry itself (the status line offers a retry).
	$effect(() => {
		// The Map layout's node card shows a farm's supply too; dam levels need the run's series list.
		const id = colourBy === 'supply' || colourBy === 'dam' || view === 'map' ? latestRun?.id : undefined;
		untrack(() => {
			if (id && id !== supplyFor) void loadSupply(id);
		});
	});

	// Dam levels at the end of the latest run, only while "Dam level" is picked: from the run
	// summary, or for a run older than engine 1.2.0 every dam's storage series
	// (overview/damLevels.ts, as the Summary's panel).
	let damLevels = $state.raw<{ runId: string; levels: DamLevel[] } | null>(null);
	let damLoading = $state<{ done: number; of: number } | null>(null);
	let damError = $state(false);
	let damAttempt = $state(0);
	$effect(() => {
		const run = colourBy === 'dam' && latestRun && supplyRun?.id === latestRun.id ? latestRun.id : null;
		void damAttempt;
		untrack(() => {
			if (!run || damLevels?.runId === run) return;
			const detail = detailCache.get(run);
			const refs = detail?.series ?? [];
			// The run's own capacities and minimum levels (a fraction in the model, a % here), as the Summary's.
			const dams = damsInRun(detail?.run.model?.nodes, nodes, refs);
			// A run from engine ≥ 1.2.0 carries the figures in its summary (issue #55): no series to fetch.
			// A forecast run's figures are its record's: dated the day before the forecast (issue #51).
			const fromSummary = supplyRun && latestRun ? damLevelsFromSummary(dams, supplyRun.summary.farms, historyEnd(latestRun)) : null;
			if (fromSummary) {
				damError = false;
				damLevels = { runId: run, levels: fromSummary };
				return;
			}
			damError = false;
			damLoading = { done: 0, of: dams.length };
			loadDamLevels(
				dams,
				(nodeId) => cachedSeries(run, 'dam_storage', nodeId, () => api.runs.series(projectId, run, 'dam_storage', nodeId)),
				4,
				(n) => {
					if (damLoading) damLoading = { done: n, of: dams.length };
				},
				latestRun?.forecastFrom ?? null
			)
				.then((levels) => {
					if (latestRun?.id === run) damLevels = { runId: run, levels };
				})
				.catch(() => {
					if (latestRun?.id === run) damError = true;
				})
				.finally(() => {
					damLoading = null;
				});
		});
	});

	const colouring = $derived.by((): Colouring | null => {
		if (colourBy === 'none' || !farms.length) return null;
		if (!latestRun || supplyRun?.id !== latestRun.id) return null;
		const run = { name: latestRun.label || fmtDate(latestRun.createdAt, true), ago: ranAgo(latestRun.createdAt) };
		if (colourBy === 'supply') return supplyColouring(nodes, supplyRun.summary, run, editor.dirty);
		return damLevels?.runId === latestRun.id ? damColouring(nodes, damLevels.levels, run, editor.dirty) : null;
	});

	// The Network is one page, the map (issue #17, option A · A2): the node
	// table opens as a grid (the Tables menu, `grid=nodes`, this component with
	// `only="table"`) and a node's full form in a sheet over the map
	// (`edit=<nodeId>`). `view` is 'table' only inside the grid modal.
	type View = 'map' | 'table';
	const view = $derived<View>(only === 'table' ? 'table' : 'map');
	// Old links: `view=table` opens the node table, `view=node` a node's form.
	$effect(() => {
		if (only) return;
		const v = page.url.searchParams.get('view');
		if (!v) return;
		untrack(() => {
			const q = new URLSearchParams(page.url.search);
			q.delete('view');
			if (v === 'table') q.set('grid', 'nodes');
			else if (v === 'node' && nodes[0]) q.set('edit', q.get('node') ?? nodes[0].id);
			void goto(`?${q}`, { replaceState: true, noScroll: true, keepFocus: true });
		});
	});

	// --- the node sheet: a node's full form over the map, while the URL names it (`edit=<id>`) ---
	const editParam = $derived(only ? null : page.url.searchParams.get('edit'));
	const editing = $derived(editParam ? (nodes.find((n) => n.id === editParam) ?? null) : null);
	const editIndex = $derived(editing ? nodes.indexOf(editing) : -1);
	let sheetOpen = $state(false);
	$effect(() => {
		sheetOpen = !!editing;
	});
	$effect(() => {
		// Closed (Done, Esc, the ✕): drop `edit` in place, so Back goes to where it was opened from.
		if (!sheetOpen && untrack(() => editParam)) void goto(withoutParam(page.url, 'edit'), { replaceState: true, noScroll: true, keepFocus: true });
	});
	$effect(() => {
		if (editing) untrack(() => (selectedId = editing.id));
	});
	/** Opens a node's form; `replace` switches the open sheet to another node (‹ ›, the picker). */
	function openEdit(id: string, replace = false) {
		// The node edited is the one picked (node=), so closing the sheet leaves the map on it.
		const q = new URLSearchParams(page.url.search);
		q.set('edit', id);
		if (!only) q.set('node', id);
		return goto(`?${q}`, { replaceState: replace, noScroll: true, keepFocus: true });
	}
	// Which nodes have a map feature, for their "Show on map" links (issue #326 A2): fetched after the
	// tab has drawn, so the map's list never delays it (workspace/mapLinks.ts).
	const mapped = new MappedNodes(() => projectId, api.map.linkedNodes);
	onMount(() => loadFarmers());
	// After the first paint, and again if the workspace switches project under this tab; the grid modal's node table has no card to link from.
	$effect(() => {
		void projectId;
		if (only !== 'table') void untrack(() => mapped.load());
	});

	// Farmers linked to each farm (WP-2.1), for the detail note and the delete
	// warning. null = not loaded (or failed): removing a farm then warns anyway.
	let farmerCount = $state<Record<string, number> | null>(null);
	async function loadFarmers() {
		if (!projectId) return;
		try {
			farmerCount = countByNode(await api.farmers.list(projectId));
		} catch {
			farmerCount = null; // removeMessage warns about farmers on every farm instead
		}
	}

	let selectedId = $state<string | null>(null);
	// `node=<id>` is the node picked on the map (a note's link, notes.ts noteHref, lands on it too):
	// a pick from the list or the drawing writes it, so a reload, a shared link and Back keep the
	// pick (playbook § 2, as Dams' `dam=`). With none, nothing is picked. The grid modal's table
	// keeps its pick to itself.
	const nodeParam = $derived(only ? null : page.url.searchParams.get('node'));
	$effect(() => {
		const id = nodeParam;
		// A link with only `edit=` (the Dams page's Edit dam) picks the node it edits.
		untrack(() => (selectedId = id ?? editing?.id ?? null));
	});

	/** Picks a node on the map: a new history entry, so Back steps back through the picks. */
	function pick(id: string) {
		selectedId = id;
		if (only || nodeParam === id) return;
		void goto(withParam(page.url, 'node', id), { noScroll: true, keepFocus: true });
	}

	function select(id: string) {
		if (view === 'map') return pick(id);
		selectedId = id;
		{
			queueMicrotask(() => {
				const row = document.getElementById(`node-row-${id}`);
				row?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
				(row?.querySelector('input') as HTMLInputElement | null)?.focus({ preventScroll: true });
			});
		}
	}

	function addUser() {
		const n = editor.addUser();
		selectedId = n.id;
		// On the map a new node is filled in on its form, in the sheet.
		if (view === 'map') void openEdit(n.id).then(() => document.getElementById(`nd-name-${n.id}`)?.focus());
		else queueMicrotask(() => document.getElementById(`user-name-${n.id}`)?.focus());
	}

	function add() {
		const n = editor.addNode();
		selectedId = n.id;
		// On the map a new node is filled in on its form, in the sheet.
		if (view === 'map') void openEdit(n.id).then(() => document.getElementById(`nd-name-${n.id}`)?.focus());
		else queueMicrotask(() => document.getElementById(`node-name-${n.id}`)?.focus());
	}

	async function remove(id: string, name: string) {
		const node = nodes.find((n) => n.id === id);
		const refs = editor.model.transfers.filter((t) => t.fromNodeId === id || t.toNodeId === id).length;
		const areas = editor.model.cropAreas.filter((a) => a.nodeId === id).length;
		const cover = (editor.model.landCover ?? []).filter((p) => p.nodeId === id).length;
		const boreholes = (editor.model.boreholes ?? []).filter((b) => b.nodeId === id).length;
		const demandObjects = (editor.model.demandObjects ?? []).filter((o) => o.nodeId === id).length;
		const upstream = nodes.filter((n) => n.downstreamNodeId === id).length;
		const into = node?.downstreamNodeId ? labelOf(node.downstreamNodeId) : null;
		const isFarm = node?.kind === 'farm';
		const question = removeMessage({ isFarm, areas, transfers: refs, cover, boreholes, demandObjects, farmers: farmerCount ? (farmerCount[id] ?? 0) : null, upstream, into });
		const kind = node ? KIND_WORD[node.kind] : 'node';
		if (question && !(await confirmDialog({ title: `Remove “${name}”?`, message: question, confirmLabel: `Remove ${kind}`, danger: true }))) return;
		// The row after it in the table (else the one before) takes the focus once it is gone.
		const at = nodes.findIndex((n) => n.id === id);
		const next = nodes[at + 1] ?? nodes[at - 1] ?? null;
		editor.removeNode(id);
		if (selectedId === id) selectedId = null;
		if (editParam === id) sheetOpen = false;
		if (nodeParam === id) void goto(withoutParam(page.url, 'node'), { replaceState: true, noScroll: true, keepFocus: true });
		// The button that was pressed has gone (the row's ✕, or the sheet with its Remove and the
		// card's Edit it would hand the focus back to): put the focus somewhere that still is.
		await tick();
		const target =
			view === 'table'
				? (next && document.getElementById(`node-name-${next.id}`)) || document.getElementById('net-add-node')
				: document.getElementById('all-nodes-h') ?? document.getElementById('net-empty-add');
		target?.focus();
	}

	// --- reordering (display order only; the model runs in topological order) ---
	let announce = $state('');

	// --- paste a block from a spreadsheet (issue #285): into a cell, or from the toolbar ---
	let pasteOpen = $state(false);
	let pasteText = $state('');
	let pasteAnchor = $state<PasteAnchor | null>(null);
	const pasteWhere = $derived(pasteAnchor ? `${nodes[pasteAnchor.row]?.name || '(unnamed)'}, ${cardLabel(TABLE_FIELDS[pasteAnchor.col]!)}` : null);
	function onTablePaste(e: ClipboardEvent) {
		const t = gridPasteTarget(e);
		if (!t) return;
		pasteAnchor = t.anchor;
		pasteText = t.text;
		pasteOpen = true;
	}
	function openPaste() {
		pasteAnchor = null;
		pasteText = '';
		pasteOpen = true;
	}
	function applyPaste(plan: PastePlan) {
		applyNodePaste(editor.model.nodes, plan);
		announce = `Pasted ${plan.changes.length} ${plan.changes.length === 1 ? 'value' : 'values'} into the node table. Save the model to keep them.`;
	}
	const labelOf = (id: string) => nodes.find((n) => n.id === id)?.name || 'unnamed node';

	function moveBy(id: string, delta: -1 | 1, focus = false) {
		const from = nodes.findIndex((n) => n.id === id);
		const to = from + delta;
		if (from < 0 || to < 0 || to >= nodes.length) return;
		editor.model.nodes = moveTo(editor.model.nodes, from, to);
		announce = `${labelOf(id)} moved to row ${to + 1} of ${nodes.length}.`;
		if (focus) void refocusMover('mv', id, delta < 0 ? 'up' : 'down');
	}

	function sortByFlowPath() {
		editor.model.nodes = renumber(flowPathOrder(editor.model.nodes));
		announce = 'Rows sorted by flow path: each tributary from its headwater down, outflow gauge last.';
	}

	function reparent(id: string, into: string) {
		const n = editor.model.nodes.find((x) => x.id === id);
		if (!n) return;
		n.downstreamNodeId = into;
		announce = `${labelOf(id)} now drains into ${labelOf(into)}.`;
	}

	function setOutlet(id: string) {
		makeOutlet(editor.model.nodes, id);
		announce = `${labelOf(id)} is now the outflow gauge.`;
	}

	// Pointer drag on a row's handle (mouse and touch).
	const reorder = new RowReorder(
		() => nodes.map((n) => n.id),
		(from, to, id) => {
			editor.model.nodes = moveTo(editor.model.nodes, from, to);
			announce = `${labelOf(id)} moved to row ${to + 1} of ${nodes.length}.`;
		}
	);

	const groupSpans = $derived.by(() => {
		const spans: { group: NodeField['group']; count: number }[] = [];
		for (const f of TABLE_FIELDS) {
			const last = spans[spans.length - 1];
			if (last && last.group === f.group) last.count++;
			else spans.push({ group: f.group, count: 1 });
		}
		return spans;
	});
	// --- the Map layout: the picked node's card and the list of every node ---
	const picked = $derived(nodes.find((n) => n.id === selectedId) ?? null);
	// The picked node's row in All nodes stays in view inside its card: on a pick (from the drawing
	// or a node= link too) and whenever the list's box changes size (playbook § 4).
	let listEl: HTMLUListElement | undefined = $state();
	let listH = $state(0);
	$effect(() => {
		const id = selectedId;
		void listH;
		const el = listEl;
		if (!id || !el) return;
		const frame = requestAnimationFrame(() => keepInView(el, el.querySelector('[aria-pressed="true"]'), 4));
		return () => cancelAnimationFrame(frame);
	});
	const latestSupply = $derived(latestRun && supplyRun?.id === latestRun.id ? supplyByNode(nodes, supplyRun.summary) : null);
	const latestName = $derived(latestRun ? latestRun.label || fmtDate(latestRun.createdAt, true) : null);
	const GRID_LINKS: [GridId, string][] = [
		['crop-factors', 'Crop factors'],
		['planted-areas', 'Planted areas'],
		['transfers', 'Transfers']
	];
	const GRID_ALL: [GridId, string][] = [['nodes', 'Node table'], ...GRID_LINKS];
	const dotBand = (id: string) => colouring?.byNode.get(id)?.band ?? null;
	// The Tables menu closes on Escape (focus back on its button) and on a click outside it, like the other pop-ups.
	// The Map layout fills the window below its own top edge (issue #17: A2 uses the whole screen),
	// less the page's gutter and the save bar while it shows (--dock-h), so the page itself never
	// scrolls. The top is measured. (It once measured what sat below it as the page's scroll height
	// less its bottom, which the window's own height props up: any height that left the page shorter
	// than the window measured itself as right, so a map shrunk on a phone never grew back at 1440.)
	let mapEl: HTMLDivElement | undefined = $state();
	let mapTop = $state(0);
	$effect(() => {
		if (!mapEl) return;
		const measure = () => {
			if (!mapEl) return;
			mapTop = mapEl.getBoundingClientRect().top + window.scrollY;
		};
		measure();
		const ro = new ResizeObserver(measure);
		ro.observe(document.body);
		return () => ro.disconnect();
	});
	let gridsOpen = $state(false);
	let gridsEl: HTMLDetailsElement | undefined = $state();
	// Close through the element, not `gridsOpen`: the toggle event that updates it is async, so right
	// after opening it can still read false, and setting it false again would change nothing.
	function closeGrids() {
		if (gridsEl) gridsEl.open = false;
	}
	function gridsKeydown(e: KeyboardEvent) {
		if (e.key !== 'Escape' || !gridsEl?.open) return;
		e.preventDefault();
		closeGrids();
		gridsEl.querySelector('summary')?.focus();
	}
	$effect(() => {
		if (!gridsOpen) return;
		const onDoc = (e: PointerEvent) => {
			if (gridsEl && !gridsEl.contains(e.target as Node)) closeGrids();
		};
		document.addEventListener('pointerdown', onDoc);
		return () => document.removeEventListener('pointerdown', onDoc);
	});
	const dams = $derived(farms.filter(hasDam).length);
	const outletName = $derived(nodes.find((n) => n.downstreamNodeId === null)?.name || null);
	/** The Map header's one line: what the network is. */
	const summaryLine = $derived(
		[
			`${farms.length} hydrological unit${farms.length === 1 ? '' : 's'}`,
			`${dams} dam${dams === 1 ? '' : 's'}`,
			`${gauges.length} gauge${gauges.length === 1 ? '' : 's'}`,
			...(users.length ? [`${users.length} other user${users.length === 1 ? '' : 's'}`] : []),
			...(outletName ? [`into ${outletName}`] : []),
			`${fmtNum(nodes.reduce((sum, n) => sum + (n.areaKm2 || 0), 0), 1)} km²`
		].join(' · ')
	);

	// The picked farm's dam at the end of the latest run (the "Dam at end of run" tile), as a % of the
	// run's own capacity on that day (issue #67: sediment, an in-service date), as the map's colour by dam level reads it (damInRun, issue #173): from the run
	// summary, or its dam_storage series through the Runs cache (overview/damLevels.ts). As on the map, a
	// farm with no dam now is "No dam" and one whose dam the run didn't model is "not in this run"
	// (damEndTile). pct null: loading, or the series had no value.
	let damEnd = $state<DamEnd | null>(null);
	$effect(() => {
		const id = view === 'map' && picked?.kind === 'farm' && picked.damCapacityM3 >= 1 ? picked.id : null;
		const run = latestRun?.id ?? null;
		// The run's details are cached before its summary lands (loadSupply): reading supplyRun re-runs this then.
		const loaded = run !== null && supplyRun?.id === run;
		const detail = run ? detailCache.get(run) : undefined;
		if (!id || !run || !loaded || !detail) {
			damEnd = null;
			return;
		}
		const dam = damInRun(detail.run.model?.nodes, nodes, detail.series ?? [], id);
		if (!dam) {
			damEnd = { nodeId: id, inRun: false, pct: null, capacityM3: 0 };
			return;
		}
		// From the run summary when it has the figure (engine ≥ 1.2.0, issue #55), else the series.
		const pct = latestRun ? damEndPctFromSummary(dam, supplyRun!.summary.farms, historyEnd(latestRun)) : undefined;
		damEnd = { nodeId: id, inRun: true, pct: pct ?? null, capacityM3: dam.capacityM3 };
		if (pct !== undefined) return;
		cachedSeries(run, 'dam_storage', id, () => api.runs.series(projectId, run, 'dam_storage', id))
			.then((s) => {
				const l = damLevel(dam, s, latestRun?.forecastFrom ?? null);
				if (picked?.id === id) damEnd = { nodeId: id, inRun: true, pct: l ? l.endPct : null, capacityM3: dam.capacityM3 };
			})
			.catch(() => {
				if (picked?.id === id) damEnd = null;
			});
	});
	// --- the node sheet's extras: its sections for the jump row, and where its crops and transfers are set ---
	const sheetSections = $derived(editing ? nodeSections(editing, (editor.model.demandObjects ?? []).filter((o) => o.nodeId === editing.id).length) : []);
	/** Scrolls the sheet's form to a section and puts the focus on it (its fieldset, named by its legend). */
	function jumpTo(s: NodeSection) {
		if (!editing) return;
		const el = document.getElementById(sectionId(editing.id, s));
		el?.scrollIntoView({ block: 'start' });
		el?.focus({ preventScroll: true });
	}
	const editingTransfers = $derived.by(() => {
		if (!editing) return null;
		const id = editing.id;
		const mine = editor.model.transfers.filter((t) => t.fromNodeId === id || t.toNodeId === id);
		if (!mine.length) return null;
		const ends = mine.map((t) => (t.fromNodeId === id ? `to ${labelOf(t.toNodeId)}` : `from ${labelOf(t.fromNodeId)}`));
		return `${mine.length} transfer${mine.length === 1 ? '' : 's'}, ${ends.join(', ')}`;
	});
	/** The farm drawer over the map, in place of the sheet. */
	function plantedHref(id: string): string {
		const q = new URLSearchParams(page.url.search);
		q.delete('edit');
		q.set('farm', id);
		return `?${q}`;
	}
	const totalArea = $derived(nodes.reduce((s, n) => s + (n.areaKm2 || 0), 0));
	const farmArea = $derived(farms.reduce((s, n) => s + (n.areaKm2 || 0), 0));
	// The page's section header shows the map's summary line and actions (not the grid modal's table).
	$effect(() => fillHeader({ context: headerContext, actions: headerActions }, view === 'map'));
</script>

{#snippet headerContext()}<span data-testid="network-summary">{nodes.length ? summaryLine : 'No nodes yet'}</span>{/snippet}
{#snippet headerActions()}
	<!-- A shortcut to the geographic map (issue #288), which also has its own sidebar row since #326 D3. -->
	<a class="btn" href="?tab=map" data-testid="network-open-map">Map</a>
	<!-- Escape closes it, as the header's other disclosures (routes/projects/[id]). -->
	<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
	<details class="grids-menu" bind:open={gridsOpen} bind:this={gridsEl} onkeydown={gridsKeydown}>
		<summary class="btn">Tables <span aria-hidden="true">▾</span></summary>
		<div class="grids-pop" role="group" aria-label="Open as a table">
			{#each GRID_ALL as [id, label] (id)}<a href={withParam(page.url, 'grid', id)} onclick={closeGrids}>{label}</a>{/each}
		</div>
	</details>
	{#if !readonly}
		<button type="button" class="btn" onclick={add}>+ Add node</button>
		<!-- A town, industry or unlisted user, once there is one outlet for it to drain into (as the node table's toolbar). -->
		{#if outletCount === 1}<button type="button" class="btn" onclick={addUser}>+ Add other user</button>{/if}
	{/if}
{/snippet}

{#snippet colourByControl()}
	<!-- Every mode is a run's (supply, dam level), so with no run there is nothing to pick (irrigated area went, issue #174). -->
	{#if farms.length && latestRun}
		<div class="colour-by">
			<label for="sch-colour">Colour hydrological units by</label>
			<select id="sch-colour" bind:value={colourBy}>
				<option value="none">Nothing</option>
				<option value="supply">Supply, latest run</option>
				{#if farms.some((f) => f.damCapacityM3 >= 1)}<option value="dam">Dam level, end of latest run</option>{/if}
			</select>
		</div>
	{/if}
{/snippet}

{#snippet colourStatus()}
	<!-- The colouring's load and error line, laid over the map's top edge rather than in the card's header:
	     in the header it wrapped the row at 1280 px and moved the map ~25 px when the load ended. -->
	{#if farms.length && latestRun && (colourBy === 'supply' || colourBy === 'dam')}
		<span class="map-status muted small" role="status">
			{#if supplyLoading}
				<span class="chip">Loading the latest run’s results…</span>
			{:else if supplyError}
				<span class="chip">
					Couldn’t load the latest run’s results.
					<button type="button" class="btn btn-sm" onclick={() => latestRun && loadSupply(latestRun.id)}>Retry</button>
				</span>
			{:else if colourBy === 'dam' && damLoading}
				<span class="chip">Loading dam levels ({damLoading.done} of {damLoading.of})…</span>
			{:else if colourBy === 'dam' && damError}
				<span class="chip">
					Couldn’t load the dam levels.
					<button type="button" class="btn btn-sm" onclick={() => { damLevels = null; damAttempt++; }}>Retry</button>
				</span>
			{/if}
		</span>
	{/if}
{/snippet}

{#snippet drawing(fill: boolean)}
	<NetworkSchematic
		{nodes}
		transfers={editor.model.transfers}
		{selectedId}
		onselect={select}
		editable={!readonly}
		onreparent={reparent}
		{colouring}
		{fill}
	/>
{/snippet}

{#if only === 'table'}
	<!-- The node table alone: the grid modal's "Node table" (model/GridModal.svelte). -->
	<section class="panel" aria-labelledby="net-h">
		<div class="panel-head"><h2 id="net-h">Network nodes</h2></div>
		{#if nodes.length === 0}
			<div class="empty">
				<p>
					{#if readonly}
						No nodes yet. An editor builds the network here or from the Map.
					{:else}
						No nodes yet. Start with the <strong>outflow gauge</strong> at the bottom of the catchment (where flow is measured
						and the EWR applies), then add the hydrological units and gauges that drain into it.
					{/if}
				</p>
				{#if !readonly}<button type="button" class="btn btn-primary" onclick={add}>Add outflow gauge</button>{/if}
			</div>
		{:else}
		<p class="muted small intro">
				Percentages are shown 0–100. Flow shares {METHOD_LABEL[method]} (<a href="?tab=settings#set-share">Settings &amp; calibration</a>){#if farms.length}; hydrological units total {fmtPct(shares.sum, 2)}{/if}.
				<span class="wide-only">The ⓘ buttons and the field guide below explain</span><span class="phone-only">The field guide below explains</span> each value.
			</p>
			<div class="table-wrap net-wrap">
				<table class="data compact net">
					<thead>
						<tr class="groups">
							<th scope="col" class="sticky" rowspan="2">{#if !readonly}<span class="visually-hidden">Order and </span>{/if}Name</th>
							<th scope="col" rowspan="2">Kind <HelpTip key="node.kind" /></th>
							<th scope="col" rowspan="2">Drains into <HelpTip key="node.downstreamNodeId" /></th>
							{#each groupSpans as g (g.group)}
								<th scope="colgroup" colspan={g.count + (g.group === 'share' ? 1 : 0)} class="grp">{GROUPS[g.group]}</th>
							{/each}
							{#if !readonly}<th scope="col" rowspan="2" class="rm"><span class="visually-hidden">Remove</span></th>{/if}
						</tr>
						<tr>
							{#each TABLE_FIELDS as f (f.key)}
								<!-- Label on top (non-breaking hyphens: "High-MAP" stays whole), then the
								     unit and its ⓘ on one bottom line, the same in every column. -->
								<th scope="col" class="num fh">
									<span class="fh-l">{f.label.replace(/-/g, '\u2011')}</span>
									<span class="fh-u">{#if f.flowUnit}<FlowUnitSelect unit={f.flowUnit} label="Unit of {f.label.toLowerCase()}" />{:else}<span class="u">{f.unit}</span>{/if}<HelpTip key={`node.${f.key}`} label="About {f.label.toLowerCase()}" /></span>
								</th>
							{/each}
							<!-- Computed, not a field, so it isn't in TABLE_FIELDS: its ⓘ is the flow-share glossary entry. -->
							<th scope="col" class="num fh">
								<span class="fh-l">In use</span>
								<span class="fh-u"><span class="u">%</span><HelpTip key="flow-share" label="About the flow share in use" /></span>
							</th>
						</tr>
					</thead>
					<tbody bind:this={reorder.body} onpaste={readonly ? undefined : onTablePaste}>
						{#each nodes as node, i (node.id)}
							{@const label = node.name || 'unnamed node'}
							{@const share = shareOf(i)}
							{@const rs = reorder.rowState(node.id, i, nodes.length)}
							<tr
								id="node-row-{node.id}"
								data-idx={i}
								class:sel={node.id === selectedId}
								class:dragging={rs.dragging}
								class:drop-before={rs.before}
								class:drop-after={rs.after}
							>
								<th scope="row" class="sticky" data-paste-col="0">
									<div class="namecell">
									{#if !readonly}
										<MoveControls id={node.id} {label} index={i} count={nodes.length} {reorder} onmove={(d) => moveBy(node.id, d, true)} />
									{/if}
									<input
										id="node-name-{node.id}"
										aria-label="Name"
										maxlength="100"
										readonly={readonly}
										bind:value={node.name}
										onfocus={() => (selectedId = node.id)}
									/>
									<!-- Notes on a saved node (WP-2.7); a node added since the last save has none yet. -->
									{#if projectId && editor.savedNodeIds.has(node.id)}
										<NotesDrawer {projectId} compact target={{ kind: 'node', nodeId: node.id, name: node.name, isFarm: node.kind === 'farm' }} />
									{/if}
									</div>
								</th>
								<td>
									<span class="cell-label" aria-hidden="true">Kind</span>
									<select aria-label="Kind of {label}" disabled={readonly} bind:value={node.kind}>
										<option value={'farm' satisfies NodeKind}>Hydrological unit</option>
										<option value={'gauge' satisfies NodeKind}>Gauge</option>
										<option value={'user' satisfies NodeKind}>Other user</option>
									</select>
								</td>
								<td>
									<span class="cell-label" aria-hidden="true">Drains into</span>
									<select
										aria-label="{label} drains into"
										disabled={readonly}
										value={node.downstreamNodeId ?? ''}
										onchange={(e) => (node.downstreamNodeId = e.currentTarget.value || null)}
									>
										<option value="">— Outlet (none) —</option>
										{#each nodes as other (other.id)}
											{#if other.id !== node.id}<option value={other.id}>{other.name || '(unnamed)'}</option>{/if}
										{/each}
									</select>
								</td>
								{#each TABLE_FIELDS as f, fi (f.key)}
									{#if (f.farmOnly && node.kind !== 'farm') || node.kind === 'user'}
										{@const what = node.kind === 'user' ? 'an other water user' : 'a gauge'}
										<td class="num na" class:pct={isPct(f)} class:vol={isVolume(f)} title="Not used for {what}"><span aria-hidden="true">–</span><span class="visually-hidden">not used for {what}</span></td>
									{:else if f.key === 'divertCapacityM3Day' && divertMonthsCell(node, label)}
										<!-- Set by month (engine ≥ 1.32.0): the run ignores the one value, so the table shows the months, read-only, and points to the node's form. -->
										{@const c = divertMonthsCell(node, label)!}
										<td class="num by-month vol" data-testid="divert-by-month-{node.id}">
											<span class="cell-label" aria-hidden="true">{cardLabel(f)} <span class="u">{f.unit}</span></span>
											{#if projectId}
												<a href="?tab=network&edit={encodeURIComponent(node.id)}" aria-label="{c.aria}: edit it in the node’s form" title="Set by month: the one value isn’t used. Edit the months in the node’s form.">{c.text}</a>
											{:else}
												<span aria-hidden="true" title="Set by month: the one value isn’t used.">{c.text}</span><span class="visually-hidden">{c.aria}</span>
											{/if}
										</td>
									{:else}
									{@const unused = fieldUnused(f, node)}
									{@const over = f.key === 'returnFlowFraction' && node.kind === 'farm' ? returnFlowHint(node.returnFlowFraction, unitEfficiency(editor.model, node.id, editor.apanMm)) : null}
									<td class:pct={isPct(f)} class:vol={isVolume(f)} class:unused={unused !== null} class:over={over !== null} data-paste-col={fi} title={unused ?? over ?? undefined}>
										<span class="cell-label" aria-hidden="true">{cardLabel(f)} <span class="u">{f.unit}</span></span>
										<NumberInput
											label={unused ? `${f.aria(label)}: ${unused}` : f.aria(label)}
											min={0}
											max={isPct(f) ? 100 : undefined}
											scale={fieldScale(f)}
											nullable={f.nullable}
											grouped={readonly && !isPct(f)}
											placeholder={f.nullable ? '–' : undefined}
											disabled={readonly || unused !== null || f.derived}
											value={f.derived ? unitEfficiency(editor.model, node.id, editor.apanMm) : (node[f.key] ?? null)}
								onchange={(v) => setNodeField(node, f.key, v)}
										/>
									</td>
									{/if}
								{/each}
								<td class="num share" class:none={share === null}><span class="cell-label">Flow share in use{' '}</span>{share === null ? '–' : fmtPct(share, 2)}</td>
								{#if !readonly}
									<td class="rm">
										<button type="button" class="btn-icon btn" aria-label="Remove {label}" title="Remove node" onclick={() => remove(node.id, label)}>✕</button>
									</td>
								{/if}
							</tr>
						{/each}
					</tbody>
					<tfoot>
						<tr>
							<th scope="row" class="sticky">Total</th>
							<td class="none"></td>
							<td class="none"></td>
							{#each TABLE_FIELDS as f (f.key)}
								{@const total = f.key === 'areaKm2' ? fmtNum(totalArea, 2) : f.key === 'damCapacityM3' ? fmtNum(farms.reduce((s, n) => s + n.damCapacityM3, 0)) : null}
								<!-- On a phone card each total names itself (the column header is gone). -->
								<td class="num" class:pct={isPct(f)} class:vol={isVolume(f)} class:none={total === null}>
									{#if total !== null}<span class="cell-label">{cardLabel(f)}{' '}</span>{total}<span class="cell-label">{' '}{f.unit}</span>{/if}
								</td>
							{/each}
							<td class="num" class:warn={farms.length > 0 && Math.abs(shares.sum - 1) >= 0.0002} class:none={!farms.length}>{#if farms.length}<span class="cell-label">Flow share in use{' '}</span>{fmtPct(shares.sum, 2)}{/if}</td>
							{#if !readonly}<td class="rm none"></td>{/if}
						</tr>
					</tfoot>
				</table>
			</div>
			{#if !readonly}
				<div class="toolbar after">
					<button type="button" class="btn" id="net-add-node" onclick={add}>+ Add node</button>
					{#if outletCount === 1}<button type="button" class="btn" onclick={addUser}>+ Add other user</button>{/if}
					<button type="button" class="btn" onclick={sortByFlowPath} title="Order rows headwater → outlet, one tributary at a time">
						Sort by flow path
					</button>
					<button type="button" class="btn" onclick={openPaste}>Paste from a spreadsheet…</button>
					{#if outletCount === 1}<span class="muted small">New nodes drain into the outlet; change "Drains into" (or drag on the schematic) to nest them. Row order is for display only.</span>{/if}
				</div>
			{/if}
			<details class="guide">
				<summary>Field guide</summary>
				<dl>
					<div><dt>Kind</dt><dd>A <strong>hydrological unit</strong> (a farm, sub-catchment or town with its own area) generates runoff, has irrigation demand and may have a dam; a stand-alone dam or natural area is also a hydrological unit. The workspace and the farmer view call it a hydrological unit; exports and the API call it a farm. A <strong>gauge</strong> is a measuring point that passes upstream flow through. An <strong>other user</strong> (a town, industry or unlisted irrigator) takes a monthly demand from the river where it sits; set it up under "Other water users" below.</dd></div>
					<div><dt>Land cover</dt><dd>Invasive trees and forestry on a hydrological unit, which reduce its runoff: edit them in the node's form (<strong>Edit</strong> on its card on the map), under "Land cover".</dd></div>
					<div><dt>Drains into</dt><dd>The node immediately downstream. Exactly one node, the outflow gauge, drains nowhere.</dd></div>
					{#each NODE_FIELDS as f (f.key)}
						<div><dt>{GROUPS[f.group]}: {f.label} ({f.unit})</dt><dd>{f.help}</dd></div>
					{/each}
					<div><dt>{GROUPS.share}: In use (%)</dt><dd>The hydrological unit's share of catchment natural flow and of the EWR with the method chosen in <a href="?tab=settings#set-share">Settings &amp; calibration</a> (by area, high/low MAP split or manual), from the saved settings. Computed, not edited; the shares should add up to 100 %.</dd></div>
				</dl>
			</details>
			{#if !readonly}
				<GridPasteDialog
					bind:open={pasteOpen}
					bind:text={pasteText}
					title="Paste into the node table"
					layout="A row per node with its name first, under a heading row naming the columns (as the CSV below has them); without names or headings the values fill the table from the cell you pasted into, in its order. A % is 0–100."
					where={pasteWhere}
					plan={(t) => planNodePaste(t, nodes, pasteAnchor)}
					onapply={applyPaste}
					csv={() => nodeTableCsv(nodes)}
					csvName="node-table.csv"
				/>
			{/if}
		{/if}
	</section>
{#if users.length}
	<section class="panel" aria-labelledby="users-h">
		<div class="panel-head">
			<h2 id="users-h">Other water users <HelpTip key="node.userDemandM3Day" /></h2>
			<span class="muted small">Towns, industry and unlisted users taking water from the river. They have no land, dam or crops.</span>
		</div>
		{#each users as u (u.id)}
			<details class="user-card" open={u.id === selectedId || users.length === 1}>
				<summary>
					<span class="user-name">{u.name || 'unnamed user'}</span>
					<span class="muted small">{describeUser(u)} · drains into {u.downstreamNodeId ? labelOf(u.downstreamNodeId) : 'nothing (it is the outlet)'}</span>
				</summary>
				<div class="field user-name-field">
					<label for="user-name-{u.id}">User name</label>
					<input id="user-name-{u.id}" maxlength="100" readonly={readonly} bind:value={u.name} />
				</div>
				<UserFields node={u} {readonly} />
			</details>
		{/each}
	</section>
{/if}
{:else}
	<!-- The map (issue #17, option A · A2): a page of its own. Its summary,
	     Tables and Add node sit in the workspace's section header (headerParts
	     below, with no nodes yet too); the map card fills the width beside the
	     picked node and the node list. -->
	{#if nodes.length === 0}
		<section class="panel" aria-label="No nodes yet">
			<div class="empty" data-testid="network-empty">
				{#if readonly}
					<p>No nodes yet. An editor builds the network here or from the Map.</p>
				{:else}
					<p>
						No nodes yet. Start with the <strong>outflow gauge</strong> at the bottom of the catchment (where flow is measured
						and the EWR applies), then add the hydrological units and gauges that drain into it. Or start from the map: click the
						outlet on the Map and the app delineates the units, their areas and what drains into what.
					</p>
					<div class="empty-actions">
						<button type="button" class="btn btn-primary" id="net-empty-add" onclick={add}>Add outflow gauge</button>
						<a class="btn" href="?tab=map&start=1" data-testid="network-start-from-map">Start from the map</a>
					</div>
				{/if}
			</div>
		</section>
	{:else}
	<div class="map-layout" bind:this={mapEl} style:--map-top="{mapTop}px">
		<!-- aria-busy while the latest run's results load: their status line sits in the card's head and,
		     where the head wraps, moves the map when it goes (e2e's waitForMapFit waits it out). -->
		<section class="panel map-card" aria-labelledby="sch-h" aria-busy={supplyLoading || (colourBy === 'dam' && damLoading !== null)}>
			<div class="panel-head">
				<h3 id="sch-h">Catchment map</h3>
				{@render colourByControl()}
			</div>
			<div class="map-body">{@render colourStatus()}{@render drawing(true)}</div>
		</section>
		<aside class="map-side" aria-label="Nodes">
			<section class="panel side-box" aria-label="Selected node">
				{#if picked}
					<NodeCard
						node={picked}
						{nodes}
						share={shareOf(nodes.indexOf(picked))}
						supply={picked.kind === 'farm' ? (latestSupply?.get(picked.id) ?? null) : null}
						damEnd={picked.kind === 'farm' && damEnd?.nodeId === picked.id ? damEnd : null}
						planting={picked.kind === 'farm' ? farmPlanting(editor.model, picked.id) : null}
						runName={latestName}
						{projectId}
						saved={editor.savedNodeIds.has(picked.id)}
						farmHref={withParam(page.url, 'farm', picked.id)}
						mapHref={mapped.has(picked.id) ? mapNodeHref(picked.id) : null}
						{readonly}
						onedit={() => openEdit(picked.id)}
					/>
				{:else}
					<p class="muted small pick-hint">Select a node on the map or in the list to see it here.</p>
				{/if}
			</section>
			<section class="panel side-box nodes-box" aria-labelledby="all-nodes-h">
				<!-- tabindex: where the focus lands after a node is removed from its sheet. -->
				<h3 class="list-h" id="all-nodes-h" tabindex="-1">All nodes</h3>
				<ul class="node-list" aria-labelledby="all-nodes-h" bind:this={listEl} bind:clientHeight={listH}>
					{#each nodes as n (n.id)}
						{@const band = dotBand(n.id)}
						<li>
							<button type="button" class="node-row" aria-pressed={n.id === selectedId} onclick={() => pick(n.id)}>
								<span class="dot {n.kind}" data-band={band} aria-hidden="true"></span>
								<span class="nm">{n.name || '(unnamed)'}</span>
								<span class="meta muted">{n.downstreamNodeId === null ? 'outlet' : `→ ${labelOf(n.downstreamNodeId)}`}</span>
							</button>
						</li>
					{/each}
				</ul>
			</section>
		</aside>
	</div>

	{/if}

	<!-- A node's full form, over the map (`edit=<id>`): every field, with its help. -->
	{#if editing}
		<Dialog bind:open={sheetOpen} title={readonly ? `${editing.name || '(unnamed)'}: details` : `Edit ${editing.name || '(unnamed)'}`} side extraWide>
			{#snippet subhead()}
				<div class="picker sheet-picker">
					<label for="node-pick" class="visually-hidden">Node to edit</label>
					<button type="button" class="btn" aria-label="Previous node" disabled={editIndex <= 0} onclick={() => openEdit(nodes[editIndex - 1]!.id, true)}>‹</button>
					<select id="node-pick" value={editing.id} onchange={(e) => openEdit(e.currentTarget.value, true)}>
						{#each nodes as n, i (n.id)}
							<option value={n.id}>{i + 1}. {n.name || '(unnamed)'} · {KIND_WORD[n.kind]}</option>
						{/each}
					</select>
					<button type="button" class="btn" aria-label="Next node" disabled={editIndex >= nodes.length - 1} onclick={() => openEdit(nodes[editIndex + 1]!.id, true)}>›</button>
				</div>
				<!-- The form's sections, fixed above it: one press scrolls to a section and focuses it. -->
				{#if sheetSections.length > 1}
					<nav class="jump" aria-label="Sections of the form" data-testid="node-sheet-jump">
						{#each sheetSections as sec (sec)}<button type="button" class="jump-link" onclick={() => jumpTo(sec)}>{SECTION_SHORT[sec]}</button>{/each}
					</nav>
				{/if}
			{/snippet}
			<div class="sheet one-node">
		{#key editing.id}
				<NodeDetail
					node={editing}
					{nodes}
					share={shareOf(editIndex)}
					{readonly}
					onremove={() => remove(editing!.id, editing!.name || 'unnamed node')}
					farmersNote={editing.kind === 'farm' ? linkedNote(farmerCount?.[editing.id] ?? 0) : null}
					mapHref={mapped.has(editing.id) ? mapNodeHref(editing.id) : null}
					previewHref={editing.kind === 'farm' && projectId ? `${base}/farm/${encodeURIComponent(projectId)}?node=${encodeURIComponent(editing.id)}` : null}
					onmakeoutlet={() => setOutlet(editing.id)}
					landCover={(editor.model.landCover ?? []).filter((p) => p.nodeId === editing.id)}
					onaddcover={() => editor.addLandCover(editing.id)}
					onremovecover={(id) => editor.removeLandCover(id)}
					boreholes={(editor.model.boreholes ?? []).filter((b) => b.nodeId === editing.id)}
					onaddborehole={() => editor.addBorehole(editing.id)}
					onremoveborehole={(id) => editor.removeBorehole(id)}
					demandObjects={(editor.model.demandObjects ?? []).filter((o) => o.nodeId === editing.id)}
					onadddemand={(category) => editor.addDemandObject(editing.id, category)}
					onremovedemand={(id) => editor.removeDemandObject(id)}
					{method}
					planting={editing.kind === 'farm' ? farmPlanting(editor.model, editing.id) : null}
					efficiency={editing.kind === 'farm' ? unitEfficiency(editor.model, editing.id, editor.apanMm) : null}
					systemsLine={editing.kind === 'farm' ? plantingSystemsLine(editing.id) : null}
					plantedHref={editing.kind === 'farm' ? plantedHref(editing.id) : null}
					transfersLine={editingTransfers}
					transfersHref={editing.kind === 'farm' ? '?tab=transfers' : null}
				/>
				{#if editing.kind === 'farm' && projectId}
					<Lazy load={loadYield}>
						{#snippet children(YieldPanel)}
							<YieldPanel {projectId} nodeId={editing.id} nodeName={editing.name} {runs} canEdit={!readonly} hasDam={hasDam(editing)} />
						{/snippet}
					</Lazy>
				{/if}
			{/key}
			</div>
			{#snippet actions()}
				{#if readonly || !onsave}
					<button type="button" class="btn" onclick={() => (sheetOpen = false)}>Close</button>
				{:else}
					<ModelSaveRow {editor} {onsave} ondone={() => (sheetOpen = false)} bind:reason />
				{/if}
			{/snippet}
		</Dialog>
	{/if}
{/if}

<style>
	.colour-by {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.4rem 0.6rem;
		margin: 0 0 0.6rem;
		font-size: 0.85rem;
	}
	.colour-by label {
		font-weight: 600;
	}
	.user-card {
		border-top: 1px solid var(--border);
		padding: 0.5rem 0;
	}
	.user-card summary {
		cursor: pointer;
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		align-items: baseline;
		min-height: 32px;
	}
	.user-name {
		font-weight: 600;
	}
	.user-name-field {
		max-width: 320px;
		margin: 0.25rem 0;
	}
	.user-name-field input {
		width: 100%;
	}
	.intro {
		margin: -0.25rem 0 0.6rem;
	}
	/* Keep the table as narrow as it can readably be: field headers wrap
	   instead of setting the column width, cells are tighter, and 0–100 %
	   columns are narrower than the volume columns. */
	.net thead th {
		white-space: normal;
	}
	.net th,
	.net td {
		padding-left: 0.35rem;
		padding-right: 0.35rem;
	}
	/* Area columns (km²) hold short values; % and volume columns set their own below. */
	.net td {
		min-width: 68px;
	}
	/* Every cell in a column carries pct / rm (not-used and footer cells too):
	   a column is as wide as its widest cell's minimum. */
	.net td.pct {
		min-width: 56px;
	}
	/* Room for a seven-digit volume (1340000) in the input, so it is never clipped. */
	.net td.vol {
		min-width: 92px;
	}
	/* A return flow above its unit's losses (runs cap it): flagged, its reason in the title and the unit form. */
	.net td.over :global(input) {
		border-color: var(--warning);
		box-shadow: inset 0 0 0 1px var(--warning);
	}
	.net td.rm {
		min-width: 0;
	}
	table.data.compact.net td :global(input) {
		min-width: 0;
	}
	.net thead th.grp {
		text-align: center;
		border-left: 1px solid var(--border);
		font-weight: 600;
		color: var(--text);
	}
	/* Field headers: every one bottom-aligned and right-aligned over its numbers,
	   the label wrapping with its ⓘ kept at the end of the last line, and the
	   unit on its own line below, so the header row reads as one even band. */
	.net thead tr:last-child th,
	.net thead th[rowspan] {
		vertical-align: bottom;
	}
	.net th.fh {
		text-align: right;
	}
	.fh-l {
		display: block;
		line-height: 1.25;
	}
	.fh-u {
		display: flex;
		justify-content: flex-end;
		align-items: center;
		gap: 0.2rem;
		margin-top: 0.2rem;
		min-height: 1.25rem;
		/* A unit stays on its line ("% of supply"), so every header's help button sits on one row. */
		white-space: nowrap;
	}
	/* Numbers right-aligned in even-width digits, like the totals under them. */
	.net td :global(input) {
		width: 100%;
		text-align: right;
		font-variant-numeric: tabular-nums;
	}
	.net tfoot td.num {
		text-align: right;
		font-variant-numeric: tabular-nums;
		/* Line the total's digits up with the input text above: cell padding + input border + input padding. */
		padding-right: calc(0.35rem + 1px + 0.35rem);
	}
	.net thead th :global(.helptip) {
		margin-left: 0.1rem;
	}
	.net th.sticky {
		position: sticky;
		left: 0;
		z-index: 2;
		background: var(--surface);
		min-width: 170px;
	}
	.net thead th.sticky,
	.net tfoot th.sticky {
		background: var(--surface-2);
		z-index: 3;
	}
	.net td:nth-child(2) {
		min-width: 90px;
	}
	.net td:nth-child(3) {
		min-width: 150px;
	}
	.net td.na {
		color: var(--text-muted);
	}
	/* River to dam set by month: read-only, lined up with the inputs' digits. */
	.net td.by-month {
		text-align: right;
		white-space: nowrap;
		font-variant-numeric: tabular-nums;
		padding-right: calc(0.35rem + 1px + 0.35rem);
	}
	.net tr.sel {
		background: var(--accent-soft);
	}
	/* Remove stays pinned on the right as the name is on the left: below about
	   1440px the table scrolls sideways inside its box, and each row's action
	   must stay in reach. */
	.net .rm {
		position: sticky;
		right: 0;
		z-index: 1;
		background: var(--surface);
		box-shadow: inset 1px 0 0 var(--border);
	}
	.net thead th.rm,
	.net tfoot td.rm {
		background: var(--surface-2);
	}
	.net tr.sel td.rm,
	.net tr.sel th.sticky {
		background: var(--accent-soft);
	}
	.share {
		color: var(--text-2);
	}
	.namecell {
		display: flex;
		align-items: center;
		gap: 0.25rem;
	}
	.namecell input {
		flex: 1;
		width: 120px;
		min-width: 120px;
	}
	/* A saved node's notes button (24 px + the gap) comes out of the name, so
	   the column keeps its width (the 1440 px layout test, model.spec.ts). */
	.namecell:has(:global(.notes-btn)) input {
		width: 92px;
		min-width: 92px;
	}
	.net tr.dragging {
		opacity: 0.5;
	}
	.net tr.drop-before > * {
		box-shadow: inset 0 2px 0 var(--accent);
	}
	.net tr.drop-after > * {
		box-shadow: inset 0 -2px 0 var(--accent);
	}
	.warn {
		color: var(--warning);
	}
	.after {
		margin: 0.75rem 0 0;
	}
	.guide {
		margin-top: 0.75rem;
		font-size: 0.85rem;
	}
	.guide summary {
		cursor: pointer;
		font-weight: 600;
		color: var(--accent);
		min-height: 32px;
		display: flex;
		align-items: center;
	}
	.guide dl {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
		gap: 0.6rem 1.5rem;
		margin: 0.5rem 0 0;
	}
	.guide dt {
		font-weight: 600;
	}
	.guide dd {
		margin: 0.1rem 0 0;
		color: var(--text-2);
	}
	.picker {
		display: flex;
		gap: 0.4rem;
		align-items: center;
		margin: 0 -0.5rem 0.5rem;
		padding: 0.4rem 0.5rem;
		position: sticky;
		top: var(--header-h);
		z-index: 4;
		background: var(--surface);
		border-bottom: 1px solid var(--border);
	}
	/* In the node sheet the picker sits in the dialog's fixed sub-header, not in the scrolling form. */
	.sheet-picker {
		position: static;
		margin: 0;
		padding: 0 0 0.5rem;
	}
	.add-one {
		margin: 0 0 0.75rem;
	}
	/* The sheet's jump row: the sections as small links, wrapping onto a second row at most on a
	   laptop (11 short names at 920 px); one strip that scrolls sideways on a phone (SectionNav's pattern). */
	.jump {
		display: flex;
		flex-wrap: wrap;
		gap: 0.15rem 0.35rem;
		padding: 0 0 0.4rem;
		font-size: 0.85rem;
	}
	.jump-link {
		/* At least 24 px (WCAG 2.5.8): the wrapped rows sit too close for the spacing exception. */
		display: inline-flex;
		align-items: center;
		min-height: 24px;
		min-width: 24px;
		background: none;
		border: 0;
		padding: 0.15rem 0.35rem;
		border-radius: var(--radius-sm);
		color: var(--accent);
		text-decoration: underline;
		text-underline-offset: 2px;
		cursor: pointer;
		white-space: nowrap;
	}
	.jump-link:hover {
		background: var(--row-hover);
	}
	.empty-actions {
		display: flex;
		flex-wrap: wrap;
		justify-content: center;
		gap: 0.5rem;
	}
	.list-h:focus-visible {
		outline: 2px solid var(--focus);
		outline-offset: 2px;
	}
	@media (max-width: 640px) {
		.jump {
			flex-wrap: nowrap;
			overflow-x: auto;
		}
		.jump-link {
			min-height: 44px;
		}
	}
	/* A control scrolled to by Tab stops below the sticky picker too, not
	   just below the app header (WCAG 2.4.11, focus not obscured). */
	.one-node :global(:is(input, select, button, a, summary)) {
		scroll-margin-top: 4.5rem;
	}
	.picker select {
		flex: 1;
		min-width: 0;
		min-height: 40px;
	}
	.picker .btn {
		min-height: 40px;
		min-width: 40px;
		justify-content: center;
	}
	@media (max-width: 640px) {
		.picker select,
		.picker .btn {
			min-height: 44px;
		}
	}
	.empty {
		padding: 1.5rem;
		text-align: center;
		color: var(--text-muted);
		border: 1px dashed var(--border-strong);
		border-radius: var(--radius);
	}
	/* Map layout (issue #17, A2): a header, then the map card beside the picked node and the node list. */
	.grids-menu {
		position: relative;
	}
	.grids-menu summary {
		list-style: none;
		cursor: pointer;
	}
	.grids-menu summary::-webkit-details-marker {
		display: none;
	}
	.grids-pop {
		position: absolute;
		right: 0;
		top: calc(100% + 4px);
		z-index: 20;
		display: grid;
		min-width: 12rem;
		padding: 0.3rem;
		background: var(--surface);
		border: 1px solid var(--border-strong);
		border-radius: var(--radius);
		box-shadow: 0 6px 20px rgb(0 0 0 / 0.14);
	}
	.grids-pop :is(a, button) {
		display: block;
		width: 100%;
		min-height: 36px;
		padding: 0.45rem 0.6rem;
		border: 0;
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--text);
		font: inherit;
		font-size: 0.9rem;
		text-align: left;
		text-decoration: none;
		cursor: pointer;
	}
	.grids-pop :is(a, button):hover {
		background: var(--surface-2);
	}
	.map-layout {
		display: grid;
		/* The side column gives up a little width on smaller screens; the map needs it more. */
		grid-template-columns: minmax(0, 1fr) clamp(17rem, 24vw, 22rem);
		gap: 1rem;
		align-items: start;
	}
	.map-card {
		margin: 0;
		min-width: 0;
	}
	.map-card .panel-head {
		flex-wrap: wrap;
		gap: 0.5rem 1rem;
	}
	.map-card h3 {
		margin: 0;
		font-size: 1.05rem;
	}
	.map-card .colour-by {
		margin: 0;
	}
	.map-body {
		position: relative;
	}
	/* Laid over the map's top-left corner, so the map never moves when it comes and goes. The live region
	   itself stays in place and draws nothing; only a message draws its chip. */
	.map-status {
		position: absolute;
		top: 0.5rem;
		left: 0.5rem;
		right: 0.5rem;
		z-index: 1;
		pointer-events: none;
	}
	.map-status .chip {
		display: inline-flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.4rem;
		padding: 0.25rem 0.6rem;
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		box-shadow: var(--shadow);
		pointer-events: auto;
	}
	.map-side {
		display: grid;
		gap: 0.75rem;
	}
	.side-box {
		margin: 0;
	}
	.pick-hint {
		margin: 0;
	}
	.list-h {
		margin: 0 0 0.4rem;
		font-size: 0.95rem;
	}
	.node-list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		/* One column the list's width: a row's one-line ending must not size the track past it. */
		grid-template-columns: minmax(0, 1fr);
		max-height: 24rem;
		overflow-y: auto;
	}
	.node-row {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		width: 100%;
		min-height: 36px;
		padding: 0.3rem 0.5rem;
		border: 0;
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--text);
		font: inherit;
		font-size: 0.9rem;
		text-align: left;
		cursor: pointer;
	}
	.node-row:hover {
		background: var(--surface-2);
	}
	.node-row[aria-pressed='true'] {
		background: var(--accent-soft);
		font-weight: 600;
	}
	/* The name takes what the row has left and wraps between words; what it
	   drains into takes at most 45 % on one line, cut with an ellipsis (the
	   button's name still reads it whole). It took its full width before, and
	   a long one squeezed the name to a column that broke mid-word ("Blinkwat/er"). */
	.node-row .nm {
		flex: 1 1 0%;
		min-width: 0;
		overflow-wrap: break-word;
	}
	.node-row .meta {
		flex: 0 1 auto;
		min-width: 0;
		max-width: 45%;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 0.8rem;
		font-weight: 400;
	}
	.dot {
		flex: none;
		width: 9px;
		height: 9px;
		border-radius: 50%;
		background: var(--brand-node, var(--accent));
	}
	.dot.gauge {
		border-radius: 2px;
		background: var(--text-2);
	}
	.dot.user {
		transform: rotate(45deg);
		border-radius: 1px;
		background: var(--text-muted);
	}
	.dot[data-band='met'] {
		background: var(--success);
	}
	.dot[data-band='short'] {
		background: var(--warning);
	}
	.dot[data-band='low'] {
		background: var(--danger);
	}
	/* No dam, no demand: hollow, as the dashed symbol on the map. */
	.dot[data-band='none'] {
		background: transparent;
		box-shadow: inset 0 0 0 1.5px var(--text-muted);
	}
	.dot[data-band='absent'] {
		background: transparent;
		box-shadow: inset 0 0 0 1.5px var(--text-muted);
		border-radius: 2px;
	}
	@media (max-width: 899px) {
		.map-layout {
			grid-template-columns: minmax(0, 1fr);
		}
		.node-row {
			min-height: 44px;
		}
	}
	/* From 900 px the layout is exactly the height left in the window (less
	   the page's gutter and the save bar while it shows); the drawing and the node list take what
	   their cards leave, each scrolling inside itself. */
	@media (min-width: 900px) {
		.map-layout {
			height: max(520px, calc(100vh - var(--map-top, 0px) - var(--dock-h, 0px) - 1rem));
			align-items: stretch;
		}
		.map-card {
			display: flex;
			flex-direction: column;
			min-height: 0;
		}
		.map-body {
			flex: 1;
			min-height: 0;
		}
		.map-side {
			display: flex;
			flex-direction: column;
			min-height: 0;
		}
		.nodes-box {
			flex: 1;
			min-height: 0;
			display: flex;
			flex-direction: column;
		}
		.nodes-box .node-list {
			flex: 1;
			min-height: 0;
			max-height: none;
			align-content: start;
		}
	}
	/* Phones: each node's row becomes a card with visible field labels, the
	   same inputs two to a row, instead of a table that scrolls sideways under
	   its pinned name and remove columns (as the crop grids, CropGrids.svelte).
	   Fields a node doesn't use are left out rather than shown as "–". The
	   repeated .net raises these over the table's own column rules. */
	.cell-label,
	.phone-only {
		display: none;
	}
	@media (max-width: 640px) {
		.wide-only {
			display: none;
		}
		.phone-only {
			display: inline;
		}
		/* The cards scroll with the modal's body, not in a 70vh box of their
		   own inside it, so Add node and the field guide follow the last card. */
		.net-wrap {
			max-height: none;
		}
		.net thead {
			display: none;
		}
		.net,
		.net tbody,
		.net tfoot {
			display: block;
		}
		.net tr {
			position: relative;
			display: grid;
			grid-template-columns: repeat(2, minmax(0, 1fr));
			gap: 0.5rem 0.75rem;
			align-items: end;
			padding: 0.75rem;
			border-bottom: 1px solid var(--border);
		}
		.net tbody tr:last-child {
			border-bottom: none;
		}
		.net.net.net tr > * {
			position: static;
			min-width: 0;
			padding: 0;
			border: 0;
			text-align: left;
			background: none;
			box-shadow: none;
		}
		.net.net.net tr > .na,
		.net.net.net tr > .none {
			display: none;
		}
		.net th[scope='row'] {
			grid-column: 1 / -1;
		}
		/* The card's first line holds the row's controls (move, notes, and
		   Remove at the top right); the name takes the whole next line, so a
		   long one stays readable. */
		.net.net.net tr > .rm {
			position: absolute;
			top: 0.75rem;
			right: 0.75rem;
		}
		.namecell {
			flex-wrap: wrap;
			row-gap: 0.4rem;
		}
		/* As tall as Remove (a 44 px phone button), so the line and ✕ line up. */
		.namecell :global(.mc) {
			min-height: 44px;
		}
		.net.net.net .namecell input {
			order: 2;
			flex: 1 1 100%;
			width: auto;
			min-width: 0;
		}
		.net select {
			width: 100%;
			min-width: 0;
		}
		.net td :global(input) {
			text-align: left;
		}
		/* A tap target as tall as the inputs beside it. */
		.net td.by-month a {
			display: inline-flex;
			align-items: center;
			min-height: 44px;
		}
		.cell-label {
			display: block;
			font-size: 0.75rem;
			font-weight: 600;
			color: var(--text-2);
			margin-bottom: 0.15rem;
		}
		/* A share or a total reads as one line: "Flow share in use 55.81%". */
		.net .share .cell-label,
		.net tfoot .cell-label {
			display: inline;
			margin: 0;
		}
		.net .share {
			grid-column: 1 / -1;
		}
		.net tfoot tr {
			grid-template-columns: 1fr;
			gap: 0.25rem;
			background: var(--surface-2);
			border-top: 2px solid var(--border-strong);
			font-variant-numeric: tabular-nums;
		}
		.net tr.drop-before {
			box-shadow: inset 0 2px 0 var(--accent);
		}
		.net tr.drop-after {
			box-shadow: inset 0 -2px 0 var(--accent);
		}
	}
</style>
