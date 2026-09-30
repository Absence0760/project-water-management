<!--
	The drought restriction rule's editor (engine ≥ 1.46.0, WP-3.8, docs/ui.md
	§ Drought restrictions, docs/model.md §2.7i): Settings → Drought
	restrictions, and the scenario form's "Change a setting" for comparing
	restriction policies. On each review date the model reads the total farm
	dam storage at the start of the day and picks the deepest level whose
	threshold it is below; the level's cuts hold until the next review or
	lift date. One card per level, side by side where there is room and one
	under the other on a phone. Bind the rule (null = off); `error` is set
	while it can't be saved, so the parent can block saving. Its own chunk:
	the Settings tab chunk sits at its size ceiling.
-->
<script lang="ts">
	import {
		BASIC_NEEDS_CATEGORIES,
		DEMAND_NORMS,
		DEMAND_PARTS,
		describeDroughtRestriction,
		RESTRICTION_DATES_MAX,
		RESTRICTION_LABEL_MAX,
		RESTRICTION_LEVELS_MAX,
		RESTRICTION_SOURCE_MAX,
		type DemandPart,
		type DroughtRestrictionRule
	} from '@water-management/engine';
	import NumberInput from '$lib/components/common/NumberInput.svelte';
	import { monthName } from '$lib/format/months';
	import { joinMonthDay, PART_LABEL, restrictionFormError, splitMonthDay, startingRule, withCut, withDateAdded, withLevelAdded } from './droughtRestriction';

	let {
		value = $bindable(),
		error = $bindable(null),
		readonly = false
	}: {
		value: DroughtRestrictionRule | null | undefined;
		error?: string | null;
		readonly?: boolean;
	} = $props();

	const uid = $props.id();
	const DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
	const floored = (p: DemandPart) => (BASIC_NEEDS_CATEGORIES as readonly string[]).includes(p);
	$effect(() => {
		error = restrictionFormError(value);
	});
	// The rule switched off is kept until the form is saved or discarded, so switching back brings it back.
	let lastRule = $state<DroughtRestrictionRule | null>(null);
	// Just switched on from the template: say so until the first edit.
	let fromTemplate = $state(false);
	function setOn(on: boolean) {
		if (!on && value) lastRule = $state.snapshot(value) as DroughtRestrictionRule;
		fromTemplate = on && !lastRule;
		value = on ? (lastRule ?? startingRule()) : null;
	}
	const rule = $derived(value ?? null);
	/** The rule with one field replaced (the whole rule is what a save stores). */
	function edit(patch: Partial<DroughtRestrictionRule>) {
		if (!value) return;
		value = { ...value, ...patch };
		fromTemplate = false;
	}
	function setDate(which: 'reviewDates' | 'liftDates', i: number, month: number, day: number) {
		const list = [...(value?.[which] ?? [])];
		list[i] = joinMonthDay(month, Math.min(day, DAYS[month - 1]!));
		edit({ [which]: list });
	}
	function removeDate(which: 'reviewDates' | 'liftDates', i: number) {
		const list = (value?.[which] ?? []).filter((_, k) => k !== i);
		if (which === 'liftDates' && !list.length) {
			const { liftDates: _gone, ...rest } = value!;
			value = rest;
			fromTemplate = false;
		} else edit({ [which]: list });
	}
	function setLevel(i: number, patch: Partial<DroughtRestrictionRule['levels'][number]>) {
		if (value) edit({ levels: value.levels.map((l, k) => (k === i ? { ...l, ...patch } : l)) });
	}
	function setCut(i: number, part: DemandPart, cut: number | null) {
		if (value) edit({ levels: value.levels.map((l, k) => (k === i ? withCut(l, part, cut) : l)) });
	}
	const words = $derived(rule ? describeDroughtRestriction(rule) : null);
</script>

