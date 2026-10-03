<!--
	settings.rainSource (engine ≥ 0.30.0, issue #40 (b), docs/model.md §2.4e):
	periods whose catchment rain comes from the alternative catchment gauge ×
	monthly factors. Each period has its dates and a reason; fixed factors with
	their provenance, or a fit against a reference series over a reference era;
	and where its gaps fall through to; optionally a quantile map of its wet
	days (engine ≥ 1.21.0). `error` is set while the list is
	invalid (the engine's own check, which the API uses), so the parent form
	can block saving. Each period's problem sits under the field it is fixed in,
	which names it (aria-describedby); a missing reason is marked once the field
	has been left. Removing a period with something written in it asks first.
-->
<script lang="ts">
	import { HEAVY_DAY_MM, QM_MIN_WET_DAYS, QM_WET_DAY_MM_MAX, QM_WET_DAY_MM_MIN, waterYearLabel, type RainSourcePeriod } from '@water-management/engine';
	import NumberInput from '$lib/components/common/NumberInput.svelte';
	import HelpTip from '$lib/components/help/HelpTip.svelte';
	import { confirmDialog } from '$lib/components/common/confirm.svelte';
	import { newRainSourcePeriod, periodHasWork, rainSourceFormError, rainSourceProblems, withFactorMode, withFallback, withQuantileMap, type RainSourceField } from './rainSource';

	let {
		value = $bindable(),
		error = $bindable(null),
		readonly = false
	}: {
		value: RainSourcePeriod[];
		error?: string | null;
		readonly?: boolean;
	} = $props();

	const uid = $props.id();
	const MONTHS = ['Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep'];
	const REFERENCES = [
		{ value: 'rain_reanalysis_mm', label: 'Reanalysis (gauge-free, e.g. ERA5)' },
		{ value: 'rain_chirps_mm', label: 'CHIRPS' }
	] as const;
	const list = $derived(value ?? []);

	$effect(() => {
		error = rainSourceFormError(list);
	});
	const problems = $derived(rainSourceProblems(list));
	// Reasons left blank are marked once the field has been left, not the moment a period is added.
	let touched = $state<Record<number, boolean>>({});
	/** The period's problem, when it is on this field (and, for the reason, once the field has been left). */
	function on(i: number, field: RainSourceField): string | null {
		const p = problems[i];
		if (!p || p.field !== field) return null;
		return field === 'reason' && !touched[i] ? null : p.message;
	}
	const errId = (i: number) => `${uid}-err${i}`;
	/** aria-invalid and aria-describedby for a field, while its period's problem is on it. */
	const invalidOn = (i: number, field: RainSourceField) =>
		on(i, field) ? { 'aria-invalid': 'true' as const, 'aria-describedby': errId(i) } : {};

	function set(i: number, p: RainSourcePeriod) {
		value = list.map((x, j) => (j === i ? p : x));
	}
	const patch = (i: number, q: Partial<RainSourcePeriod>) => set(i, { ...list[i]!, ...q });
	function add() {
		value = [...list, newRainSourcePeriod()];
	}
	async function remove(i: number) {
		const p = list[i]!;
		if (
			periodHasWork(p) &&
			!(await confirmDialog({
				title: `Remove rain-source period ${i + 1}?`,
				message: `${p.start} to ${p.end}${p.reason.trim() ? ` (“${p.reason.trim()}”)` : ''}: its dates, reason and factors, with where they came from, go with it.`,
				confirmLabel: 'Remove the period',
				danger: true
			}))
		)
			return;
		value = list.filter((_, j) => j !== i);
		touched = {};
	}
	function setFactor(i: number, m: number, v: number) {
		const p = list[i]!;
		if (p.factors === 'fit') return;
		set(i, { ...p, factors: p.factors.map((f, k) => (k === m ? v : f)) });
	}
</script>

<div class="rain-source" data-testid="rain-source">
	<div class="head">
		<h3 class="title">Rain source periods <HelpTip key="settings.rainSource" /></h3>
		<span class="hint">
			Over each period, catchment rain comes from the alternative catchment gauge × its month’s factor instead of the catchment series, which then stays out
			of every factor fit. A day the gauge has no reading falls through to the fallback, then forecast rain.
		</span>
	</div>
	{#if list.length}
		<ol class="periods">
			{#each list as p, i (i)}
				{@const fixed = p.factors !== 'fit'}
				<li class="period" data-testid="rain-source-period">
					<fieldset class="plain">
						<legend>Period {i + 1}: alternative catchment gauge</legend>
						<div class="row">
							<div class="field">
								<label for="{uid}-s{i}">From</label>
								<input id="{uid}-s{i}" type="date" readonly={readonly} value={p.start} onchange={(e) => patch(i, { start: e.currentTarget.value })} {...invalidOn(i, 'start')} />
							</div>
							<div class="field">
								<label for="{uid}-e{i}">To</label>
								<input id="{uid}-e{i}" type="date" readonly={readonly} value={p.end} onchange={(e) => patch(i, { end: e.currentTarget.value })} {...invalidOn(i, 'end')} />
							</div>
							<div class="field reason">
								<label for="{uid}-r{i}">Reason</label>
								<input
									id="{uid}-r{i}"
									maxlength="500"
									readonly={readonly}
									placeholder="e.g. gauges closed 2012; in-catchment automatic station from then"
									value={p.reason}
									class:invalid={!!on(i, 'reason')}
									oninput={(e) => patch(i, { reason: e.currentTarget.value })}
									onblur={() => (touched[i] = true)}
									aria-invalid={on(i, 'reason') ? 'true' : undefined}
									aria-describedby={on(i, 'reason') ? errId(i) : `${uid}-r${i}-h`}
								/>
								<span class="hint" id="{uid}-r{i}-h">Required: why the gauge stands in for the catchment series here.</span>
							</div>
							{#if !readonly}
								<button type="button" class="btn btn-icon" aria-label="Remove rain-source period {i + 1}" title="Remove" onclick={() => remove(i)}>✕</button>
							{/if}
						</div>
						<div class="field">
							<label for="{uid}-m{i}">Factors</label>
							<select id="{uid}-m{i}" disabled={readonly} value={fixed ? 'fixed' : 'fit'} onchange={(e) => set(i, withFactorMode(p, e.currentTarget.value as 'fixed' | 'fit'))}>
								<option value="fixed">Fixed monthly factors, with where they came from</option>
								<option value="fit">Fit against a reference series</option>
							</select>
						</div>
						{#if p.factors !== 'fit'}
							{@const factors = p.factors}
							<table class="months">
								<thead><tr>{#each MONTHS as m (m)}<th scope="col">{m}</th>{/each}</tr></thead>
								<tbody>
									<tr>
										{#each MONTHS as m, k (m)}
											<td><NumberInput label="Factor, {m}, period {i + 1}" min={0.25} max={4} step={0.01} disabled={readonly} value={factors[k] ?? null} onchange={(v) => v !== null && setFactor(i, k, v)} /></td>
										{/each}
									</tr>
								</tbody>
							</table>
							<div class="row">
								<div class="field grow">
									<label for="{uid}-ps{i}">Fitted by</label>
									<input id="{uid}-ps{i}" maxlength="200" readonly={readonly} placeholder="e.g. hydrologist, rain-forcing study" value={p.provenance?.source ?? ''} oninput={(e) => patch(i, { provenance: { ...p.provenance!, source: e.currentTarget.value } })} {...invalidOn(i, 'source')} />
								</div>
								<div class="field">
									<label for="{uid}-pf{i}">Fitted on, from</label>
									<input id="{uid}-pf{i}" type="date" readonly={readonly} value={p.provenance?.fittedFrom ?? ''} onchange={(e) => patch(i, { provenance: { ...p.provenance!, fittedFrom: e.currentTarget.value } })} {...invalidOn(i, 'fittedFrom')} />
								</div>
								<div class="field">
									<label for="{uid}-pt{i}">to</label>
									<input id="{uid}-pt{i}" type="date" readonly={readonly} value={p.provenance?.fittedTo ?? ''} onchange={(e) => patch(i, { provenance: { ...p.provenance!, fittedTo: e.currentTarget.value } })} {...invalidOn(i, 'fittedTo')} />
								</div>
								<div class="field grow">
									<label for="{uid}-pm{i}">Method</label>
									<input id="{uid}-pm{i}" maxlength="200" readonly={readonly} placeholder="e.g. catchment ÷ ERA5 over the reference era, by month" value={p.provenance?.method ?? ''} oninput={(e) => patch(i, { provenance: { ...p.provenance!, method: e.currentTarget.value } })} {...invalidOn(i, 'method')} />
								</div>
							</div>
						{:else}
							{@const ref = p.fitReference!}
							<div class="row">
								<div class="field">
									<label for="{uid}-fr{i}">Reference</label>
									<select id="{uid}-fr{i}" disabled={readonly} value={ref.series} onchange={(e) => patch(i, { fitReference: { ...ref, series: e.currentTarget.value as 'rain_reanalysis_mm' } })}>
										{#each REFERENCES as r (r.value)}<option value={r.value}>{r.label}</option>{/each}
									</select>
								</div>
								<div class="field year">
									<label for="{uid}-ff{i}">Reference era from <span class="u">(water year)</span></label>
									<NumberInput id="{uid}-ff{i}" min={1800} max={2200} step={1} disabled={readonly} value={ref.fromWaterYear} onchange={(v) => v !== null && patch(i, { fitReference: { ...ref, fromWaterYear: v } })} aria-describedby="{uid}-ff{i}-h" />
									<span class="hint" id="{uid}-ff{i}-h">WY {waterYearLabel(ref.fromWaterYear)}</span>
								</div>
								<div class="field year">
									<label for="{uid}-ft{i}">to</label>
									<NumberInput id="{uid}-ft{i}" min={1800} max={2200} step={1} disabled={readonly} value={ref.toWaterYear} onchange={(v) => v !== null && patch(i, { fitReference: { ...ref, toWaterYear: v } })} aria-describedby="{uid}-ft{i}-h" />
									<span class="hint" id="{uid}-ft{i}-h">WY {waterYearLabel(ref.toWaterYear)}</span>
								</div>
							</div>
							<span class="hint">
								Factor = (catchment ÷ reference over the reference era) ÷ (gauge ÷ reference over the period): the gauge lands at the catchment series’ level
								in the years it was trusted. Pick a reference that doesn’t contain the gauge.
							</span>
						{/if}
						<div class="row">
							<div class="field">
								<label for="{uid}-fb{i}">Gaps from</label>
								<select id="{uid}-fb{i}" disabled={readonly} value={p.fallback ? p.fallback.series : 'chirps'} onchange={(e) => set(i, withFallback(p, e.currentTarget.value as 'chirps' | 'rain_reanalysis_mm'))}>
									<option value="chirps">CHIRPS × the CHIRPS fit-period factors</option>
									<option value="rain_reanalysis_mm">Reanalysis × catchment ÷ reanalysis factors</option>
								</select>
							</div>
							{#if p.fallback}
								{@const fb = p.fallback}
								<div class="field year">
									<label for="{uid}-bf{i}">Fitted on water years from</label>
									<NumberInput id="{uid}-bf{i}" min={1800} max={2200} step={1} disabled={readonly} value={fb.fromWaterYear} onchange={(v) => v !== null && patch(i, { fallback: { ...fb, fromWaterYear: v } })} />
								</div>
								<div class="field year">
									<label for="{uid}-bt{i}">to</label>
									<NumberInput id="{uid}-bt{i}" min={1800} max={2200} step={1} disabled={readonly} value={fb.toWaterYear} onchange={(v) => v !== null && patch(i, { fallback: { ...fb, toWaterYear: v } })} />
								</div>
							{/if}
						</div>
						<label class="check">
							<input type="checkbox" disabled={readonly} checked={p.gaugeInChirps === true} onchange={(e) => patch(i, { gaugeInChirps: e.currentTarget.checked })} />
							CHIRPS ingests this gauge in this period (so CHIRPS can be neither the fit reference nor the fallback)
						</label>
						<label class="check">
							<input type="checkbox" disabled={readonly} checked={!!p.quantileMap} onchange={(e) => set(i, withQuantileMap(p, e.currentTarget.checked))} />
							Quantile-map its wet days onto the catchment series (each month’s total kept)
						</label>
						{#if p.quantileMap}
							{@const q = p.quantileMap}
							<div class="row">
								<div class="field year">
									<label for="{uid}-qf{i}">Mapped onto water years from</label>
									<NumberInput id="{uid}-qf{i}" min={1800} max={2200} step={1} disabled={readonly} value={q.fromWaterYear} onchange={(v) => v !== null && patch(i, { quantileMap: { ...q, fromWaterYear: v } })} aria-describedby="{uid}-qf{i}-h" />
									<span class="hint" id="{uid}-qf{i}-h">WY {waterYearLabel(q.fromWaterYear)}</span>
								</div>
								<div class="field year">
									<label for="{uid}-qt{i}">to</label>
									<NumberInput id="{uid}-qt{i}" min={1800} max={2200} step={1} disabled={readonly} value={q.toWaterYear} onchange={(v) => v !== null && patch(i, { quantileMap: { ...q, toWaterYear: v } })} aria-describedby="{uid}-qt{i}-h" />
									<span class="hint" id="{uid}-qt{i}-h">WY {waterYearLabel(q.toWaterYear)}</span>
								</div>
								<div class="field year">
									<label for="{uid}-qw{i}">Wet day from <span class="u">(mm)</span></label>
									<NumberInput id="{uid}-qw{i}" min={QM_WET_DAY_MM_MIN} max={QM_WET_DAY_MM_MAX} step={0.1} disabled={readonly} value={q.wetDayMm} onchange={(v) => v !== null && patch(i, { quantileMap: { ...q, wetDayMm: v } })} />
								</div>
							</div>
							<span class="hint">
								The gauge’s wet days are mapped, month by month, onto the catchment series’ wet days in those years (a month with fewer than {QM_MIN_WET_DAYS} wet days
								uses its three-month season, else keeps the factor alone), then scaled back to the month’s total: the spread of the falls changes, the volume
								doesn’t. Each run reports the share of rain on heavy days (≥ {HEAVY_DAY_MM} mm) either way.
							</span>
						{/if}
						<!-- The period's problem: named by the field it is on (aria-describedby); one in no field in particular stands alone. -->
						{#if problems[i] && (problems[i]!.field === 'period' || on(i, problems[i]!.field))}
							<p class="err" id={errId(i)}>{problems[i]!.message}.</p>
						{/if}
					</fieldset>
				</li>
			{/each}
		</ol>
	{:else}
		<p class="hint" data-testid="rain-source-none">None: the catchment series throughout.</p>
	{/if}
	{#if !readonly}
		<div class="add"><button type="button" class="btn btn-sm" onclick={add}>Add a rain-source period</button></div>
	{/if}
	<!-- A problem with the list as a whole (too many periods), which no period carries. -->
	{#if error && !problems.some(Boolean)}<p class="err">{error}.</p>{/if}
</div>

<style>
	.rain-source {
		display: grid;
		gap: 0.5rem;
		margin-bottom: 0.75rem;
	}
	.head {
		display: grid;
		gap: 0.2rem;
		max-width: 75ch;
	}
	.lbl {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
	}
	.title {
		font-size: 0.95rem;
		margin: 0;
	}
	legend {
		font-weight: 500;
		font-size: 0.85rem;
		color: var(--text-2);
	}
	.hint {
		font-size: 0.8rem;
		color: var(--text-muted);
	}
	.u {
		font-weight: 400;
		color: var(--text-muted);
		font-size: 0.8rem;
	}
	.periods {
		list-style: none;
		padding: 0;
		margin: 0;
		display: grid;
		gap: 0.75rem;
	}
	.period {
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		padding: 0.5rem 0.75rem;
	}
	.plain {
		border: 0;
		padding: 0;
		margin: 0;
		min-width: 0;
		display: grid;
		gap: 0.4rem;
	}
	legend {
		padding: 0;
		margin-bottom: 0.2rem;
	}
	.row {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-end;
		gap: 0.25rem 0.75rem;
	}
	.field {
		margin: 0;
	}
	.grow,
	.reason {
		flex: 1;
		min-width: min(100%, 220px);
	}
	.reason input,
	.grow input {
		width: 100%;
	}
	.year {
		width: 170px;
	}
	.months {
		border-collapse: collapse;
		display: block;
		overflow-x: auto;
		max-width: 100%;
	}
	.months th {
		font-size: 0.75rem;
		font-weight: 500;
		color: var(--text-muted);
	}
	.months td :global(input) {
		width: 4.2rem;
	}
	.check {
		display: flex;
		gap: 0.4rem;
		align-items: center;
		font-size: 0.85rem;
	}
	.add {
		margin-top: 0.25rem;
	}
	.err {
		color: var(--danger);
		font-size: 0.8rem;
	}
	input.invalid {
		border-color: var(--danger);
	}
</style>
