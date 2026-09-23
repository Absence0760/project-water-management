<script lang="ts">
	import type { NodeKind } from '@water-management/engine';
	import NumberInput from '$lib/components/common/NumberInput.svelte';
	import type { ModelEditor } from '$lib/model/editor.svelte';
	import NetworkTree from './NetworkTree.svelte';

	let { editor, readonly }: { editor: ModelEditor; readonly: boolean } = $props();

	const nodes = $derived(editor.model.nodes);
	const outletCount = $derived(nodes.filter((n) => n.downstreamNodeId === null).length);

	function add() {
		const n = editor.addNode();
		queueMicrotask(() => document.getElementById(`node-name-${n.id}`)?.focus());
	}

	function remove(id: string, name: string) {
		const refs = editor.model.transfers.filter((t) => t.fromNodeId === id || t.toNodeId === id).length;
		const areas = editor.model.cropAreas.filter((a) => a.nodeId === id).length;
		if ((refs || areas) && !confirm(`Remove "${name}"? Its ${areas} crop area(s) and ${refs} transfer(s) are removed too; nodes draining into it are re-routed downstream.`)) return;
		editor.removeNode(id);
	}
</script>

<div class="layout">
	<section class="panel table-panel" aria-labelledby="net-h">
		<div class="panel-head">
			<h2 id="net-h">Network nodes</h2>
			<span class="muted small">
				{nodes.length} node{nodes.length === 1 ? '' : 's'} · percentages are of the dam or flow, 0–100
			</span>
		</div>
		{#if nodes.length === 0}
			<div class="empty">
				<p>No nodes yet. Start with the outflow gauge at the bottom of the catchment, then add the farms that drain into it.</p>
				{#if !readonly}<button type="button" class="btn btn-primary" onclick={add}>Add outflow gauge</button>{/if}
			</div>
		{:else}
			<div class="table-wrap">
				<table class="data compact net">
					<thead>
						<tr>
							<th scope="col" class="sticky">Name</th>
							<th scope="col">Kind</th>
							<th scope="col">Drains into</th>
							<th scope="col" class="num">Area<br /><span class="u">km²</span></th>
							<th scope="col" class="num">Area hi<br /><span class="u">km²</span></th>
							<th scope="col" class="num">Area lo<br /><span class="u">km²</span></th>
							<th scope="col" class="num">Dam capacity<br /><span class="u">m³</span></th>
							<th scope="col" class="num">Dam initial<br /><span class="u">%</span></th>
							<th scope="col" class="num">Dam min<br /><span class="u">%</span></th>
							<th scope="col" class="num">Upstream→dam<br /><span class="u">%</span></th>
							<th scope="col" class="num">Runoff→dam<br /><span class="u">%</span></th>
							<th scope="col" class="num">Divert cap<br /><span class="u">m³/day</span></th>
							<th scope="col" class="num">Return flow<br /><span class="u">%</span></th>
							<th scope="col" class="num">Manual flow share<br /><span class="u">%</span></th>
							{#if !readonly}<th scope="col"><span class="visually-hidden">Remove</span></th>{/if}
						</tr>
					</thead>
					<tbody>
						{#each nodes as node (node.id)}
							{@const label = node.name || 'unnamed node'}
							<tr>
								<th scope="row" class="sticky">
									<input
										id="node-name-{node.id}"
										aria-label="Name"
										maxlength="100"
										readonly={readonly}
										bind:value={node.name}
									/>
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
								<td><NumberInput label="Area of {label}, km²" min={0} disabled={readonly} bind:value={node.areaKm2} /></td>
								<td><NumberInput label="High-MAP area of {label}, km²" min={0} disabled={readonly} bind:value={node.areaHiKm2} /></td>
								<td><NumberInput label="Low-MAP area of {label}, km²" min={0} disabled={readonly} bind:value={node.areaLoKm2} /></td>
								<td><NumberInput label="Dam capacity of {label}, m³" min={0} disabled={readonly} bind:value={node.damCapacityM3} /></td>
								<td><NumberInput label="Dam initial storage of {label}, %" min={0} max={100} scale={100} disabled={readonly} bind:value={node.damInitialPct} /></td>
								<td><NumberInput label="Dam minimum storage of {label}, %" min={0} max={100} scale={100} disabled={readonly} bind:value={node.damMinPct} /></td>
								<td><NumberInput label="Upstream inflow entering above the dam at {label}, %" min={0} max={100} scale={100} disabled={readonly} bind:value={node.pctUpstreamToDam} /></td>
								<td><NumberInput label="Own runoff entering above the dam at {label}, %" min={0} max={100} scale={100} disabled={readonly} bind:value={node.pctRunoffToDam} /></td>
								<td><NumberInput label="Divert capacity of {label}, m³/day" min={0} disabled={readonly} bind:value={node.divertCapacityM3Day} /></td>
								<td><NumberInput label="Return flow of {label}, %" min={0} max={100} scale={100} disabled={readonly} bind:value={node.returnFlowPct} /></td>
								<td><NumberInput label="Manual flow share of {label}, %" min={0} max={100} scale={100} nullable placeholder="–" disabled={readonly} bind:value={node.flowShareManual} /></td>
								{#if !readonly}
									<td>
										<button type="button" class="btn-icon btn" aria-label="Remove {label}" title="Remove node" onclick={() => remove(node.id, label)}>✕</button>
									</td>
								{/if}
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
			{#if !readonly}
				<div class="toolbar after">
					<button type="button" class="btn" onclick={add}>+ Add node</button>
					{#if outletCount === 1}<span class="muted small">New nodes drain into the outlet; change "Drains into" to nest them.</span>{/if}
				</div>
			{/if}
		{/if}
	</section>

	<section class="panel tree-panel" aria-labelledby="tree-h">
		<div class="panel-head"><h2 id="tree-h">Drainage tree</h2></div>
		<NetworkTree {nodes} />
	</section>
</div>

<style>
	.layout {
		display: grid;
		grid-template-columns: minmax(0, 1fr) 300px;
		gap: 1rem;
		align-items: start;
	}
	@media (max-width: 1200px) {
		.layout {
			grid-template-columns: minmax(0, 1fr);
		}
	}
	.small {
		font-size: 0.8rem;
	}
	.u {
		font-weight: 400;
		color: var(--text-muted);
	}
	.net td {
		min-width: 90px;
	}
	.net th.sticky {
		position: sticky;
		left: 0;
		z-index: 2;
		background: var(--surface);
		min-width: 170px;
	}
	.net thead th.sticky {
		background: var(--surface-2);
		z-index: 3;
	}
	.net td:nth-child(2) {
		min-width: 90px;
	}
	.net td:nth-child(3) {
		min-width: 160px;
	}
	.after {
		margin: 0.75rem 0 0;
	}
	.empty {
		padding: 1.5rem;
		text-align: center;
		color: var(--text-muted);
		border: 1px dashed var(--border-strong);
		border-radius: var(--radius);
	}
</style>
