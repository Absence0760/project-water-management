<script lang="ts">
	import type { ProjectSettings } from '@water-management/engine';
	import NumberInput from '$lib/components/common/NumberInput.svelte';
	import HelpTip from '$lib/components/help/HelpTip.svelte';
	import MoveControls from '$lib/components/model/MoveControls.svelte';
	import { refocusMover, RowReorder } from '$lib/components/model/rowReorder.svelte';
	import { moveTo, reorderSubset } from '$lib/model/order';
	import { fmtNum, fmtPct } from '$lib/format/number';
	import { WATER_YEAR_MONTHS } from '$lib/format/months';
	import type { ModelEditor } from '$lib/model/editor.svelte';
	import { farmDemands, highCropFactors } from './demand';

	let { editor, settings, readonly }: { editor: ModelEditor; settings: ProjectSettings; readonly: boolean } = $props();

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
	// Factors multiply A-pan, not ET₀: above 1.0 is worth a second look (a hint, never blocking).
	const highFactors = $derived(highCropFactors(crops, WATER_YEAR_MONTHS));

	// Demand preview: saved A-pan × current (possibly unsaved) crops and areas.
	const apanSet = $derived(settings.apanMm.some((v) => v > 0));
	const demand = $derived(
		farmDemands(
			editor.model,
			settings.apanMm,
			settings.februaryDays,
			farms.map((f) => f.id)
		)
	);
	const demandTotal = $derived({
		monthly: WATER_YEAR_MONTHS.map((_, m) => demand.reduce((s, d) => s + (d.monthlyM3Day[m] ?? 0), 0)),
		mean: demand.reduce((s, d) => s + d.meanM3Day, 0),
		annual: demand.reduce((s, d) => s + d.annualMm3, 0)
	});
	const peak = $derived(Math.max(1e-9, ...demand.flatMap((d) => d.monthlyM3Day)));
	const shade = (v: number) => `--i: ${Math.round((v / peak) * 100)}%`;

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

	// --- display order: crops have their own; farm rows share the node order ---
	let announce = $state('');
	function moveCrop(from: number, to: number, focus: 'up' | 'down' | null = null) {
		const c = crops[from];
		if (!c || to < 0 || to >= crops.length) return;
		editor.model.crops = moveTo(editor.model.crops, from, to);
		announce = `${c.name || 'Crop'} moved to position ${to + 1} of ${crops.length}.`;
		if (focus) void refocusMover('mvc', c.id, focus);
	}
	function moveFarm(from: number, to: number, focus: 'up' | 'down' | null = null) {
		const f = farms[from];
		if (!f || to < 0 || to >= farms.length) return;
		editor.model.nodes = reorderSubset(editor.model.nodes, farms.map((x) => x.id), from, to);
		announce = `${f.name || 'Farm'} moved to row ${to + 1} of ${farms.length} (network order).`;
		if (focus) void refocusMover('mvf', f.id, focus);
	}
	const cropReorder = new RowReorder(() => crops.map((c) => c.id), (from, to) => moveCrop(from, to));
	const farmReorder = new RowReorder(() => farms.map((f) => f.id), (from, to) => moveFarm(from, to));
</script>

<p class="visually-hidden" aria-live="polite">{announce}</p>

