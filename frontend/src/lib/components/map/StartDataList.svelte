<!--
	Start from the map's data step as a to-do list (issue #646 item 2; docs/ui.md
	§ Map, startData.ts): each data proposal a run needs, in the order a run
	reads them, with its status from what the project holds now (Done, Started,
	To do) and a link to where it is accepted. The next one is marked. The
	Getting started pill shows the same items once the sheet is closed.
-->
<script lang="ts">
	import { nextItem, STATUS_WORD, type DataItem } from './startData';

	let { items }: { items: readonly DataItem[] } = $props();
	const next = $derived(nextItem(items));
</script>

<ol class="todo" data-testid="start-data-list">
	{#each items as it, i (it.id)}
		<li class="item {it.status}" data-item={it.id} data-status={it.status} data-next={next?.id === it.id ? 'true' : undefined}>
			<span class="icon" aria-hidden="true">
				{#if it.status === 'done'}
					<svg viewBox="0 0 20 20" width="20" height="20"><circle cx="10" cy="10" r="9" /><path d="m6 10.5 2.6 2.5L14 7.5" /></svg>
				{:else}
					<svg viewBox="0 0 20 20" width="20" height="20"><circle cx="10" cy="10" r="8.25" /><text x="10" y="14">{i + 1}</text></svg>
				{/if}
			</span>
			<div class="body">
				<p class="title">
					<a href={it.href} data-testid={it.id === 'run' ? 'start-run' : `start-data-${it.id}`}>{it.title}</a>
					<span class="status" data-testid="start-data-status">{STATUS_WORD[it.status]}</span>
					{#if next?.id === it.id}<span class="next">Next</span>{/if}
					{#if it.optional && it.status !== 'done'}<span class="muted small">(optional)</span>{/if}
				</p>
				<p class="detail">
					{it.detail} <span class="where">({it.where}{#if it.more}; <a href={it.more.href}>{it.more.text}</a>{/if})</span>
				</p>
			</div>
		</li>
	{/each}
</ol>

<style>
	.todo {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.item {
		display: flex;
		gap: 0.6rem;
		padding: 0.45rem 0.1rem;
	}
	.item + .item {
		border-top: 1px solid var(--border);
	}
	.icon {
		flex: none;
		line-height: 0;
		margin-top: 1px;
	}
	.icon svg {
		overflow: visible;
	}
	.done .icon circle {
		fill: var(--success);
	}
	.done .icon path {
		fill: none;
		stroke: var(--success-soft);
		stroke-width: 2.2;
		stroke-linecap: round;
		stroke-linejoin: round;
	}
	.item:not(.done) .icon circle {
		fill: none;
		stroke: var(--text-muted);
		stroke-width: 1.6;
	}
	.item.partial .icon circle {
		stroke: var(--accent);
	}
	.icon text {
		fill: var(--text-2);
		font-size: 11px;
		font-weight: 700;
		text-anchor: middle;
		font-family: var(--font-sans);
	}
	.body {
		min-width: 0;
	}
	.title {
		margin: 0;
		font-weight: 600;
		display: flex;
		flex-wrap: wrap;
		gap: 0.2rem 0.5rem;
		align-items: baseline;
	}
	.status {
		font-size: var(--font-sm);
		font-weight: 600;
		color: var(--text-2);
	}
	.next {
		font-size: var(--font-xs);
		font-weight: 700;
		padding: 0 0.4rem;
		border-radius: 999px;
		background: var(--accent-soft);
		color: var(--text);
	}
	.detail {
		margin: 0.15rem 0 0;
		font-size: 0.85rem;
		color: var(--text-2);
	}
	.where {
		color: var(--text-muted);
	}
</style>
