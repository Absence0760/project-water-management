<script lang="ts">
	// Schematic of the drains-into tree: headwaters at the top, the outflow
	// gauge at the bottom, river lines thickening with upstream area, and
	// transfers as dashed arrows. The drawing is a visual aid: click a node to
	// edit it, or (editors) drag it onto another node to change what it drains
	// into. The "Drains into" selects are the keyboard path to the same edit;
	// the list below the drawing is its text equivalent.
	import { MediaQuery } from 'svelte/reactivity';
	import type { NetworkNode, Transfer } from '@water-management/engine';
	import { fmtNum } from '$lib/format/number';
	import { drainageTree } from '$lib/model/tree';
	import { fmtVolume, hasDam } from './fields';
	import { canDrainInto, validDropTargets } from './reorder';
	import {
		bandCrossings,
		distinctShortNames,
		labelBox,
		measuredWidths,
		paperBands,
		schematicLayout,
		symbolBox,
		transferPathData,
		wrappedSchematicLayout,
		type Point,
		type SchematicEdge,
		type SchematicNode,
		type Segment
	} from './schematic';
	import type { Colouring } from './farmColour';

	let {
		nodes,
		transfers = [],
		selectedId = null,
		onselect,
		editable = false,
		onreparent,
		colouring = null,
		fill = false,
		paper = false
	}: {
		nodes: NetworkNode[];
		transfers?: Transfer[];
		selectedId?: string | null;
		onselect?: (id: string) => void;
		/** Allow dragging a node onto another to re-point "drains into". */
		editable?: boolean;
		onreparent?: (id: string, drainsInto: string) => void;
		/** Colour farms by supply, dam level or irrigated area (farmColour.ts); null = the plain drawing. */
		colouring?: Colouring | null;
		/**
		 * Fill the box it sits in (the Network's Map layout, issue #17): the
		 * columns and rows spread out to the box's width and height (at most
		 * FILL_MAX_SPREAD times their usual spacing), text at its usual size; a
		 * network too big for the box keeps the usual spacing and scrolls. The
		 * legend is one line. The parent gives it its height.
		 */
		fill?: boolean;
		/**
		 * The printed report's drawing: at most PAPER_COLS columns wide, branches
		 * that don't fit side by side wrapped onto more rows (wrappedSchematicLayout),
		 * so it prints at A4 width with its names at a readable size. Not for screen.
		 */
		paper?: boolean;
	} = $props();

	/**
	 * Columns on paper: a drawing this wide is ~790 px, more for a long second
	 * line (~860 px for 30 units with dams), which A4 prints at ≥ ~80 %, so
	 * names stay at ≥ 7 pt of type (~7.6 pt there; report-schematic-print.spec.ts
	 * measures them in the PDF).
	 */
	const PAPER_COLS = 5;
	// Ids for the drawing's markers and hatch: the report draws it twice (screen and paper).
	const uid = $props.id();

	const FILL_MAX_SPREAD = 1.8;
	const wide = new MediaQuery('min-width: 900px');
	let boxW = $state(0);
	let boxH = $state(0);

	const supplyOf = (id: string) => colouring?.byNode.get(id);
	const legend = $derived(colouring?.legend ?? []);
	// The map key lists only what the drawing has, so no entry sends the eye looking for a shape that isn't there.
	const has = $derived({
		unit: nodes.some((n) => n.kind === 'farm' && !hasDam(n)),
		dam: nodes.some((n) => n.kind === 'farm' && hasDam(n)),
		gauge: nodes.some((n) => n.kind === 'gauge' && n.downstreamNodeId !== null),
		outlet: nodes.some((n) => n.kind === 'gauge' && n.downstreamNodeId === null),
		user: nodes.some((n) => n.kind === 'user'),
		transfer: transfers.length > 0
	});
	const COLOUR_HEADING = { supply: 'Colour: supply', dam: 'Colour: dam level' } as const;

	const name = (n: NetworkNode) => n.name || '(unnamed)';
	// Names as drawn: at most 17 characters, and never two different names cut to the same text.
	const shortNames = $derived.by(() => {
		const cut = distinctShortNames(nodes.map(name));
		return new Map(nodes.map((n, i) => [n.id, cut[i]!]));
	});
	const short = (n: NetworkNode) => shortNames.get(n.id) ?? name(n);

	// The labels' widths in the font they are drawn in (the system's sans, which
	// varies: DejaVu Sans draws ~15 % wider than the estimate), so the column
	// spacing and the transfers' routing keep clear of the text actually drawn.
	// Measured on a canvas in the drawing's font (.label / .meta below); the
	// meta line's digits are tabular there, so they're measured as zeros.
	const widths = (() => {
		const ctx = typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d');
		if (!ctx) return undefined;
		const family = getComputedStyle(document.documentElement).getPropertyValue('--font-sans').trim() || 'sans-serif';
		const fonts = { label: `600 12.5px ${family}`, meta: `11px ${family}` };
		const cache = new Map<string, number>();
		return measuredWidths((text, font) => {
			const s = font === 'meta' ? text.replace(/\d/g, '0') : text;
			const key = `${font}\n${s}`;
			let w = cache.get(key);
			if (w === undefined) {
				ctx.font = fonts[font];
				w = ctx.measureText(s).width;
				cache.set(key, w);
			}
			return w;
		});
	})();
	const isOutlet = (n: NetworkNode) => n.downstreamNodeId === null;
	const nameOf = (id: string) => nodes.find((n) => n.id === id)?.name || '(unnamed)';

	// --- drag to re-parent ------------------------------------------------------
	let svgEl: SVGSVGElement | undefined = $state();
	type Drag = { id: string; x: number; y: number; sx: number; sy: number; moved: boolean; over: string | null; valid: Set<string> };
	let drag = $state<Drag | null>(null);
	const dragName = $derived(drag ? nameOf(drag.id) : '');
	const overCheck = $derived(drag?.over ? canDrainInto(nodes, drag.id, drag.over) : null);

	function toSvg(e: PointerEvent) {
		const m = svgEl?.getScreenCTM();
		if (!svgEl || !m) return { x: 0, y: 0 };
		const pt = svgEl.createSVGPoint();
		pt.x = e.clientX;
		pt.y = e.clientY;
		const p = pt.matrixTransform(m.inverse());
		return { x: p.x, y: p.y };
	}
	function nearest(x: number, y: number, except: string): string | null {
		let best: string | null = null;
		let bestD = 30;
		for (const [id, p] of pos) {
			if (id === except) continue;
			const d = Math.hypot(p.x - x, p.y - y);
			if (d < bestD) {
				bestD = d;
				best = id;
			}
		}
		return best;
	}
	function onDown(e: PointerEvent, id: string) {
		if (!editable || e.button !== 0) return;
		(e.currentTarget as Element).setPointerCapture(e.pointerId);
		const p = toSvg(e);
		drag = { id, ...p, sx: p.x, sy: p.y, moved: false, over: null, valid: validDropTargets(nodes, id) };
	}
	function onMove(e: PointerEvent) {
		if (!drag) return;
		const p = toSvg(e);
		drag.x = p.x;
		drag.y = p.y;
		if (!drag.moved && Math.hypot(p.x - drag.sx, p.y - drag.sy) > 5) drag.moved = true;
		drag.over = drag.moved ? nearest(p.x, p.y, drag.id) : null;
	}
	function onUp() {
		const d = drag;
		drag = null;
		if (!d) return;
		if (!d.moved) onselect?.(d.id);
		else if (d.over && d.valid.has(d.over)) {
			const current = nodes.find((n) => n.id === d.id)?.downstreamNodeId;
			if (current !== d.over) onreparent?.(d.id, d.over);
			onselect?.(d.id);
		}
	}
	function onKey(e: KeyboardEvent) {
		if (e.key === 'Escape' && drag) drag = null;
	}

	const COL_W = 150;
	const ROW_H = 74;
	/** Spacing to fill the box (fill mode): at least `min`, at most FILL_MAX_SPREAD times the usual spacing. */
	const spread = (min: number, usual: number, room: number, gaps: number) =>
		fill && gaps > 0 && room > 0 ? Math.min(usual * FILL_MAX_SPREAD, Math.max(min, room / gaps)) : min;
	const PAD_X = 24;
	const PAD_Y = 22;

	const layout = $derived(paper ? wrappedSchematicLayout(nodes, PAPER_COLS) : schematicLayout(nodes));
	// Fill mode sizes the columns from the labels actually drawn, not the widest possible one, so a
	// catchment that fits the card isn't pushed off its right edge. Columns are at least wide enough
	// that no label runs into the next node on its row; they spread as far as every node's label still ends inside
	// the box (at most FILL_MAX_SPREAD × the usual spacing); and the drawing ends at the right-most
	// label. Elsewhere (the report, on screen and paper): the fixed spacing, widened only where a
	// label drawn in a wide font would run into the next node on its row.
	const labelRight = (ln: SchematicNode) => labelBox({ x: 0, y: 0 }, short(ln.node), metaText(ln), widths).x1 + 8;
	// A label only needs clearing where another node sits to its right on the same row.
	const minColW = $derived.by(() => {
		let need = 60;
		const rows = new Map<number, SchematicNode[]>();
		for (const n of layout.nodes) rows.set(n.row, [...(rows.get(n.row) ?? []), n]);
		for (const row of rows.values()) {
			row.sort((a, b) => a.col - b.col);
			for (let i = 1; i < row.length; i++) need = Math.max(need, (labelRight(row[i - 1]!) + 4) / (row[i]!.col - row[i - 1]!.col));
		}
		return fill ? need : Math.max(COL_W, need);
	});
	const fitColW = $derived(
		Math.min(Infinity, ...layout.nodes.filter((n) => n.col > 0).map((n) => (boxW - 2 - PAD_X * 2 - 12 - labelRight(n)) / n.col))
	);
	const colW = $derived(fill && boxW > 0 && layout.cols > 1 ? Math.max(minColW, Math.min(COL_W * FILL_MAX_SPREAD, fitColW)) : minColW);
	const rightEdge = $derived(fill || paper ? Math.max(0, ...layout.nodes.map((n) => n.col * colW + labelRight(n))) : 0);
	// Rows spread only where the parent fixes the box's height (the Map layout from 900 px); below that
	// the box is as tall as the drawing, and spreading to it would feed back on itself.
	const rowH = $derived(wide.current ? spread(ROW_H, ROW_H, boxH - 2 - PAD_Y * 2 - 30, layout.rows - 1) : ROW_H);
	const tree = $derived(drainageTree(nodes));
	const pos = $derived(
		new Map(layout.nodes.map((n) => [n.node.id, { x: PAD_X + 12 + n.col * colW, y: PAD_Y + n.row * rowH }]))
	);
	const width = $derived(fill || paper ? PAD_X * 2 + 12 + rightEdge : PAD_X * 2 + 12 + (layout.cols - 1) * colW + 126);
	const height = $derived(PAD_Y * 2 + Math.max(layout.rows - 1, 0) * rowH + 30);
	const maxArea = $derived(Math.max(1e-9, ...layout.nodes.map((n) => n.cumulativeAreaKm2)));
	const areaOf = $derived(new Map(layout.nodes.map((n) => [n.node.id, n.cumulativeAreaKm2])));

	const strokeFor = (id: string) => 1.5 + 4 * Math.sqrt((areaOf.get(id) ?? 0) / maxArea);

	/** A river's corners: down from the node, along its confluence line, down into the node it drains into. */
	function edgePoints(fromId: string, toId: string, via?: number): Point[] {
		const a = pos.get(fromId);
		const b = pos.get(toId);
		if (!a || !b) return [];
		const midY = b.y - rowH / 2;
		// A wrapped row (paper): under its own row to the gutter, down it, then into the node's confluence line.
		if (via !== undefined) {
			const gx = PAD_X + 12 + via * colW;
			const y = a.y + rowH / 2;
			return [{ x: a.x, y: a.y + 10 }, { x: a.x, y }, { x: gx, y }, { x: gx, y: midY }, { x: b.x, y: midY }, { x: b.x, y: b.y - 13 }];
		}
		if (Math.abs(a.x - b.x) < 0.5) return [{ x: a.x, y: a.y + 10 }, { x: a.x, y: b.y - 13 }];
		return [{ x: a.x, y: a.y + 10 }, { x: a.x, y: midY }, { x: b.x, y: midY }, { x: b.x, y: b.y - 13 }];
	}
	const edgePath = (fromId: string, toId: string, via?: number) =>
		edgePoints(fromId, toId, via).map((p, i) => `${i ? 'L' : 'M'}${p.x},${p.y}`).join(' ');
	// Every straight piece of every river: a routed transfer may cross them but not run along them.
	const riverSegments = $derived(
		layout.edges.flatMap((e): Segment[] => {
			const pts = edgePoints(e.from, e.to, e.via);
			return pts.slice(1).map((b, i) => ({ a: pts[i]!, b }));
		})
	);

	const metaText = (ln: SchematicNode) => {
		const s = supplyOf(ln.node.id);
		// Coloured, a farm's second line is what it's coloured by alone ("82% supplied", "64% full"):
		// with the area and dam as well it ran into the next column's label. Both stay in its tooltip.
		if (s) return s.text;
		return `${isOutlet(ln.node) ? 'outflow · ' : ''}${fmtNum(ln.cumulativeAreaKm2, 1)} km²${hasDam(ln.node) ? ` · ${fmtVolume(ln.node.damCapacityM3)}` : ''}`;
	};

	// What a transfer arc must not cross: every label, and every symbol but its own two ends.
	const labels = $derived(layout.nodes.map((ln) => labelBox(pos.get(ln.node.id)!, short(ln.node), metaText(ln), widths)));
	const symbols = $derived(layout.nodes.map((ln) => ({ id: ln.node.id, box: symbolBox(pos.get(ln.node.id)!) })));

	/**
	 * What one SVG draws: rows between y0 and y1 of the whole drawing, and the
	 * columns (px) where rivers run off its bottom (`outs`) and on from its top (`ins`).
	 */
	type View = { key: string; y0: number; y1: number; nodes: SchematicNode[]; edges: SchematicEdge[]; outs: number[]; ins: number[] };
	/**
	 * A4 inside the report's `@page` margins (14 mm 12 mm), in CSS px: the
	 * paper drawing prints at most this wide, scaled down to fit.
	 */
	const PAGE_W = 703;
	const PAGE_H = 1016;
	/** Room on a band's page for the section heading (first band), a continuation note above and below, and some slack. */
	const HEADING_H = 60;
	const NOTE_H = 22;
	const SLACK = 16;
	// On paper, a drawing taller than its page is split into page-high bands at row boundaries
	// (paperBands), each its own SVG that prints whole; one that fits prints as one, as on screen.
	const views = $derived.by((): View[] => {
		const whole: View = { key: 'all', y0: 0, y1: height, nodes: layout.nodes, edges: layout.edges, outs: [], ins: [] };
		if (!paper) return [whole];
		const scale = Math.min(1, PAGE_W / width);
		if (height * scale <= PAGE_H - HEADING_H - SLACK) return [whole];
		const rest = (PAGE_H - 2 * NOTE_H - SLACK) / scale;
		const bands = paperBands({ rows: layout.rows, rowH, padY: PAD_Y, height }, { first: rest - HEADING_H / scale, rest });
		if (bands.length < 2) return [whole];
		const rowOf = new Map(layout.nodes.map((n) => [n.node.id, n.row]));
		const xOf = (col: number) => PAD_X + 12 + col * colW;
		return bands.map((b, i) => ({
			key: String(b.first),
			y0: b.y0,
			y1: b.y1,
			nodes: layout.nodes.filter((n) => n.row >= b.first && n.row <= b.last),
			// A river drawn in every band it passes through; the band's edges clip it.
			edges: layout.edges.filter((e) => (rowOf.get(e.from) ?? -1) <= b.last && (rowOf.get(e.to) ?? -1) >= b.first),
			outs: i < bands.length - 1 ? bandCrossings(layout, b.last).map(xOf) : [],
			ins: i > 0 ? bandCrossings(layout, b.first - 1).map(xOf) : []
		}));
	});

	// Worked out once per layout, not on every redraw (a drag redraws on every pointer move).
	const transferPaths = $derived(new Map(transfers.map((t) => [t.id, transferPath(t)])));

	function transferPath(t: Transfer): string {
		const a = pos.get(t.fromNodeId);
		const b = pos.get(t.toNodeId);
		if (!a || !b || t.fromNodeId === t.toNodeId) return '';
		const others = symbols.filter((s) => s.id !== t.fromNodeId && s.id !== t.toNodeId).map((s) => s.box);
		return transferPathData(a, b, [...labels, ...others], { x0: 0, y0: 0, x1: width, y1: height }, riverSegments).d;
	}

