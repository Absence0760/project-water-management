<script lang="ts">
	import NumberInput from '$lib/components/common/NumberInput.svelte';
	import { fmtNum } from '$lib/format/number';
	import { WATER_YEAR_MONTHS } from '$lib/format/months';
	import type { ModelEditor } from '$lib/model/editor.svelte';

	let { editor, readonly }: { editor: ModelEditor; readonly: boolean } = $props();

	const crops = $derived(editor.model.crops);
	// Farms, plus any other node that already carries crop areas.
	const farms = $derived(
		editor.model.nodes.filter((n) => n.kind === 'farm' || editor.model.cropAreas.some((a) => a.nodeId === n.id))
	);

	const rowTotal = (nodeId: string) =>
		editor.model.cropAreas.filter((a) => a.nodeId === nodeId).reduce((s, a) => s + a.areaM2, 0);
	const colTotal = (cropId: string) =>
		editor.model.cropAreas
			.filter((a) => a.cropId === cropId && farms.some((f) => f.id === a.nodeId))
			.reduce((s, a) => s + a.areaM2, 0);
	const grandTotal = $derived(crops.reduce((s, c) => s + colTotal(c.id), 0));

	function add() {
		const c = editor.addCrop();
		queueMicrotask(() => document.getElementById(`crop-name-${c.id}`)?.focus());
	}

	function remove(id: string, name: string) {
		const used = editor.model.cropAreas.some((a) => a.cropId === id);
		if (used && !confirm(`Remove crop "${name}" and its planted areas on every farm?`)) return;
		editor.removeCrop(id);
	}

	const ha = (m2: number) => fmtNum(m2 / 10_000, 2);
</script>

<section class="panel" aria-labelledby="crops-h">
	<div class="panel-head">
		<h2 id="crops-h">Crops</h2>
		<span class="muted small">Crop factor per month, applied to A-pan evaporation (water year Oct → Sep)</span>
	</div>
	{#if crops.length === 0}
		<div class="empty">
			<p>No crops defined.</p>
			{#if !readonly}<button type="button" class="btn btn-primary" onclick={add}>Add crop</button>{/if}
		</div>
	{:else}
		<div class="table-wrap">
			<table class="data compact factors">
				<thead>
					<tr>
						<th scope="col">Crop</th>
						{#each WATER_YEAR_MONTHS as m (m)}<th scope="col" class="num">{m}</th>{/each}
						<th scope="col" class="num">Mean</th>
						{#if !readonly}<th scope="col"><span class="visually-hidden">Remove</span></th>{/if}
					</tr>
				</thead>
				<tbody>
					{#each crops as crop (crop.id)}
						{@const label = crop.name || 'unnamed crop'}
						<tr>
							<th scope="row">
								<input id="crop-name-{crop.id}" aria-label="Crop name" maxlength="100" readonly={readonly} bind:value={crop.name} />
							</th>
							{#each WATER_YEAR_MONTHS as m, i (m)}
								<td>
									<NumberInput
										label="{label} crop factor, {m}"
										min={0}
										step={0.01}
										disabled={readonly}
										bind:value={crop.cropFactor[i]}
									/>
								</td>
							{/each}
							<td class="num muted">{fmtNum(crop.cropFactor.reduce((s, f) => s + (f || 0), 0) / 12, 2)}</td>
							{#if !readonly}
								<td><button type="button" class="btn btn-icon" aria-label="Remove {label}" title="Remove crop" onclick={() => remove(crop.id, label)}>✕</button></td>
							{/if}
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
		{#if !readonly}<div class="toolbar after"><button type="button" class="btn" onclick={add}>+ Add crop</button></div>{/if}
	{/if}
</section>

<section class="panel" aria-labelledby="areas-h">
	<div class="panel-head">
		<h2 id="areas-h">Planted areas</h2>
		<span class="muted small">m² per farm and crop (hectares shown beneath)</span>
	</div>
	{#if farms.length === 0 || crops.length === 0}
		<p class="muted">Add at least one farm (Network tab) and one crop to enter planted areas.</p>
	{:else}
		<div class="table-wrap">
			<table class="data compact areas">
				<thead>
					<tr>
						<th scope="col">Farm</th>
						{#each crops as c (c.id)}<th scope="col" class="num">{c.name || '(unnamed)'}</th>{/each}
						<th scope="col" class="num">Total</th>
					</tr>
				</thead>
				<tbody>
					{#each farms as f (f.id)}
						{@const total = rowTotal(f.id)}
						<tr>
							<th scope="row">{f.name || '(unnamed)'}</th>
							{#each crops as c (c.id)}
								{@const v = editor.cropArea(f.id, c.id)}
								<td>
									<NumberInput
										label="{c.name || 'crop'} on {f.name || 'farm'}, m²"
										min={0}
										step={100}
										disabled={readonly}
										value={v}
										onchange={(n) => editor.setCropArea(f.id, c.id, n ?? 0)}
									/>
									<span class="ha">{v ? `${ha(v)} ha` : ' '}</span>
								</td>
							{/each}
							<td class="num total">
								{fmtNum(total)} m²<span class="ha">{ha(total)} ha</span>
							</td>
						</tr>
					{/each}
				</tbody>
				<tfoot>
					<tr>
						<th scope="row">Total</th>
						{#each crops as c (c.id)}
							{@const t = colTotal(c.id)}
							<td class="num">{fmtNum(t)} m²<span class="ha">{ha(t)} ha</span></td>
						{/each}
						<td class="num">{fmtNum(grandTotal)} m²<span class="ha">{ha(grandTotal)} ha</span></td>
					</tr>
				</tfoot>
			</table>
		</div>
	{/if}
</section>

<style>
	.small {
		font-size: 0.8rem;
	}
	.factors th[scope='row'] {
		min-width: 160px;
	}
	.factors td {
		min-width: 64px;
	}
	.factors td :global(input[type='number']) {
		min-width: 3.8rem;
	}
	.areas td {
		min-width: 120px;
		vertical-align: top;
	}
	.ha {
		display: block;
		font-size: 0.72rem;
		color: var(--text-muted);
		text-align: right;
		font-variant-numeric: tabular-nums;
		min-height: 1em;
	}
	.total {
		vertical-align: top;
	}
	.after {
		margin: 0.75rem 0 0;
	}
	.empty {
		padding: 1.5rem;
		text-align: center;
		color: var(--text-muted);
		border: 1px dashed var(--border-strong);
		border-radius: var(--radius);
	}
</style>
