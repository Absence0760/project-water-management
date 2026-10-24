<!--
	Settings field for settings.qualityFlags.lowFlowPeriods (engine ≥ 1.90.0,
	issue #557, docs/model.md §2.10h): date ranges in which only a record's
	low flows are valid. Inside one, a reading above the threshold is flagged
	"above a low-flow period's threshold" and left out of every score (never
	censored); readings at or below it are scored as usual. Sits under the
	calibration exclusions, which drop whole days. Bind the list; `error` is
	set while it is invalid, so the parent form can block saving. Its rows
	mirror common/PeriodList.svelte's layout with more fields; fold the two
	into one piece if a third such list appears (extract on the third caller).
-->
<script lang="ts">
	import { LOW_FLOW_TEXT_MAX, lowFlowPeriodsError, RATING_SOURCE_MAX, type CalibrationFlowKind, type LowFlowPeriod } from '@water-management/engine';
	import DayInput from '#lib/components/common/DayInput.svelte';
	import NumberInput from '#lib/components/common/NumberInput.svelte';
	import HelpTip from '#lib/components/help/HelpTip.svelte';
	import { ratedKinds, RECORD_NAME } from '#lib/components/settings/qualityFlags.js';
	import { localIsoDate } from '#lib/format/number.js';

	let {
		list = $bindable([]),
		error = $bindable(null),
		readonly = false,
		seriesKinds = null,
		flowKind = null,
		siteName = null
	}: {
		list: LowFlowPeriod[];
		error?: string | null;
		readonly?: boolean;
		/** Series kinds the project has (null = not known: both records are offered). */
		seriesKinds?: string[] | null;
		/** settings.calibrationFlowKind: a new row starts on the record calibrated against. */
		flowKind?: CalibrationFlowKind | null;
		/** The calibration site's name when it is a gauge inside the network, where the periods don't apply. */
		siteName?: string | null;
	} = $props();

	const uid = $props.id();
	const kinds = $derived(ratedKinds(seriesKinds));

	$effect(() => {
		error = lowFlowPeriodsError(list);
	});

	function add() {
		// A water year before the earliest listed, else last water year by the viewer's own day (as the exclusions'),
		// so pressing twice never gives two rows on the same dates.
		const [year, month] = localIsoDate().split('-').map(Number);
		const listed = list.map((p) => Number(p.start.slice(0, 4)) - (Number(p.start.slice(5, 7)) >= 10 ? 0 : 1));
		const y = listed.length ? Math.min(...listed) - 1 : year - (month >= 10 ? 0 : 1) - 1;
		const kind: CalibrationFlowKind = flowKind && kinds.includes(flowKind) ? flowKind : kinds.includes('flow_logger_m3s') ? 'flow_logger_m3s' : (kinds[0] ?? 'flow_observed_m3s');
		list = [...list, { kind, start: `${y}-10-01`, end: `${y + 1}-09-30`, maxM3s: 1, reason: '', source: '' }];
	}
	const remove = (i: number) => (list = list.filter((_, j) => j !== i));
	const set = (i: number, patch: Partial<LowFlowPeriod>) => (list[i] = { ...list[i]!, ...patch });
	const blank = (v: string) => !v.trim();
</script>

<div class="lf" role="group" aria-labelledby="{uid}-l" aria-describedby="{uid}-hint" data-testid="low-flow-periods">
	<div class="head">
		<span class="legend"><span id="{uid}-l">Low flows only</span> <HelpTip key="settings.qualityFlags" label="Low flows only" /></span>
		{#if !readonly}
			<button type="button" class="btn btn-sm" onclick={add}>Use only low flows in a date range</button>
		{/if}
	</div>
	<p class="hint explain" id="{uid}-hint">
		For a period in which a record's high flows are wrong but its low flows are good. Inside the dates, a reading above the threshold is left out of Fit
		automatically, the run's statistics, its EWR test on the record and the plausibility checks; readings at or below it are scored as usual.
	</p>
	{#if siteName && list.length}
		<p class="note" data-testid="low-flow-site-note">
			These periods apply to the outlet's records. Calibration is scored at {siteName}, so they are not used until it is scored at the outlet again.
		</p>
	{/if}
	{#if list.length}
		<ol class="rows">
			{#each list as x, i (i)}
				<li class="row" data-testid="low-flow-period">
					<div class="field">
						<label for="{uid}-k{i}">Record</label>
						<select id="{uid}-k{i}" disabled={readonly} value={x.kind} onchange={(e) => set(i, { kind: e.currentTarget.value as CalibrationFlowKind })}>
							{#each kinds.includes(x.kind) ? kinds : [...kinds, x.kind] as k (k)}<option value={k}>{RECORD_NAME[k]}</option>{/each}
						</select>
					</div>
					<div class="field">
						<label for="{uid}-s{i}">From</label>
						<DayInput id="{uid}-s{i}" {readonly} value={x.start} onchange={(v) => set(i, { start: v })} />
					</div>
					<div class="field">
						<label for="{uid}-e{i}">To</label>
						<DayInput id="{uid}-e{i}" {readonly} value={x.end} onchange={(v) => set(i, { end: v })} />
					</div>
					<div class="field thr">
						<label for="{uid}-t{i}">Valid up to <span class="u">(m³/s)</span></label>
						<NumberInput id="{uid}-t{i}" min={0} step="any" disabled={readonly} value={x.maxM3s} onchange={(v) => v !== null && set(i, { maxM3s: v })} />
					</div>
					<div class="field text">
						<label for="{uid}-r{i}">Reason</label>
						<input
							id="{uid}-r{i}"
							maxlength={LOW_FLOW_TEXT_MAX}
							{readonly}
							placeholder="e.g. logger over-reads floods after the 2019 washout"
							value={x.reason}
							aria-invalid={blank(x.reason) || undefined}
							class:invalid={blank(x.reason)}
							oninput={(e) => set(i, { reason: e.currentTarget.value })}
						/>
					</div>
					<div class="field text">
						<label for="{uid}-o{i}">Source</label>
						<input
							id="{uid}-o{i}"
							maxlength={RATING_SOURCE_MAX}
							{readonly}
							placeholder="e.g. client's site visit, 2026-10"
							value={x.source}
							aria-invalid={blank(x.source) || undefined}
							class:invalid={blank(x.source)}
							oninput={(e) => set(i, { source: e.currentTarget.value })}
						/>
					</div>
					{#if !readonly}
						<button type="button" class="btn btn-icon" aria-label="Remove low-flow period {i + 1}" title="Remove" onclick={() => remove(i)}>✕</button>
					{/if}
				</li>
			{/each}
		</ol>
	{:else}
		<p class="muted small">None: every reading in the calibration window is scored at any flow.</p>
	{/if}
	{#if error}<p class="err" role="alert">{error}.</p>{/if}
</div>

<style>
	.lf {
		min-width: 0;
	}
	.head {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.25rem 0.75rem;
		margin-bottom: 0.2rem;
	}
	.legend {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		font-weight: 500;
		font-size: 0.85rem;
		color: var(--text-2);
	}
	.hint {
		font-size: var(--font-sm);
		color: var(--text-muted);
		max-width: 75ch;
		margin: 0 0 0.4rem;
	}
	.note {
		font-size: var(--font-sm);
		color: var(--text-2);
		border-left: 3px solid var(--warning);
		padding-left: 0.5rem;
		max-width: 75ch;
		margin: 0 0 0.4rem;
	}
	.u {
		font-weight: 400;
		color: var(--text-muted);
		font-size: var(--font-sm);
	}
	.rows {
		list-style: none;
		padding: 0;
		margin: 0;
		display: grid;
		gap: 0.4rem;
	}
	.row {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-end;
		gap: 0.25rem 0.75rem;
	}
	.row .field {
		margin: 0;
	}
	.thr {
		width: 130px;
	}
	.text {
		flex: 1;
		min-width: min(100%, 200px);
	}
	.text input {
		width: 100%;
	}
	.err {
		color: var(--danger);
		font-size: var(--font-sm);
	}
	input.invalid {
		border-color: var(--danger);
	}
	@media (max-width: 640px) {
		.btn {
			min-height: 44px;
		}
	}
</style>
