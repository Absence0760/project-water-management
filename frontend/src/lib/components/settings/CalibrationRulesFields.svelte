<!--
	Settings fields for settings.calibrationRules (engine ≥ 1.25.0, issue #153):
	automated calibration's pre-declared rules. The exclusion rule, the forcing,
	bounds and objectives to fit, the held-out test and score that pick the fit,
	the filters, and the hydrologist's sign-off. The server sets the revision and
	clears the sign-off when a rule changes. Bind the value; `error` is set while
	it is invalid, so the parent form can block saving.
-->
<script lang="ts">
	import {
		CALIBRATION_BOUNDS,
		ON_NEW_DATA,
		ON_NEW_DATA_LABEL,
		OBJECTIVE_LABELS,
		MAX_STARTS,
		OBJECTIVES,
		RULE_BUDGET_MAX,
		RULE_BUDGET_MIN,
		RULE_CASES_MAX,
		RULE_SEED_MAX,
		SIGNED_OFF_BY_MAX,
		ruleCaseCount,
		rulePanOptions,
		SELECTION_TEST_LABEL,
		SELECTION_TESTS,
		type CalibrationBounds,
		type CalibrationRules,
		type ObjectiveId
	} from '@water-management/engine';
	import HelpTip from '$lib/components/help/HelpTip.svelte';
	import NumberInput from '$lib/components/common/NumberInput.svelte';
	import { BOUNDS_LABEL } from '$lib/calibration/fit';
	import { pctToShare, rulesFieldsError, rulesStatusText, shareToPct, toggled } from './calibrationRules';

	let {
		value = $bindable(),
		error = $bindable(null),
		readonly = false
	}: {
		value: CalibrationRules;
		error?: string | null;
		readonly?: boolean;
	} = $props();

	const uid = $props.id();
	const pans = rulePanOptions();
	const panIds = pans.map((p) => p.id);
	const fits = $derived(ruleCaseCount(value));
	$effect(() => {
		error = rulesFieldsError(value);
	});
	const name = (o: ObjectiveId) => OBJECTIVE_LABELS[o];
	let signBy = $state('');
</script>

<fieldset class="plain rules" aria-describedby="{uid}-hint" data-testid="calibration-rules">
	<legend>Calibration rules <HelpTip key="settings.calibrationRules" /></legend>
	<p class="hint" id="{uid}-hint">
		Automated calibration makes its choices by these rules, saved before any fit is seen: which water years to leave out, which fits to try and which
		one to keep. It only runs on the saved rules, and saving a change raises the revision.
	</p>
	<p class="status small" data-testid="rules-status">
		<span class="badge" class:draft={!value.signedOff}>{value.signedOff ? 'Signed off' : 'Draft'}</span>
		{rulesStatusText(value)}
	</p>

	<div class="grid">
		<div class="field">
			<label class="check">
				<input
					type="checkbox"
					disabled={readonly}
					checked={value.exclusions.maxFlaggedShare !== null}
					onchange={(e) => (value.exclusions = { maxFlaggedShare: e.currentTarget.checked ? 0.2 : null })}
				/>
				Leave out a water year by its flagged days
			</label>
			{#if value.exclusions.maxFlaggedShare !== null}
				<label for="{uid}-share">When more than this share of its observed days are flagged <span class="u">(%)</span></label>
				<NumberInput
					id="{uid}-share"
					min={0.1}
					max={99.9}
					step={0.1}
					disabled={readonly}
					bind:value={() => shareToPct(value.exclusions.maxFlaggedShare), (v) => (value.exclusions = { maxFlaggedShare: pctToShare(v) })}
				/>
			{/if}
		</div>

		<div class="field">
			<label for="{uid}-score">Keep the fit with the best</label>
			<select id="{uid}-score" bind:value={value.selection.score} disabled={readonly}>
				{#each OBJECTIVES as o (o)}<option value={o}>{name(o)}</option>{/each}
			</select>
			<label for="{uid}-test" class="sub">on the held-out test</label>
			<select id="{uid}-test" bind:value={value.selection.test} disabled={readonly}>
				{#each SELECTION_TESTS as t (t)}<option value={t}>{SELECTION_TEST_LABEL[t]}</option>{/each}
			</select>
		</div>
	</div>

	<div class="grid">
		<fieldset class="plain group">
			<legend class="sub">Pan coefficients to fit under</legend>
			{#each pans as p (p.id)}
				<label class="check">
					<input
						type="checkbox"
						disabled={readonly}
						checked={value.forcing.pan.includes(p.id)}
						onchange={(e) => (value.forcing = { pan: toggled(panIds, value.forcing.pan, p.id, e.currentTarget.checked) })}
					/>
					{p.label}
				</label>
			{/each}
		</fieldset>
		<fieldset class="plain group">
			<legend class="sub">Bounds</legend>
			{#each CALIBRATION_BOUNDS as b (b)}
				<label class="check">
					<input
						type="checkbox"
						disabled={readonly}
						checked={value.cases.bounds.includes(b)}
						onchange={(e) => (value.cases = { ...value.cases, bounds: toggled<CalibrationBounds>(CALIBRATION_BOUNDS, value.cases.bounds, b, e.currentTarget.checked) })}
					/>
					{BOUNDS_LABEL[b].replace(' (default)', '')}
				</label>
			{/each}
		</fieldset>
		<fieldset class="plain group">
			<legend class="sub">Objectives</legend>
			{#each OBJECTIVES as o (o)}
				<label class="check">
					<input
						type="checkbox"
						disabled={readonly}
						checked={value.cases.objectives.includes(o)}
						onchange={(e) => (value.cases = { ...value.cases, objectives: toggled<ObjectiveId>(OBJECTIVES, value.cases.objectives, o, e.currentTarget.checked) })}
					/>
					{name(o)}
				</label>
			{/each}
		</fieldset>
		<fieldset class="plain group">
			<legend class="sub">Filters a kept fit must pass</legend>
			<label class="check">
				<input type="checkbox" disabled={readonly} bind:checked={value.filters.wr2012Mar} />
				Natural MAR inside the WR2012 band
			</label>
			<label class="check">
				<input type="checkbox" disabled={readonly} bind:checked={value.filters.typicalParams} />
				Parameters in the typical range
			</label>
		</fieldset>
	</div>
	<div class="grid" data-testid="rules-search">
		<div class="field">
			<label for="{uid}-budget">Model runs per fit</label>
			<NumberInput id="{uid}-budget" min={RULE_BUDGET_MIN} max={RULE_BUDGET_MAX} step={50} disabled={readonly} bind:value={() => value.run.budget, (v) => (value.run = { ...value.run, budget: v ?? RULE_BUDGET_MIN })} />
		</div>
		<div class="field">
			<label for="{uid}-starts">Starts per fit</label>
			<NumberInput id="{uid}-starts" min={1} max={MAX_STARTS} step={1} disabled={readonly} bind:value={() => value.run.starts, (v) => (value.run = { ...value.run, starts: v ?? 1 })} />
		</div>
		<div class="field">
			<label for="{uid}-seed">Seed</label>
			<NumberInput id="{uid}-seed" min={0} max={RULE_SEED_MAX} step={1} disabled={readonly} bind:value={() => value.run.seed, (v) => (value.run = { ...value.run, seed: v ?? 0 })} />
		</div>
	</div>
	<div class="grid" data-testid="rules-after">
		<div class="field">
			<label for="{uid}-new-data">When new observed or rain data arrives</label>
			<select id="{uid}-new-data" bind:value={value.after.onNewData} disabled={readonly}>
				{#each ON_NEW_DATA as o (o)}<option value={o}>{ON_NEW_DATA_LABEL[o]}</option>{/each}
			</select>
		</div>
		<label class="check">
			<input type="checkbox" disabled={readonly} bind:checked={value.after.ensemble} />
			After a kept fit is applied, run the model and the uncertainty ensemble around it
		</label>
	</div>
	<p class="hint" data-testid="rules-fits">{fits} fit{fits === 1 ? '' : 's'}, each with the split-sample and dry → wet tests (at most {RULE_CASES_MAX}). The seed, starts and model runs are rules too: trying another seed after a result is a rule change, with its own revision.</p>

	{#if !readonly}
		<div class="sign" data-testid="rules-sign-off">
			{#if value.signedOff}
				<button type="button" class="btn btn-sm" onclick={() => (value.signedOff = null)}>Withdraw the sign-off</button>
			{:else}
				<div class="field">
					<label for="{uid}-by">Your name, as a signature</label>
					<input id="{uid}-by" type="text" maxlength={SIGNED_OFF_BY_MAX} bind:value={signBy} placeholder="e.g. Dr A. Hydrologist" />
				</div>
				<!-- The server dates it and records your account in the project's history, whatever date is sent. -->
				<button type="button" class="btn btn-sm" disabled={!signBy.trim()} onclick={() => (value.signedOff = { by: signBy.trim(), on: new Date().toISOString().slice(0, 10) })}>
					Sign off these rules
				</button>
			{/if}
			<span class="hint">Sign off once you (the hydrologist) have agreed these rules. Saving records it with your account and today’s date; changing a rule later withdraws it.</span>
		</div>
	{/if}
	{#if error}<p class="err" role="alert">{error}</p>{/if}
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
	.sub {
		font-size: 0.85rem;
		font-weight: 500;
		color: var(--text-2);
	}
	.group {
		margin: 0;
	}
	.hint {
		font-size: 0.8rem;
		color: var(--text-muted);
		margin: 0 0 0.4rem;
	}
	.status {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin: 0 0 0.5rem;
	}
	.badge {
		font-size: 0.75rem;
		font-weight: 600;
		padding: 0.05rem 0.45rem;
		border-radius: 999px;
		background: var(--accent-soft);
	}
	.badge.draft {
		background: var(--warning-soft);
	}
	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
		gap: 0.25rem 1.25rem;
		margin-bottom: 0.4rem;
		align-items: start;
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
	.check {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		min-height: 32px;
	}
	.sign {
		display: flex;
		flex-wrap: wrap;
		align-items: end;
		gap: 0.5rem 1rem;
		margin: 0.25rem 0;
	}
	.u {
		color: var(--text-muted);
		font-weight: 400;
	}
	.err {
		color: var(--danger);
		font-size: 0.85rem;
	}
	@media (max-width: 640px) {
		.btn {
			min-height: 44px;
		}
	}
</style>
