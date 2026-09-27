<script lang="ts">
	// A thin meandering river between sections, in place of a rule
	// (scripts/landing-art/vector/river-divider.svg). Decorative.
	import { ART } from './art.generated';
</script>

<svg class="divider" viewBox="0 0 1200 28" preserveAspectRatio="none" aria-hidden="true" focusable="false"><path d={ART.river} /></svg>

<style>
	.divider {
		display: block;
		width: 100%;
		height: 28px;
		margin-block: clamp(3rem, 7vw, 5.5rem);
		fill: none;
		stroke: var(--brand-outlet);
		stroke-width: 1.5;
		stroke-linecap: round;
		vector-effect: non-scaling-stroke;
		opacity: 0.55;
	}
	.divider path {
		vector-effect: non-scaling-stroke;
	}
</style>
