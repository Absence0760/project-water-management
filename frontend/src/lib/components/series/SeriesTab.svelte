<script module lang="ts">
	const loadPreviewDialog = () => import('./SeriesPreviewDialog.svelte');
</script>

<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import {
		agreementOptions,
		checkSeries,
		doubleMass,
		doubleMassCheck,
		fromEpochDay,
		observedAgreement,
		rainVsChirps,
		rainVsChirpsCheck,
		resolveDataQuality,
		resolveZeroRain,
		SERIES_KINDS,
		toEpochDay,
		type ProjectSettings,
		type SeriesCheckKind,
		type SeriesKind,
		type SeriesMeta
	} from '@water-management/engine';
	import { api, type RunMeta } from '$lib/api';
	import LineChart from '$lib/components/charts/LineChart.svelte';
	import Lazy from '$lib/components/common/Lazy.svelte';
	import { prefetch } from '$lib/components/common/lazy';
	import LoadState from '$lib/components/common/LoadState.svelte';
	import DownloadMenu from '$lib/components/export/DownloadMenu.svelte';
	import HelpTip from '$lib/components/help/HelpTip.svelte';
	import { downloads } from '$lib/export';
	import { fmtNum, localIsoDate } from '$lib/format/number';
	import { CsvError, parseSeriesCsv, type ParsedSeries } from '$lib/series/csv';
	import { defaultUnit, KIND_OPTIONS, kindLabel } from '$lib/series/kinds';
	import { coverageBins, coverageStats, daysBetween, describeAge, mergePreview, type Daily } from './coverage';
	import AgreementTable from './AgreementTable.svelte';
	import CoverageStrip from './CoverageStrip.svelte';
	import DoubleMassPanel from './DoubleMassPanel.svelte';
	import UploadForm from './UploadForm.svelte';
	import type { UploadResult } from './upload';
	import { KIND_ROLES, seriesInUse } from './roles';
	import { valuesCache } from './valuesCache';
	import { zeroRainShading } from './zeroRain';

	let {
		projectId,
		readonly,
		initial = null,
		runs = null,
		settings = null,
		onSeriesChange
	}: {
		projectId: string;
		readonly: boolean;
		/** Already-loaded list (the page's), so the first frame has the final layout. */
		initial?: SeriesMeta[] | null;
		runs?: RunMeta[] | null;
		/** The project's settings, the same object the Settings tab gets; null only before the page's own load finishes. */
		settings?: ProjectSettings | null;
		onSeriesChange?: (list: SeriesMeta[]) => void;
	} = $props();

	/** Gauge-vs-logger thresholds; null = the engine defaults. */
	const dataQuality = $derived(settings?.dataQuality ?? null);
	const zeroRainRuns = $derived(settings?.zeroRainRuns ?? null);

	let list = $state<SeriesMeta[]>(untrack(() => initial ?? []));
	let loading = $state(untrack(() => initial === null));
	let loadError = $state<string | null>(null);
	let actionError = $state<string | null>(null);

	// Full values per series (for coverage and the chart). Input series are few
	// (one per kind, a handful of names), so fetching them all is cheap.
	// $state.raw: 16k-value daily arrays must not be wrapped in deep reactive
	// proxies — reading them element by element froze the Runs tab. Replace, never mutate.
	let values = $state.raw<Record<string, Daily>>({});
	// The viewer's calendar date, as on the project list (projects/freshness.ts).
	const today = localIsoDate();

	let selectedId = $state<string | null>(null);
	const viewing = $derived(list.find((s) => s.id === selectedId) ?? null);

	let previewOpen = $state(false);
	// The preview dialog is its own chunk (preview.ts pulls in the engine's
	// run preparation): fetched on first open, warmed on hover/focus, then kept.
	let previewMounted = $state(false);
	const warmPreview = () => prefetch(loadPreviewDialog);
	let previewFocusSeriesId = $state<string | null>(null);
	/** The card header's "Preview all data": every column, nothing highlighted. */
	function openPreviewAll() {
		previewFocusSeriesId = null;
		previewMounted = true;
		previewOpen = true;
	}
	/** A row's own "Preview": that series' column un-hidden, scrolled to and highlighted. */
	function openPreviewSeries(id: string) {
		previewFocusSeriesId = id;
		previewMounted = true;
		previewOpen = true;
	}

	// Clicking anywhere on a row shows that series in the chart; clicks on the
	// row's own controls (View, CSV menu, Delete) keep their meaning. The View
	// button stays the keyboard / screen-reader way to do the same.
	function rowClick(e: MouseEvent, id: string) {
		if ((e.target as Element).closest('button, a, input, select, summary, [role="menu"]')) return;
		selectedId = id;
	}
	let flowLog = $state(false);

	const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
	const endDate = (s: { startDate: string; length: number }) => fromEpochDay(toEpochDay(s.startDate) + s.length - 1);
	const inUse = $derived(seriesInUse(list));
	const latestRun = $derived(runs?.[0] ?? null);
	const isRain = (k: string) => k.startsWith('rain_');

	async function load() {
		if (!list.length) loading = true;
		loadError = null;
		try {
			list = await api.series.list(projectId);
			onSeriesChange?.(list);
			void loadValues();
		} catch (e) {
			loadError = msg(e);
		} finally {
			loading = false;
		}
	}
	onMount(() => {
		if (initial) void loadValues();
		void load();
	});

	async function loadValues() {
		await Promise.all(
			list.map(async (s) => {
				const key = `${projectId}/${s.id}`;
				const hit = valuesCache.get(key);
				if (hit && hit.startDate === s.startDate && hit.values.length === s.length) {
					values = { ...values, [s.id]: hit };
					return;
				}
				try {
					const d = await api.series.get(projectId, s.id);
					const v = { startDate: d.startDate, values: d.values };
					valuesCache.set(key, v);
					values = { ...values, [s.id]: v };
				} catch {
					/* coverage cells stay "–" */
				}
			})
		);
		if (!selectedId && list.length) selectedId = pickDefault(list);
	}

	// Default chart: observed flow if present, else the main rainfall.
	function pickDefault(l: SeriesMeta[]): string {
		const prefer = ['flow_observed_m3s', 'rain_catchment_mm'];
		for (const k of prefer) {
			const s = l.find((x) => x.kind === k && inUse.has(x.id));
			if (s) return s.id;
		}
		return l[0]!.id;
	}

	const stats = $derived(
		Object.fromEntries(list.map((s) => [s.id, values[s.id] ? coverageStats(values[s.id]!, s.kind) : null]))
	);
	const bins = $derived(Object.fromEntries(list.map((s) => [s.id, values[s.id] ? coverageBins(values[s.id]!) : []])));
	const newestDate = $derived(list.reduce((m, s) => (endDate(s) > m ? endDate(s) : m), ''));
	const newerThanRun = $derived(
		latestRun ? list.filter((s) => KIND_ROLES[s.kind]?.driver !== false && inUse.has(s.id) && endDate(s) > latestRun.endDate) : []
	);

	// The series a run reads for a kind: the first of that kind by name.
	const first = (k: string) => [...list].filter((s) => s.kind === k).sort((a, b) => a.name.localeCompare(b.name))[0];

	// Days a run treats as missing (CR-20) or spreads a multi-day accumulation over (B4), shaded on the
	// catchment rain a run reads: the first by name. Accumulations are judged against the CHIRPS a run reads.
	const shading = $derived.by(() => {
		if (!viewing || viewing.kind !== 'rain_catchment_mm' || viewing.id !== first('rain_catchment_mm')?.id) return null;
		const v = values[viewing.id];
		const h = first('rain_chirps_mm');
		return v ? zeroRainShading(v, resolveZeroRain(zeroRainRuns, []), (h && values[h.id]) || null, settings?.chirpsBiasCorrection ?? 'monthly') : null;
	});

	// Gauge vs logger, when both records exist.
	const agreement = $derived.by(() => {
		const o = first('flow_observed_m3s');
		const l = first('flow_logger_m3s');
		const vo = o && values[o.id];
		const vl = l && values[l.id];
		// resolveDataQuality falls back to the defaults for anything missing or invalid, like a run does.
		return vo && vl
			? observedAgreement({ flow_observed_m3s: vo, flow_logger_m3s: vl }, agreementOptions(resolveDataQuality(dataQuality)))
			: null;
	});

	// Catchment rain vs CHIRPS, when both exist: water years far below CHIRPS (zeros that are really missing data?).
	const lowVsChirps = $derived.by(() => {
		const c = first('rain_catchment_mm');
		const h = first('rain_chirps_mm');
		const vc = c && values[c.id];
		const vh = h && values[h.id];
		const check = vc && vh ? rainVsChirpsCheck(rainVsChirps({ rain_catchment_mm: vc, rain_chirps_mm: vh })) : null;
		return check ? { id: `${c!.id}-${check.check}`, series: c!, check } : null;
	});

	// Double mass of catchment rain against CHIRPS (engine ≥ 0.18.0), on the days a run would use: the zero-rain settings decide which are suspect.
	const dm = $derived.by(() => {
		const c = first('rain_catchment_mm');
		const h = first('rain_chirps_mm');
		const vc = c && values[c.id];
		const vh = h && values[h.id];
		return vc && vh ? { series: c!, result: doubleMass({ rain_catchment_mm: vc, rain_chirps_mm: vh }, resolveZeroRain(zeroRainRuns, [])) } : null;
	});
	const dmCheck = $derived.by(() => {
		const check = dm ? doubleMassCheck(dm.result) : null;
		return check ? { id: `${dm!.series.id}-${check.check}`, series: dm!.series, check } : null;
	});

	// Negative values, outliers, flat-lines and zero runs per series (the checks a run reports as warnings).
	const checks = $derived([
		...list.flatMap((s) => {
			const v = values[s.id];
			if (!v || !(SERIES_KINDS as readonly string[]).includes(s.kind)) return [];
			return checkSeries(s.kind as SeriesKind, v).map((c) => ({ id: `${s.id}-${c.check}`, series: s, check: c }));
		}),
		...(lowVsChirps ? [lowVsChirps] : []),
		...(dmCheck ? [dmCheck] : [])
	]);
	const CHECK_LABEL: Record<SeriesCheckKind, string> = {
		negative: 'Negative values',
		outlier: 'Outliers',
		flatline: 'Flat stretch',
		zerorun: 'Zero rain run',
		lowvschirps: 'Low vs CHIRPS',
		doublemass: 'Double mass vs CHIRPS'
	};

	async function remove(s: SeriesMeta) {
		if (!confirm(`Delete the series "${s.name || kindLabel(s.kind)}"? Runs already stored are not affected.`)) return;
		actionError = null;
		try {
			await api.series.remove(projectId, s.id);
			list = list.filter((x) => x.id !== s.id);
			onSeriesChange?.(list);
			if (selectedId === s.id) selectedId = list[0]?.id ?? null;
		} catch (e) {
			actionError = msg(e);
		}
	}

	async function uploaded(r: UploadResult) {
		values = Object.fromEntries(Object.entries(values).filter(([id]) => id !== r.meta.id));
		await load();
		selectedId = r.meta.id;
	}

	const typical = (s: SeriesMeta) => {
		const st = stats[s.id];
		if (!st) return '…';
		if (isRain(s.kind)) return st.meanAnnualMm === null ? '–' : `${fmtNum(st.meanAnnualMm)} mm/a`;
		return st.meanDaily === null ? '–' : `${fmtNum(st.meanDaily, st.meanDaily < 1 ? 3 : 2)} ${s.unit}`;
	};
