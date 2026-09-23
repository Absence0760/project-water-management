<script lang="ts">
	import type { NetworkNode } from '@water-management/engine';
	import { fmtNum } from '$lib/format/number';
	import { drainageTree } from '$lib/model/tree';

	let { nodes }: { nodes: NetworkNode[] } = $props();
	const tree = $derived(drainageTree(nodes));
</script>

{#if nodes.length === 0}
	<p class="muted">Add nodes to see how water flows through the catchment.</p>
{:else}
	<p class="muted small">Outlet at the top; each node is indented under the node it drains into.</p>
	<ul class="tree" aria-label="Drainage tree">
		{#each tree.rows as row (row.node.id)}
			<li style="--depth: {row.depth}" class:root={row.depth === 0}>
				<span class="name">{row.node.name || '(unnamed)'}</span>
				<span class="kind" class:gauge={row.node.kind === 'gauge'}>{row.node.kind}</span>
				<span class="meta">
					{fmtNum(row.node.areaKm2, 2)} km²{#if row.node.damCapacityM3 > 0} · dam {fmtNum(row.node.damCapacityM3)} m³{/if}
				</span>
				{#if row.depth === 0 && row.node.downstreamNodeId === null}<span class="outlet">outlet</span>{/if}
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
	.small {
		font-size: 0.8rem;
	}
	.tree {
		list-style: none;
		margin: 0;
		padding: 0;
		font-size: 0.85rem;
	}
	.tree li {
		position: relative;
		padding: 0.3rem 0 0.3rem calc(var(--depth) * 1.1rem + 0.2rem);
		display: flex;
		flex-wrap: wrap;
		gap: 0.1rem 0.4rem;
		align-items: baseline;
		border-bottom: 1px solid var(--border);
	}
	.tree li:not(.root)::before {
		content: '';
		position: absolute;
		left: calc(var(--depth) * 1.1rem - 0.7rem);
		top: 0;
		height: 1.05rem;
		width: 0.55rem;
		border-left: 1px solid var(--border-strong);
		border-bottom: 1px solid var(--border-strong);
	}
	.name {
		font-weight: 600;
	}
	.kind {
		font-size: 0.7rem;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--success);
	}
	.kind.gauge {
		color: var(--accent);
	}
	.meta {
		width: 100%;
		color: var(--text-muted);
		font-size: 0.78rem;
		font-variant-numeric: tabular-nums;
	}
	.outlet {
		font-size: 0.7rem;
		padding: 0 0.35rem;
		border-radius: 999px;
		background: var(--accent-soft);
		color: var(--accent);
	}
	.alert {
		margin-top: 0.75rem;
		font-size: 0.85rem;
	}
</style>
