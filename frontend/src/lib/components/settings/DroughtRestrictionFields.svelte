<!--
	The drought restriction rule's editor (engine ≥ 1.46.0, WP-3.8, docs/ui.md
	§ Drought restrictions, docs/model.md §2.7i): Settings → Drought
	restrictions, and the scenario form's "Change a setting" for comparing
	restriction policies. On each review date the model reads the total farm
	dam storage at the start of the day and picks the deepest level whose
	threshold it is below; the level's cuts hold until the next review or
	lift date. A domestic or municipal object is never cut below its
	basic-needs floor. Bind the rule (null = off); `error` is set while it
	can't be saved, so the parent can block saving. Its own chunk: the
	Settings tab chunk sits at its size ceiling.
-->
<script lang="ts">
	import { DEMAND_PARTS, describeDroughtRestriction, RESTRICTION_DATES_MAX, RESTRICTION_LABEL_MAX, RESTRICTION_LEVELS_MAX, RESTRICTION_SOURCE_MAX, type DemandPart, type DroughtRestrictionRule } from '@water-management/engine';
	import NumberInput from '$lib/components/common/NumberInput.svelte';
	import { monthName } from '$lib/format/months';
	import { FLOORED_PARTS, joinMonthDay, PART_LABEL, restrictionFormError, splitMonthDay, startingRule, withCut, withDateAdded, withLevelAdded } from './droughtRestriction';

	let {
		value = $bindable(),
		error = $bindable(null),
		readonly = false,
		toggle = true
	}: {
		value: DroughtRestrictionRule | null | undefined;
		error?: string | null;
		readonly?: boolean;
		/** Show the on/off switch (the scenario form turns a rule off with its own choice). */
		toggle?: boolean;
	} = $props();

	const uid = $props.id();
	const DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
	$effect(() => {
		error = restrictionFormError(value);
	});
	// The rule switched off is kept until the form is saved or discarded, so switching back brings it back.
	let lastRule = $state<DroughtRestrictionRule | null>(null);
	function setOn(on: boolean) {
		if (!on && value) lastRule = $state.snapshot(value) as DroughtRestrictionRule;
		value = on ? (lastRule ?? startingRule()) : null;
	}
	const rule = $derived(value ?? null);
	/** The rule with one field replaced (the whole rule is what a save stores). */
	function edit(patch: Partial<DroughtRestrictionRule>) {
		if (value) value = { ...value, ...patch };
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
		} else edit({ [which]: list });
	}
	function setLevel(i: number, patch: Partial<DroughtRestrictionRule['levels'][number]>) {
		if (!value) return;
		edit({ levels: value.levels.map((l, k) => (k === i ? { ...l, ...patch } : l)) });
	}
	function setCut(i: number, part: DemandPart, cut: number | null) {
		if (!value) return;
		edit({ levels: value.levels.map((l, k) => (k === i ? withCut(l, part, cut) : l)) });
	}
	const words = $derived(rule ? describeDroughtRestriction(rule) : null);
</script>

<div class="restrict" data-testid="drought-restriction">
	{#if toggle}
		<label class="check">
			<input type="checkbox" disabled={readonly} checked={!!rule} aria-describedby="{uid}-hint" onchange={(e) => setOn(e.currentTarget.checked)} data-testid="restriction-on" />
			Apply drought restrictions in runs
		</label>
	{/if}
	<p class="hint" id="{uid}-hint">
		On each review date the model reads the total storage of the farm dams at the start of the day, as a share of their capacity, and applies
		the deepest level it is below until the next review or lift date. Each level cuts each part of every hydrological unit’s demand by its own
		share. Domestic and municipal demand objects are never cut below their basic-needs floor of 25 litres per person a day. A model rule, not
		the restriction notice farmers see. Off, every run is as before. The dates and levels you start from are a template, pending the hydrologist.
	</p>
	{#if rule}
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
							<button type="button" onclick={() => removeDate(which, i)}>Remove<span class="visually-hidden"> {which === 'reviewDates' ? 'review' : 'lift'} date {i + 1}</span></button>
						{/if}
					</div>
				{/each}
				{#if !readonly && list.length < RESTRICTION_DATES_MAX}
					<button type="button" onclick={() => edit({ [which]: withDateAdded(list) })}>Add a {which === 'reviewDates' ? 'review' : 'lift'} date</button>
				{/if}
			</fieldset>
		{/each}

		<div class="table-wrap">
			<table class="data compact levels" data-testid="restriction-levels">
				<caption>Levels, mildest first: the storage each starts below, and its cut on each part of demand (blank = not cut)</caption>
				<thead>
					<tr>
						<th scope="col">Level</th>
						{#each rule.levels as l, i (i)}<th scope="col">{l.label?.trim() || `Level ${i + 1}`}</th>{/each}
					</tr>
				</thead>
				<tbody>
					<tr>
						<th scope="row">Name</th>
						{#each rule.levels as l, i (i)}
							<td><input type="text" maxlength={RESTRICTION_LABEL_MAX} aria-label="Level {i + 1}: name" disabled={readonly} value={l.label ?? ''} onchange={(e) => setLevel(i, { label: e.currentTarget.value })} /></td>
						{/each}
					</tr>
					<tr>
						<th scope="row">Starts below (% of capacity)</th>
						{#each rule.levels as l, i (i)}
							<td><NumberInput label="Level {i + 1}: starts below, % of capacity" min={0} max={100} scale={100} disabled={readonly} value={l.belowPct} onchange={(v) => v !== null && setLevel(i, { belowPct: v })} /></td>
						{/each}
					</tr>
					{#each DEMAND_PARTS as part (part)}
						<tr>
							<th scope="row">{PART_LABEL[part]} cut (%){#if FLOORED_PARTS.includes(part)}<span class="muted small"> (floor kept)</span>{/if}</th>
							{#each rule.levels as l, i (i)}
								<td>
									<NumberInput
										label="Level {i + 1}: cut on {PART_LABEL[part]}, %"
										nullable
										min={0}
										max={100}
										scale={100}
										disabled={readonly}
										value={l.cuts[part] ?? null}
										onchange={(v) => setCut(i, part, v)}
									/>
								</td>
							{/each}
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
		{#if !readonly}
			<div class="level-actions">
				{#if rule.levels.length < RESTRICTION_LEVELS_MAX}<button type="button" onclick={() => edit({ levels: withLevelAdded(rule.levels) })}>Add a deeper level</button>{/if}
				{#if rule.levels.length > 1}<button type="button" onclick={() => edit({ levels: rule.levels.slice(0, -1) })}>Remove the deepest level</button>{/if}
			</div>
		{/if}
		<div class="field">
			<label for="{uid}-source">Where the levels come from (optional)</label>
			<input id="{uid}-source" type="text" maxlength={RESTRICTION_SOURCE_MAX} disabled={readonly} value={rule.source ?? ''} onchange={(e) => edit({ source: e.currentTarget.value })} />
		</div>
		{#if words}<p class="muted small" data-testid="restriction-words">In words: {words}.</p>{/if}
		{#if error}<p class="err" role="alert" data-testid="restriction-error">{error}</p>{/if}
	{/if}
</div>

<style>
	.restrict {
		display: grid;
		gap: 0.6rem;
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
	.table-wrap {
		overflow-x: auto;
		max-width: 100%;
	}
	.levels caption {
		text-align: left;
		caption-side: top;
		padding-bottom: 0.35rem;
	}
	.levels td :global(input) {
		width: 6rem;
	}
	.level-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}
</style>
