<script lang="ts">
	// Drag handle + ↑/↓ buttons for one row of a reorderable table. The handle
	// is pointer-only (hidden from assistive tech); the buttons are the
	// keyboard/screen-reader path and keep focus on the moved row.
	import type { RowReorder } from './rowReorder.svelte';

	let {
		id,
		label,
		index,
		count,
		reorder,
		onmove,
		idPrefix = 'mv'
	}: {
		id: string;
		/** Item name for the accessible labels ("Move Hilltop farm up"). */
		label: string;
		index: number;
		count: number;
		reorder: RowReorder;
		onmove: (delta: -1 | 1) => void;
		idPrefix?: string;
	} = $props();
</script>

<span class="mc">
	<span
		class="handle"
		aria-hidden="true"
		title="Drag to reorder"
		onpointerdown={(e) => reorder.down(e, id)}
		onpointermove={reorder.move}
		onpointerup={reorder.up}
		onpointercancel={reorder.cancel}
	>
		<svg viewBox="0 0 10 16" width="10" height="16"
			><circle cx="3" cy="3" r="1.4" /><circle cx="7" cy="3" r="1.4" /><circle cx="3" cy="8" r="1.4" /><circle
				cx="7"
				cy="8"
				r="1.4"
			/><circle cx="3" cy="13" r="1.4" /><circle cx="7" cy="13" r="1.4" /></svg
		>
	</span>
	<span class="movers">
		<button type="button" id="{idPrefix}-up-{id}" class="mv" aria-label="Move {label} up" title="Move up" disabled={index === 0} onclick={() => onmove(-1)}>
			<svg viewBox="0 0 10 6" width="10" height="6" aria-hidden="true"><path d="M1 5 5 1l4 4" /></svg>
		</button>
		<button type="button" id="{idPrefix}-down-{id}" class="mv" aria-label="Move {label} down" title="Move down" disabled={index >= count - 1} onclick={() => onmove(1)}>
			<svg viewBox="0 0 10 6" width="10" height="6" aria-hidden="true"><path d="M1 1l4 4 4-4" /></svg>
		</button>
	</span>
</span>

<style>
	.mc {
		display: inline-flex;
		align-items: center;
		gap: 0.1rem;
		flex: none;
	}
	.handle {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 18px;
		height: 30px;
		color: var(--text-muted);
		cursor: grab;
		touch-action: none;
		border-radius: var(--radius-sm);
	}
	.handle:hover {
		background: var(--surface-2);
		color: var(--text);
	}
	.handle:active {
		cursor: grabbing;
	}
	.handle svg {
		fill: currentColor;
	}
	.movers {
		display: inline-flex;
	}
	/* Side by side at 24 × 24 px: the WCAG 2.2 minimum target size (2.5.8).
	   Stacked, each button was 22 × 15. */
	.mv {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		border: 1px solid transparent;
		background: none;
		color: var(--text-muted);
		width: 24px;
		height: 24px;
		padding: 0;
		cursor: pointer;
		border-radius: 3px;
	}
	.mv svg {
		fill: none;
		stroke: currentColor;
		stroke-width: 1.6;
	}
	.mv:hover:not(:disabled) {
		background: var(--surface-2);
		color: var(--text);
	}
	.mv:focus-visible {
		outline-offset: 0;
	}
	.mv:disabled {
		opacity: 0.3;
		cursor: default;
	}
</style>