<section class="panel" aria-labelledby="crops-h">
	<div class="panel-head">
		<h2 id="crops-h">Crop factors <HelpTip key="crop.cropFactor" /></h2>
		<span class="muted small">Water year, October → September</span>
	</div>
	<p class="muted small intro">
		A crop factor scales monthly A-pan evaporation to the crop's water use: gross irrigation need (mm) = A-pan × crop
		factor. It is <strong>× A-pan, not an FAO Kc</strong>: FAO-56 Kc values multiply reference ET₀, about 0.7–0.85 × pan, so
		multiply a published Kc by the pan coefficient before entering it. Use 0 for months the crop isn't irrigated.
	</p>
	{#if crops.length === 0}
		<div class="empty">
			<p>No crops defined. Add each irrigated crop (e.g. citrus, vines, pasture) with its monthly crop factors.</p>
			{#if !readonly}<button type="button" class="btn btn-primary" onclick={add}>Add crop</button>{/if}
		</div>
	{:else}
		<div class="table-wrap">
			<table class="data compact factors">
				<thead>
					<tr>
						<th scope="col" class="sticky">Crop</th>
						{#each WATER_YEAR_MONTHS as m (m)}<th scope="col" class="num">{m}</th>{/each}
						<th scope="col" class="num">Mean</th>
						{#if !readonly}<th scope="col"><span class="visually-hidden">Remove</span></th>{/if}
					</tr>
				</thead>
				<tbody bind:this={cropReorder.body}>
					{#each crops as crop, ci (crop.id)}
						{@const label = crop.name || 'unnamed crop'}
						{@const rs = cropReorder.rowState(crop.id, ci, crops.length)}
						<tr data-idx={ci} class:dragging={rs.dragging} class:drop-before={rs.before} class:drop-after={rs.after}>
							<th scope="row" class="sticky">
								<span class="namecell">
									{#if !readonly}
										<MoveControls id={crop.id} {label} index={ci} count={crops.length} reorder={cropReorder} idPrefix="mvc" onmove={(d) => moveCrop(ci, ci + d, d < 0 ? 'up' : 'down')} />
									{/if}
									<input id="crop-name-{crop.id}" aria-label="Crop name" maxlength="100" readonly={readonly} bind:value={crop.name} />
								</span>
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
		{#if highFactors.length}
			<p class="alert alert-warning small" role="status">
				A crop factor above 1.0 means the crop uses more water than an open A-pan loses. That can happen, but check it isn't an
				FAO Kc entered as it is:
				{#each highFactors as h, i (h.id)}{i ? '; ' : ' '}<strong>{h.name || 'unnamed crop'}</strong> ({h.months.join(', ')}){/each}.
			</p>
		{/if}
		{#if !readonly}<div class="toolbar after"><button type="button" class="btn" onclick={add}>+ Add crop</button></div>{/if}
	{/if}
</section>

<section class="panel" aria-labelledby="areas-h">
	<div class="panel-head">
		<h2 id="areas-h">Planted areas</h2>
		<span class="muted small">Irrigated area per farm and crop, hectares · rows follow the network order</span>
	</div>
	{#if farms.length === 0 || crops.length === 0}
		<p class="muted">Add at least one farm (Network tab) and one crop to enter planted areas.</p>
	{:else}
		<div class="table-wrap">
			<table class="data compact areas">
				<thead>
					<tr>
						<th scope="col" class="sticky">Farm</th>
						{#each crops as c (c.id)}<th scope="col" class="num">{c.name || '(unnamed)'}<br /><span class="u">ha</span></th>{/each}
						<th scope="col" class="num">Total<br /><span class="u">ha</span></th>
					</tr>
				</thead>
				<tbody bind:this={farmReorder.body}>
					{#each farms as f, fi (f.id)}
						{@const rs = farmReorder.rowState(f.id, fi, farms.length)}
						<tr data-idx={fi} class:dragging={rs.dragging} class:drop-before={rs.before} class:drop-after={rs.after}>
							<th scope="row" class="sticky">
								<span class="namecell">
									{#if !readonly}
										<MoveControls id={f.id} label={f.name || 'farm'} index={fi} count={farms.length} reorder={farmReorder} idPrefix="mvf" onmove={(d) => moveFarm(fi, fi + d, d < 0 ? 'up' : 'down')} />
									{/if}
									<span>{f.name || '(unnamed)'}</span>
								</span>
							</th>
							{#each crops as c (c.id)}
								<td>
									<NumberInput
										label="{c.name || 'crop'} on {f.name || 'farm'}, ha"
										min={0}
										step={0.1}
										scale={1 / 10_000}
										disabled={readonly}
										value={editor.cropArea(f.id, c.id)}
										onchange={(n) => editor.setCropArea(f.id, c.id, n ?? 0)}
									/>
								</td>
							{/each}
							<td class="num total">{ha(rowTotal(f.id))}</td>
						</tr>
					{/each}
				</tbody>
				<tfoot>
					<tr>
						<th scope="row" class="sticky">Total</th>
						{#each crops as c (c.id)}
							<td class="num">{ha(colTotal(c.id))} ha</td>
						{/each}
						<td class="num">{ha(grandTotal)} ha</td>
					</tr>
				</tfoot>
			</table>
		</div>
	{/if}
</section>

<section class="panel" aria-labelledby="dem-h">
	<div class="panel-head">
		<h2 id="dem-h">Irrigation demand preview <HelpTip key="settings.apanMm" label="About A-pan evaporation" /></h2>
		<span class="muted small">Gross demand, m³/day per month</span>
	</div>
	<p class="muted small intro">
		Gross demand = Σ area × A-pan × crop factor, spread over the days in each month (February {fmtNum(settings.februaryDays, 2)}
		days). On each simulated day the model then subtracts effective rainfall ({fmtPct(settings.effectiveRainFraction, 0)} of rain on the
		cropped area{#if settings.effectiveRainStoreMm > 0}, with what the crop can't use that day carried over in a
			{fmtNum(settings.effectiveRainStoreMm, 0)} mm soil-water store{/if}) to get the net demand the farm's dam and river must supply. Uses saved A-pan values and the crops and areas above,
		including unsaved edits.
	</p>
	{#if !apanSet}
		<div class="alert alert-info">
			A-pan evaporation isn't set yet, so demand is zero. <a href="?tab=settings">Enter the monthly A-pan values</a>
			(Settings & calibration, Demand).
		</div>
	{/if}
	{#if farms.length === 0}
		<p class="muted">No farms yet.</p>
	{:else}
		<div class="table-wrap">
			<table class="data compact demand">
				<thead>
					<tr>
						<th scope="col" class="sticky">Farm</th>
						<th scope="col" class="num">Area<br /><span class="u">ha</span></th>
						{#each WATER_YEAR_MONTHS as m (m)}<th scope="col" class="num">{m}<br /><span class="u">m³/day</span></th>{/each}
						<th scope="col" class="num">Mean<br /><span class="u">m³/day</span></th>
						<th scope="col" class="num">Annual<br /><span class="u">Mm³/a</span></th>
					</tr>
				</thead>
				<tbody>
					{#each farms as f, i (f.id)}
						{@const d = demand[i]}
						{#if d}
							<tr>
								<th scope="row" class="sticky">{f.name || '(unnamed)'}</th>
								<td class="num">{fmtNum(d.areaHa, 1)}</td>
								{#each d.monthlyM3Day as v, m (m)}<td class="num heat" style={shade(v)}>{fmtNum(v)}</td>{/each}
								<td class="num">{fmtNum(d.meanM3Day)}</td>
								<td class="num strong">{fmtNum(d.annualMm3, 3)}</td>
							</tr>
						{/if}
					{/each}
				</tbody>
				<tfoot>
					<tr>
						<th scope="row" class="sticky">Catchment</th>
						<td class="num">{ha(grandTotal)}</td>
						{#each demandTotal.monthly as v, m (m)}<td class="num">{fmtNum(v)}</td>{/each}
						<td class="num">{fmtNum(demandTotal.mean)}</td>
						<td class="num">{fmtNum(demandTotal.annual, 3)}</td>
					</tr>
				</tfoot>
			</table>
		</div>
		<p class="muted small after">
			1 Mm³ = 1 million m³. Darker cells are months of higher demand. Annual catchment demand is
			{fmtNum(demandTotal.annual, 3)} Mm³/a ({fmtNum((demandTotal.annual * 1e6) / 86_400 / 365.25, 3)} m³/s on average).
		</p>
	{/if}
</section>

<style>
	.small {
		font-size: 0.8rem;
	}
	.intro {
		margin: -0.25rem 0 0.75rem;
		max-width: 75ch;
	}
	.u {
		font-weight: 400;
		color: var(--text-muted);
	}
	th.sticky {
		position: sticky;
		left: 0;
		z-index: 2;
		background: var(--surface);
	}
	thead th.sticky,
	tfoot th.sticky {
		background: var(--surface-2);
		z-index: 3;
	}
	.factors th[scope='row'] {
		min-width: 150px;
	}
	.factors td {
		min-width: 64px;
	}
	.factors td :global(input[type='number']) {
		min-width: 3.8rem;
	}
	.areas td {
		min-width: 100px;
	}
	.areas th[scope='row'],
	.demand th[scope='row'] {
		min-width: 130px;
		white-space: nowrap;
	}
	.total {
		font-weight: 600;
	}
	.namecell {
		display: flex;
		align-items: center;
		gap: 0.25rem;
	}
	.namecell input {
		flex: 1;
		min-width: 110px;
	}
	tr.dragging {
		opacity: 0.5;
	}
	tr.drop-before > * {
		box-shadow: inset 0 2px 0 var(--accent);
	}
	tr.drop-after > * {
		box-shadow: inset 0 -2px 0 var(--accent);
	}
	.demand td {
		min-width: 64px;
	}
	.heat {
		background: color-mix(in srgb, color-mix(in srgb, var(--brand-outlet) 45%, transparent) var(--i), transparent);
	}
	.strong {
		font-weight: 600;
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