<div class="restrict" data-testid="drought-restriction">
	<label class="check">
		<input type="checkbox" disabled={readonly} checked={!!rule} aria-describedby="{uid}-hint" onchange={(e) => setOn(e.currentTarget.checked)} data-testid="restriction-on" />
		Apply drought restrictions in runs
	</label>
	<p class="hint" id="{uid}-hint">
		Cut demand by level when the farm dams fall below a share of their capacity. A model rule, not the restriction notice farmers see;
		<strong>off, runs are as before.</strong>
	</p>
	{#if !rule && readonly}
		<p class="rule" data-testid="restriction-words">Drought restrictions: off.</p>
	{/if}
	{#if rule}
		{#if words}<p class="rule" data-testid="restriction-words">The rule: {words}.</p>{/if}
		{#if fromTemplate}
			<p class="hint" data-testid="restriction-template">
				A starting template in the shape of DWS restriction schedules, pending the hydrologist: set the dates, thresholds and cuts the WUA uses.
			</p>
		{/if}
		{#each ['reviewDates', 'liftDates'] as const as which (which)}
			{@const list = rule[which] ?? []}
			<fieldset class="plain dates" data-testid="restriction-{which}">
				<legend>{which === 'reviewDates' ? 'Review dates (the level is decided)' : 'Lift dates (any restriction ends)'}</legend>
				{#each list as md, i (i)}
					{@const p = splitMonthDay(md)}
					<div class="date">
						<select aria-label="{which === 'reviewDates' ? 'Review' : 'Lift'} date {i + 1}: month" disabled={readonly} value={p.month} onchange={(e) => setDate(which, i, Number(e.currentTarget.value), p.day)}>
							{#each DAYS as _, m (m)}<option value={m + 1}>{monthName(m + 1)}</option>{/each}
						</select>
						<input
							type="number"
							min="1"
							max={DAYS[p.month - 1]}
							aria-label="{which === 'reviewDates' ? 'Review' : 'Lift'} date {i + 1}: day"
							disabled={readonly}
							value={p.day}
							onchange={(e) => setDate(which, i, p.month, Math.max(1, Math.round(Number(e.currentTarget.value) || 1)))}
						/>
						{#if !readonly && (which === 'liftDates' || list.length > 1)}
							<button type="button" class="btn btn-sm btn-ghost" onclick={() => removeDate(which, i)}>Remove<span class="visually-hidden"> {which === 'reviewDates' ? 'review' : 'lift'} date {i + 1}</span></button>
						{/if}
					</div>
				{/each}
				{#if !readonly && list.length < RESTRICTION_DATES_MAX}
					<button type="button" class="btn btn-sm" onclick={() => edit({ [which]: withDateAdded(list) })}>Add a {which === 'reviewDates' ? 'review' : 'lift'} date</button>
				{/if}
			</fieldset>
		{/each}

		<p class="hint">
			Levels, mildest first: each starts below a share of the farm dams’ capacity and cuts each part of demand by its own %. Blank is not cut.
			Domestic and municipal demand objects keep their basic-needs floor of {DEMAND_NORMS.basicLitresPerPersonDay} litres a person a day.
		</p>
		<div class="levels" data-testid="restriction-levels">
			{#each rule.levels as l, i (i)}
				<fieldset class="level" data-testid="restriction-level">
					<legend>{l.label?.trim() || `Level ${i + 1}`}</legend>
					<div class="row">
						<label for="{uid}-l{i}-name">Name</label>
						<input id="{uid}-l{i}-name" type="text" maxlength={RESTRICTION_LABEL_MAX} aria-label="Level {i + 1}: name" disabled={readonly} value={l.label ?? ''} onchange={(e) => setLevel(i, { label: e.currentTarget.value })} />
					</div>
					<div class="row">
						<span class="lbl" aria-hidden="true">Starts below (% of capacity)</span>
						<NumberInput label="Level {i + 1}: starts below, % of capacity" min={0} max={100} scale={100} disabled={readonly} value={l.belowPct} onchange={(v) => v !== null && setLevel(i, { belowPct: v })} />
					</div>
					{#each DEMAND_PARTS as part (part)}
						<div class="row">
							<span class="lbl" aria-hidden="true">{PART_LABEL[part]} cut (%){#if floored(part)}<span class="muted"> (floor kept)</span>{/if}</span>
							<NumberInput
								label="Level {i + 1}: cut on {PART_LABEL[part]}, %"
								nullable
								min={0}
								max={100}
								scale={100}
								placeholder="Not cut"
								disabled={readonly}
								value={l.cuts[part] ?? null}
								onchange={(v) => setCut(i, part, v)}
							/>
						</div>
					{/each}
				</fieldset>
			{/each}
		</div>
		{#if !readonly}
			<div class="level-actions">
				{#if rule.levels.length < RESTRICTION_LEVELS_MAX}<button type="button" class="btn btn-sm" onclick={() => edit({ levels: withLevelAdded(rule.levels) })}>Add a deeper level</button>{/if}
				{#if rule.levels.length > 1}<button type="button" class="btn btn-sm btn-ghost" onclick={() => edit({ levels: rule.levels.slice(0, -1) })}>Remove the deepest level</button>{/if}
			</div>
		{/if}
		<div class="field">
			<label for="{uid}-source">Where the levels come from (optional)</label>
			<input id="{uid}-source" type="text" maxlength={RESTRICTION_SOURCE_MAX} disabled={readonly} value={rule.source ?? ''} onchange={(e) => edit({ source: e.currentTarget.value })} />
		</div>
		{#if error}<p class="err" role="status" data-testid="restriction-error">{error}</p>{/if}
	{/if}
</div>

<style>
	.restrict {
		display: grid;
		gap: 0.6rem;
		min-width: 0;
	}
	.check {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		min-height: 32px;
	}
	.hint {
		font-size: 0.8rem;
		color: var(--text-muted);
		margin: 0;
		max-width: 75ch;
	}
	.rule {
		margin: 0;
		max-width: 75ch;
	}
	.plain {
		border: 0;
		padding: 0;
		margin: 0;
		min-width: 0;
	}
	legend {
		padding: 0;
		margin-bottom: 0.2rem;
		font-weight: 500;
	}
	.dates {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem 1rem;
		align-items: center;
	}
	.date {
		display: flex;
		gap: 0.35rem;
		align-items: center;
	}
	.date input {
		width: 4.5rem;
	}
	/* One card per level: side by side where there is room, one under the other on a phone (ui-playbook § 2). */
	.levels {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(min(100%, 17rem), 1fr));
		gap: 0.75rem;
	}
	.level {
		margin: 0;
		padding: 0.5rem 0.75rem 0.75rem;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		min-width: 0;
		display: grid;
		gap: 0.3rem;
	}
	.row {
		display: grid;
		grid-template-columns: minmax(0, 1fr) 6.5rem;
		gap: 0.5rem;
		align-items: center;
		font-size: 0.85rem;
	}
	.row :global(input) {
		width: 100%;
	}
	.level-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}
	.field {
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
		max-width: 40rem;
	}
	.err {
		color: var(--danger);
		font-size: 0.85rem;
		margin: 0;
	}
</style>