</script>

{#if actionError}<div class="alert alert-error" role="alert">{actionError}</div>{/if}

{#if newerThanRun.length && latestRun}
	<div class="alert alert-info" role="status">
		New data since the latest run: {newerThanRun.map((s) => s.name || kindLabel(s.kind)).join(', ')} now run{newerThanRun.length === 1 ? 's' : ''}
		to {newestDate}, but “{latestRun.label || 'the latest run'}” ends {latestRun.endDate}.
		<a href="?tab=runs">Re-run the model</a> to include it.
	</div>
{/if}

<section class="panel" aria-labelledby="ser-h">
	<div class="panel-head">
		<h2 id="ser-h">Input time series</h2>
		{#if list.length}
			<span class="muted small">Daily values · {list.length} series{newestDate ? ` · data up to ${newestDate} (${describeAge(daysBetween(newestDate, today))})` : ''}</span>
			<button type="button" class="btn btn-sm" onclick={openPreviewAll} onpointerenter={warmPreview} onfocus={warmPreview}>Preview all data</button>
		{/if}
	</div>
	<LoadState
		{loading}
		error={loadError}
		retry={load}
		empty={list.length === 0}
		emptyText={readonly
			? 'No time series yet. An editor can upload daily rainfall and observed flow as CSV files.'
			: 'No time series yet. Upload daily rainfall (and, to calibrate, observed flow at the outflow gauge) as CSV files with the Upload CSV form below.'}
	>
		<!-- Below 640px each row is a card (CSS grid), so the row's numbers, coverage and
		     buttons all fit a phone without scrolling the table sideways. The explicit
		     table roles keep the table semantics that some browsers (Safari) drop once
		     rows and cells stop being display: table-*. -->
		<div class="table-wrap">
			<!-- svelte-ignore a11y_no_redundant_roles -->
			<table class="data series" role="table">
				<thead role="rowgroup">
					<tr role="row">
						<th scope="col" role="columnheader">Series</th>
						<th scope="col" role="columnheader">Period</th>
						<th scope="col" role="columnheader">Data up to</th>
						<th scope="col" role="columnheader" class="num">Missing<br /><span class="u">% of days</span></th>
						<th scope="col" role="columnheader" class="num">Typical<br /><span class="u">mean</span></th>
						<th scope="col" role="columnheader" class="cov">Coverage by year</th>
						<th scope="col" role="columnheader"><span class="visually-hidden">Actions</span></th>
					</tr>
				</thead>
				<tbody role="rowgroup">
					{#each list as s (s.id)}
						{@const st = stats[s.id]}
						{@const end = endDate(s)}
						{@const age = daysBetween(st?.lastValueDate ?? end, today)}
						{@const role = KIND_ROLES[s.kind]}
						<!-- Pointer shortcut only; the View button is the accessible control. -->
						<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
						<tr role="row" class="pick" class:selected={s.id === selectedId} onclick={(e) => rowClick(e, s.id)}>
							<th scope="row" role="rowheader">
								<span class="kind">{kindLabel(s.kind)}</span>
								<span class="nm">{s.name || '–'} <span class="u">({s.unit})</span></span>
								{#if role}
									<span class="role" class:unused={!inUse.has(s.id)} title={role.help}>
										{inUse.has(s.id) || s.kind === 'flow_reference_m3s'
											? role.role
											: s.kind === 'flow_logger_m3s' && !list.some((x) => x.kind === s.kind && inUse.has(x.id))
												? 'Calibration if chosen in settings'
												: 'Not used (another series of this kind is)'}
									</span>
								{/if}
							</th>
							<td role="cell" class="num period" data-label="Period">{s.startDate} →<br />{end}</td>
							<td role="cell" class="upto" data-label="Data up to">
								<span class="num">{st?.lastValueDate ?? end}</span>
								<span class="age" class:stale={age > 31}>{describeAge(age)}</span>
							</td>
							<td role="cell" class="num missing" class:warn={st && st.missingPct >= 5} data-label="Missing (% of days)">{st ? fmtNum(st.missingPct, 1) : '…'}</td>
							<td role="cell" class="num typical" data-label="Typical (mean)">{typical(s)}</td>
							<td role="cell" class="cov" data-label="Coverage by year">
								{#if values[s.id]}
									<CoverageStrip bins={bins[s.id] ?? []} byMonth={s.length < 3 * 365} label="Coverage of {s.name || kindLabel(s.kind)}" />
									<span class="range"><span>{s.startDate.slice(0, 4)}</span><span>{end.slice(0, 4)}</span></span>
								{:else}
									<span class="strip-ph" aria-hidden="true"></span>
								{/if}
							</td>
							<td role="cell" class="act">
								<div class="acts">
								<button type="button" class="btn btn-sm" aria-pressed={s.id === selectedId} onclick={() => (selectedId = s.id)}>View</button>
								<button type="button" class="btn btn-sm" onclick={() => openPreviewSeries(s.id)} onpointerenter={warmPreview} onfocus={warmPreview}>Preview</button>
								<DownloadMenu label="CSV" items={[{ label: `${s.name || kindLabel(s.kind)} (CSV)`, url: downloads.series(projectId, s.id), hint: `${s.startDate} → ${end}` }]} />
								{#if !readonly}
									<button type="button" class="btn btn-sm btn-danger" onclick={() => remove(s)} aria-label="Delete {s.name || kindLabel(s.kind)}">Delete</button>
								{/if}
								</div>
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
		<p class="muted small key">
			<span class="sw full"></span> complete year <span class="sw part"></span> some days missing <span class="sw none"></span> no data.
			Rainfall "typical" = mean annual total; flow = mean daily flow.
		</p>
	</LoadState>
</section>

{#if viewing}
	<section class="panel" aria-labelledby="chart-h">
		<h2 id="chart-h" class="visually-hidden">Series chart</h2>
		{#if values[viewing.id]}
			<LineChart
				title="{kindLabel(viewing.kind)}{viewing.name ? ` · ${viewing.name}` : ''}"
				unit={isRain(viewing.kind) ? 'mm/day' : viewing.unit}
				series={[{ label: viewing.name || kindLabel(viewing.kind), startDate: values[viewing.id]!.startDate, values: values[viewing.id]!.values }]}
				logToggle={!isRain(viewing.kind)}
				bind:log={flowLog}
				recentDays={3 * 365}
				recentLabel="Last 3 years"
				shade={shading?.ranges ?? []}
				caption={shading?.caption ?? undefined}
			/>
		{:else}
			<div class="chart-ph" role="status">Loading series…</div>
		{/if}
	</section>
{/if}

{#if agreement}
	<section class="panel" aria-label="Gauge vs logger agreement">
		<AgreementTable {agreement} headingLevel={2} />
	</section>
{/if}

{#if dm?.result}
	<DoubleMassPanel dm={dm.result} />
{/if}

{#if list.length && Object.keys(values).length}
	<section class="panel" aria-labelledby="chk-h" data-testid="series-checks">
		<div class="panel-head">
			<h2 id="chk-h">Data checks</h2>
			<span class="muted small">Negative values, outliers, flat stretches, catchment rain that looks missing but reads 0, and changes in its ratio to CHIRPS. Runs list the same checks as warnings.</span>
		</div>
		{#if checks.length}
			<ul class="checks">
				{#each checks as c (c.id)}
					<li>
						<span class="badge badge-warn">{CHECK_LABEL[c.check.check]}</span>
						<strong>{c.series.name || kindLabel(c.series.kind)}</strong>
						<span class="muted">({kindLabel(c.series.kind)})</span>:
						{c.check.text.slice(c.check.text.indexOf(':') + 1).trim()}
					</li>
				{/each}
			</ul>
		{:else}
			<p class="muted small">No negative values, outliers, flat stretches, suspicious zero rain or breaks against CHIRPS found in the loaded series.</p>
		{/if}
	</section>
{/if}

<div class="lower" class:with-upload={!readonly}>
	<!-- Upload comes first in reading order so on a phone it sits right under the
	     series table, not below the whole reference list; wide screens still show it
	     on the right (grid areas). -->
	{#if !readonly}
		<section class="panel upload" id="upload-csv" aria-labelledby="up-h">
			<div class="panel-head"><h2 id="up-h">Upload CSV</h2></div>
			<UploadForm {projectId} {list} onuploaded={uploaded} />
		</section>
	{/if}
	<section class="panel uses" aria-labelledby="use-h">
		<div class="panel-head"><h2 id="use-h">What the model uses</h2></div>
		<dl class="roles">
			{#each KIND_OPTIONS as o (o.value)}
				{@const r = KIND_ROLES[o.value]}
				{@const have = list.some((s) => s.kind === o.value)}
				<div>
					<dt>{o.label} <HelpTip key={`series.${o.value}`} /> {#if have}<span class="have">✓ loaded</span>{/if}</dt>
					<dd>{r?.help}</dd>
				</div>
			{/each}
		</dl>
		<p class="muted small">
			A run needs at least one rainfall series; its period is the span of those series unless Settings sets one.
			With several series of one kind, the first by name is used.
		</p>
	</section>
</div>

{#if previewMounted}
	<Lazy load={loadPreviewDialog}>
		{#snippet children(SeriesPreviewDialog)}
			<SeriesPreviewDialog bind:open={previewOpen} {list} {values} {settings} focusSeriesId={previewFocusSeriesId} onRetry={loadValues} />
		{/snippet}
	</Lazy>
{/if}

<style>
	.small {
		font-size: 0.8rem;
	}
	.u {
		font-weight: 400;
		color: var(--text-muted);
	}
	.series th[scope='row'] {
		min-width: 190px;
	}
	.kind {
		display: block;
		font-weight: 600;
	}
	.nm {
		display: block;
		font-weight: 400;
		color: var(--text-2);
		font-size: 0.82rem;
	}
	.role {
		display: inline-block;
		margin-top: 0.15rem;
		font-size: 0.7rem;
		font-weight: 600;
		padding: 0 0.4rem;
		border-radius: 999px;
		background: var(--accent-soft);
		color: var(--accent);
		cursor: help;
	}
	.role.unused {
		background: var(--surface-2);
		color: var(--text-muted);
	}
	.period {
		font-size: 0.82rem;
		text-align: left;
	}
	.upto .num {
		display: block;
		text-align: left;
	}
	.age {
		font-size: 0.75rem;
		color: var(--text-muted);
	}
	.age.stale {
		color: var(--warning);
		font-weight: 600;
	}
	.warn {
		color: var(--warning);
		font-weight: 600;
	}
	.cov {
		min-width: 150px;
		width: 22%;
	}
	.range {
		display: flex;
		justify-content: space-between;
		font-size: 0.7rem;
		color: var(--text-muted);
		font-variant-numeric: tabular-nums;
	}
	.strip-ph {
		display: block;
		height: 14px;
		margin-bottom: 1rem;
		border-radius: 2px;
		background: var(--surface-2);
	}
	tr.pick {
		cursor: pointer;
	}
	tr.pick:hover {
		background: var(--surface-2);
	}
	tr.selected,
	tr.selected:hover {
		background: var(--accent-soft);
	}
	.act {
		text-align: right;
		white-space: nowrap;
	}
	.acts {
		display: flex;
		gap: 0.3rem;
		justify-content: flex-end;
		align-items: center;
	}
	.key {
		margin: 0.5rem 0 0;
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.3rem;
	}
	.sw {
		display: inline-block;
		width: 10px;
		height: 10px;
		border-radius: 2px;
		margin-left: 0.4rem;
	}
	.sw.full {
		background: var(--brand-outlet);
		margin-left: 0;
	}
	.sw.part {
		background: color-mix(in srgb, var(--warning) 70%, transparent);
	}
	.sw.none {
		background: color-mix(in srgb, var(--danger) 55%, transparent);
	}
	.chart-ph {
		height: 380px;
		display: flex;
		align-items: center;
		justify-content: center;
		color: var(--text-muted);
	}
	.checks {
		margin: 0;
		padding-left: 1.1rem;
		display: grid;
		gap: 0.35rem;
		font-size: 0.85rem;
	}
	.checks .badge {
		text-transform: none;
		margin-right: 0.25rem;
	}
	.lower {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 1rem;
		align-items: start;
	}
	@media (min-width: 1001px) {
		.lower.with-upload {
			grid-template-columns: minmax(0, 1fr) minmax(0, 420px);
			grid-template-areas: 'uses upload';
		}
		.lower.with-upload .uses {
			grid-area: uses;
		}
		.lower.with-upload .upload {
			grid-area: upload;
		}
	}
	/* Phone: each series row becomes a card, so nothing hides behind a sideways scroll. */
	@media (max-width: 640px) {
		.series,
		.series tbody {
			display: block;
		}
		.series thead {
			position: absolute;
			width: 1px;
			height: 1px;
			overflow: hidden;
			clip: rect(0 0 0 0);
			white-space: nowrap;
		}
		.series tr.pick {
			display: grid;
			grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
			gap: 0.5rem 0.75rem;
			padding: 0.75rem;
			border-bottom: 1px solid var(--border);
		}
		.series tr.pick:last-child {
			border-bottom: 0;
		}
		.series tr.pick > th,
		.series tr.pick > td {
			display: block;
			padding: 0;
			border: 0;
			min-width: 0;
			width: auto;
			text-align: left;
		}
		.series th[scope='row'],
		.series td.cov,
		.series td.act {
			grid-column: 1 / -1;
		}
		/* The column header, as a visible label; silent to screen readers, which get the real header. */
		.series td[data-label]::before {
			content: attr(data-label) / '';
			display: block;
			font-size: 0.7rem;
			font-weight: 600;
			color: var(--text-muted);
		}
		.series td.act {
			white-space: normal;
		}
		.series .acts {
			flex-wrap: wrap;
			justify-content: flex-start;
		}
	}
	.roles {
		margin: 0 0 0.5rem;
		display: grid;
		gap: 0.5rem;
	}
	.roles dt {
		font-weight: 600;
		font-size: 0.875rem;
	}
	.roles dd {
		margin: 0.1rem 0 0;
		font-size: 0.82rem;
		color: var(--text-2);
	}
	.have {
		font-size: 0.72rem;
		font-weight: 600;
		color: var(--success);
		margin-left: 0.3rem;
	}
</style>
