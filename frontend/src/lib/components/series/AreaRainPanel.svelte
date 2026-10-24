<script lang="ts">
	// An area's rain under its rainfall station, opened from its row on the Data tab (issue #553 round 5,
	// docs/ui.md § Data): the rain used with the four lines behind it (the station as recorded, the station ×
	// the MAP ratio, the area's CHIRPS as stored and corrected) on one chart, a strip under it for the days the
	// rain used didn't come from the station, the day counts and the pairing's factors in words, and a CSV of
	// those lines. The lines are ./derivedRain.ts's, computed by the parent from the model input when opened.
	import LineChart from '#lib/components/charts/LineChart.svelte';
	import DownloadMenu from '#lib/components/export/DownloadMenu.svelte';
	import { fmtNum } from '#lib/format/number.js';
	import { sourceLanes, sourceSummary, type AreaRainLines } from './derivedRain';
	import { datedCsv } from './groupedCsv';

	let {
		id,
		name,
		stationName,
		correctingName,
		lines,
		loading = false,
		error = null,
		onretry
	}: {
		/** The panel's element id (the row's disclosure controls it). */
		id: string;
		/** The area: "Average catchment rainfall" or the unit's name. */
		name: string;
		stationName: string;
		/** The station its CHIRPS is corrected against. */
		correctingName: string;
		lines: AreaRainLines | null;
		loading?: boolean;
		error?: string | null;
		onretry?: () => void;
	} = $props();

	const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
	const lanes = $derived(lines ? sourceLanes(lines.startDate, lines.source) : []);
	const series = $derived.by(() => {
		const l = lines;
		if (!l) return [];
		const at = (label: string, values: (number | null)[], color: string, style?: 'dashed') => ({ label, startDate: l.startDate, values, color, ...(style ? { style } : {}) });
		return [
			at('Rain used', l.rainUsed, '--series-1'),
			at(`${stationName} as recorded`, l.stationRaw, '--series-2', 'dashed' as const),
			at(`${stationName} × ${fmtNum(l.forcing.ratio, 2)}`, l.stationScaled, '--series-3'),
			...(l.chirpsRaw ? [at('CHIRPS as stored', l.chirpsRaw, '--series-4', 'dashed' as const)] : []),
			...(l.chirpsCorrected ? [at(`CHIRPS corrected against ${correctingName}`, l.chirpsCorrected, '--series-5')] : [])
		];
	});
	const fileName = $derived(`${name.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').toLowerCase() || 'area'}-rain.csv`);
	const csvItem = $derived(
		lines
			? [
					{
						label: `${name}: rain used and its lines (CSV)`,
						url: `build:area-rain:${id}`,
						hint: 'Rain used, its source, the station and CHIRPS lines',
						build: async () => {
							const l = lines!;
							const text = datedCsv(
								[`${name}: rain used from ${stationName}; CHIRPS corrected against ${correctingName}; computed from the stored inputs, not stored`],
								series.map((s) => ({ header: `${s.label} (mm)`, startDate: s.startDate, values: s.values })).concat([{ header: 'Rain used from', startDate: l.startDate, values: l.source as never }])
							);
							return { blob: new Blob([text], { type: 'text/csv;charset=utf-8' }), filename: fileName };
						}
					}
				]
			: []
	);
</script>

<div class="area-rain" {id} data-testid="area-rain">
	{#if error}
		<p class="err" role="alert">Couldn’t compute the rain of {name}: {error} {#if onretry}<button type="button" class="btn btn-sm" onclick={onretry}>Try again</button>{/if}</p>
	{:else if loading || !lines}
		<p class="muted" role="status">{loading ? 'Computing the rain from the stored inputs…' : 'A run reads no station for this area with the settings as saved.'}</p>
	{:else}
		<p class="facts" data-testid="area-rain-days">
			{sourceSummary(lines.source)}
			{#if lines.refused}
				The station pairing for its CHIRPS gaps is refused: {lines.refused}.
			{:else if lines.factors}
				CHIRPS factors against {correctingName}, January to December: {lines.factors.map((k, m) => `${MONTHS[m]} ${fmtNum(k, 2)}`).join(', ')}.
			{/if}
		</p>
		<LineChart
			title="{name}: rain used and the lines behind it"
			unit="mm/day"
			height={280}
			{series}
			recentDays={3 * 365}
			recentLabel="Last 3 years"
			{lanes}
			lanesLabel="Where the rain used came from"
			lanesNote="no strip: the station’s own reading × its ratio"
		/>
		<div class="area-dl"><DownloadMenu label="CSV" items={csvItem} align="start" /></div>
	{/if}
</div>

<style>
	.area-rain {
		display: grid;
		gap: 0.5rem;
		padding: 0.5rem 0 0.75rem;
		min-width: 0;
	}
	.facts {
		margin: 0;
		max-width: 60rem;
		font-size: 0.85rem;
		color: var(--text-2);
	}
	.err {
		margin: 0;
		color: var(--danger);
	}
	.area-dl {
		display: flex;
	}
</style>
