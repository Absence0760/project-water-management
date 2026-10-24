<!--
	Settings → Flow share → Split the EWR between units by (settings.ewrSplit, engine ≥ 1.94.0, issue #553,
	docs/model.md §2.5b, docs/ui.md § Settings & calibration): the flow share (the default, what every earlier run
	did) or each unit's natural MAR. Self-contained, props in and a change out, so it can sit in whichever Settings
	section holds the flow generation choices: `value` is the stored setting (undefined = the flow share), `perUnit`
	whether Rain for each unit is on (the only case the two differ, which the hint says), `onchange` gets the new
	method. Its own chunk, in the Settings tab's lazy sections.
-->
<script lang="ts">
	import { EWR_SPLIT_METHODS, type EwrSplitMethod } from '@water-management/engine';
	import HelpTip from '#lib/components/help/HelpTip.svelte';
	import { ewrSplitHint, EWR_SPLIT_OPTIONS } from './ewrSplit';

	let {
		value,
		perUnit = false,
		readonly = false,
		onchange
	}: {
		value: EwrSplitMethod | undefined;
		perUnit?: boolean;
		readonly?: boolean;
		onchange?: (next: EwrSplitMethod) => void;
	} = $props();

	const uid = $props.id();
	const current = $derived(value ?? 'flowShare');
	const hint = $derived(ewrSplitHint(current, perUnit));

	function pick(v: string) {
		if ((EWR_SPLIT_METHODS as readonly string[]).includes(v)) onchange?.(v as EwrSplitMethod);
	}
</script>

<div class="field ewr-split" data-testid="ewr-split" data-unit-rain={perUnit ? 'on' : 'off'}>
	<span class="lbl"><label for="{uid}-split">Split the EWR between units by</label><HelpTip key="settings.ewrSplit" /></span>
	<select id="{uid}-split" disabled={readonly} value={current} onchange={(e) => pick(e.currentTarget.value)} aria-describedby="{uid}-split-h {uid}-split-state">
		{#each EWR_SPLIT_OPTIONS as o (o.value)}<option value={o.value}>{o.label}</option>{/each}
	</select>
	<span class="hint explain" id="{uid}-split-h">{hint.explain}</span>
	<!-- A state line, not an explanation: it stays when the explanations are off, as the flow share's note does. -->
	<span class="hint" id="{uid}-split-state" role="note" data-testid="ewr-split-state">{hint.state}</span>
</div>

<style>
	.ewr-split {
		max-width: 36rem;
	}
	.ewr-split select {
		width: 100%;
	}
	.lbl {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
	}
	.lbl label {
		font-weight: 500;
		font-size: 0.85rem;
		color: var(--text-2);
	}
</style>
