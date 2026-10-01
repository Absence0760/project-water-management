<!--
	The Map tab's compact list (issue #326 E3, E6; docs/ui.md § Map): every
	feature grouped by kind, parcels first, each group largest first
	(mapList.ts groupFeatures). A row is a button that picks the feature
	(aria-pressed); under its name, its size or position, what it stands for
	and, for a parcel, where that unit's area came from (typed or from the
	map). It scrolls inside its card where the page fits the window; the
	picked row is kept in view inside the list, never by scrolling the page.
-->
<script lang="ts">
	import type { MapFeature, MapNodeArea } from '$lib/api/types';
	import { featureSummary } from './mapData';
	import { areaSourceOf, areaSourceText, featureName, groupFeatures } from './mapList';

	let {
		features,
		nodes,
		selectedId,
		onselect,
		labelledby
	}: {
		features: MapFeature[];
		nodes: MapNodeArea[];
		selectedId: string | null;
		onselect: (id: string) => void;
		/** The id of the heading that names the list. */
		labelledby: string;
	} = $props();

	const uid = $props.id();
	const groups = $derived(groupFeatures(features));
	/** What it stands for: the node's name, or "linked" when that is the feature's own name (Vaalbank's parcel stands for Vaalbank). */
	const standsText = (f: MapFeature) => (!f.nodeName ? '' : f.nodeName === featureName(f) ? ' · linked' : ` · ${f.nodeName}`);
	let box: HTMLDivElement | undefined = $state();

	// Keep the picked row in view inside the list (a map click or a link may pick one far down), without
	// moving the page. Again when the list's box changes size: the window fit is measured after the first
	// render, so a row "in view" in the unfitted list can end up below the fitted one (ui-playbook § 4).
	$effect(() => {
		const id = selectedId;
		const el = box;
		if (!el || !id) return;
		const keep = () => {
			const row = el.querySelector<HTMLElement>(`[data-feature="${CSS.escape(id)}"]`);
			if (!row || el.scrollHeight <= el.clientHeight) return;
			const b = el.getBoundingClientRect();
			const r = row.getBoundingClientRect();
			// Whole pixels, rounded away from the row: scrollTop rounds a fraction down, which left the row a sliver short of the box's edge.
			if (r.top < b.top) el.scrollTop -= Math.ceil(b.top - r.top);
			else if (r.bottom > b.bottom) el.scrollTop += Math.ceil(r.bottom - b.bottom);
		};
		keep();
		const ro = new ResizeObserver(keep);
		ro.observe(el);
		return () => ro.disconnect();
	});
</script>

<div class="list-scroll" bind:this={box} data-testid="map-feature-list">
	{#each groups as g (g.kind)}
		<div class="group" role="group" aria-labelledby="{labelledby} {uid}-{g.kind}">
			<h3 class="group-h" id="{uid}-{g.kind}">{g.label} <span class="muted">{g.features.length}</span></h3>
			<ul>
				{#each g.features as f (f.id)}
					{@const src = areaSourceText(areaSourceOf(f, nodes))}
					<li data-feature={f.id} data-kind={f.kind}>
						<button type="button" class="row" aria-pressed={f.id === selectedId} onclick={() => onselect(f.id)}>
							<span class="nm">{featureName(f)}</span>
							<span class="meta muted">
								{featureSummary(f)}{standsText(f)}{#if src}{' · '}<span class="src" data-source={src}>{src}</span>{/if}
							</span>
						</button>
					</li>
				{/each}
			</ul>
		</div>
	{/each}
</div>

<style>
	/* Positioned: the scroll box is the containing block for anything absolute inside it (ui-playbook § 2). */
	.list-scroll {
		position: relative;
	}
	.group + .group {
		margin-top: 0.5rem;
	}
	.group-h {
		margin: 0 0 0.15rem;
		padding: 0 0.5rem;
		font-size: 0.8rem;
		font-weight: 600;
		color: var(--text-2);
		text-transform: uppercase;
		letter-spacing: 0.03em;
	}
	ul {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		grid-template-columns: minmax(0, 1fr);
	}
	.row {
		display: grid;
		gap: 0.05rem;
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
	.row:hover {
		background: var(--surface-2);
	}
	.row[aria-pressed='true'] {
		background: var(--accent-soft);
	}
	.row[aria-pressed='true'] .nm {
		font-weight: 600;
	}
	.nm {
		overflow-wrap: break-word;
		min-width: 0;
	}
	.meta {
		font-size: 0.8rem;
		overflow-wrap: break-word;
		min-width: 0;
	}
	.src[data-source='area from the map'] {
		color: var(--text-2);
		font-weight: 600;
	}
</style>
