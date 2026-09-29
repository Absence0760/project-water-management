<script module lang="ts">
	const loadPreviewDialog = () => import('./SeriesPreviewDialog.svelte');
</script>

<script lang="ts">
	// Data (issue #17, option A): the input series, freshness first. The
	// section header carries the title, the count and "N behind" (the same
	// count as the sidebar's badge), Preview all data and Add data. The table
	// lists the series behind first (series/freshness.ts `freshnessOrder`,
	// the badge's own rule), then those a run reads, then the rest; picking a
	// row charts it (`series=<id>`, so Back returns to the one before). On a
	// big enough window the table and the chart are exactly the height left
	// (the Dams page's measure): the table scrolls inside its box and the
	// chart fills the rest. The checks, the upload form and the reference
	// follow below.
	import { onMount, untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { fillHeader } from '$lib/components/workspace/headerSlot.svelte';
	import { withParam, withoutParam } from '$lib/workspace/overlays';
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
		resolveChirpsFitPeriod,
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
	import { asksFreeProvenance, asksProvenance, CHIRPS_CHOICES, describeProvenance, provenanceFields, rebuildingNote, seriesProvenance } from '$lib/series/provenance';
	import { coverageBins, coverageStats, daysBetween, describeAge, mergePreview, type Daily } from './coverage';
	import AgreementTable from './AgreementTable.svelte';
	import CoverageStrip from './CoverageStrip.svelte';
	import DoubleMassPanel from './DoubleMassPanel.svelte';
	import UploadForm from './UploadForm.svelte';
	import type { UploadResult } from './upload';
	import { gaugeRecordsInUse, isPeriodOnly, KIND_ROLES, rainSourceKinds, seriesInUse, SITED_KINDS } from './roles';
	import { freshness, freshnessOrder, isRecordedRain, STALE_DAYS } from './freshness';
	import { cachedValues, cacheValues } from './valuesCache';
	import { zeroRainShading } from './zeroRain';
	import { dataAnchor, dataNavGroups } from './sections';
	import SectionNav from '$lib/components/common/SectionNav.svelte';
	import { holdAnchor } from '$lib/help/anchor';

	let {
		projectId,
		readonly,
		initial = null,
		runs = null,
		settings = null,
		gauges = [],
		onSeriesChange
	}: {
		projectId: string;
		readonly: boolean;
		/** Already-loaded list (the page's), so the first frame has the final layout. */
		initial?: SeriesMeta[] | null;
		runs?: RunMeta[] | null;
		/** The project's settings, the same object the Settings tab gets; null only before the page's own load finishes. */
		settings?: ProjectSettings | null;
		/** The model's gauge nodes above the outlet: a flow record can be attached to one (084_gauge_records, engine ≥ 1.4.0). */
		gauges?: readonly { id: string; name: string }[];
		onSeriesChange?: (list: SeriesMeta[]) => void;
	} = $props();

	/** Gauge-vs-logger thresholds; null = the engine defaults. */
	const dataQuality = $derived(settings?.dataQuality ?? null);
	// The project's data-quality limits; resolveDataQuality falls back to the defaults for anything missing or invalid, like a run does.
	const dq = $derived(resolveDataQuality(dataQuality));
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

	// The page's list changed without us (the header's Add data dialog uploaded a file): show it.
	// Our own changes come back through onSeriesChange as this same array, so they are skipped.
	$effect(() => {
		const i = initial;
		untrack(() => {
			if (!i || i === list) return;
			list = i;
			void loadValues();
		});
	});

	// The charted series is in the URL (`series=<id>`); without one (or a stale one), the default.
	const seriesParam = $derived(page.url.searchParams.get('series'));
	const selectedId = $derived(
		seriesParam && list.some((s) => s.id === seriesParam) ? seriesParam : list.length ? pickDefault(list) : null
	);
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
		choose(id);
	}
	/** Chart a series: a URL change, so it can be shared and Back returns; stacked, the chart comes into view. */
	function choose(id: string, replaceState = false) {
		if (id === selectedId && seriesParam === id) return;
		void goto(withParam(page.url, 'series', id), { noScroll: true, keepFocus: true, replaceState }).then(() => {
			if (!fit && !replaceState) chartEl?.scrollIntoView({ block: 'nearest' });
		});
	}
	let flowLog = $state(false);

	const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
	const endDate = (s: { startDate: string; length: number }) => fromEpochDay(toEpochDay(s.startDate) + s.length - 1);
	const inUse = $derived(seriesInUse(list, rainSourceKinds(settings?.rainSource)));
	const gaugeInUse = $derived(gaugeRecordsInUse(list, gauges));
	const siteName = (id: string) => gauges.find((g) => g.id === id)?.name ?? 'a node no longer in the model';
	const latestRun = $derived(runs?.[0] ?? null);
	// Depth series in mm/day: rain, and daily A-pan evaporation (issue #45).
	const isRain = (k: string) => k.endsWith('_mm');

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
				const hit = cachedValues(projectId, s);
				if (hit) {
					values = { ...values, [s.id]: hit };
					return;
				}
				try {
					const v = cacheValues(projectId, await api.series.get(projectId, s.id));
					values = { ...values, [s.id]: v };
				} catch {
					/* coverage cells stay "–" */
				}
			})
		);
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
	// Recorded rain drives a run, so it is what "up to" means (series/freshness.ts).
	const rainUpTo = $derived(list.filter((s) => isRecordedRain(s.kind)).reduce((m, s) => (endDate(s) > m ? endDate(s) : m), ''));
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
		// The CHIRPS fit period too (engine ≥ 0.29.0): accumulations are judged with each range's factors, as a run judges them.
		const fit = { fitPeriod: resolveChirpsFitPeriod(settings?.chirpsFitPeriod, []), dq };
		return v ? zeroRainShading(v, resolveZeroRain(zeroRainRuns, []), (h && values[h.id]) || null, settings?.chirpsBiasCorrection ?? 'monthly', fit) : null;
	});

	// Gauge vs logger, when both records exist.
	const agreement = $derived.by(() => {
		const o = first('flow_observed_m3s');
		const l = first('flow_logger_m3s');
		const vo = o && values[o.id];
		const vl = l && values[l.id];
		return vo && vl ? observedAgreement({ flow_observed_m3s: vo, flow_logger_m3s: vl }, agreementOptions(dq)) : null;
	});

	// Catchment rain vs CHIRPS, when both exist: water years far below CHIRPS (zeros that are really missing data?).
	const lowVsChirps = $derived.by(() => {
		const c = first('rain_catchment_mm');
		const h = first('rain_chirps_mm');
		const vc = c && values[c.id];
		const vh = h && values[h.id];
		const check = vc && vh ? rainVsChirpsCheck(rainVsChirps({ rain_catchment_mm: vc, rain_chirps_mm: vh }, dq)) : null;
		return check ? { id: `${c!.id}-${check.check}`, series: c!, check } : null;
	});

	// Double mass of catchment rain against CHIRPS (engine ≥ 0.18.0), on the days a run would use: the zero-rain settings decide which are suspect.
	const dm = $derived.by(() => {
		const c = first('rain_catchment_mm');
		const h = first('rain_chirps_mm');
		const vc = c && values[c.id];
		const vh = h && values[h.id];
		return vc && vh ? { series: c!, result: doubleMass({ rain_catchment_mm: vc, rain_chirps_mm: vh }, resolveZeroRain(zeroRainRuns, []), dq) } : null;
	});
	const dmCheck = $derived.by(() => {
		const fp = resolveChirpsFitPeriod(settings?.chirpsFitPeriod, []);
		const check = dm ? doubleMassCheck(dm.result, Array.isArray(fp) ? 'ranges' : fp) : null;
		return check ? { id: `${dm!.series.id}-${check.check}`, series: dm!.series, check } : null;
	});

	// Negative values, outliers, flat-lines and zero runs per series (the checks a run reports as warnings).
	const checks = $derived([
		...list.flatMap((s) => {
			const v = values[s.id];
			if (!v || !(SERIES_KINDS as readonly string[]).includes(s.kind)) return [];
			// The catchment rain's zero-run check reads CHIRPS when the CHIRPS check is on, as a run does.
			const h = s.kind === 'rain_catchment_mm' ? first('rain_chirps_mm') : null;
			return checkSeries(s.kind as SeriesKind, v, dq, (h && values[h.id]) || null).map((c) => ({ id: `${s.id}-${c.check}`, series: s, check: c }));
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
			// The deleted series was charted: back to the default, without a history entry for it.
			if (seriesParam === s.id) void goto(withoutParam(page.url, 'series'), { noScroll: true, keepFocus: true, replaceState: true });
		} catch (e) {
			actionError = msg(e);
		}
	}

	/** Say which CHIRPS product and version a series holds (issue #40 part c); its values are untouched. */
	async function relabel(s: SeriesMeta, key: string) {
		actionError = null;
		const f = provenanceFields(key);
		try {
			const meta = await api.series.label(projectId, s.id, f.product, f.productVersion);
			list = list.map((x) => (x.id === s.id ? { ...x, product: meta.product, productVersion: meta.productVersion } : x));
			onSeriesChange?.(list);
		} catch (e) {
			actionError = msg(e);
		}
	}

	/** Move a flow record to a gauge inside the network, or back to the outlet (''). */
	async function moveSite(s: SeriesMeta, nodeId: string) {
		actionError = null;
		try {
			const meta = await api.series.site(projectId, s.id, nodeId || null);
			list = list.map((x) => (x.id === s.id ? { ...x, siteNodeId: meta.siteNodeId ?? null } : x));
			onSeriesChange?.(list);
		} catch (e) {
			actionError = msg(e);
		}
	}

	async function uploaded(r: UploadResult) {
		values = Object.fromEntries(Object.entries(values).filter(([id]) => id !== r.meta.id));
		await load();
		choose(r.meta.id, true);
	}

	const typical = (s: SeriesMeta) => {
		const st = stats[s.id];
		if (!st) return '…';
		if (isRain(s.kind)) return st.meanAnnualMm === null ? '–' : `${fmtNum(st.meanAnnualMm)} mm/a`;
		return st.meanDaily === null ? '–' : `${fmtNum(st.meanDaily, st.meanDaily < 1 ? 3 : 2)} ${s.unit}`;
	};

	// --- freshness first: the badge's "behind" (freshness.ts), the rows in that order ---
	const fresh = $derived(freshness(list, today));
	const behindAge = $derived(new Map((fresh?.behind ?? []).map((b) => [b.id, b.age])));
	const rows = $derived(freshnessOrder(list, fresh?.behind ?? [], inUse));
	const behindText = $derived(
		behindAge.size ? `${behindAge.size} behind (more than ${STALE_DAYS} days old)` : ''
	);

	// --- the table and the chart fit the window on a big enough page (the Dams page's measure) ---
	let pageW = $state(0);
	let innerH = $state(0);
	// Below ~720 px high the table would get only a row or two; the page scrolls as before instead.
	const fit = $derived(pageW >= 720 && innerH >= 720 && list.length > 0);
	let chartEl: HTMLElement | undefined = $state();
	let firstEl: HTMLDivElement | undefined = $state();
	let firstTop = $state(0);
	$effect(() => {
		if (!firstEl) return;
		const el = firstEl;
		const measure = () => (firstTop = el.getBoundingClientRect().top + window.scrollY);
		measure();
		const ro = new ResizeObserver(measure);
		ro.observe(document.body);
		return () => ro.disconnect();
	});
	// Filling: the plot gets what the slot leaves after the chart's own head, legend and caption.
	const FIXED_H = 320;
	const MIN_H = 150;
	let slot: HTMLDivElement | undefined = $state();
	let fig: HTMLDivElement | undefined = $state();
	let fillH = $state(FIXED_H);
	$effect(() => {
		if (!fit || !slot || !fig) return;
		const s = slot;
		const f = fig;
		const measure = () => {
			const wrap = f.querySelector<HTMLElement>('.u-wrap');
			if (!wrap) return;
			const target = Math.max(MIN_H, Math.floor(s.clientHeight - (f.offsetHeight - wrap.offsetHeight)));
			if (Math.abs(target - fillH) > 2) fillH = target;
		};
		measure();
		const ro = new ResizeObserver(measure);
		ro.observe(s);
		ro.observe(f);
		return () => ro.disconnect();
	});
	const chartH = $derived(fit ? fillH : FIXED_H);

	// The section header (workspace/SectionHeader) carries the title and the count; the tab adds Preview all data.
	$effect(() => fillHeader({ actions: headerActions }));

	// The in-page menu (common/SectionNav): only the panels drawn, as each one's condition below.
	const hasChecks = $derived(list.length > 0 && Object.keys(values).length > 0);
	const navGroups = $derived(
		dataNavGroups({ chart: !!viewing, agreement: !!agreement, doubleMass: !!dm?.result, checks: hasChecks, upload: !readonly })
	);
	// A link to a panel (`?tab=series#data-checks`, the menu's own links reloaded): the tab is a lazy
	// chunk and most panels wait for the series, so land on it once drawn and hold it while the page
	// settles (as Settings, Runs and River & reserve do), with focus on its heading.
	onMount(() => {
		const hash = page.url.hash.slice(1);
		if (!dataAnchor(hash)) return;
		let release = () => {};
		const land = () => {
			const el = document.getElementById(hash);
			if (!el) return false;
			release = holdAnchor(el);
			const heading = el.querySelector<HTMLElement>('h2, h3');
			if (heading) {
				if (!heading.hasAttribute('tabindex')) heading.tabIndex = -1;
				heading.focus({ preventScroll: true });
			}
			return true;
		};
		if (land()) return () => release();
		const mo = new MutationObserver(() => land() && mo.disconnect());
		mo.observe(document.body, { childList: true, subtree: true });
		return () => {
			mo.disconnect();
			release();
		};
	});
</script>

<svelte:window bind:innerHeight={innerH} />

{#snippet headerActions()}
	{#if list.length}
		<button type="button" class="btn" onclick={openPreviewAll} onpointerenter={warmPreview} onfocus={warmPreview}>Preview all data</button>
	{/if}
{/snippet}

<!-- The notices: one slim line each under the section header, as the page's own. -->
{#if actionError || (newerThanRun.length && latestRun) || rebuildingNote(list, (s) => s.name || kindLabel(s.kind))}
	<div class="notes">
		{#if actionError}<p class="note err" role="alert">{actionError}</p>{/if}
		{#if newerThanRun.length && latestRun}
			<p class="note note-info" role="status">
				New data since the latest run: {newerThanRun.map((s) => s.name || kindLabel(s.kind)).join(', ')} now run{newerThanRun.length === 1 ? 's' : ''}
				to {newerThanRun.reduce((m, s) => (endDate(s) > m ? endDate(s) : m), '')}, but “{latestRun.label || 'the latest run'}” ends {latestRun.endDate}.
				<a href="?tab=runs">Re-run the model</a> to include it.
			</p>
		{/if}
		{#if rebuildingNote(list, (s) => s.name || kindLabel(s.kind))}
			<p class="note note-info" role="status" data-testid="rebuilding-note">{rebuildingNote(list, (s) => s.name || kindLabel(s.kind))}</p>
		{/if}
	</div>
{/if}

<!-- In-page menu: at the tab's top level, not in .data-page, so it sticks down the panels below the chart. -->
{#if list.length}<SectionNav groups={navGroups} label="Data sections" />{/if}

<div class="data-page" bind:clientWidth={pageW}>
<div class="first" class:fit bind:this={firstEl} style:--first-top="{firstTop}px">
<section class="panel list-panel" id="data-series" aria-labelledby="ser-h">
	<div class="panel-head">
		<h2 id="ser-h">Input time series</h2>
		{#if list.length}
			<span class="muted small" data-testid="series-summary"
				>Daily values · {list.length} series{#if behindText}{' · '}<span class="behind-text">{behindText}</span>{/if}{rainUpTo ? ` · recorded rain up to ${rainUpTo} (${describeAge(daysBetween(rainUpTo, today))})` : ''}</span
			>
		{/if}
	</div>
	<LoadState
		{loading}
		error={loadError}
		retry={load}
		empty={list.length === 0}
		emptyText={readonly
			? 'No time series yet. An editor can upload daily rainfall and observed flow as CSV files.'
			: 'No time series yet. Upload daily rainfall (and, to calibrate, observed flow at the outflow gauge) as CSV files with Add data or the Upload CSV form below.'}
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
						<th scope="col" role="columnheader">Data up to</th>
						<th scope="col" role="columnheader">Period</th>
						<th scope="col" role="columnheader" class="num">Missing<br /><span class="u">% of days</span></th>
						<th scope="col" role="columnheader" class="num">Typical<br /><span class="u">mean</span></th>
						<th scope="col" role="columnheader" class="cov">Coverage by year</th>
						<th scope="col" role="columnheader"><span class="visually-hidden">Actions</span></th>
					</tr>
				</thead>
				<tbody role="rowgroup">
					{#each rows as s (s.id)}
						{@const st = stats[s.id]}
						{@const end = endDate(s)}
						{@const age = daysBetween(st?.lastValueDate ?? end, today)}
						{@const role = KIND_ROLES[s.kind]}
						{@const behind = behindAge.get(s.id)}
						<!-- Pointer shortcut only; the View button is the accessible control. -->
						<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
						<tr role="row" class="pick" class:selected={s.id === selectedId} class:is-behind={behind !== undefined} data-series={s.id} onclick={(e) => rowClick(e, s.id)}>
							<th scope="row" role="rowheader">
								<span class="kind">{kindLabel(s.kind)}</span>
								<span class="nm">{s.name || '–'} <span class="u">({s.unit})</span></span>
								{#if s.rebuilding}
									<span class="rebuilding" data-testid="series-rebuilding" title="A data feed is backfilling a replacement; this series stays as it is until it completes">Being replaced</span>
								{/if}
								{#if asksProvenance(s.kind)}
									{#if readonly}
										<span class="prov" data-testid="series-provenance">{describeProvenance(s)}</span>
									{:else}
										<select
											class="prov"
											data-testid="series-provenance"
											aria-label="Product and version of {s.name || kindLabel(s.kind)}"
											value={s.product && s.productVersion ? `${s.product}/${s.productVersion}` : ''}
											onchange={(e) => relabel(s, e.currentTarget.value)}
										>
											<option value="">Version not recorded</option>
											{#each CHIRPS_CHOICES as c (c.value)}<option value={c.value}>{c.label}</option>{/each}
										</select>
									{/if}
								{:else if asksFreeProvenance(s.kind) && seriesProvenance(s)}
									<span class="prov" data-testid="series-provenance">{describeProvenance(s)}</span>
								{/if}
								{#if SITED_KINDS.has(s.kind) && (gauges.length || s.siteNodeId)}
									{#if readonly}
										<span class="prov" data-testid="series-site">{s.siteNodeId ? `At gauge ${siteName(s.siteNodeId)}` : 'At the outlet'}</span>
									{:else}
										<select
											class="prov"
											data-testid="series-site"
											aria-label="Where {s.name || kindLabel(s.kind)} was measured"
											value={s.siteNodeId ?? ''}
											onchange={(e) => moveSite(s, e.currentTarget.value)}
										>
											<option value="">At the outlet</option>
											{#each gauges as g (g.id)}<option value={g.id}>At gauge {g.name}</option>{/each}
											{#if s.siteNodeId && !gauges.some((g) => g.id === s.siteNodeId)}
												<option value={s.siteNodeId} disabled>At a node no longer in the model</option>
											{/if}
										</select>
									{/if}
								{/if}
								{#if s.dayBoundary}
									<span class="prov" data-testid="series-day-boundary" title="Added up from sub-daily readings in {s.dayBoundary}–{s.dayBoundary} windows"
										>{s.dayBoundary} day</span
									>
								{/if}
								{#if role}
									<span class="role" class:unused={!inUse.has(s.id) && !gaugeInUse.has(s.id)} title={s.siteNodeId ? 'Checked against the simulated flow at its gauge (the Plausibility checks on Runs & results); calibration and the EWR test use the outlet’s records.' : role.help}>
										{s.siteNodeId
											? gaugeInUse.has(s.id)
												? 'Gauge record (checks only)'
												: gauges.some((g) => g.id === s.siteNodeId)
													? 'Not used (another record of this kind is at this gauge)'
													: 'Not used: its gauge is no longer in the model'
											: inUse.has(s.id) || s.kind === 'flow_reference_m3s'
											? role.role
											: s.kind === 'flow_logger_m3s' && !list.some((x) => x.kind === s.kind && inUse.has(x.id))
												? 'Calibration if chosen in settings'
												: isPeriodOnly(s.kind) && !list.some((x) => x.kind === s.kind && inUse.has(x.id))
													? 'Not used: no rain-source period names it'
													: 'Not used (another series of this kind is)'}
									</span>
								{/if}
							</th>
							<td role="cell" class="upto" data-label="Data up to">
								<span class="num">{st?.lastValueDate ?? end}</span>
								<span class="age">{describeAge(age)}</span>
								{#if behind !== undefined}
									<span class="behind" data-testid="series-behind" title="A run reads this series and it ends {behind} days ago, more than {STALE_DAYS}: the Data badge counts it"
										>Behind</span
									>
								{/if}
							</td>
							<td role="cell" class="num period" data-label="Period">{s.startDate} →<br />{end}</td>
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
								<button type="button" class="btn btn-sm" aria-pressed={s.id === selectedId} onclick={() => choose(s.id)}>View</button>
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
			Rainfall "typical" = mean annual total; flow = mean daily flow. <span class="behind">Behind</span> a series a run reads, more than {STALE_DAYS} days old.
		</p>
	</LoadState>
</section>

{#if viewing}
	<section class="panel chart-panel" id="data-chart" aria-labelledby="chart-h" bind:this={chartEl}>
		<h2 id="chart-h" class="visually-hidden">Series chart</h2>
		{#if values[viewing.id]}
			<div class="slot" bind:this={slot}>
				<div bind:this={fig}>
					<LineChart
						title="{kindLabel(viewing.kind)}{viewing.name ? ` · ${viewing.name}` : ''}"
						unit={isRain(viewing.kind) ? 'mm/day' : viewing.unit}
						height={chartH}
						series={[{ label: viewing.name || kindLabel(viewing.kind), startDate: values[viewing.id]!.startDate, values: values[viewing.id]!.values }]}
						logToggle={!isRain(viewing.kind)}
						bind:log={flowLog}
						recentDays={3 * 365}
						recentLabel="Last 3 years"
						shade={shading?.ranges ?? []}
						caption={shading?.caption ?? undefined}
					/>
				</div>
			</div>
		{:else}
			<div class="chart-ph" role="status">Loading series…</div>
		{/if}
	</section>
{/if}
</div>
</div>

{#if agreement}
	<section class="panel" id="data-agreement" aria-label="Gauge vs logger agreement">
		<AgreementTable {agreement} headingLevel={2} />
	</section>
{/if}

{#if dm?.result}
	<div id="data-double-mass"><DoubleMassPanel dm={dm.result} /></div>
{/if}

{#if hasChecks}
	<section class="panel" id="data-checks" aria-labelledby="chk-h" data-testid="series-checks">
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
	<section class="panel uses" id="data-uses" aria-labelledby="use-h">
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
	.rebuilding {
		display: inline-block;
		margin-top: 0.15rem;
		font-size: 0.7rem;
		font-weight: 600;
		padding: 0 0.4rem;
		border-radius: 999px;
		background: var(--warning-soft);
		color: var(--warning);
	}
	.prov {
		display: block;
		margin-top: 0.15rem;
		font-size: 0.75rem;
		max-width: 100%;
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
	/* "Behind": the Data badge's rule (freshness.ts), in words as well as colour. */
	.behind {
		display: inline-block;
		margin-left: 0.3rem;
		font-size: 0.7rem;
		font-weight: 600;
		padding: 0 0.4rem;
		border-radius: 999px;
		background: var(--warning-soft);
		color: var(--warning);
	}
	.key .behind {
		margin-left: 0.4rem;
	}
	.behind-text {
		color: var(--warning);
		font-weight: 600;
	}
	@media (min-width: 641px) {
		tr.is-behind > th[scope='row'] {
			box-shadow: inset 3px 0 0 var(--warning);
		}
	}
	.notes {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 0.4rem;
		margin: 0 0 0.75rem;
		font-size: 0.85rem;
	}
	.note {
		margin: 0;
		padding: 0.2rem 0.4rem 0.2rem 0.6rem;
		border-left: 3px solid var(--accent);
		border-radius: var(--radius-sm);
		background: var(--surface);
		color: var(--text-2);
	}
	.note-info {
		background: var(--accent-soft);
		color: var(--text);
	}
	.note.err {
		border-left-color: var(--danger);
		color: var(--danger);
	}
	.data-page {
		container: data-page / inline-size;
	}
	.first {
		display: flex;
		flex-direction: column;
	}
	/* Big enough: the table and the chart are the height left in the window (less the save bar); the table's rows
	   scroll inside its box, the chart takes the rest. */
	.first.fit {
		height: max(540px, calc(100vh - var(--first-top, 0px) - var(--dock-h, 0px) - 1rem));
		gap: 1rem;
		margin-bottom: 1rem;
	}
	.fit > .panel {
		margin: 0;
	}
	.fit .list-panel {
		flex: 0 1 auto;
		min-height: 11rem;
		max-height: 55%;
		display: flex;
		flex-direction: column;
	}
	.fit .list-panel :global(.table-wrap) {
		flex: 1 1 auto;
		min-height: 0;
		max-height: none;
	}
	.fit .chart-panel {
		flex: 1 1 0;
		min-height: 16rem;
		display: flex;
		flex-direction: column;
	}
	.fit .slot {
		flex: 1 1 0;
		min-height: 0;
		overflow: hidden;
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
		.series tr.pick.is-behind {
			box-shadow: inset 3px 0 0 var(--warning);
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
