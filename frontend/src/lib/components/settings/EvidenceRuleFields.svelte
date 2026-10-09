<!--
	Settings → Evidence (issue #71, docs/design/evidence-report.md ER3 and G4):
	the uncertainty rule the project declares for its licensing evidence,
	settings.evidenceUncertaintyRule. Declared before anyone sees a band: an
	evidence report cites the first complete ensemble whose options match it
	exactly, and none when there is no rule. Replaced whole on save; switching
	it off saves null, and switching it back on brings back the rule switched
	off (bind `last` to the page's draft, settingsDraft `kept`), never the
	defaults, until the form is saved or discarded. Bind the value; `error` is set while it is invalid, so
	the parent form can block saving. Its own chunk: the Settings tab chunk sits
	at its size ceiling.
-->
<script lang="ts">
	import HelpTip from '$lib/components/help/HelpTip.svelte';
	import {
		declaredRuleText,
		ENSEMBLE_MEMBERS_MAX,
		ENSEMBLE_MEMBERS_MIN,
		OBJECTIVE_LABELS,
		OBJECTIVES,
		PAN_OFFSET_MAX,
		WR2012_LEVELS,
		type CalibrationBounds,
		type DeclaredUncertaintyRule
	} from '@water-management/engine';
	import NumberInput from '$lib/components/common/NumberInput.svelte';
	import FieldHistoryLine from '$lib/components/history/FieldHistoryLine.svelte';
	import { evidenceRuleFieldsError, RULE_BOUNDS_LABEL, RULE_WR2012_LABEL, withEvidenceRule } from './evidenceRule';

	let {
		value = $bindable(),
		error = $bindable(null),
		saved,
		last = $bindable(),
		readonly = false
	}: {
		value: DeclaredUncertaintyRule | null | undefined;
		error?: string | null;
		/** The rule as saved, so switching off withdraws it (null) or, never saved, leaves the form unchanged. */
		saved: DeclaredUncertaintyRule | null | undefined;
		/** The rule switching it off turned off, kept until saved or discarded. */
		last?: unknown;
		readonly?: boolean;
	} = $props();

	const uid = $props.id();
	const BOUNDS: CalibrationBounds[] = ['typical', 'wide'];
	$effect(() => {
		error = evidenceRuleFieldsError(value);
	});

	function setOn(on: boolean) {
		if (!on && value) last = $state.snapshot(value);
		value = withEvidenceRule(on, saved, last as DeclaredUncertaintyRule | null | undefined);
	}
	/** One threshold changed, the rule replaced whole (as it is saved). */
	function setThreshold<K extends keyof DeclaredUncertaintyRule['thresholds']>(k: K, v: DeclaredUncertaintyRule['thresholds'][K]) {
		if (value) value = { ...value, thresholds: { ...value.thresholds, [k]: v } };
	}
</script>

<div class="evidence" data-testid="evidence-rule">
	<label class="check">
		<input type="checkbox" disabled={readonly} checked={!!value} aria-describedby="{uid}-hint{value ? '' : ` ${uid}-off`}" onchange={(e) => setOn(e.currentTarget.checked)} />
		Declare an uncertainty rule for evidence
	</label>
	<p class="hint explain" id="{uid}-hint">
		The uncertainty bands an evidence report shows come only from an ensemble run to this rule: its size, bounds, pan-coefficient shift and the
		tests a parameter set must pass to be kept. Declare it before anyone sees a band, so the rule can’t be tuned until the bands look kind.
		Changing it later is recorded in the History tab, and a new ensemble must then be run to it.
	</p>
	<!-- What leaving it off means, shown whether or not the explanations are (Settings' switch, issue #468). -->
	{#if !value}<p class="hint" id="{uid}-off"><strong>With no rule declared, an evidence report cites no ensemble.</strong></p>{/if}

	{#if value}
		<div class="grid">
			<div class="field">
				<label for="{uid}-members">Members <HelpTip key="uncertainty-bands" label="About the ensemble" /></label>
				<NumberInput
					id="{uid}-members"
					min={ENSEMBLE_MEMBERS_MIN}
					max={ENSEMBLE_MEMBERS_MAX}
					step={1}
					disabled={readonly}
					bind:value={() => value!.members, (v) => (value = { ...value!, members: v ?? ENSEMBLE_MEMBERS_MIN })}
					aria-describedby="{uid}-members-h"
				/>
				<span class="hint" id="{uid}-members-h">Parameter sets sampled, {ENSEMBLE_MEMBERS_MIN} to {ENSEMBLE_MEMBERS_MAX}.</span>
			</div>
			<div class="field">
				<label for="{uid}-bounds">Bounds <HelpTip key="calibration-bounds" label="About the search range" /></label>
				<select
					id="{uid}-bounds"
					disabled={readonly}
					value={value.bounds}
					onchange={(e) => (value = { ...value!, bounds: e.currentTarget.value as CalibrationBounds })}
				>
					{#each BOUNDS as b (b)}<option value={b}>{RULE_BOUNDS_LABEL[b]}</option>{/each}
				</select>
			</div>
			<div class="field">
				<label for="{uid}-pan">Pan-coefficient shift <span class="u">(±)</span></label>
				<NumberInput
					id="{uid}-pan"
					min={0}
					max={PAN_OFFSET_MAX}
					step={0.01}
					disabled={readonly}
					bind:value={() => value!.panOffset, (v) => (value = { ...value!, panOffset: v ?? 0 })}
					aria-describedby="{uid}-pan-h"
				/>
				<span class="hint" id="{uid}-pan-h">0 to {PAN_OFFSET_MAX}; 0 leaves the pan coefficient as it is.</span>
			</div>
		</div>
		<fieldset class="plain">
			<legend class="sub">A parameter set is kept when it passes <HelpTip key="evidence-uncertainty-rule" label="About the acceptance tests" /></legend>
			<div class="grid">
				<div class="field">
					<label for="{uid}-obj">Skill score <HelpTip key="calibration-objective" label="About choosing the skill measure" /></label>
					<select
						id="{uid}-obj"
						disabled={readonly}
						value={value.thresholds.objective}
						onchange={(e) => setThreshold('objective', e.currentTarget.value as DeclaredUncertaintyRule['thresholds']['objective'])}
					>
						{#each OBJECTIVES as o (o)}<option value={o}>{OBJECTIVE_LABELS[o]}</option>{/each}
					</select>
				</div>
				<div class="field">
					<label for="{uid}-skill">Lowest skill kept</label>
					<NumberInput
						id="{uid}-skill"
						min={-10}
						max={1}
						step={0.01}
						disabled={readonly}
						bind:value={() => value!.thresholds.minSkill, (v) => setThreshold('minSkill', v ?? 0)}
					/>
				</div>
				<div class="field">
					<label for="{uid}-wr2012">Worst WR2012 flag kept</label>
					<select
						id="{uid}-wr2012"
						disabled={readonly}
						value={value.thresholds.wr2012MaxLevel}
						onchange={(e) => setThreshold('wr2012MaxLevel', e.currentTarget.value as DeclaredUncertaintyRule['thresholds']['wr2012MaxLevel'])}
					>
						{#each WR2012_LEVELS as l (l)}<option value={l}>{RULE_WR2012_LABEL[l]}</option>{/each}
					</select>
				</div>
				<div class="field">
					<label for="{uid}-bias">Largest low-flow bias kept <span class="u">(± %)</span></label>
					<NumberInput
						id="{uid}-bias"
						min={1}
						max={1000}
						nullable
						placeholder="No check"
						disabled={readonly}
						bind:value={() => value!.thresholds.maxLowFlowBiasPct, (v) => setThreshold('maxLowFlowBiasPct', v)}
						aria-describedby="{uid}-bias-h"
					/>
					<span class="hint" id="{uid}-bias-h">Blank: no low-flow check.</span>
				</div>
			</div>
		</fieldset>
		<p class="rule small" data-testid="evidence-rule-text"><strong>The rule:</strong> {declaredRuleText(value)}</p>
		{#if error}<p class="err" role="status">{error}</p>{/if}
	{:else if readonly}
		<p class="rule small" data-testid="evidence-rule-text"><strong>The rule:</strong> not declared</p>
	{/if}
	<FieldHistoryLine field="settings:evidenceUncertaintyRule" />
</div>

<style>
	.plain {
		border: 0;
		padding: 0;
		margin: 0.5rem 0 0;
		min-width: 0;
	}
	legend {
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
		max-width: 75ch;
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
	.rule {
		margin: 0.25rem 0;
		max-width: 75ch;
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
