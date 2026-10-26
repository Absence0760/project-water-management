<script lang="ts">
	// The page's one m³/s / m³/day switch for its flow charts, shown in each chart's toolbar. Every copy binds the
	// same state, so its name says it changes them all (issue #586 D13): Model quality's charts (ModelQuality.svelte)
	// and The model’s working’s daily series chart (RunCharts.svelte) on Runs & results.
	let { unit = $bindable() }: { unit: 'm³/s' | 'm³/day' } = $props();
</script>

<span class="seg" role="group" aria-label="Flow units, for every flow chart on this page">
	<button type="button" class="btn btn-sm" aria-pressed={unit === 'm³/s'} onclick={() => (unit = 'm³/s')}>m³/s</button>
	<button type="button" class="btn btn-sm" aria-pressed={unit === 'm³/day'} onclick={() => (unit = 'm³/day')}>m³/day</button>
</span>
