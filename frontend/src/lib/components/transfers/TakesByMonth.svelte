<script lang="ts">
	// A river off-take that takes a maximum or a formula, month by month (engine ≥
	// 1.114.0, docs/model.md §2.6a *A maximum or a formula by month*): a row per
	// water-year month, Oct to Sep, each with what it takes, "A maximum" (up to
	// the month's rate) or "A formula" (a × x^b % of the river, at most its
	// largest share and the month's rate, the canal), the rate, and a formula
	// month's a, b and largest share. A blank rate is a month off. The unit of x
	// and which flow it is are the rule's (DiversionCurveFields). A rule stored
	// by engine 1.113.0 with one curve shows it in every month; the first edit
	// writes the rule's own monthly list (engine withMonthlyRates for the rates),
	// which runs the same until a month is changed. Above the table, on the
	// group's title line: the months in words and "Apply … to every month".
	import type { Snippet } from 'svelte';
	import { diversionMonthsOf, transferRatesM3s, withMonthlyDiversion, withMonthlyRates, type MonthDiversion, type Transfer } from '@water-management/engine';
	import NumberInput from '#lib/components/common/NumberInput.svelte';
	import { WATER_YEAR_MONTHS } from '#lib/format/months.js';
	import { transferUnit } from '#lib/components/network/flowUnit.svelte.js';

	let {
		rule,
		label,
		disabled = false,
		title
	}: { rule: Transfer; /** "transfer 1": names the fields. */ label: string; disabled?: boolean; /** The group's title, at the head line's start. */ title?: Snippet } = $props();

	const rates = $derived(transferRatesM3s(rule));
	const curves = $derived(diversionMonthsOf(rule));
	const k = $derived(transferUnit.scaleFromM3s);
	let copyFrom = $state(0);
	const formulas = $derived(curves.filter((c) => c).length);
	const summary = $derived(
		formulas === 0 ? 'A maximum every month' : formulas === 12 ? 'A formula every month' : `A formula in ${formulas} month${formulas === 1 ? '' : 's'}, a maximum in ${12 - formulas}`
	);

	/** A month's formula as the form holds it while it is typed: a field left blank is null until it is filled. */
	type Draft = { coefficient: number | null; exponent: number | null; maxPct: number | null };

	/** Write the rule's curve by month (sized by a curve, the one curve of engine 1.113.0 emptied). */
	function writeCurves(list: (Draft | null)[]) {
		Object.assign(rule, { sizing: 'diversionCurve', monthlyDiversion: list as (MonthDiversion | null)[], diversionCoefficient: null, diversionExponent: null, diversionMaxPct: null });
	}
	function setRate(i: number, v: number | null) {
		const next = transferRatesM3s(rule);
		next[i] = v !== null && v > 0 ? v : 0;
		Object.assign(rule, withMonthlyRates(next));
	}
	/** A month to a formula starts from the nearest month that has one (a blank one when none does), or back to a maximum. */
	function setMode(i: number, formula: boolean) {
		const list: (Draft | null)[] = diversionMonthsOf(rule);
		if (formula) {
			const near = [...list.keys()].sort((a, b) => Math.abs(a - i) - Math.abs(b - i)).find((j) => list[j]);
			list[i] = near !== undefined ? { ...list[near]! } : { coefficient: null, exponent: null, maxPct: null };
		} else list[i] = null;
		// The last formula gone: a rule up to its maximum every month (engine withMonthlyDiversion), which saves as one.
		if (!list.some((m) => m)) Object.assign(rule, withMonthlyDiversion(list as (MonthDiversion | null)[]));
		else writeCurves(list);
	}
	function setCurve(i: number, field: keyof Draft, v: number | null) {
		const list: (Draft | null)[] = diversionMonthsOf(rule);
		list[i] = { ...(list[i] ?? { coefficient: null, exponent: null, maxPct: null }), [field]: v };
		writeCurves(list);
	}
	/** Every month takes what `from` takes: its rule, its rate and its formula. */
	function applyToAll(from: number) {
		const c = diversionMonthsOf(rule)[from] ?? null;
		Object.assign(rule, withMonthlyRates(new Array(12).fill(transferRatesM3s(rule)[from] ?? 0)));
		writeCurves(new Array(12).fill(null).map(() => (c ? { ...c } : null)));
	}
</script>

