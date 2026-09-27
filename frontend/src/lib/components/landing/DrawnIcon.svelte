<script lang="ts">
	// One of the audience icons (scripts/landing-art/vector/icon-*.svg, drawn as
	// one family: a 48 px grid, 1.75 px strokes, round caps, the brand navy with
	// one water-blue accent). Decorative: its card says who it is for. Once
	// `armed` (the page's script is running and motion is allowed) the strokes
	// wait undrawn, and `draw` draws each on once (stroke-dashoffset). Without
	// script, and under reduced motion, it is simply drawn: never drawn, then
	// blanked, then drawn again.
	import { ART } from './art.generated';

	let { name, armed = false, draw = false }: { name: keyof typeof ART.icons; armed?: boolean; draw?: boolean } = $props();
</script>

<svg viewBox="0 0 48 48" width="48" height="48" aria-hidden="true" focusable="false">
	<!-- The state classes sit on each path, not on the svg: Chromium didn't
	     restyle the paths when `draw` landed on their svg (the compound
	     `.armed.draw path` never took), so they stayed undrawn. -->
	{#each ART.icons[name] as p, i (i)}
		<path d={p.d} class:accent={p.accent} class:armed class:draw stroke-dasharray={'dash' in p ? p.dash : undefined} pathLength={'dash' in p ? undefined : 1} style:animation-delay="{i * 120}ms" />
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
		path.armed[pathLength] {
			stroke-dasharray: 1;
			stroke-dashoffset: 1;
		}
		path.armed.draw[pathLength] {
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
