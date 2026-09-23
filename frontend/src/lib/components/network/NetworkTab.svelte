<script lang="ts">
	import { onMount } from 'svelte';
	import { flowShares, type NodeKind, type ProjectSettings } from '@water-management/engine';
	import NumberInput from '$lib/components/common/NumberInput.svelte';
	import MoveControls from '$lib/components/model/MoveControls.svelte';
	import { refocusMover, RowReorder } from '$lib/components/model/rowReorder.svelte';
	import { fmtNum, fmtPct } from '$lib/format/number';
	import type { ModelEditor } from '$lib/model/editor.svelte';
	import { GROUPS, isPct, NODE_FIELDS, type NodeField } from './fields';
	import NetworkSchematic from './NetworkSchematic.svelte';
	import NodeDetail from './NodeDetail.svelte';
	import { flowPathOrder, makeOutlet, moveTo, renumber } from './reorder';

	let {
		editor,
		settings,
		readonly
	}: { editor: ModelEditor; settings?: ProjectSettings; readonly: boolean } = $props();

	const nodes = $derived(editor.model.nodes);
	const outletCount = $derived(nodes.filter((n) => n.downstreamNodeId === null).length);
	const farms = $derived(nodes.filter((n) => n.kind === 'farm'));
	const method = $derived(settings?.flowShareMethod ?? 'area');
	const shares = $derived(flowShares(nodes, method, settings?.hiLoSplit ?? { hi: 0.81, lo: 0.19 }));
	const shareOf = (i: number) => (nodes[i]?.kind === 'farm' ? (shares.share[i] ?? 0) : null);
	const METHOD_LABEL = { area: 'by area', hiLo: 'high/low MAP split', manual: 'manual shares' } as const;

	// Table (all nodes, every field) on wide screens; one node at a time with
	// help text on phones. Either can be picked.
	let view = $state<'table' | 'detail'>('table');
	onMount(() => {
		if (!matchMedia('(min-width: 900px)').matches) view = 'detail';
	});

	let selectedId = $state<string | null>(null);
	const selected = $derived(nodes.find((n) => n.id === selectedId) ?? nodes[0] ?? null);
	const selectedIndex = $derived(selected ? nodes.indexOf(selected) : -1);

	function select(id: string) {
		selectedId = id;
		if (view === 'table') {
			queueMicrotask(() => {
				const row = document.getElementById(`node-row-${id}`);
				row?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
				(row?.querySelector('input') as HTMLInputElement | null)?.focus({ preventScroll: true });
			});
		}
	}

	function add() {
		const n = editor.addNode();
		selectedId = n.id;
		queueMicrotask(() => document.getElementById(view === 'table' ? `node-name-${n.id}` : `nd-name-${n.id}`)?.focus());
	}

	function remove(id: string, name: string) {
		const refs = editor.model.transfers.filter((t) => t.fromNodeId === id || t.toNodeId === id).length;
		const areas = editor.model.cropAreas.filter((a) => a.nodeId === id).length;
		if ((refs || areas) && !confirm(`Remove "${name}"? Its ${areas} crop area(s) and ${refs} transfer(s) are removed too; nodes draining into it are re-routed downstream.`)) return;
		editor.removeNode(id);
		if (selectedId === id) selectedId = null;
	}

	// --- reordering (display order only; the model runs in topological order) ---
	let announce = $state('');
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
		for (const f of NODE_FIELDS) {
			const last = spans[spans.length - 1];
			if (last && last.group === f.group) last.count++;
			else spans.push({ group: f.group, count: 1 });
		}
		return spans;
	});
	const totalArea = $derived(nodes.reduce((s, n) => s + (n.areaKm2 || 0), 0));
	const farmArea = $derived(farms.reduce((s, n) => s + (n.areaKm2 || 0), 0));
</script>

