<!--
	One patching priority (issue #612, docs/model.md §2.4i, docs/ui.md § Model settings): an ordered list of pull-downs,
	each a station other than the main one or CHIRPS, with Up, Down, Remove and Add a source, and under each station how
	many of the main station's gap days it fills over the run's history, or why it can't help (`use`, from
	patchChoices.ts; a station that can't help is greyed out in the pull-downs). Three callers: a unit's row and the
	select-several action (FlowGenerationUnits.svelte), and the catchment's station (FlowGenerationCatchment.svelte).
-->
<script lang="ts">
	import { CHIRPS_PATCH, patchAdd, patchMove, patchRemove, patchSet, patchUsabilityText, type PatchUsability, type PatchValue, type StationOption } from './flowGeneration';

	let {
		values,
		set,
		mainId,
		who,
		use,
		stations,
		readonly = false,
		chirpsText
	}: {
		values: PatchValue[];
		set: (v: PatchValue[]) => void;
		/** The main station, never a choice. */
		mainId: string | null;
		/** Whose gaps, for the controls' names ("Unit A", "the catchment"). */
		who: string;
		/** Each station's usability against the main station, or null while unknown. */
		use: Record<string, PatchUsability> | null;
		stations: readonly StationOption[];
		readonly?: boolean;
		/** What CHIRPS, corrected, is for this area. */
		chirpsText: string;
	} = $props();

	const next = $derived(patchAdd(values, stations, mainId, use ? (id) => use[id]?.usable === true : undefined));
</script>

{#if values.length}
	<ol class="chain" aria-label="Then patch gaps from, for {who}" data-testid="flowgen-patch">
		{#each values as v, i (v)}
			{@const u = v === CHIRPS_PATCH ? null : (use?.[v] ?? null)}
			<li data-testid="flowgen-patch-entry" data-source={v}>
				<span class="chain-row">
					<select aria-label="Patch source {i + 1} for {who}" disabled={readonly} value={v} onchange={(e) => set(patchSet(values, i, e.currentTarget.value))}>
						{#each stations.filter((st) => st.id !== mainId) as st (st.id)}
							{@const su = use?.[st.id]}
							<option value={st.id} disabled={!!su && !su.usable && st.id !== v}>{st.name}{su && !su.usable ? ` (can’t help: ${su.reason})` : ''}</option>
						{/each}
						<option value={CHIRPS_PATCH}>CHIRPS, corrected</option>
						{#if v !== CHIRPS_PATCH && !stations.some((st) => st.id === v)}<option value={v}>A station the project no longer has</option>{/if}
					</select>
					{#if !readonly}
						<button type="button" class="btn btn-sm" aria-label="Move patch source {i + 1} for {who} up" disabled={i === 0} onclick={() => set(patchMove(values, i, -1))}>Up</button>
						<button type="button" class="btn btn-sm" aria-label="Move patch source {i + 1} for {who} down" disabled={i === values.length - 1} onclick={() => set(patchMove(values, i, 1))}
							>Down</button
						>
						<button type="button" class="btn btn-sm" aria-label="Remove patch source {i + 1} for {who}" onclick={() => set(patchRemove(values, i))}>Remove</button>
					{/if}
				</span>
				{#if v === CHIRPS_PATCH}
					<span class="small block muted">{chirpsText}</span>
				{:else if u}
					<span class="small block" class:err={!u.usable} data-testid="flowgen-patch-fill">{patchUsabilityText(u)}</span>
				{/if}
			</li>
		{/each}
	</ol>
{:else}
	<span class="small block muted" data-testid="flowgen-patch-none">Nothing: the station’s gaps go to the next fallback.</span>
{/if}
{#if !readonly}
	<button type="button" class="btn btn-sm add" disabled={!next} onclick={() => next && set(next)}>Add a source</button>
{/if}

<style>
	.small {
		font-size: var(--font-sm);
	}
	.block {
		display: block;
	}
	.muted {
		color: var(--text-2);
	}
	.err {
		display: block;
		color: var(--danger);
	}
	.chain {
		margin: 0;
		padding-left: 1.2rem;
	}
	.chain li + li {
		margin-top: 0.3rem;
	}
	.chain-row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.25rem;
	}
	.chain-row select {
		max-width: 100%;
	}
	.add {
		margin-top: 0.3rem;
	}
	@media (pointer: coarse), (max-width: 640px) {
		.chain-row select,
		.chain .btn,
		.add {
			min-height: var(--tap);
		}
	}
	/* Inside the Per unit table's stacked rows (FlowGenerationUnits.svelte, narrower than 40rem), a pull-down takes the width. */
	@container flowgen-rows (max-width: 40rem) {
		.chain-row select {
			width: 100%;
		}
	}
</style>
