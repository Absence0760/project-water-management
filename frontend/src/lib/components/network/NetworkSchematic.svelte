<script lang="ts">
	// Schematic of the drains-into tree: headwaters at the top, the outflow
	// gauge at the bottom, river lines thickening with upstream area, and
	// transfers as dashed arrows. The drawing is a visual aid: click a node to
	// edit it, or (editors) drag it onto another node to change what it drains
	// into. The "Drains into" selects are the keyboard path to the same edit;
	// the list below the drawing is its text equivalent.
	import type { NetworkNode, Transfer } from '@water-management/engine';
	import { fmtNum } from '$lib/format/number';
	import { drainageTree } from '$lib/model/tree';
	import { fmtVolume, hasDam } from './fields';
	import { canDrainInto, validDropTargets } from './reorder';
	import { arcPath, labelBox, schematicLayout, symbolBox, transferArc, type SchematicNode } from './schematic';

	let {
		nodes,
		transfers = [],
		selectedId = null,
		onselect,
		editable = false,
		onreparent
	}: {
		nodes: NetworkNode[];
		transfers?: Transfer[];
		selectedId?: string | null;
		onselect?: (id: string) => void;
		/** Allow dragging a node onto another to re-point "drains into". */
		editable?: boolean;
		onreparent?: (id: string, drainsInto: string) => void;
	} = $props();

	const short = (s: string, n = 17) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
	const name = (n: NetworkNode) => n.name || '(unnamed)';
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
	const PAD_X = 24;
	const PAD_Y = 22;

	const layout = $derived(schematicLayout(nodes));
	const tree = $derived(drainageTree(nodes));
	const pos = $derived(
		new Map(layout.nodes.map((n) => [n.node.id, { x: PAD_X + 12 + n.col * COL_W, y: PAD_Y + n.row * ROW_H }]))
	);
	const width = $derived(PAD_X * 2 + 12 + (layout.cols - 1) * COL_W + 126);
	const height = $derived(PAD_Y * 2 + Math.max(layout.rows - 1, 0) * ROW_H + 30);
	const maxArea = $derived(Math.max(1e-9, ...layout.nodes.map((n) => n.cumulativeAreaKm2)));
	const areaOf = $derived(new Map(layout.nodes.map((n) => [n.node.id, n.cumulativeAreaKm2])));

	const strokeFor = (id: string) => 1.5 + 4 * Math.sqrt((areaOf.get(id) ?? 0) / maxArea);

	function edgePath(fromId: string, toId: string): string {
		const a = pos.get(fromId);
		const b = pos.get(toId);
		if (!a || !b) return '';
		const midY = b.y - ROW_H / 2;
		if (Math.abs(a.x - b.x) < 0.5) return `M${a.x},${a.y + 10} V${b.y - 13}`;
		return `M${a.x},${a.y + 10} V${midY} H${b.x} V${b.y - 13}`;
	}

	const metaText = (ln: SchematicNode) =>
		`${isOutlet(ln.node) ? 'outflow · ' : ''}${fmtNum(ln.cumulativeAreaKm2, 1)} km²${hasDam(ln.node) ? ` · ${fmtVolume(ln.node.damCapacityM3)}` : ''}`;

	// What a transfer arc must not cross: every label, and every symbol but its own two ends.
	const labels = $derived(layout.nodes.map((ln) => labelBox(pos.get(ln.node.id)!, short(name(ln.node)), metaText(ln))));
	const symbols = $derived(layout.nodes.map((ln) => ({ id: ln.node.id, box: symbolBox(pos.get(ln.node.id)!) })));

	function transferPath(t: Transfer): string {
		const a = pos.get(t.fromNodeId);
		const b = pos.get(t.toNodeId);
		if (!a || !b || t.fromNodeId === t.toNodeId) return '';
		const others = symbols.filter((s) => s.id !== t.fromNodeId && s.id !== t.toNodeId).map((s) => s.box);
		return arcPath(transferArc(a, b, [...labels, ...others], { x0: 0, y0: 0, x1: width, y1: height }));
	}

</script>

<svelte:window onkeydown={onKey} />

