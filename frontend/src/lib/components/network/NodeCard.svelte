<script lang="ts">
	// Network → Map layout: the node picked on the map or in the list, at a
	// glance (issue #17, option A · A2). Edit opens its full form (the node
	// sheet); a farm's planted areas open in the farm drawer.
	import type { NetworkNode } from '@water-management/engine';
	import type { FarmPlanting } from '$lib/components/crops/farmDrawer';
	import { fmtNum, fmtPct } from '$lib/format/number';
	import NotesDrawer from '$lib/components/notes/NotesDrawer.svelte';
	import type { FarmSupply } from './supplyColour';
	import { describeUser } from './users';
	import { damEndTile, type DamEnd } from '$lib/components/overview/damLevels';

	let {
		node,
		nodes,
		share,
		supply,
		damEnd = null,
		planting,
		runName,
		readonly,
		onedit,
		projectId = '',
		saved = false,
		farmHref,
		mapHref = null
	}: {
		node: NetworkNode;
		nodes: readonly NetworkNode[];
		/** Flow share in use (0–1), farms only. */
		share: number | null;
		/** The farm's supply in the latest run; null when there is no run (or not loaded). */
		supply: FarmSupply | null;
		/** The farm's dam at the end of the latest run (null: no run, or loading). */
		damEnd?: DamEnd | null;
		planting: FarmPlanting | null;
		/** The latest run's label, for the supply tile. */
		runName: string | null;
		readonly: boolean;
		onedit: () => void;
		projectId?: string;
		/** The node is saved, so it can carry notes (a node added since the last save has none yet). */
		saved?: boolean;
		/** Opens this farm's planted areas (the farm drawer) over the page as it is. */
		farmHref: string;
		/** This node on the Map tab (issue #326 A2); null when no map feature is linked to it. */
		mapHref?: string | null;
	} = $props();

	const KIND = { farm: 'hydrological unit', gauge: 'gauge', user: 'other water user' } as const;
	const isOutlet = $derived(node.downstreamNodeId === null);
	const downstream = $derived(nodes.find((n) => n.id === node.downstreamNodeId)?.name || '(unnamed)');
	const name = $derived(node.name || '(unnamed)');
	const dam = $derived(damEndTile(damEnd, node.damCapacityM3));
</script>

<section class="card" aria-labelledby="node-card-h" data-testid="node-card">
	<div class="head">
		<div>
			<span class="kicker">Selected · {isOutlet ? 'outflow gauge' : KIND[node.kind]}</span>
			<h3 id="node-card-h">{name}</h3>
		</div>
		<div class="acts">
			{#if projectId && saved}
				<NotesDrawer {projectId} compact target={{ kind: 'node', nodeId: node.id, name: node.name, isFarm: node.kind === 'farm' }} />
			{/if}
			{#if mapHref}<a class="btn btn-sm" href={mapHref} data-testid="node-card-map">Show on map<span class="visually-hidden"> ({name})</span></a>{/if}
			<button type="button" class="btn btn-sm" onclick={onedit}>{readonly ? 'Details' : 'Edit'}<span class="visually-hidden"> {name}</span></button>
		</div>
	</div>

	{#if node.kind === 'farm'}
		<div class="tiles">
			<div class="tile" data-band={supply?.band ?? 'none'}>
				<span class="t-l">Supplied{runName ? `, ${runName}` : ''}</span>
				<span class="t-v">{supply?.fraction != null ? fmtPct(supply.fraction, 0) : '–'}</span>
				{#if supply && supply.fraction == null}<span class="t-s">{supply.text}</span>{/if}
			</div>
			<div class="tile">
				<span class="t-l">Dam at end of run</span>
				<span class="t-v">{dam.value}</span>
				{#if dam.sub}<span class="t-s">{dam.sub}</span>{/if}
			</div>
		</div>
	{/if}

	<dl>
		{#if !isOutlet}<div><dt>Drains into</dt><dd>{downstream}</dd></div>{/if}
		{#if node.kind === 'user'}
			<div><dt>Takes</dt><dd>{describeUser(node)}</dd></div>
		{:else}
			<div><dt>Catchment area</dt><dd class="num">{fmtNum(node.areaKm2 || 0, 2)} km²</dd></div>
		{/if}
		{#if node.kind === 'farm'}
			<div><dt>Flow share</dt><dd class="num">{share === null ? '–' : fmtPct(share, 1)}</dd></div>
			<div><dt>Dam</dt><dd class="num">{node.damCapacityM3 > 0 ? `${fmtNum(node.damCapacityM3)} m³` : 'No dam'}</dd></div>
			<div>
				<dt>Irrigated</dt>
				<dd>
					<a href={farmHref}>
						{#if planting?.planted}
							{fmtNum(planting.totalM2 / 10_000, 2)} ha, {planting.planted} crop{planting.planted === 1 ? '' : 's'}
						{:else}
							Nothing planted
						{/if}
					</a>
				</dd>
			</div>
		{/if}
	</dl>
</section>

<style>
	.card {
		display: grid;
		gap: 0.75rem;
	}
	.head {
		display: flex;
		justify-content: space-between;
		align-items: flex-start;
		gap: 0.5rem;
	}
	.acts {
		display: flex;
		align-items: center;
		gap: 0.35rem;
	}
	.kicker {
		font-size: 0.75rem;
		color: var(--text-muted);
		text-transform: uppercase;
		letter-spacing: 0.05em;
	}
	h3 {
		margin: 0.1rem 0 0;
		font-size: 1.2rem;
		overflow-wrap: anywhere;
	}
	.tiles {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 0.5rem;
	}
	.tile {
		display: grid;
		gap: 0.1rem;
		padding: 0.5rem 0.65rem;
		border-radius: var(--radius);
		background: var(--surface-2);
	}
	.tile[data-band='low'] {
		background: var(--danger-soft);
	}
	.tile[data-band='short'] {
		background: var(--warning-soft);
	}
	.t-l,
	.t-s {
		font-size: 0.78rem;
		color: var(--text-2);
	}
	.t-v {
		font-size: 1.25rem;
		font-weight: 600;
		font-variant-numeric: tabular-nums;
	}
	dl {
		margin: 0;
		display: grid;
		font-size: 0.9rem;
	}
	dl div {
		display: flex;
		justify-content: space-between;
		gap: 0.75rem;
		padding: 0.4rem 0;
		border-bottom: 1px solid var(--border);
	}
	dl div:last-child {
		border-bottom: 0;
	}
	dt {
		color: var(--text-2);
	}
	dd {
		margin: 0;
		text-align: right;
	}
	.num {
		font-variant-numeric: tabular-nums;
	}
</style>
