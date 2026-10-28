<!--
	Settings field for settings.flowMissing (engine ≥ 1.102.0, issue #611,
	docs/model.md §2.10h): each flow record's own missing periods, by its series
	id. A run reads those days of that record as missing (its statistics, the
	fit, the EWR test on it and the plausibility checks skip them, and its gap
	fill may fill them), where the calibration exclusions above leave the days
	out of every record. One period list a record (common/PeriodList.svelte),
	under the record's name; a record the list names but the project no longer
	has shows as a deleted series, so its periods can still be removed. Bind
	`value`; `error` is set while any list is invalid, so the parent form can
	block saving.
-->
<script lang="ts">
	import type { CalibrationExclusion } from '@water-management/engine';
	import PeriodList from '#lib/components/common/PeriodList.svelte';
	import { withRecordList, withUnlisted, type RecordOption } from '#lib/components/settings/recordPeriods.js';

	let {
		value = $bindable(),
		error = $bindable(null),
		records,
		readonly = false
	}: {
		value: Record<string, CalibrationExclusion[]> | null | undefined;
		error?: string | null;
		/** The project's flow records (recordPeriods.ts flowRecordOptions); null = not loaded yet. */
		records: RecordOption[] | null;
		readonly?: boolean;
	} = $props();

	const shown = $derived(records ? withUnlisted(records, value) : []);
	// Each list's own problem; the field's is the first, named by its record.
	let errors = $state<Record<string, string | null>>({});
	$effect(() => {
		const first = shown.find((r) => errors[r.id]);
		error = first ? `${first.label}: ${errors[first.id]}` : null;
	});
</script>

<div class="fm" data-testid="flow-missing-periods">
	{#if records === null}
		<p class="muted small">Loading the flow records…</p>
	{:else if shown.length === 0}
		<p class="muted small">Missing periods of one record: none to set, as the project has no flow record yet.</p>
	{:else}
		{#each shown as r (r.id)}
			<div class="record" data-testid="flow-missing-record" data-series={r.id}>
				<PeriodList
					bind:list={() => value?.[r.id] ?? [], (v) => (value = withRecordList(value, r.id, v))}
					bind:error={() => errors[r.id] ?? null, (v) => (errors[r.id] = v)}
					{readonly}
					legend="Missing periods of {r.label}"
					helpKey="settings.flowMissing"
					helpLabel="Missing periods of {r.label}"
					hint="Days of this record read as missing, as if blank: its statistics, Fit automatically, the EWR test on it and the plausibility checks skip them, and its gap fill may fill them. The other records keep theirs. Each needs a reason; runs record them."
					empty="None: every reading of this record is used."
					addYearLabel="A water year missing"
					addRangeLabel="A date range missing"
					placeholder="e.g. weir silted up; logger drift"
					noun="missing period"
				/>
			</div>
		{/each}
	{/if}
</div>

<style>
	.fm {
		display: grid;
		gap: 0.75rem;
		min-width: 0;
	}
</style>