<fieldset class="bymonth" data-testid="takes-by-month">
	<legend class="visually-hidden">What {label} takes in each month: a maximum rate, or a formula (a × x^b % of the river) up to its rate</legend>
	<div class="head">
		{@render title?.()}
		<div class="sum">
			<span class="summary muted">{summary}</span>
			{#if !disabled}
				<span class="apply">
					<select aria-label="Month to apply to every month, {label}" bind:value={copyFrom}>
						{#each WATER_YEAR_MONTHS as m, i (m)}<option value={i}>{m}</option>{/each}
					</select>
					<button type="button" class="btn btn-sm btn-ghost" onclick={() => applyToAll(copyFrom)}>Apply to every month</button>
				</span>
			{/if}
		</div>
	</div>
	<!-- Six columns can be wider than a phone's card: the wrap takes focus so the keyboard can scroll it (axe scrollable-region-focusable). -->
	<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
	<div class="table-wrap" tabindex="0" role="region" aria-label="What {label} takes, month by month">
		<table class="data">
			<thead>
				<tr>
					<th scope="col">Month</th>
					<th scope="col">Takes</th>
					<th scope="col">Rate, {transferUnit.label}</th>
					<th scope="col">a</th>
					<th scope="col">b</th>
					<th scope="col">Largest share, %</th>
				</tr>
			</thead>
			<tbody>
				{#each WATER_YEAR_MONTHS as m, i (m)}
					{@const c = curves[i]}
					<tr class:formula={!!c} class:off={!(rates[i]! > 0)} data-month={m}>
						<th scope="row">{m}</th>
						<td>
							<select aria-label="Takes in {m}, {label}" {disabled} value={c ? 'formula' : 'max'} onchange={(e) => setMode(i, e.currentTarget.value === 'formula')}>
								<option value="max">A maximum</option>
								<option value="formula">A formula</option>
							</select>
						</td>
						<td data-paste-col={i}>
							<NumberInput
								label="{c ? 'Canal capacity' : 'Max rate'} of {label} in {m}, {transferUnit.label}"
								min={0}
								step={transferUnit.id === 'm3s' ? 0.001 : 1}
								scale={k}
								nullable
								placeholder="off"
								{disabled}
								value={rates[i]! > 0 ? rates[i]! : null}
								onchange={(v) => setRate(i, v)}
							/>
						</td>
						{#if c}
							<td><NumberInput label="Coefficient a of {label} in {m}" min={0} nullable placeholder="a" {disabled} value={c.coefficient ?? null} onchange={(v) => setCurve(i, 'coefficient', v)} /></td>
							<td><NumberInput label="Exponent b of {label} in {m}" nullable placeholder="b" {disabled} value={c.exponent ?? null} onchange={(v) => setCurve(i, 'exponent', v)} /></td>
							<td><NumberInput label="Largest share of {label} in {m}, %" min={0} max={100} scale={100} nullable placeholder="100" {disabled} value={c.maxPct ?? null} onchange={(v) => setCurve(i, 'maxPct', v)} /></td>
						{:else}
							<td class="none" colspan="3"><span class="muted small">up to the rate</span></td>
						{/if}
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
</fieldset>

<style>
	.bymonth {
		border: 0;
		margin: 0;
		padding: 0;
		min-width: 0;
	}
	.head {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 0.1rem 0.75rem;
		margin-bottom: 0.3rem;
	}
	.sum {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.25rem 0.5rem;
		margin-left: auto;
		min-height: 24px;
	}
	.summary {
		font-size: var(--font-sm);
	}
	.apply {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
	}
	.apply select,
	.apply .btn {
		min-height: 24px;
		font-size: var(--font-xs);
	}
	.table-wrap:focus-visible {
		outline: 2px solid var(--focus);
		outline-offset: 2px;
	}
	table {
		width: 100%;
	}
	th[scope='row'] {
		font-weight: 600;
		white-space: nowrap;
	}
	tr.off th[scope='row'] {
		color: var(--text-muted);
		font-weight: 400;
	}
	td {
		padding-block: 0.15rem;
	}
	td :global(input[type='number']) {
		box-sizing: border-box;
		width: 100%;
		min-width: 4.5rem;
		text-align: right;
		font-variant-numeric: tabular-nums;
	}
	td select {
		min-width: 7.5rem;
	}
	td.none {
		text-align: left;
	}
</style>
