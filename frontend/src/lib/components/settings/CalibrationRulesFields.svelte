<!--
	Settings fields for settings.calibrationRules (engine ≥ 1.25.0, issue #153):
	automated calibration's pre-declared rules. The exclusion rule, the forcing,
	bounds and objectives to fit, the held-out test and score that pick the fit,
	the filters, and the hydrologist's sign-off. The server sets the revision and
	clears the sign-off when a rule changes. Bind the value; `error` is set while
	it is invalid, so the parent form can block saving. Bind `lastShare` to the
	page's draft (settingsDraft `kept`): the flagged-days share unticking its rule
	turned off, brought back when it is ticked again until saved or discarded.
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
	import { BOUNDS_LABEL, searchSummary } from '$lib/calibration/fit';
	import { pctToShare, rulesFieldsError, rulesStatusText, shareToPct, toggled } from './calibrationRules';
	import { keptOr } from './kept';
	import { localIsoDate } from '$lib/format/number';

	let {
		value = $bindable(),
		error = $bindable(null),
		lastShare = $bindable(),
		readonly = false
	}: {
		value: CalibrationRules;
		error?: string | null;
		/** The share unticking "Leave out a water year…" turned off. */
		lastShare?: unknown;
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
	let searchOpen = $state(false);
	/** 20 % by default; ticked again, the share it was unticked with. */
	function setExclusion(on: boolean) {
		const share = value.exclusions.maxFlaggedShare;
		if (!on && share !== null) lastShare = share;
		value.exclusions = { maxFlaggedShare: keptOr(on, lastShare as number | null | undefined, () => 0.2, null) };
	}
</script>

<!-- The head holds what the rules are (revision, sign-off, how many fits) and the sign-off itself, so the actions are
     above the fields, not under ~25 of them; the fields follow in four labelled groups, the search folded into its
     values (ui-playbook.md § 2, "A form's state and actions in its head"). Saving is the page's save bar. -->
<fieldset class="plain rules" aria-describedby="{uid}-hint" data-testid="calibration-rules">
	<legend><h3 class="title">Calibration rules <HelpTip key="settings.calibrationRules" label="About the calibration rules" /></h3></legend>
	<p class="hint explain" id="{uid}-hint">
		Automated calibration makes its choices by these rules, saved before any fit is seen: which water years to leave out, which fits to try and which
		one to keep. It only runs on the saved rules, and saving a change raises the revision.
	</p>
	<div class="head" data-testid="rules-head">
		<div class="state">
			<p class="status small" data-testid="rules-status">
				<span class="badge" class:draft={!value.signedOff}>{value.signedOff ? 'Signed off' : 'Draft'}</span>
				{rulesStatusText(value)}
			</p>
			<p class="hint fits" data-testid="rules-fits">{fits} fit{fits === 1 ? '' : 's'}, each with the split-sample and dry → wet tests (at most {RULE_CASES_MAX}).</p>
		</div>
		{#if !readonly}
			<div class="sign" data-testid="rules-sign-off">
				{#if value.signedOff}
					<button type="button" class="btn" onclick={() => (value.signedOff = null)} aria-describedby="{uid}-sign-h">Withdraw the sign-off</button>
				{:else}
					<div class="field">
						<label for="{uid}-by">Your name, as a signature <HelpTip key="calibration-rules" label="About signing off the rules" /></label>
						<input id="{uid}-by" type="text" maxlength={SIGNED_OFF_BY_MAX} bind:value={signBy} placeholder="e.g. Dr A. Hydrologist" />
					</div>
					<!-- The server dates it and records your account in the project's history, whatever date is sent. -->
					<button type="button" class="btn" disabled={!signBy.trim()} onclick={() => (value.signedOff = { by: signBy.trim(), on: localIsoDate() })} aria-describedby="{uid}-sign-h">
						Sign off these rules
					</button>
				{/if}
				<span class="hint explain sign-hint" id="{uid}-sign-h">Sign off once you (the hydrologist) have agreed these rules. Saving records it with your account and today’s date; changing a rule later withdraws it.</span>
			</div>
		{/if}
	</div>
	{#if error}<p class="err" role="alert">{error}</p>{/if}

	<div class="groups">
		<fieldset class="plain group try" data-testid="rules-try">
			<legend class="group-name">What to try</legend>
			<div class="lists">
				<fieldset class="plain list">
					<legend class="sub">Pan coefficients to fit under <HelpTip key="pan-coefficient" label="About the pan coefficients to fit under" /></legend>
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
				<fieldset class="plain list">
					<legend class="sub">Bounds <HelpTip key="calibration-bounds" label="About the parameter ranges" /></legend>
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
				<fieldset class="plain list">
					<legend class="sub">Objectives <HelpTip key="calibration-objective" label="About choosing an objective" /></legend>
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
			</div>
		</fieldset>

		<fieldset class="plain group keep" data-testid="rules-keep">
			<legend class="group-name">Which fit to keep</legend>
			<div class="lists">
				<div class="field">
					<label for="{uid}-score">Keep the fit with the best <HelpTip key="calibration-selection-score" label="About the selection score" /></label>
					<select id="{uid}-score" bind:value={value.selection.score} disabled={readonly}>
						{#each OBJECTIVES as o (o)}<option value={o}>{name(o)}</option>{/each}
					</select>
					<label for="{uid}-test" class="sub">on the held-out test <HelpTip key="validation-tests" label="About the validation tests" /></label>
					<select id="{uid}-test" bind:value={value.selection.test} disabled={readonly}>
						{#each SELECTION_TESTS as t (t)}<option value={t}>{SELECTION_TEST_LABEL[t]}</option>{/each}
					</select>
				</div>
				<div>
					<fieldset class="plain list">
						<legend class="sub">Filters a kept fit must pass <HelpTip key="calibration-rule-filters" label="About the filters" /></legend>
						<label class="check">
							<input type="checkbox" disabled={readonly} bind:checked={value.filters.wr2012Mar} />
							Natural MAR inside the WR2012 band
						</label>
						<label class="check">
							<input type="checkbox" disabled={readonly} bind:checked={value.filters.typicalParams} />
							Parameters in the typical range
						</label>
					</fieldset>
					<div class="field leave-out">
						<div class="tip-row">
							<label class="check">
								<input
									type="checkbox"
									disabled={readonly}
									checked={value.exclusions.maxFlaggedShare !== null}
									onchange={(e) => setExclusion(e.currentTarget.checked)}
								/>
								Leave out a water year by its flagged days
							</label>
							<HelpTip key="flagged-year-rule" label="About the flagged-year rule" />
						</div>
						{#if value.exclusions.maxFlaggedShare !== null}
							<label for="{uid}-share" class="sub">When more than this share of its observed days are flagged <span class="u">(%)</span></label>
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
				</div>
			</div>
		</fieldset>

		<fieldset class="plain group after" data-testid="rules-after">
			<legend class="group-name">When data arrives</legend>
			<div class="lists">
				<div class="field">
					<label for="{uid}-new-data">When new observed or rain data arrives <HelpTip key="rules-on-new-data" label="About running the rules on new data" /></label>
					<select id="{uid}-new-data" bind:value={value.after.onNewData} disabled={readonly}>
						{#each ON_NEW_DATA as o (o)}<option value={o}>{ON_NEW_DATA_LABEL[o]}</option>{/each}
					</select>
				</div>
				<div class="tip-row">
					<label class="check">
						<input type="checkbox" disabled={readonly} bind:checked={value.after.ensemble} />
						After a kept fit is applied, run the model and the uncertainty ensemble around it
					</label>
					<HelpTip key="uncertainty-bands" label="About the uncertainty ensemble" />
				</div>
			</div>
		</fieldset>

		<!-- Rarely changed: folded into its values, opened in place (a closed <details> keeps its fields in the page,
		     so Find a setting still reaches them and opens it). -->
		<details class="fold group" data-testid="rules-search" bind:open={searchOpen}>
			<summary>
				<span class="fold-name">Search budget per fit:</span>
				<span data-testid="rules-search-summary">{searchSummary({ budget: value.run.budget, starts: value.run.starts, seed: value.run.seed })}</span>
				<span class="fold-problem">needs fixing</span>
				<span class="fold-change" aria-hidden="true">{searchOpen ? 'Hide' : 'Change'}</span>
			</summary>
			<fieldset class="plain">
				<legend class="visually-hidden">Search budget</legend>
				<div class="fold-body">
					<div class="field">
						<label for="{uid}-budget">Model runs per fit <HelpTip key="calibration-search" label="About the search settings" /></label>
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
				<p class="hint" data-testid="rules-search-note">The seed, starts and model runs are rules too: trying another seed after a result is a rule change, with its own revision.</p>
			</fieldset>
		</details>
	</div>
</fieldset>

<style>
	.plain {
		border: 0;
		padding: 0;
		margin: 0;
		min-width: 0;
	}
	.rules {
		container: cal-rules / inline-size;
	}
	.title {
		margin: 0;
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
	.hint {
		font-size: 0.8rem;
		color: var(--text-muted);
		margin: 0 0 0.4rem;
	}
	/* The head: what the rules are on the left, the sign-off on the right (under it in a narrow column). */
	.head {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-start;
		justify-content: space-between;
		gap: 0.5rem 1.5rem;
		padding: 0.25rem 0 0.6rem;
		border-bottom: 1px solid var(--border);
	}
	.state {
		flex: 1 1 auto;
	}
	.status {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem;
		margin: 0 0 0.25rem;
	}
	.fits {
		margin: 0;
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
	.sign {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-end;
		gap: 0.25rem 0.5rem;
	}
	.sign .field {
		margin: 0;
		gap: 0.15rem;
	}
	.sign input {
		width: 15rem;
	}
	.sign-hint {
		flex-basis: 100%;
		max-width: 46ch;
		margin: 0;
	}
	/* The four groups: each named, its lists side by side and top-aligned where the column allows. */
	.groups {
		display: grid;
		gap: 0.75rem;
		margin-top: 0.6rem;
	}
	.group-name {
		font-size: 0.8rem;
		font-weight: 600;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--text-muted);
		margin-bottom: 0.3rem;
	}
	.lists {
		display: grid;
		grid-template-columns: 1fr;
		gap: 0.5rem 1.25rem;
		align-items: start;
	}
	@container cal-rules (min-width: 44rem) {
		.try .lists {
			grid-template-columns: repeat(3, minmax(0, 1fr));
		}
		.keep .lists,
		.after .lists {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
		/* The ensemble tick sits level with the select beside it, under the label line. */
		.after .tip-row {
			padding-top: 1.35rem;
		}
	}
	.field {
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
		margin: 0;
	}
	/* Not a checkbox: stretched, "Leave out a water year…" sat half a field away from its box. */
	.field :global(input:not([type='checkbox'])),
	.field select {
		width: 100%;
	}
	/* A field's label is as tall as one with a help tip, so the inputs of a row line up with or without one. */
	.field > label {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0 0.25rem;
		min-height: 24px;
	}
	.leave-out {
		margin-top: 0.4rem;
	}
	/* A box beside its words, aligned with their first line however many lines they wrap to. */
	.check {
		display: flex;
		align-items: flex-start;
		gap: 0.45rem;
		padding: 0.3rem 0;
		line-height: 1.4;
	}
	.check input {
		margin: calc((1lh - 1rem) / 2) 0 0;
	}
	/* A label and its help tip on one line: the tip sits outside the label (a label holds only its own control). */
	.tip-row {
		display: flex;
		align-items: flex-start;
		gap: 0.4rem;
	}
	.tip-row > :global(.helptip) {
		margin-top: 0.3rem;
	}
	.u {
		color: var(--text-muted);
		font-weight: 400;
	}
	.err {
		color: var(--danger);
		font-size: 0.85rem;
		margin: 0.4rem 0 0;
	}
	/* A narrow column (a phone): touch-sized buttons. A container query, as the app frame's width isn't the viewport's. */
	@container cal-rules (max-width: 40rem) {
		.btn {
			min-height: 44px;
		}
		.sign input {
			width: 100%;
		}
		.sign,
		.sign .field {
			flex: 1 1 100%;
		}
	}
</style>
