<script lang="ts">
	// A farm's land-cover patches (WP-1.35, docs/model.md §2.5a): invasive alien
	// trees and forestry that use more water than the natural vegetation, each
	// reducing the farm's runoff by its class's (or its own) reductions times
	// its area × condensed cover. The patches are the editor's own objects, so
	// edits land in the model directly.
	import { tick } from 'svelte';
	import { LAND_COVER_CLASSES, LAND_COVER_DEFAULTS_SOURCE, type LandCoverClass, type LandCoverPatch, type NetworkNode } from '@water-management/engine';
	import NumberInput from '$lib/components/common/NumberInput.svelte';
	import { confirmDialog } from '$lib/components/common/confirm.svelte';
	import HelpTip from '$lib/components/help/HelpTip.svelte';
	import { fmtNum } from '$lib/format/number';
	import { classDefaults, coverShare } from './landcover';
	import { focusAfter, patchQuestion } from './removeQuestions';

	let {
		node,
		patches,
		readonly,
		onadd,
		onremove
	}: {
		node: NetworkNode;
		/** This farm's patches (live editor objects). */
		patches: LandCoverPatch[];
		readonly: boolean;
		onadd?: () => void;
		onremove?: (id: string) => void;
	} = $props();

	const share = $derived(coverShare(node, patches));
	const label = $derived(node.name || 'this hydrological unit');
	const classLabel = (c: LandCoverClass) => LAND_COVER_CLASSES.find((x) => x.id === c)?.label ?? c;
	let addBtn: HTMLButtonElement | undefined = $state();

	/** Asks first when the patch has an area, then puts the focus on the next one (or + Add land cover). */
	async function remove(p: LandCoverPatch, i: number) {
		const q = patchQuestion(p, i, classLabel(p.coverClass));
		if (q && !(await confirmDialog(q))) return;
		const at = focusAfter(i, patches.length);
		const nextId = at === null ? null : patches.filter((x) => x.id !== p.id)[at]?.id;
		onremove?.(p.id);
		await tick();
		(nextId ? document.getElementById(`lc-class-${nextId}`) : addBtn)?.focus();
	}
</script>

<div class="cover" data-testid="land-cover-{node.id}">
	<p class="hint">
		Invasive alien trees and forestry use more water than the natural vegetation. Each patch removes its class's share of
		the hydrological unit's runoff at full cover, times its area × condensed cover. Class reductions are {LAND_COVER_DEFAULTS_SOURCE}.
		<HelpTip key="land-cover" />
	</p>
	{#if patches.length === 0}
		<p class="muted small">No land cover on {label}.</p>
	{:else}
		<ul class="patches">
			{#each patches as p, i (p.id)}
				{@const d = classDefaults(p.coverClass)}
				<li>
					<div class="grid">
						<div class="field">
							<label for="lc-class-{p.id}">Cover class</label>
							<select id="lc-class-{p.id}" disabled={readonly} value={p.coverClass} onchange={(e) => (p.coverClass = e.currentTarget.value as LandCoverClass)}>
								{#each LAND_COVER_CLASSES as c (c.id)}<option value={c.id}>{c.label}</option>{/each}
							</select>
						</div>
						<div class="field">
							<label for="lc-area-{p.id}">Area <span class="u">(km²)</span></label>
							<NumberInput id="lc-area-{p.id}" min={0} disabled={readonly} value={p.areaKm2} onchange={(v) => (p.areaKm2 = v ?? 0)} />
						</div>
						<div class="field">
							<span class="lbl"><label for="lc-density-{p.id}">Condensed cover <span class="u">(%)</span></label><HelpTip key="land-cover" label="About condensed cover" /></span>
							<NumberInput id="lc-density-{p.id}" min={0} max={100} scale={100} disabled={readonly} value={p.densityPct} onchange={(v) => (p.densityPct = v ?? 0)} />
						</div>
						<div class="field check">
							<label>
								<input
									type="checkbox"
									disabled={readonly}
									checked={p.factors !== null}
									onchange={(e) => (p.factors = e.currentTarget.checked ? { mar: d.mar, lowFlow: d.lowFlow } : null)}
								/>
								Own reductions (patch {i + 1})
							</label>
						</div>
						{#if p.factors}
							<div class="field">
								<label for="lc-mar-{p.id}">Reduction of flows <span class="u">(%)</span></label>
								<NumberInput id="lc-mar-{p.id}" min={0} max={100} scale={100} disabled={readonly} value={p.factors.mar} onchange={(v) => (p.factors!.mar = v ?? 0)} />
							</div>
							<div class="field">
								<label for="lc-low-{p.id}">Reduction of low flows <span class="u">(%)</span></label>
								<NumberInput id="lc-low-{p.id}" min={0} max={100} scale={100} disabled={readonly} value={p.factors.lowFlow} onchange={(v) => (p.factors!.lowFlow = v ?? 0)} />
							</div>
						{:else}
							<p class="hint defaults">Class reductions at full cover: {Math.round(d.mar * 100)} % of flows, {Math.round(d.lowFlow * 100)} % of low flows.</p>
						{/if}
					</div>
					{#if !readonly && onremove}
						<button type="button" class="btn btn-sm" onclick={() => remove(p, i)}>Remove land-cover patch {i + 1} ({classLabel(p.coverClass)})</button>
					{/if}
				</li>
			{/each}
		</ul>
		<p class="muted small" class:warn={share > 1}>
			Condensed cover {Math.round(share * 100)} % of the hydrological unit's {fmtNum(node.areaKm2 || 0, 2)} km²{share > 1 ? ': more than the hydrological unit; the run scales it down' : ''}.
		</p>
	{/if}
	{#if !readonly && onadd}
		<button type="button" class="btn" onclick={onadd} bind:this={addBtn}>+ Add land cover</button>
	{/if}
</div>

<style>
	.patches {
		list-style: none;
		padding: 0;
		margin: 0 0 0.5rem;
	}
	.patches li {
		border-top: 1px solid var(--border);
		padding: 0.5rem 0;
	}
	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
		gap: 0 1rem;
		align-items: end;
	}
	.field :global(input:not([type='checkbox'])),
	.field select {
		width: 100%;
	}
	.field label {
		font-weight: 500;
		font-size: 0.85rem;
		color: var(--text-2);
	}
	.lbl {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
	}
	.check label {
		display: inline-flex;
		gap: 0.4rem;
		align-items: center;
		min-height: 36px;
	}
	.defaults {
		grid-column: span 2;
		margin: 0;
		font-size: 0.85rem;
	}
	.warn {
		color: var(--warning);
	}
	@media (max-width: 640px) {
		.field :global(input:not([type='checkbox'])),
		.field select,
		.btn {
			min-height: 44px;
		}
	}
</style>