{#if nodes.length === 0}
	<p class="muted">Add nodes to see how water flows through the catchment.</p>
{:else}
	<div class="scroller" data-scroll-region data-scroll-label="Schematic drawing">
		<svg
			bind:this={svgEl}
			viewBox="0 0 {width} {height}"
			width={width}
			height={height}
			aria-hidden="true"
			class="schematic"
			class:dragging={drag?.moved}
		>
			<defs>
				<marker id="sch-flow" viewBox="0 0 8 8" refX="7" refY="4" markerUnits="userSpaceOnUse" markerWidth="9" markerHeight="9" orient="auto-start-reverse">
					<path d="M0,0 L8,4 L0,8 z" class="arrow-river" />
				</marker>
				<marker id="sch-transfer" viewBox="0 0 8 8" refX="7" refY="4" markerUnits="userSpaceOnUse" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
					<path d="M0,0 L8,4 L0,8 z" class="arrow-transfer" />
				</marker>
			</defs>

			{#each layout.edges as e (e.from)}
				<path class="river" d={edgePath(e.from, e.to)} stroke-width={strokeFor(e.from)} marker-end="url(#sch-flow)" />
			{/each}

			{#each transfers as t (t.id)}
				{@const d = transferPath(t)}
				{#if d}
					<path class="transfer" class:off={!t.enabled} d={d} marker-end="url(#sch-transfer)">
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

			{#each layout.nodes as ln (ln.node.id)}
				{@const p = pos.get(ln.node.id)!}
				{@const n = ln.node}
				{@const dam = hasDam(n)}
				<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
				<g
					class="node"
					class:selected={n.id === selectedId}
					class:editable
					class:drop-ok={drag?.moved && drag.id !== n.id && drag.valid.has(n.id)}
					class:drop-no={drag?.moved && drag.id !== n.id && !drag.valid.has(n.id)}
					class:drop-over={drag?.moved && drag.over === n.id}
					class:dragged={drag?.moved && drag.id === n.id}
					transform="translate({p.x},{p.y})"
					onclick={() => !editable && onselect?.(n.id)}
					onpointerdown={(e) => onDown(e, n.id)}
					onpointermove={onMove}
					onpointerup={onUp}
					onpointercancel={() => (drag = null)}
				>
					<title>{name(n)} ({n.kind}{isOutlet(n) ? ', outflow gauge' : ''}) · {fmtNum(n.areaKm2, 2)} km²{dam ? ` · dam ${fmtVolume(n.damCapacityM3)}` : ''}</title>
					<circle class="halo" r="17" />
					{#if n.kind === 'gauge'}
						<path class="gauge" class:outlet={isOutlet(n)} d={isOutlet(n) ? 'M-12,-9 H12 L0,11 Z' : 'M-9,-7 H9 L0,9 Z'} />
					{:else if dam}
						<rect class="farm dam" x="-9" y="-9" width="18" height="18" rx="3" />
						<path class="dam-water" d="M-6,1 q3,-3 6,0 t6,0" />
					{:else}
						<circle class="farm" r="8" />
					{/if}
					<text class="label" x="17" y="-2">{short(name(n))}</text>
					<text class="meta" x="17" y="12">{metaText(ln)}</text>
				</g>
			{/each}
		</svg>
	</div>

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

	<ul class="legend" aria-hidden="true">
		<li><svg width="16" height="16" viewBox="-9 -9 18 18"><circle class="farm" r="7" /></svg> Farm</li>
		<li>
			<svg width="16" height="16" viewBox="-9 -9 18 18"><rect class="farm dam" x="-8" y="-8" width="16" height="16" rx="3" /></svg>
			Farm with dam
		</li>
		<li><svg width="16" height="16" viewBox="-10 -9 20 18"><path class="gauge" d="M-9,-7 H9 L0,9 Z" /></svg> Gauge</li>
		<li><svg width="16" height="16" viewBox="-13 -10 26 22"><path class="gauge outlet" d="M-12,-9 H12 L0,11 Z" /></svg> Outflow gauge</li>
		<li><svg width="26" height="10" viewBox="0 0 26 10"><path class="transfer" d="M1,5 H24" /></svg> Transfer</li>
		<li class="muted">Line width grows with upstream area; labels show area incl. upstream.</li>
	</ul>

	<!-- Text equivalent of the drawing: each node under the node it drains into. -->
	<ul class="visually-hidden" aria-label="Drainage tree">
		{#each tree.rows as row (row.node.id)}
			<li>
				{name(row.node)}, {row.node.kind}{row.depth === 0 && row.node.downstreamNodeId === null ? ', outlet' : ''}, level {row.depth + 1}
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
		/* Tokens for the drawing, following light/dark mode. */
		--sch-river: var(--brand-outlet);
		--sch-node: var(--text);
		--sch-fill: var(--surface);
		--sch-transfer: #7a4fc4;
	}
	@media (prefers-color-scheme: dark) {
		:global(:root:not([data-theme='light'])) .scroller {
			--sch-transfer: #b79cf0;
		}
	}
	:global(:root[data-theme='dark']) .scroller {
		--sch-transfer: #b79cf0;
	}
	.schematic {
		display: block;
		margin: 0 auto;
		font-family: var(--font-sans);
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
		--sch-river: var(--brand-outlet);
		--sch-node: var(--text);
		--sch-fill: var(--surface);
		--sch-transfer: #7a4fc4;
	}
	.alert {
		margin-top: 0.75rem;
		font-size: 0.85rem;
	}
</style>
