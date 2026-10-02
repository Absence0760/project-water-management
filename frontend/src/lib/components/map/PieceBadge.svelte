<!--
	A proposal piece's number on its card in the Start and Divide sheets (#326
	C3's follow-up, pieces.ts): the same number and tint as its badge on the
	map, so the cards are the map's key. The number is text (read with the
	card's name); the tint is decoration beside it.
-->
<script lang="ts">
	import { pieceTints } from './mapStyle';

	let { label, tint }: { label: string; tint: number } = $props();
	const colour = $derived(tint >= 0 ? pieceTints()[tint] : null);
	// No tint: the rest of the catchment, or a unit with no land (no piece of its own): a dashed ring.
</script>

<span class="badge" class:rest={!colour} style:--piece-tint={colour} data-testid="piece-badge">
	<span class="visually-hidden">Piece {label}:</span>
	<span aria-hidden="true">{label}</span>
</span>

<style>
	.badge {
		display: inline-grid;
		place-items: center;
		flex: none;
		min-width: 1.6rem;
		height: 1.6rem;
		padding: 0 0.3rem;
		box-sizing: border-box;
		border-radius: 999px;
		border: 2px solid var(--accent);
		background: var(--surface);
		box-shadow: inset 0 -5px 0 var(--piece-tint, transparent);
		color: var(--text);
		font-weight: 700;
		font-size: 0.8rem;
		line-height: 1;
	}
	.rest {
		border-style: dashed;
	}
</style>