</script>

<svelte:window onkeydown={onKey} />

<!-- The map key, in groups (the shapes, the lines, what the colour means), each
     swatch drawn with the map's own shapes and classes so it looks like what it
     names. A colour band shows a unit and a unit with a dam side by side: the
     colour fills either shape. Hidden from assistive tech: each node's name,
     kind and band are in the drainage tree and its label line. -->
{#snippet mapKey()}
	<div class="key" aria-hidden="true" data-testid="map-key">
		<ul class="legend">
			<li class="key-h">Nodes</li>
			{#if has.unit}<li><svg width="18" height="18" viewBox="-10 -10 20 20"><circle class="farm" r="8" /></svg> Hydrological unit</li>{/if}
			{#if has.dam}
				<li>
					<svg width="18" height="18" viewBox="-10 -10 20 20"><rect class="farm dam" x="-9" y="-9" width="18" height="18" rx="3" /><path class="dam-water" d="M-6,1 q3,-3 6,0 t6,0" /></svg>
					Hydrological unit with a dam
				</li>
			{/if}
			{#if has.gauge}<li><svg width="18" height="18" viewBox="-10 -10 20 20"><path class="gauge" d="M-9,-7 H9 L0,9 Z" /></svg> Gauge</li>{/if}
			{#if has.outlet}<li><svg width="20" height="18" viewBox="-13 -10 26 22"><path class="gauge outlet" d="M-12,-9 H12 L0,11 Z" /></svg> Outflow gauge</li>{/if}
			{#if has.user}<li><svg width="18" height="18" viewBox="-11 -11 22 22"><path class="user" d="M0,-10 L10,0 L0,10 L-10,0 Z" /></svg> Other water user</li>{/if}
		</ul>
		<ul class="legend">
			<li class="key-h">Lines</li>
			<li>
				<svg width="34" height="12" viewBox="0 0 34 12"><path class="arrow-river" d="M1,5.3 L25,3.6 L25,1.5 L33,6 L25,10.5 L25,8.4 L1,6.7 Z" /></svg>
				River, thicker with more area upstream
			</li>
			{#if has.transfer}<li><svg width="30" height="12" viewBox="0 0 30 12"><path class="transfer" d="M1,6 H22" /><path class="arrow-transfer" d="M22,2 L29,6 L22,10 z" /></svg> Transfer</li>{/if}
		</ul>
		{#if colouring && legend.length}
			<ul class="legend">
				<li class="key-h">{COLOUR_HEADING[colouring.mode]}</li>
				{#each legend as l (l.band)}
					<li data-supply={l.band}>
						<svg width="36" height="18" viewBox="-10 -10 38 20"><circle class="farm" r="8" /><rect class="farm" x="10" y="-8" width="16" height="16" rx="3" /></svg>
						{l.label}
					</li>
				{/each}
			</ul>
		{/if}
	</div>
{/snippet}

{#snippet drawing(v: View, id: string)}
	<svg
		bind:this={svgEl}
		viewBox="0 {v.y0} {width} {v.y1 - v.y0}"
		width={width}
		height={v.y1 - v.y0}
		aria-hidden="true"
		class="schematic"
		class:dragging={drag?.moved}
		style:--sch-hatch="url(#{id}-hatch)"
	>
		<defs>
			<marker id="{id}-flow" viewBox="0 0 8 8" refX="7" refY="4" markerUnits="userSpaceOnUse" markerWidth="9" markerHeight="9" orient="auto-start-reverse">
				<path d="M0,0 L8,4 L0,8 z" class="arrow-river" />
			</marker>
			<!-- Fill for farms in the model but not in the run being coloured by. -->
			<pattern id="{id}-hatch" patternUnits="userSpaceOnUse" width="4" height="4" patternTransform="rotate(45)">
				<rect class="hatch-bg" width="4" height="4" />
				<line class="hatch-line" x1="0" y1="0" x2="0" y2="4" />
			</pattern>
			<marker id="{id}-transfer" viewBox="0 0 8 8" refX="7" refY="4" markerUnits="userSpaceOnUse" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
				<path d="M0,0 L8,4 L0,8 z" class="arrow-transfer" />
			</marker>
		</defs>

		{#each v.edges as e (e.from)}
			<path class="river" d={edgePath(e.from, e.to, e.via)} stroke-width={strokeFor(e.from)} marker-end="url(#{id}-flow)" />
		{/each}

		{#each transfers as t (t.id)}
			{@const d = transferPaths.get(t.id)}
			{#if d}
				<path class="transfer" class:off={!t.enabled} d={d} marker-end="url(#{id}-transfer)">
					<title>Transfer {nameOf(t.fromNodeId)} → {nameOf(t.toNodeId)}{t.enabled ? '' : ' (disabled)'}</title>
				</path>
			{/if}
		{/each}

		{#if drag?.moved}
			{@const from = pos.get(drag.id)}
			{#if from}
				<line class="preview" class:bad={overCheck && !overCheck.ok} x1={from.x} y1={from.y} x2={drag.x} y2={drag.y} />
			{/if}
		{/if}

		{#each v.nodes as ln (ln.node.id)}
			{@const p = pos.get(ln.node.id)!}
			{@const n = ln.node}
			{@const dam = hasDam(n)}
			{@const sup = supplyOf(n.id)}
			<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
			<g
				class="node"
				class:selected={n.id === selectedId}
				class:editable
				class:drop-ok={drag?.moved && drag.id !== n.id && drag.valid.has(n.id)}
				class:drop-no={drag?.moved && drag.id !== n.id && !drag.valid.has(n.id)}
				class:drop-over={drag?.moved && drag.over === n.id}
				class:dragged={drag?.moved && drag.id === n.id}
				data-supply={sup?.band}
				transform="translate({p.x},{p.y})"
				onclick={() => !editable && onselect?.(n.id)}
				onpointerdown={(e) => onDown(e, n.id)}
				onpointermove={onMove}
				onpointerup={onUp}
				onpointercancel={() => (drag = null)}
			>
				<title>{name(n)} ({n.kind === 'user' ? 'other water user' : n.kind}{isOutlet(n) ? ', outflow gauge' : ''}){n.kind === 'user' ? '' : ` · ${fmtNum(n.areaKm2, 2)} km²`}{dam ? ` · dam ${fmtVolume(n.damCapacityM3)}` : ''}{sup ? ` · ${sup.text}` : ''}</title>
				<circle class="halo" r="17" />
				{#if n.kind === 'user'}
					<!-- An other water user (WP-1.33): a diamond, a tap on the river. -->
					<path class="user" d="M0,-10 L10,0 L0,10 L-10,0 Z" />
				{:else if n.kind === 'gauge'}
					<path class="gauge" class:outlet={isOutlet(n)} d={isOutlet(n) ? 'M-12,-9 H12 L0,11 Z' : 'M-9,-7 H9 L0,9 Z'} />
				{:else if dam}
					<rect class="farm dam" x="-9" y="-9" width="18" height="18" rx="3" />
					<path class="dam-water" d="M-6,1 q3,-3 6,0 t6,0" />
				{:else}
					<circle class="farm" r="8" />
				{/if}
				<text class="label" x="17" y="-2">{short(n)}</text>
				<text class="meta" x="17" y="12">{metaText(ln)}</text>
			</g>
		{/each}

		<!-- On paper, where a band is cut: an arrowhead on each river running off its foot or on from its top. -->
		{#each v.outs as x (x)}
			<path class="arrow-river continues" d="M{x - 5},{v.y1 - 8} h10 l-5,7 z" />
		{/each}
		{#each v.ins as x (x)}
			<path class="arrow-river continues" d="M{x - 5},{v.y0 + 1} h10 l-5,7 z" />
		{/each}
	</svg>
{/snippet}

{#if nodes.length === 0}
	<p class="muted">Add nodes to see how water flows through the catchment.</p>
{:else}
	<!-- The drawing's tokens sit on this box, so the map key under the drawing is drawn in the same colours (and hatch) as the map. -->
	<div class="sch" class:fill style:--sch-hatch="url(#{views.length > 1 ? `${uid}-0` : uid}-hatch)">
	<!-- data-fit: the box size (and the media state) the drawing on screen was laid out for. A resize
	     reaches the layout a frame or more later (the box's ResizeObserver, the media query's change
	     event), so the drawing is settled only once this matches the box as it is now (e2e waits on
	     that, support/diagrams.ts mapFitted). -->
	<div
		class="scroller"
		class:fill
		class:banded={views.length > 1}
		data-scroll-region
		data-scroll-label="Schematic drawing"
		data-fit="{boxW}x{boxH}{wide.current ? ' wide' : ''}"
		bind:clientWidth={boxW}
		bind:clientHeight={boxH}
	>
		{#if views.length === 1}
			{@render drawing(views[0]!, uid)}
		{:else}
			<!-- Paper, taller than a page: one SVG per page-high band, each printed whole. -->
			{#each views as v, i (v.key)}
				<div class="band">
					{#if i > 0}<p class="band-note">Continued from the previous page: rivers run on from the top.</p>{/if}
					{@render drawing(v, `${uid}-${i}`)}
					{#if i < views.length - 1}<p class="band-note">Continues on the next page: rivers run off the foot.</p>{/if}
				</div>
			{/each}
		{/if}
	</div>

	{#if fill}
		<!-- One line under the map: the shapes, the supply bands and the run
		     they come from, then the drag hint. While dragging, the hint is the
		     live drop status instead. -->
		<div class="legend-line">
			{@render mapKey()}
			{#if colouring}
				<p class="supply-run">
					{colouring.caption}
					{#if colouring.unsaved}<strong>The colours show that run, not your unsaved changes.</strong>{/if}
				</p>
			{/if}
			{#if editable}
				<p class="drag-status" aria-live="polite">
					{#if drag?.moved}
						{#if overCheck && !overCheck.ok}
							Can't drop here: {overCheck.reason}.
						{:else if drag.over}
							Release to make {dragName} drain into {nameOf(drag.over)}.
						{:else if drag.valid.size === 0}
							{nodes.find((n) => n.id === drag?.id)?.downstreamNodeId === null
								? `${dragName} is the outflow gauge and stays at the outlet; use "Make outflow gauge" on another node to change that.`
								: `No other node can take ${dragName} without making a loop.`}
						{:else}
							Drop {dragName} on the node it should drain into. Esc cancels.
						{/if}
					{:else}
						Drag a node onto another to change what it drains into.
					{/if}
				</p>
			{/if}
		</div>
	{:else}
	{#if editable}
		<p class="drag-status" aria-live="polite">
			{#if drag?.moved}
				{#if overCheck && !overCheck.ok}
					Can't drop here: {overCheck.reason}.
				{:else if drag.over}
					Release to make {dragName} drain into {nameOf(drag.over)}.
				{:else if drag.valid.size === 0}
					{nodes.find((n) => n.id === drag?.id)?.downstreamNodeId === null
						? `${dragName} is the outflow gauge and stays at the outlet; use "Make outflow gauge" on another node to change that.`
						: `No other node can take ${dragName} without making a loop.`}
				{:else}
					Drop {dragName} on the node it should drain into. Esc cancels.
				{/if}
			{:else}
				Tip: drag a node onto another to change what it drains into.
			{/if}
		</p>
	{/if}

	{@render mapKey()}
	{#if colouring}
		<!-- Read out (not aria-hidden): what the colours show and from which run.
		     The bands themselves are also in each node's label and the drainage tree. -->
		<div class="supply-legend">
			<p class="supply-run">
				{colouring.caption}
				{#if colouring.unsaved}<strong>The colours show that run, not your unsaved changes.</strong>{/if}
			</p>
		</div>
	{/if}

	{/if}
	</div>

	<!-- Text equivalent of the drawing: each node under the node it drains into. -->
	<ul class="visually-hidden" aria-label="Drainage tree">
		{#each tree.rows as row (row.node.id)}
			{@const sup = supplyOf(row.node.id)}
			<li>
				{name(row.node)}, {row.node.kind}{row.depth === 0 && row.node.downstreamNodeId === null ? ', outlet' : ''}, level {row.depth + 1}{sup ? `, ${sup.text}` : ''}
			</li>
		{/each}
	</ul>

	{#if tree.orphans.length}
		<div class="alert alert-warning" role="status">
			Not connected to an outlet (loop):
			{tree.orphans.map((n) => n.name || '(unnamed)').join(', ')}
		</div>
	{/if}
{/if}

<style>
	.scroller {
		overflow-x: auto;
		overscroll-behavior-x: contain;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--surface-sunken);
	}
	/* Tokens for the drawing and its key, following light/dark mode. */
	.sch {
		--sch-river: var(--brand-outlet);
		--sch-node: var(--text);
		--sch-fill: var(--surface);
		--sch-transfer: #7a4fc4;
		/* What the labels' halo is drawn in: the drawing's own ground. */
		--sch-ground: var(--surface-sunken);
	}
	@media (prefers-color-scheme: dark) {
		:global(:root:not([data-theme='light'])) .sch {
			--sch-transfer: #b79cf0;
		}
	}
	:global(:root[data-theme='dark']) .sch {
		--sch-transfer: #b79cf0;
	}
	.schematic {
		display: block;
		margin: 0 auto;
		font-family: var(--font-sans);
	}
	/* Fill mode: a flex column the parent sizes; the drawing's box takes the
	   height left after the legend line and scrolls both ways when the
	   network is bigger than it. */
	.sch.fill {
		display: flex;
		flex-direction: column;
		height: 100%;
		min-height: 0;
	}
	.scroller.fill {
		flex: 1;
		min-height: 0;
		display: flex;
		/* Centred while it fits; top-aligned once it is taller than the box, or
		   its top row (names and all) is cut off where the box can't scroll to. */
		align-items: safe center;
		overflow: auto;
	}
	.legend-line {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.2rem 1rem;
		margin-top: 0.5rem;
		font-size: 0.8rem;
		color: var(--text-2);
	}
	.legend-line .legend,
	.legend-line p {
		margin: 0;
	}
	.legend-line .drag-status {
		color: var(--text-muted);
	}
	/* A flex item would otherwise shrink below its size instead of scrolling. */
	.scroller.fill .schematic {
		flex: none;
	}
	@media (max-width: 899px) {
		.scroller.fill {
			flex: none;
		}
	}
	.river {
		fill: none;
		stroke: var(--sch-river);
		stroke-linejoin: round;
	}
	.arrow-river {
		fill: var(--sch-river);
	}
	.transfer {
		fill: none;
		stroke: var(--sch-transfer);
		stroke-width: 1.6;
		stroke-dasharray: 5 4;
	}
	.transfer.off {
		opacity: 0.45;
	}
	.arrow-transfer {
		fill: var(--sch-transfer);
	}
	.schematic {
		user-select: none;
	}
	.node {
		cursor: pointer;
	}
	.node.editable {
		cursor: grab;
		touch-action: none;
	}
	.dragging .node {
		cursor: grabbing;
	}
	.node.drop-no {
		opacity: 0.3;
	}
	.node.drop-ok .halo {
		stroke: var(--success);
		stroke-width: 1.5;
		stroke-dasharray: 3 2;
	}
	.node.drop-over .halo {
		fill: color-mix(in srgb, var(--success) 22%, transparent);
		stroke-dasharray: none;
		stroke-width: 2.5;
	}
	.node.drop-over.drop-no .halo {
		fill: color-mix(in srgb, var(--danger) 22%, transparent);
		stroke: var(--danger);
	}
	.node.dragged {
		opacity: 0.6;
	}
	.preview {
		stroke: var(--success);
		stroke-width: 2;
		stroke-dasharray: 4 3;
	}
	.preview.bad {
		stroke: var(--danger);
	}
	.drag-status {
		margin: 0.5rem 0 0;
		font-size: 0.8rem;
		color: var(--text-muted);
		min-height: 1.2em;
	}
	.halo {
		fill: transparent;
		stroke: none;
	}
	.node:hover .halo {
		fill: color-mix(in srgb, var(--accent) 12%, transparent);
	}
	.node.selected .halo {
		fill: color-mix(in srgb, var(--accent) 16%, transparent);
		stroke: var(--accent);
		stroke-width: 2;
	}
	.farm {
		fill: var(--sch-fill);
		stroke: var(--sch-node);
		stroke-width: 1.8;
	}
	.farm.dam {
		fill: color-mix(in srgb, var(--sch-river) 30%, var(--sch-fill));
	}
	/* Colour by supply (data-supply on a node, or on a legend item). The three
	   bands step in lightness as well as hue in both themes (light → mid →
	   strong on the light surface, dark → mid → bright on the dark one), so
	   they read apart without colour vision. Selection, hover and drop states
	   live on the halo and on opacity, so they are untouched. */
	[data-supply='met'] .farm {
		fill: color-mix(in srgb, var(--success) 25%, var(--sch-fill));
	}
	[data-supply='short'] .farm {
		fill: color-mix(in srgb, var(--warning) 60%, var(--sch-fill));
	}
	[data-supply='low'] .farm {
		fill: var(--danger);
	}
	[data-supply='low'] .dam-water {
		stroke: var(--sch-fill);
	}
	[data-supply='none'] .farm {
		fill: var(--sch-fill);
		stroke-dasharray: 2 2;
	}
	[data-supply='absent'] .farm {
		fill: var(--sch-hatch);
		stroke: var(--text-muted);
		stroke-dasharray: 3 2;
	}
	.hatch-bg {
		fill: var(--sch-fill);
	}
	.hatch-line {
		stroke: var(--text-muted);
		stroke-width: 1.2;
	}
	.supply-legend {
		margin-top: 0.4rem;
	}
	.supply-run {
		margin: 0;
		font-size: 0.8rem;
		color: var(--text-2);
	}
	.supply-legend .legend {
		margin-top: 0.3rem;
	}
	.dam-water {
		fill: none;
		stroke: var(--sch-node);
		stroke-width: 1.3;
	}
	.gauge {
		fill: var(--sch-fill);
		stroke: var(--sch-node);
		stroke-width: 1.8;
		stroke-linejoin: round;
	}
	.gauge.outlet {
		fill: var(--sch-node);
	}
	.user {
		fill: var(--sch-fill);
		stroke: var(--warning);
		stroke-width: 1.8;
		stroke-linejoin: round;
	}
	/* Labels: the name strong, its figure a step down in size, weight and
	   colour (both ≥ 4.5:1 on the ground in either theme). Each carries a halo
	   in the ground's colour, so a line that has to pass (a transfer with no
	   clear way round, the drag preview) breaks behind the words instead of
	   striking through them. */
	.label,
	.meta {
		paint-order: stroke fill;
		stroke: var(--sch-ground);
		stroke-width: 4px;
		stroke-linejoin: round;
	}
	/* No halo on paper. Chromium prints stroked text as a second copy of every
	   word (a Type 3 font drawing the stroke), so the PDF's text held each name
	   twice: found twice by a search, pasted twice, and read out twice by a
	   PDF text reader (poppler before 25 lists both; report-schematic-print.spec.ts).
	   Paper needs no halo: nothing is dragged there, and the routed transfers
	   clear every label (diagram-labels.spec.ts checks the printed drawing). */
	@media print {
		.label,
		.meta {
			stroke: none;
		}
	}
	.label {
		font-size: 12.5px;
		font-weight: 600;
		fill: var(--text);
	}
	.meta {
		font-size: 11px;
		fill: var(--text-muted);
		font-variant-numeric: tabular-nums;
	}
	.legend {
		list-style: none;
		display: flex;
		flex-wrap: wrap;
		gap: 0.3rem 1rem;
		margin: 0.6rem 0 0;
		padding: 0;
		font-size: 0.8rem;
		color: var(--text-2);
	}
	.legend li {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
	}
	.legend svg {
		overflow: visible;
		flex: none;
	}
	/* The key: one group per row on a phone, side by side when there is room,
	   each led by its heading so shapes and colours don't read as one list. */
	.key {
		flex-basis: 100%;
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem 2rem;
		margin-top: 0.6rem;
	}
	.key .legend {
		margin: 0;
		gap: 0.3rem 0.9rem;
	}
	.key-h {
		font-weight: 600;
		color: var(--text);
	}
	/* Paper bands (taller than a page): each prints whole, its notes with it,
	   in a box of its own rather than one box broken across the pages. */
	.scroller.banded {
		border: 0;
		background: none;
	}
	.band {
		break-inside: avoid;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--surface-sunken);
	}
	.band + .band {
		margin-top: 0.75rem;
	}
	.band-note {
		margin: 0.2rem 0.5rem;
		font-size: 0.75rem;
		color: var(--text-muted);
	}
	.alert {
		margin-top: 0.75rem;
		font-size: 0.85rem;
	}
</style>
