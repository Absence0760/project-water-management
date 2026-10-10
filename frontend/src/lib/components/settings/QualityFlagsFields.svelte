<!--
	Settings fields for settings.qualityFlags (engine ≥ 1.22.0, calibration
	research CR-18/19): the gauged range of each calibration record (the
	highest and lowest field gaugings behind its rating curve, with their
	source), how Fit automatically scores extrapolated, suspect and
	infilled days, and (engine ≥ 1.81.0, issue #507 item 2) the months the
	river is known to stop, which decide which zero-flow stretches are trusted. Bind the value; `error` is set while it is invalid, so the
	parent form can block saving.
-->
<script lang="ts">
	import { RATING_SOURCE_MAX, type CalibrationFlowKind, type GaugeRating, type QualityFlagSettings } from '@water-management/engine';
	import HelpTip from '$lib/components/help/HelpTip.svelte';
	import NumberInput from '$lib/components/common/NumberInput.svelte';
	import { ABOVE_OPTIONS, FLAG_OPTIONS, qualityFlagsError, ratedKinds, ratingField, ratingProblem, RECORD_NAME, withRating } from './qualityFlags';
	import { ZERO_FLOW_TRUST_MAX_DAYS, zeroFlowMonthsText } from '@water-management/engine';
	import MonthPicker from '$lib/components/common/MonthPicker.svelte';

	let {
		value = $bindable(),
		error = $bindable(null),
		readonly = false,
		seriesKinds = null
	}: {
		value: QualityFlagSettings;
		error?: string | null;
		readonly?: boolean;
		/** Series kinds the project has (null = not known: both records are offered). */
		seriesKinds?: string[] | null;
	} = $props();

	const uid = $props.id();
	const kinds = $derived(ratedKinds(seriesKinds));
	$effect(() => {
		error = qualityFlagsError(value);
	});
	const set = (kind: CalibrationFlowKind, patch: Partial<GaugeRating>) => (value.ratings = withRating(value.ratings, kind, patch));
</script>

<fieldset class="plain qf" aria-describedby="{uid}-hint">
	<legend><h3 class="title">Quality flags for Fit automatically <HelpTip key="settings.qualityFlags" /></h3></legend>
	<p class="hint" id="{uid}-hint">
		A flow above the highest field gauging, or below the lowest, comes from an extrapolated rating curve. Enter the gauged range where you know it,
		with where it comes from. Days the Data checks call suspect (outliers, flat stretches) are flagged too. The fit leaves flagged days out by default
		and shows its score on all days beside it; the run’s calibration statistics still score every observed day.
	</p>
	{#each kinds as kind (kind)}
		{@const r = ratingField(value, kind)}
		<!-- The record's problem sits under the field it is fixed in, which names it (aria-describedby). -->
		{@const p = ratingProblem(value, kind)}
		{@const errId = `${uid}-${kind}-err`}
		<div class="rating" data-testid="rating-{kind}">
			<div class="field">
				<label for="{uid}-{kind}-max">{RECORD_NAME[kind]}: highest gauging <span class="u">(m³/s)</span></label>
				<NumberInput
					id="{uid}-{kind}-max"
					nullable
					min={0}
					step="any"
					disabled={readonly}
					bind:value={() => r.gaugedMaxM3s, (v) => set(kind, { gaugedMaxM3s: v })}
					placeholder="not known"
					aria-invalid={p?.field === 'max' ? 'true' : undefined}
					aria-describedby={p?.field === 'max' ? errId : undefined}
				/>
				{#if p?.field === 'max'}<span class="err" id={errId}>{p.message}</span>{/if}
			</div>
			<div class="field">
				<label for="{uid}-{kind}-min"><span class="visually-hidden">{RECORD_NAME[kind]}: </span>Lowest gauging <span class="u">(m³/s)</span></label>
				<NumberInput
					id="{uid}-{kind}-min"
					nullable
					min={0}
					step="any"
					disabled={readonly}
					bind:value={() => r.gaugedMinM3s, (v) => set(kind, { gaugedMinM3s: v })}
					placeholder="not known"
					aria-invalid={p?.field === 'min' ? 'true' : undefined}
					aria-describedby={p?.field === 'min' ? errId : undefined}
				/>
				{#if p?.field === 'min'}<span class="err" id={errId}>{p.message}</span>{/if}
			</div>
			<div class="field source">
				<label for="{uid}-{kind}-src">Source<span class="visually-hidden"> of the {RECORD_NAME[kind].toLowerCase()} gauged range</span></label>
				<input
					id="{uid}-{kind}-src"
					type="text"
					maxlength={RATING_SOURCE_MAX}
					readonly={readonly}
					value={r.source}
					oninput={(e) => set(kind, { source: e.currentTarget.value })}
					placeholder="e.g. DWS gauging list, rating table 2019"
					aria-invalid={p?.field === 'source' ? 'true' : undefined}
					aria-describedby={p?.field === 'source' ? errId : undefined}
				/>
				{#if p?.field === 'source'}<span class="err" id={errId}>{p.message}</span>{/if}
			</div>
		</div>
	{/each}
	<div class="uses">
		<div class="field">
			<label for="{uid}-above">Days above the highest gauging <HelpTip key="quality-flags" label="About how flagged days are treated" /></label>
			<select id="{uid}-above" bind:value={value.aboveRating} disabled={readonly}>
				{#each ABOVE_OPTIONS as o (o.value)}<option value={o.value}>{o.label}</option>{/each}
			</select>
		</div>
		<div class="field">
			<label for="{uid}-below">Days below the lowest gauging</label>
			<select id="{uid}-below" bind:value={value.belowRating} disabled={readonly}>
				{#each FLAG_OPTIONS as o (o.value)}<option value={o.value}>{o.label}</option>{/each}
			</select>
		</div>
		<div class="field">
			<label for="{uid}-suspect">Suspect days</label>
			<select id="{uid}-suspect" bind:value={value.suspect} disabled={readonly}>
				{#each FLAG_OPTIONS as o (o.value)}<option value={o.value}>{o.label}</option>{/each}
			</select>
		</div>
		<div class="field">
			<label for="{uid}-infilled">Infilled days</label>
			<select id="{uid}-infilled" bind:value={value.infilled} disabled={readonly}>
				{#each FLAG_OPTIONS as o (o.value)}<option value={o.value}>{o.label}</option>{/each}
			</select>
		</div>
	</div>
	<!-- Engine ≥ 1.81.0 (issue #507 item 2): absent on settings saved before it, read as none. -->
	<div class="months" data-testid="zero-flow-months">
		<p class="months-title" aria-hidden="true">Months the river stops</p>
		<p class="hint" id="{uid}-months-hint">
			A broken or blocked logger also reads zero flow. A zero-flow stretch wholly inside the months ticked here is trusted as the river stopping and
			scored. With months ticked, any other zero stretch is suspect; with none, only a stretch longer than {ZERO_FLOW_TRUST_MAX_DAYS} days is. Suspect days
			follow “Suspect days” above: check them with the client, and record a logger failure as an exclusion period.
		</p>
		<!-- MonthPicker keeps each toggle a 24 px target, 44 px on a phone (WCAG 2.5.8). -->
		<MonthPicker
			bind:months={() => value.zeroFlowMonths ?? [], (v) => (value.zeroFlowMonths = v)}
			label="Months the river stops"
			summary={zeroFlowMonthsText(value.zeroFlowMonths) === 'none' ? 'None: a zero stretch is judged by its length alone' : zeroFlowMonthsText(value.zeroFlowMonths)}
			disabled={readonly}
		/>
	</div>
	<!-- A record not shown here (its series is gone) still blocks Save: say so. -->
	{#if error && !kinds.some((k) => ratingProblem(value, k))}<p class="err">{error}</p>{/if}
</fieldset>

<style>
	.plain {
		border: 0;
		padding: 0;
		margin: 0.75rem 0 0;
		min-width: 0;
	}
	legend {
		font-weight: 500;
		font-size: 0.9rem;
		padding: 0;
		margin-bottom: 0.2rem;
	}
	.title {
		margin: 0;
	}
	.hint {
		font-size: 0.8rem;
		color: var(--text-muted);
		margin: 0 0 0.4rem;
	}
	.rating,
	.uses {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
		gap: 0.25rem 1rem;
		margin-bottom: 0.4rem;
	}
	.field {
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
	}
	.field :global(input),
	.field select {
		width: 100%;
	}
	.months-title {
		font-weight: 500;
		font-size: 0.85rem;
		margin: 0.5rem 0 0.15rem;
	}
	.u {
		color: var(--text-muted);
		font-weight: 400;
	}
	.err {
		color: var(--danger);
		font-size: 0.85rem;
	}
</style>
