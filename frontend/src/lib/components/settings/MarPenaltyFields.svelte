<!--
	Settings → Fit the parameters → Fit automatically: the switch for the
	WR2012 MAR soft penalty (settings.wr2012.calibrationPenalty.enabled, issue
	#4 phase 6). It moved here from the WR2012 check (issue #521), beside the
	fit it changes; its weight and the MAR band stay in the WR2012 check,
	shown there while the penalty is on. It is a saved setting, so it goes
	through the page's save bar, unlike the fit's own choices. It needs the
	WR2012 check's reference MAR: without one it says so and links there.
-->
<script lang="ts">
	import type { Wr2012Settings } from '@water-management/engine';
	import HelpTip from '#lib/components/help/HelpTip.svelte';

	let {
		value = $bindable(),
		readonly = false
	}: {
		value: Wr2012Settings;
		readonly?: boolean;
	} = $props();
</script>

<fieldset class="plain penalty" data-testid="mar-penalty">
	<legend>WR2012 MAR penalty <HelpTip key="wr2012-penalty" /></legend>
	{#if !value.reference}
		<p class="hint" data-testid="mar-penalty-off">Needs a WR2012 reference MAR: switch on the <a href="#set-wr2012">WR2012 check</a> first.</p>
	{:else}
		<label class="check">
			<input type="checkbox" disabled={readonly} bind:checked={value.calibrationPenalty.enabled} />
			Add a soft penalty on the MAR when fitting automatically
		</label>
		{#if value.calibrationPenalty.enabled}
			<!-- A state line: where its weight and band are set. -->
			<p class="hint" data-testid="mar-penalty-where">Its weight and MAR band are under the <a href="#set-wr2012">WR2012 check</a>.</p>
		{/if}
		<span class="hint explain">Off by default. A saved setting (the save bar), unlike the fit’s other choices; the fit then also runs without it, so you can see what it changed.</span>
	{/if}
</fieldset>

<style>
	.plain {
		border: 0;
		padding: 0;
		margin: 0;
		min-width: 0;
	}
	.penalty {
		display: grid;
		gap: 0.3rem;
	}
	legend {
		font-weight: 500;
		font-size: 0.85rem;
		color: var(--text-2);
		padding: 0;
		margin-bottom: 0.2rem;
	}
	legend :global(.helptip) {
		margin-left: 0.15rem;
	}
	.check {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		min-height: 36px;
	}
	.check input {
		flex-shrink: 0;
	}
	.hint {
		display: block;
		font-size: var(--font-sm);
		color: var(--text-muted);
		max-width: 75ch;
		margin: 0;
	}
</style>
