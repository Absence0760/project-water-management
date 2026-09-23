<script lang="ts">
	// A signed change (b − a) with ▲/▼, coloured by better/worse. The sign,
	// arrow and the visually-hidden "better"/"worse" carry the meaning, so
	// colour is never the only cue.
	import type { MetricDelta } from '@water-management/engine';
	import { formatDelta, type MetricSpec } from './delta';

	let { m, spec }: { m: MetricDelta; spec: MetricSpec } = $props();
	const f = $derived(formatDelta(m, spec));
</script>

<span class="delta {f.tone}" title={f.label}>
	{#if f.arrow}<span class="arrow" aria-hidden="true">{f.arrow}</span>{/if}<span aria-hidden="true">{f.text}</span>
	<span class="visually-hidden">{f.label}</span>
</span>

<style>
	.delta {
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
		font-weight: 600;
	}
	.arrow {
		font-size: 0.75em;
		margin-right: 0.2em;
		vertical-align: 0.1em;
	}
	.better {
		color: var(--success);
	}
	.worse {
		color: var(--danger);
	}
	.neutral {
		color: var(--text-2);
		font-weight: 500;
	}
</style>
