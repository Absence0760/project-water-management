<script lang="ts">
	// One of the audience icons (scripts/landing-art/vector/icon-*.svg, drawn as
	// one family: a 48 px grid, 1.75 px strokes, round caps, the brand navy with
	// one water-blue accent). Decorative: its card says who it is for. With
	// `draw`, each stroke draws itself on once (stroke-dashoffset); still under
	// reduced motion, and fully drawn before the script runs.
	import { ART } from './art.generated';

	let { name, draw = false }: { name: keyof typeof ART.icons; draw?: boolean } = $props();
</script>

<svg class:draw viewBox="0 0 48 48" width="48" height="48" aria-hidden="true" focusable="false">
	{#each ART.icons[name] as p, i (i)}
		<path d={p.d} class:accent={p.accent} stroke-dasharray={'dash' in p ? p.dash : undefined} pathLength={'dash' in p ? undefined : 1} style:animation-delay="{i * 120}ms" />
	{/each}
</svg>

<style>
	svg {
		display: block;
		fill: none;
		stroke: var(--brand-node);
		stroke-width: 1.75;
		stroke-linecap: round;
		stroke-linejoin: round;
	}
	.accent {
		stroke: var(--brand-outlet);
	}
	@media (prefers-reduced-motion: no-preference) {
		.draw path[pathLength] {
			stroke-dasharray: 1;
			animation: draw 900ms ease-out both;
		}
	}
	@keyframes draw {
		from {
			stroke-dashoffset: 1;
		}
		to {
			stroke-dashoffset: 0;
		}
	}
</style>
