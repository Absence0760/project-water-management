<!--
	Settings field for settings.calibrationExclusions (issue #4): periods left
	out of every calibration score, each a whole water year or a date range,
	each with a required reason. Bind the list; `error` is set while it is
	invalid, so the parent form can block saving.
-->
<script lang="ts">
	import type { CalibrationExclusion } from '@water-management/engine';
	import PeriodList from '$lib/components/common/PeriodList.svelte';

	let {
		list = $bindable([]),
		error = $bindable(null),
		readonly = false
	}: {
		list: CalibrationExclusion[];
		error?: string | null;
		readonly?: boolean;
	} = $props();
</script>

<PeriodList
	bind:list
	bind:error
	{readonly}
	legend="Calibration exclusions"
	helpKey="settings.calibrationExclusions"
	hint="Periods left out of every calibration score (Fit automatically and the run's statistics), such as a suspect rain year or the gauge after a known break. Each needs a reason; runs record them, and comparing runs lists any change."
	empty="None: every observed day in the calibration window is scored."
	addYearLabel="Exclude a water year"
	addRangeLabel="Exclude a date range"
	placeholder="e.g. rain gauge moved; suspect rainfall"
	noun="exclusion"
/>
