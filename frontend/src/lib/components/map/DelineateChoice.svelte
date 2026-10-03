<!--
	What Delineate makes (issue #374's UI list: one header button, not two):
	the catchment above one point (the draw bar's Delineate…) or sub-catchments,
	one per click (the click bar). Shown in both bars, so either switches to the
	other; picking the one already on does nothing.
-->
<script lang="ts">
	let { value, onchange }: { value: 'one' | 'clicks'; onchange: (v: 'one' | 'clicks') => void } = $props();
	const uid = $props.id();
</script>

<fieldset class="choice small" data-testid="map-delineate-choice">
	<legend class="visually-hidden">What to delineate</legend>
	<label><input type="radio" name="{uid}-what" value="one" checked={value === 'one'} onchange={() => onchange('one')} data-testid="map-delineate-one" /> One catchment, above a point</label>
	<label><input type="radio" name="{uid}-what" value="clicks" checked={value === 'clicks'} onchange={() => onchange('clicks')} data-testid="map-delineate-clicks" /> Sub-catchments, one per click</label>
</fieldset>

<style>
	.choice {
		display: flex;
		flex-wrap: wrap;
		gap: 0.25rem 1rem;
		margin: 0;
		padding: 0;
		border: 0;
	}
	/* Each choice at least 24 px tall, so the radios keep WCAG 2.5.8's target spacing (as Delineate's own radios). */
	.choice label {
		display: inline-flex;
		gap: 0.35rem;
		align-items: center;
		min-height: 24px;
	}
</style>
