<!--
	Settings → Flow calibration → Rain into GR4J → Areal rainfall correction, while it is on
	(settings.arealRain, engine ≥ 1.13.0, docs/model.md §2.4g, docs/ui.md § Model settings): the factor in
	every month, what it was derived from, the 12 monthly factors and the required source. Its own chunk (issue
	#521): most projects leave the correction off, and the Settings tab chunk sits at its size ceiling. Bind the
	setting; the page works out `arealError` (arealRainFormError), which blocks Save and shows under the source.
-->
<script lang="ts">
	import type { ProjectModel, ProjectSettings } from '@water-management/engine';
	import NumberInput from '#lib/components/common/NumberInput.svelte';
	import FieldHistoryLine from '#lib/components/history/FieldHistoryLine.svelte';
	import { WATER_YEAR_MONTHS } from '#lib/format/months.js';
	import ArealMapHelper from './ArealMapHelper.svelte';
	import { AREAL_METHOD_OPTIONS, flatFactor, storedArealRain, withFactorEveryMonth, type EditableArealRain } from './arealRain';

	let {
		value = $bindable(),
		arealError = null,
		readonly = false,
		projectId,
		settings,
		model
	}: {
		value: ProjectSettings['arealRain'];
		arealError?: string | null;
		readonly?: boolean;
		/** For the "from a MAP" helper (ArealMapHelper): the project, and the form's settings and model a run would read. */
		projectId?: string;
		settings?: () => ProjectSettings;
		model?: () => ProjectModel | undefined;
	} = $props();

	const areal = $derived(value as unknown as EditableArealRain);
	const arealFlat = $derived(flatFactor(areal));
</script>

<div class="fields">
	<div class="field">
		<span class="lbl"><label for="st-areal-all">Factor in every month <span class="u">(×)</span></label></span>
		<NumberInput
			id="st-areal-all"
			min={0.25}
			max={4}
			step={0.01}
			decimals={3}
			disabled={readonly}
			value={arealFlat}
			aria-describedby="st-areal-all-h{arealFlat === null ? ' st-areal-all-now' : ''}"
			onchange={(v) => {
				if (v !== null && value) value = storedArealRain(withFactorEveryMonth(areal, v));
			}}
		/>
		<span class="hint explain" id="st-areal-all-h">An independent MAP ÷ the forcing’s mean annual rain gives one factor.</span>
		{#if arealFlat === null}<span class="hint" id="st-areal-all-now">The months differ now (below).</span>{/if}
	</div>
	<div class="field">
		<span class="lbl"><label for="st-areal-method">Derived from</label></span>
		<select
			id="st-areal-method"
			disabled={readonly}
			value={areal.method}
			aria-describedby="st-areal-method-h"
			onchange={(e) => {
				if (value) value = storedArealRain({ ...areal, method: e.currentTarget.value as EditableArealRain['method'] });
			}}
		>
			{#each AREAL_METHOD_OPTIONS as o (o.value)}<option value={o.value}>{o.label}</option>{/each}
		</select>
		<span class="hint explain" id="st-areal-method-h">{AREAL_METHOD_OPTIONS.find((o) => o.value === areal.method)?.hint}</span>
	</div>
</div>
{#if !readonly && projectId && settings}
	<!-- An independent MAP ÷ the rain GR4J runs on (engine arealFactorFromMap): shown before Use fills anything. -->
	<ArealMapHelper {projectId} {settings} {model} current={areal} onapply={(next) => (value = storedArealRain(next))} />
{/if}
<div class="table-wrap">
	<table class="data compact monthly">
		<thead>
			<tr>
				<th scope="col" class="sticky">Month</th>
				{#each WATER_YEAR_MONTHS as m (m)}<th scope="col" class="num">{m}</th>{/each}
			</tr>
		</thead>
		<tbody>
			<tr>
				<th scope="row" class="sticky">Areal factor <span class="u">×</span></th>
				{#each WATER_YEAR_MONTHS as m, i (m)}
					<td>
						<NumberInput
							label="Areal rainfall factor, {m}"
							min={0.25}
							max={4}
							step={0.01}
							decimals={3}
							disabled={readonly}
							value={areal.factors[i] ?? 1}
							onchange={(v) => {
								if (v !== null && value) value = storedArealRain({ ...areal, factors: areal.factors.map((f, j) => (j === i ? v : f)) });
							}}
						/>
					</td>
				{/each}
			</tr>
		</tbody>
	</table>
</div>
<div class="field pe-source">
	<span class="lbl"><label for="st-areal-source">Source</label></span>
	<input
		id="st-areal-source"
		readonly={readonly}
		required
		value={areal.source}
		placeholder="e.g. catchment MAP 560 mm (reference) ÷ CHIRPS mean 2001–2024"
		aria-invalid={(!!arealError && !areal.source.trim()) || undefined}
		aria-describedby={arealError ? 'st-areal-source-h st-areal-err' : 'st-areal-source-h'}
		oninput={(e) => {
			if (value) value = storedArealRain({ ...areal, source: e.currentTarget.value });
		}}
	/>
	<span class="hint" id="st-areal-source-h">Required: the MAP or gauges and their reference, and the years compared. A fit records the factors, so changing them marks it “Forcing changed since fit”.</span>
	{#if arealError}<span class="err" id="st-areal-err">{arealError}</span>{/if}
</div>
<FieldHistoryLine field="settings:arealRain" />

<style>
	/* The Settings tab's own field and monthly-row styles are scoped to it: the same rules here. */
	.u {
		font-weight: 400;
		color: var(--text-muted);
		font-size: var(--font-sm);
	}
	.hint {
		display: block;
		font-size: var(--font-sm);
		max-width: 75ch;
	}
	.fields {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
		gap: 0 1.25rem;
		margin-top: 0.5rem;
	}
	.field :global(input),
	.field select {
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
	th.sticky {
		position: sticky;
		left: 0;
		z-index: 2;
		background: var(--surface);
		white-space: nowrap;
	}
	thead th.sticky {
		background: var(--surface-2);
		z-index: 3;
	}
	.monthly td {
		width: calc(6.5ch + 0.7rem + 2px + 0.4rem);
		padding-left: 0.1rem;
		padding-right: 0.1rem;
	}
	table.data.monthly td :global(input) {
		min-width: calc(6.5ch + 0.7rem + 2px);
	}
	.monthly td :global(input[type='number']) {
		appearance: textfield;
	}
	.monthly th.sticky {
		width: 13rem;
		white-space: normal;
	}
	.table-wrap {
		container: monthly / inline-size;
	}
	@container monthly (max-width: 30rem) {
		.monthly th.sticky {
			width: 6.5rem;
			min-width: 6.5rem;
		}
		.monthly th.sticky .u {
			display: block;
		}
	}
	.pe-source {
		max-width: 40rem;
		margin-top: 0.5rem;
	}
	.pe-source input {
		width: 100%;
	}
	.err {
		display: block;
		color: var(--danger);
		font-size: var(--font-sm);
	}
</style>