<section class="panel" aria-labelledby="sch-h">
	<div class="panel-head">
		<h2 id="sch-h">Schematic</h2>
		<span class="muted small">
			{#if nodes.length}
				{farms.length} farm{farms.length === 1 ? '' : 's'} · {nodes.length - farms.length} gauge{nodes.length - farms.length === 1 ? '' : 's'} ·
				{fmtNum(farmArea, 1)} km² of farm area
			{:else}
				Water flows down the page to the outflow gauge
			{/if}
		</span>
	</div>
	<NetworkSchematic
		{nodes}
		transfers={editor.model.transfers}
		selectedId={selected?.id ?? null}
		onselect={select}
		editable={!readonly}
		onreparent={reparent}
	/>
</section>

<p class="visually-hidden" aria-live="polite">{announce}</p>

<section class="panel" aria-labelledby="net-h">
	<div class="panel-head">
		<h2 id="net-h">Network nodes</h2>
		{#if nodes.length}
			<div class="seg" role="group" aria-label="Layout">
				<button type="button" class="btn btn-sm" aria-pressed={view === 'table'} onclick={() => (view = 'table')}>Table</button>
				<button type="button" class="btn btn-sm" aria-pressed={view === 'detail'} onclick={() => (view = 'detail')}>One node</button>
			</div>
		{/if}
	</div>
	{#if nodes.length === 0}
		<div class="empty">
			<p>
				No nodes yet. Start with the <strong>outflow gauge</strong> at the bottom of the catchment (where flow is measured
				and the EWR applies), then add the farms and gauges that drain into it.
			</p>
			{#if !readonly}<button type="button" class="btn btn-primary" onclick={add}>Add outflow gauge</button>{/if}
		</div>
	{:else if view === 'table'}
		<p class="muted small intro">
			Percentages are shown 0–100. Flow shares {METHOD_LABEL[method]} (Settings & calibration){#if farms.length}; farms total {fmtPct(shares.sum, 2)}{/if}.
			Hover a column heading, or see the field guide below, for what each value means.
		</p>
		<div class="table-wrap">
			<table class="data compact net">
				<thead>
					<tr class="groups">
						<th scope="col" class="sticky" rowspan="2">{#if !readonly}<span class="visually-hidden">Order and </span>{/if}Name</th>
						<th scope="col" rowspan="2">Kind</th>
						<th scope="col" rowspan="2">Drains into</th>
						{#each groupSpans as g (g.group)}
							<th scope="colgroup" colspan={g.count + (g.group === 'share' ? 1 : 0)} class="grp">{GROUPS[g.group]}</th>
						{/each}
						{#if !readonly}<th scope="col" rowspan="2"><span class="visually-hidden">Remove</span></th>{/if}
					</tr>
					<tr>
						{#each NODE_FIELDS as f (f.key)}
							<th scope="col" class="num" title={f.help}>{f.label}<br /><span class="u">{f.unit}</span></th>
						{/each}
						<th scope="col" class="num" title="Share of catchment natural flow and EWR each farm receives with the method in Settings & calibration.">In use<br /><span class="u">%</span></th>
					</tr>
				</thead>
				<tbody bind:this={reorder.body}>
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
							<th scope="row" class="sticky">
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
								</div>
							</th>
							<td>
								<select aria-label="Kind of {label}" disabled={readonly} bind:value={node.kind}>
									<option value={'farm' satisfies NodeKind}>Farm</option>
									<option value={'gauge' satisfies NodeKind}>Gauge</option>
								</select>
							</td>
							<td>
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
							{#each NODE_FIELDS as f (f.key)}
								<td class:na={f.farmOnly && node.kind !== 'farm'}>
									<NumberInput
										label={f.aria(label)}
										min={0}
										max={isPct(f) ? 100 : undefined}
										scale={isPct(f) ? 100 : 1}
										nullable={f.nullable}
										placeholder={f.nullable ? '–' : undefined}
										disabled={readonly}
										bind:value={node[f.key]}
									/>
								</td>
							{/each}
							<td class="num share">{share === null ? '–' : fmtPct(share, 2)}</td>
							{#if !readonly}
								<td>
									<button type="button" class="btn-icon btn" aria-label="Remove {label}" title="Remove node" onclick={() => remove(node.id, label)}>✕</button>
								</td>
							{/if}
						</tr>
					{/each}
				</tbody>
				<tfoot>
					<tr>
						<th scope="row" class="sticky">Total</th>
						<td></td>
						<td></td>
						{#each NODE_FIELDS as f (f.key)}
							<td class="num">
								{#if f.key === 'areaKm2'}{fmtNum(totalArea, 2)}{:else if f.key === 'damCapacityM3'}{fmtNum(farms.reduce((s, n) => s + n.damCapacityM3, 0))}{/if}
							</td>
						{/each}
						<td class="num" class:warn={farms.length > 0 && Math.abs(shares.sum - 1) >= 0.0002}>{farms.length ? fmtPct(shares.sum, 2) : ''}</td>
						{#if !readonly}<td></td>{/if}
					</tr>
				</tfoot>
			</table>
		</div>
		{#if !readonly}
			<div class="toolbar after">
				<button type="button" class="btn" onclick={add}>+ Add node</button>
				<button type="button" class="btn" onclick={sortByFlowPath} title="Order rows headwater → outlet, one tributary at a time">
					Sort by flow path
				</button>
				{#if outletCount === 1}<span class="muted small">New nodes drain into the outlet; change "Drains into" (or drag on the schematic) to nest them. Row order is for display only.</span>{/if}
			</div>
		{/if}
		<details class="guide">
			<summary>Field guide</summary>
			<dl>
				<div><dt>Kind</dt><dd>A <strong>farm</strong> generates runoff, has irrigation demand and may have a dam (a stand-alone dam or natural area is also a farm). A <strong>gauge</strong> is a measuring point that passes upstream flow through.</dd></div>
				<div><dt>Drains into</dt><dd>The node immediately downstream. Exactly one node, the outflow gauge, drains nowhere.</dd></div>
				{#each NODE_FIELDS as f (f.key)}
					<div><dt>{GROUPS[f.group]}: {f.label} ({f.unit})</dt><dd>{f.help}</dd></div>
				{/each}
			</dl>
		</details>
	{:else if selected}
		<div class="picker">
			<label for="node-pick" class="visually-hidden">Node to edit</label>
			<button type="button" class="btn" aria-label="Previous node" disabled={selectedIndex <= 0} onclick={() => (selectedId = nodes[selectedIndex - 1]!.id)}>‹</button>
			<select id="node-pick" value={selected.id} onchange={(e) => (selectedId = e.currentTarget.value)}>
				{#each nodes as n, i (n.id)}
					<option value={n.id}>{i + 1}. {n.name || '(unnamed)'} · {n.kind}</option>
				{/each}
			</select>
			<button type="button" class="btn" aria-label="Next node" disabled={selectedIndex >= nodes.length - 1} onclick={() => (selectedId = nodes[selectedIndex + 1]!.id)}>›</button>
			{#if !readonly}<button type="button" class="btn" onclick={add}>+ Add node</button>{/if}
		</div>
		{#key selected.id}
			<NodeDetail
				node={selected}
				{nodes}
				share={shareOf(selectedIndex)}
				{readonly}
				onremove={() => remove(selected.id, selected.name || 'unnamed node')}
				onmove={(d) => moveBy(selected.id, d)}
				canMoveUp={selectedIndex > 0}
				canMoveDown={selectedIndex < nodes.length - 1}
				onmakeoutlet={() => setOutlet(selected.id)}
			/>
		{/key}
	{/if}
</section>

<style>
	.small {
		font-size: 0.8rem;
	}
	.intro {
		margin: -0.25rem 0 0.6rem;
	}
	.u {
		font-weight: 400;
		color: var(--text-muted);
	}
	.seg {
		display: inline-flex;
	}
	.seg .btn:first-child {
		border-radius: var(--radius-sm) 0 0 var(--radius-sm);
	}
	.seg .btn:last-child {
		border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
		margin-left: -1px;
	}
	.seg .btn[aria-pressed='true'] {
		background: var(--accent-soft);
		border-color: var(--accent);
		color: var(--accent);
	}
	.net td {
		min-width: 84px;
	}
	.net thead th.grp {
		text-align: center;
		border-left: 1px solid var(--border);
		font-weight: 600;
		color: var(--text);
	}
	.net thead th[title] {
		cursor: help;
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
		min-width: 160px;
	}
	.net td.na :global(input) {
		opacity: 0.45;
	}
	.net tr.sel {
		background: var(--accent-soft);
	}
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
		min-width: 120px;
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
		flex-wrap: wrap;
		margin-bottom: 0.75rem;
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
		.picker .btn,
		.seg .btn {
			min-height: 44px;
		}
		.picker select {
			flex-basis: calc(100% - 100px);
		}
	}
	.empty {
		padding: 1.5rem;
		text-align: center;
		color: var(--text-muted);
		border: 1px dashed var(--border-strong);
		border-radius: var(--radius);
	}
</style>
