<script lang="ts">
	// A farm's or other user's individual boreholes (WP-3.9, docs/model.md
	// §2.7d): each with its own capacity (the specialist's sustainable yield),
	// annual cap per water year, supply mode, target (straight to the crop or
	// into the dam) and stream-depletion share. The boreholes are the editor's
	// own objects, so edits land in the model directly.
	import { BOREHOLE_MODES, ga538VolumeM3, type Borehole, type BoreholeMode, type BoreholeTarget, type NetworkNode } from '@water-management/engine';
	import NumberInput from '$lib/components/common/NumberInput.svelte';
	import HelpTip from '$lib/components/help/HelpTip.svelte';
	import { fmtNum } from '$lib/format/number';

	let {
		node,
		boreholes,
		readonly,
		onadd,
		onremove
	}: {
		node: NetworkNode;
		/** This node's boreholes (live editor objects). */
		boreholes: Borehole[];
		readonly: boolean;
		onadd?: () => void;
		onremove?: (id: string) => void;
	} = $props();

	const MODE_LABEL: Record<BoreholeMode, string> = {
		supplemental: 'Supplemental: after the dam and river',
		primary: 'Primary: first, the dam and river cover the rest',
		emergency: 'Emergency: supplemental while the dam is below its level',
		none: 'None: on record, never pumps'
	};
	const hasDam = $derived(node.kind === 'farm' && node.damCapacityM3 > 0);
	const label = $derived(node.name || (node.kind === 'user' ? 'this user' : 'this hydrological unit'));
	// The GN 538 volume for the property (engine ≥ 1.12.0): area × Table 2 rate, at most 40 000 m³/a; else the ceiling.
	const ga = $derived(ga538VolumeM3(node));
	const capped = $derived(boreholes.filter((b) => b.mode !== 'none').reduce<number | null>((s, b) => (s === null || b.annualCapM3 === null ? null : s + b.annualCapM3), 0));
</script>

<div class="bores" data-testid="boreholes-{node.id}">
	<p class="hint">
		Each borehole pumps up to its capacity a day and, with a cap, up to its annual cap per water year (October to September). The
		combined capacity above, if any, runs as well. <HelpTip key="node.boreholeCapacityM3Day" />
	</p>
	<p class="hint note" role="note">
		<span class="badge badge-warn">Low confidence</span> Depletion is a fixed fraction, not an aquifer model. Attach the geohydrology report.
	</p>
	{#if boreholes.length === 0}
		<p class="muted small">No individual boreholes on {label}.</p>
	{:else}
		<ul class="list">
			{#each boreholes as b, i (b.id)}
				<li>
					<div class="grid">
						<div class="field">
							<label for="bh-name-{b.id}">Name</label>
							<input id="bh-name-{b.id}" maxlength="200" readonly={readonly} bind:value={b.name} />
						</div>
						<div class="field">
							<label for="bh-cap-{b.id}">Capacity <span class="u">(m³/day)</span></label>
							<NumberInput id="bh-cap-{b.id}" min={0} grouped disabled={readonly} value={b.capacityM3Day} onchange={(v) => (b.capacityM3Day = v ?? 0)} />
						</div>
						<div class="field">
							<label for="bh-annual-{b.id}">Annual cap <span class="u">(m³/a)</span></label>
							<NumberInput id="bh-annual-{b.id}" min={0} grouped nullable placeholder="no cap" disabled={readonly} value={b.annualCapM3} onchange={(v) => (b.annualCapM3 = v)} />
						</div>
						<div class="field">
							<label for="bh-mode-{b.id}">Mode</label>
							<select id="bh-mode-{b.id}" disabled={readonly} value={b.mode} onchange={(e) => (b.mode = e.currentTarget.value as BoreholeMode)}>
								{#each BOREHOLE_MODES as m (m)}<option value={m} disabled={m === 'emergency' && !hasDam}>{MODE_LABEL[m]}</option>{/each}
							</select>
						</div>
						{#if b.mode === 'emergency'}
							<div class="field">
								<label for="bh-level-{b.id}">Runs below <span class="u">(% of dam)</span></label>
								<NumberInput id="bh-level-{b.id}" min={0} max={100} scale={100} disabled={readonly} value={b.emergencyBelowPct} onchange={(v) => (b.emergencyBelowPct = v ?? 0)} />
							</div>
						{/if}
						{#if node.kind === 'farm'}
							<div class="field">
								<label for="bh-target-{b.id}">Pumps into</label>
								<select id="bh-target-{b.id}" disabled={readonly} value={b.target} onchange={(e) => (b.target = e.currentTarget.value as BoreholeTarget)}>
									<option value="direct">The crop (straight to irrigation)</option>
									<option value="dam" disabled={!hasDam}>The hydrological unit's dam</option>
								</select>
							</div>
						{/if}
						<div class="field">
							<label for="bh-dep-{b.id}">Stream depletion <span class="u">(% of pumping)</span></label>
							<NumberInput id="bh-dep-{b.id}" min={0} max={100} scale={100} disabled={readonly} value={b.depletionFactor} onchange={(v) => (b.depletionFactor = v ?? 0)} />
						</div>
					</div>
					{#if !readonly && onremove}
						<button type="button" class="btn btn-sm" onclick={() => onremove(b.id)}>Remove borehole {i + 1}</button>
					{/if}
				</li>
			{/each}
		</ul>
		<p class="muted small" data-testid="bh-cap-note">
			{capped === null ? 'At least one borehole has no annual cap.' : `Annual caps total ${fmtNum(capped, 0)} m³/a.`}
			{#if ga.basis === 'property'}
				For context, the GN 538 general authorisation allows this property {fmtNum(ga.limitM3, 0)} m³/a of groundwater (its area × the Table 2
				rate, at most 40 000) in any 12 months.
			{:else}
				For context, the GN 538 general authorisation allows a property its area × the Table 2 rate of its quaternary, at most 40 000 m³/a;
				enter the property area and rate above for this one’s.
			{/if}
			The run shows modelled use against both; the app never decides whether a use is lawful.
			It doesn’t cover an alluvial aquifer connected to the stream, or groundwater taken within 100 m of a watercourse.
		</p>
	{/if}
	{#if !readonly && onadd}
		<button type="button" class="btn" onclick={onadd}>+ Add borehole</button>
	{/if}
</div>

<style>
	.list {
		list-style: none;
		padding: 0;
		margin: 0 0 0.5rem;
	}
	.list li {
		border-top: 1px solid var(--border);
		padding: 0.5rem 0;
	}
	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
		gap: 0 1rem;
		align-items: end;
	}
	.field :global(input),
	.field select {
		width: 100%;
	}
	.field label {
		font-weight: 500;
		font-size: 0.85rem;
		color: var(--text-2);
	}
	.note .badge {
		margin-right: 0.35rem;
	}
	@media (max-width: 640px) {
		.field :global(input),
		.field select,
		.btn {
			min-height: 44px;
		}
	}
</style>
