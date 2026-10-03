<script lang="ts">
	// Settings → Outcome matrix (issue #53 R4, docs/ui.md § Outcome matrix):
	// how the Runs tab's outcome matrix splits water years into classes, and
	// the risk cut-offs its cells are coloured by. Part of the Settings form
	// (the save bar saves it), in the Settings tab's chunk. No model input: it changes how results are read, never a
	// run. The cut-offs' defaults are placeholders pending the hydrologist
	// (plan.md O1; the client agreed, issue #90), and the section says so while
	// they are in use. The year-class method's default is confirmed (O2).
	import { DEFAULT_OUTCOME_RISK_CUTOFFS, YEAR_CLASS_QUINTILE_MIN_YEARS, type YearClassMethod } from '@water-management/engine';
	import NumberInput from '$lib/components/common/NumberInput.svelte';
	import type { OutcomeSettings } from '$lib/api/types';

	let { value = $bindable(), readonly, error }: { value: OutcomeSettings; readonly: boolean; error: string | null } = $props();

	const METHODS: { value: YearClassMethod; label: string }[] = [
		{ value: 'auto', label: `Automatic: terciles, quintiles from ${YEAR_CLASS_QUINTILE_MIN_YEARS} years (default)` },
		{ value: 'terciles', label: 'Terciles: dry, normal, wet' },
		{ value: 'quintiles', label: 'Quintiles: very dry … very wet' }
	];

	type Metric = keyof OutcomeSettings['riskCutoffs'];
	const METRICS: { id: Metric; legend: string; lower: string; increasing: string; hint: string }[] = [
		{
			id: 'reserveMonthsMet',
			legend: 'Reserve months met',
			lower: 'Lower risk from',
			increasing: 'Increasing risk from',
			hint: 'Share of a class’s months that meet the Reserve rule table; below “increasing risk” is high risk. Used when every demand level has a rule table at the matrix’s Reserve site (the outlet unless a gauge is picked on the Runs tab), and always at a gauge.'
		},
		{
			id: 'daysBelowEwr',
			legend: 'Days below the pragmatic EWR',
			lower: 'Lower risk up to',
			increasing: 'Increasing risk up to',
			hint: 'Share of a class’s days below the pragmatic EWR at the outlet; above “increasing risk” is high risk. Used otherwise.'
		}
	];

	/** Use the engine's placeholder cut-offs (null), or start custom ones from them. */
	function setDefault(m: Metric, on: boolean) {
		value.riskCutoffs[m] = on ? null : { ...DEFAULT_OUTCOME_RISK_CUTOFFS[m] };
	}
	const pct = (v: number) => `${Math.round(v * 1000) / 10} %`;
</script>

<section class="panel" aria-labelledby="out-h" data-testid="outcome-settings">
	<div class="panel-head">
		<h2 id="out-h">Outcome matrix</h2>
		<span class="muted small">How the Runs tab reads a demand sweep by class of year</span>
	</div>
	<div class="field">
		<label for="out-method">Water-year classes</label>
		<select id="out-method" disabled={readonly} bind:value={value.yearClassMethod} aria-describedby="out-method-h">
			{#each METHODS as m (m.value)}
				<option value={m.value}>{m.label}</option>
			{/each}
		</select>
		<span class="hint" id="out-method-h">
			The base run’s complete water years ranked by their natural flow. Automatic uses quintiles once the record has
			{YEAR_CLASS_QUINTILE_MIN_YEARS} complete years.
		</span>
	</div>
	{#each METRICS as m (m.id)}
		{@const pair = value.riskCutoffs[m.id]}
		<fieldset class="metric">
			<legend>
				{m.legend}
				{#if !pair}<span class="badge badge-warn" data-testid="cutoffs-pending-{m.id}">Provisional defaults, not yet confirmed by the catchment’s hydrologist</span>{/if}
			</legend>
			<label class="check">
				<input type="checkbox" disabled={readonly} checked={!pair} onchange={(e) => setDefault(m.id, e.currentTarget.checked)} />
				Use the default cut-offs ({pct(DEFAULT_OUTCOME_RISK_CUTOFFS[m.id].lower)} and {pct(DEFAULT_OUTCOME_RISK_CUTOFFS[m.id].increasing)})
			</label>
			{#if pair}
				<div class="fields">
					<div class="field">
						<label for="out-{m.id}-lower">{m.lower} <span class="u">(%)</span></label>
						<NumberInput id="out-{m.id}-lower" decimals={1} min={0} max={100} scale={100} disabled={readonly} bind:value={pair.lower} />
					</div>
					<div class="field">
						<label for="out-{m.id}-increasing">{m.increasing} <span class="u">(%)</span></label>
						<NumberInput id="out-{m.id}-increasing" decimals={1} min={0} max={100} scale={100} disabled={readonly} bind:value={pair.increasing} />
					</div>
				</div>
			{/if}
			<p class="hint">{m.hint}</p>
		</fieldset>
	{/each}
	<p class="hint muted">
		These only decide how the matrix labels a result; they never change a model run. The defaults are placeholders until the hydrologist
		confirms them (client question O1).
	</p>
	{#if error}<p class="err" role="alert">{error}</p>{/if}
</section>

<style>
	.metric {
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		padding: 0.5rem 0.75rem 0.25rem;
		margin: 0.75rem 0 0;
	}
	.metric legend {
		font-weight: 600;
		padding: 0 0.25rem;
		display: flex;
		gap: 0.5rem;
		align-items: center;
		flex-wrap: wrap;
	}
	.fields {
		display: flex;
		flex-wrap: wrap;
		gap: 0.75rem 1.25rem;
	}
	.check {
		display: flex;
		gap: 0.4rem;
		align-items: center;
		margin: 0.25rem 0;
	}
	.hint {
		display: block;
		font-size: 0.8rem;
	}
	.err {
		color: var(--danger);
	}
</style>
