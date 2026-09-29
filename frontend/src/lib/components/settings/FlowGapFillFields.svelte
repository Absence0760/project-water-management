<!--
	settings.flowGapFill (engine ≥ 1.23.0, issue #66, docs/model.md §2.10i):
	whether a run fills the gaps of the observed gauge and logger records, and
	how, and whether statistics read the filled days. Off for every record by
	default. Each number is kept inside the engine's bounds by its input, so
	the section never blocks Save.
-->
<script lang="ts">
	import { DEFAULT_FLOW_GAP_SPEC, donorOptions, GAP_FILL_KINDS, GAP_FILL_LIMITS, gapFillRecordLabel, type FlowGapFillSettings, type GapFillDonor, type GapFillKind } from '@water-management/engine';
	import NumberInput from '$lib/components/common/NumberInput.svelte';
	import HelpTip from '$lib/components/help/HelpTip.svelte';

	let {
		value = $bindable(),
		readonly = false,
		/** The series kinds the project holds (null = not known yet): a record without a series is still offered, a donor without one is marked. */
		seriesKinds = null
	}: {
		value: FlowGapFillSettings;
		readonly?: boolean;
		seriesKinds?: readonly string[] | null;
	} = $props();

	const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
	const has = (k: string) => seriesKinds === null || seriesKinds.includes(k);
	const shown = $derived(GAP_FILL_KINDS.filter((k) => has(k) || value[k]));

	function setOn(kind: GapFillKind, on: boolean) {
		value[kind] = on ? { ...DEFAULT_FLOW_GAP_SPEC } : null;
	}
	function set(kind: GapFillKind, key: 'interpolateMaxDays' | 'donorMaxDays' | 'donorMinOverlapDays', v: number | null) {
		const spec = value[kind];
		if (spec && v !== null) value[kind] = { ...spec, [key]: v };
	}
	function setDonor(kind: GapFillKind, v: GapFillDonor | null) {
		const spec = value[kind];
		if (spec) value[kind] = { ...spec, donor: v };
	}
</script>

<div class="gap-fill" data-testid="flow-gap-fill-settings">
	<h3 class="sub">Flow gaps <HelpTip key="settings.flowGapFill" /></h3>
	<p class="hint">
		Fill gaps in an observed record in a run only; the record you uploaded is never changed. Short gaps are interpolated on a log scale (a
		recession), longer ones filled from another record scaled by the ratio of their totals on shared days. Off unless you turn it on.
	</p>
	{#if shown.length === 0}
		<p class="muted small">The project has no observed gauge or logger record.</p>
	{/if}
	{#each shown as kind (kind)}
		{@const spec = value[kind]}
		<fieldset class="rec" data-testid="gap-fill-{kind}">
			<legend>{cap(gapFillRecordLabel(kind))}</legend>
			<label class="check"><input type="checkbox" disabled={readonly} checked={!!spec} onchange={(e) => setOn(kind, e.currentTarget.checked)} /> Fill gaps in a run</label>
			{#if spec}
				<div class="grid">
					<div class="field">
						<label for="gf-{kind}-interp">Interpolate gaps up to (days)</label>
						<NumberInput id="gf-{kind}-interp" min={0} max={GAP_FILL_LIMITS.interpolateMaxDays} step={1} disabled={readonly} bind:value={() => value[kind]?.interpolateMaxDays ?? DEFAULT_FLOW_GAP_SPEC.interpolateMaxDays, (v) => set(kind, 'interpolateMaxDays', v)} aria-describedby="gf-{kind}-interp-h" />
						<span class="hint" id="gf-{kind}-interp-h">0 = none. Longer gaps are never interpolated: a flood inside them would be missed.</span>
					</div>
					<div class="field">
						<label for="gf-{kind}-donor">Fill longer gaps from</label>
						<select id="gf-{kind}-donor" disabled={readonly} bind:value={() => value[kind]?.donor ?? null, (v) => setDonor(kind, v)}>
							<option value={null}>No other record</option>
							{#each donorOptions(kind) as d (d)}<option value={d}>The {gapFillRecordLabel(d)}{has(d) ? '' : ' (none uploaded)'}</option>{/each}
						</select>
					</div>
					{#if spec.donor}
						<div class="field">
							<label for="gf-{kind}-dmax">Longest gap filled from it (days)</label>
							<NumberInput id="gf-{kind}-dmax" min={1} max={GAP_FILL_LIMITS.donorMaxDays} step={1} disabled={readonly} bind:value={() => value[kind]?.donorMaxDays ?? DEFAULT_FLOW_GAP_SPEC.donorMaxDays, (v) => set(kind, 'donorMaxDays', v)} />
						</div>
						<div class="field">
							<label for="gf-{kind}-overlap">Fewest shared days for the ratio</label>
							<NumberInput
								id="gf-{kind}-overlap"
								min={GAP_FILL_LIMITS.donorMinOverlapDaysMin}
								max={GAP_FILL_LIMITS.donorMinOverlapDaysMax}
								step={1}
								disabled={readonly}
								bind:value={() => value[kind]?.donorMinOverlapDays ?? DEFAULT_FLOW_GAP_SPEC.donorMinOverlapDays, (v) => set(kind, 'donorMinOverlapDays', v)}
							/>
						</div>
					{/if}
				</div>
			{/if}
		</fieldset>
	{/each}
	<label class="check">
		<input type="checkbox" disabled={readonly} bind:checked={value.useFilledDays} aria-describedby="gf-use-h" /> Statistics read filled days
	</label>
	<span class="hint" id="gf-use-h">
		Off (the default): the calibration scores, the fit, the EWR test on the observed record and the plausibility checks use measured days
		only, and filled days are shown and exported. On: they read the filled record.
	</span>
</div>

<style>
	.gap-fill {
		margin-top: 1rem;
	}
	.rec {
		border: 1px solid var(--border);
		border-radius: var(--radius, 6px);
		padding: 0.5rem 0.75rem;
		margin: 0.5rem 0;
	}
	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr));
		gap: 0.5rem 1rem;
		margin-top: 0.5rem;
	}
	.check {
		display: flex;
		align-items: center;
		gap: 0.4rem;
	}
	.hint {
		display: block;
	}
</style>
