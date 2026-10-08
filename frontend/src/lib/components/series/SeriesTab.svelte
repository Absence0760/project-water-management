<script module lang="ts">
	const loadPreviewDialog = () => import('./SeriesPreviewDialog.svelte');
</script>

<script lang="ts">
	// Data (issue #17, option A): the input series, freshness first. The
	// section header carries the title, the count and "N behind" (the same
	// count as the sidebar's badge), Preview all data and Add data. The table
	// lists the series behind first (series/freshness.ts `freshnessOrder`,
	// the badge's own rule), then those a run reads, then the rest; picking a
	// row charts it (`series=<id>`, so Back returns to the one before). The
	// page flows in the window's one scroll: the first few rows show, the rest
	// behind "Show all N series" (series/fold.ts; the charted row always
	// shows), and nothing scrolls inside itself. The chart follows the table,
	// and a pick brings it into view. The checks and the reference follow.
	// Uploading is the header's Add data (series/AddDataDialog.svelte): the
	// page charts what it uploaded (`series=`), and the empty state's button
	// opens the same dialog (`onadddata`).
	import { confirmDialog } from '$lib/components/common/confirm.svelte';
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
		isGapFillKind,
		observedAgreement,
		originLabel,
		recordFlowFlags,
		resolveFlowGapFill,
		resolveQualityFlags,
		seriesOrigin,
		rainVsChirps,
		rainVsChirpsCheck,
		resolveDataQuality,
		resolveChirpsFitPeriod,
		resolveZeroRain,
		SERIES_KINDS,
		toEpochDay,
		type CalibrationFlowKind,
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
	import { fmtNum } from '$lib/format/number';
	import { projectToday } from '$lib/components/projects/freshness';
	import { CsvError, parseSeriesCsv, type ParsedSeries } from '$lib/series/csv';
	import { defaultUnit, KIND_OPTIONS, kindLabel } from '$lib/series/kinds';
	import { asksFreeProvenance, asksProvenance, CHIRPS_CHOICES, describeProvenance, feedMark, provenanceFields, rebuildingNote, seriesProvenance } from '$lib/series/provenance';
	import { coverageBins, coverageStats, daysBetween, mergePreview, type Daily } from './coverage';
	import { agoText } from '$lib/format/age';
	import AgreementTable from './AgreementTable.svelte';
	import CoverageStrip from './CoverageStrip.svelte';
	import DoubleMassPanel from './DoubleMassPanel.svelte';
	import { gaugeRecordsInUse, KIND_ROLES, rainSourceKinds, roleBadge, seriesInUse, SITED_KINDS } from './roles';
	import { freshness, freshnessOrder, STALE_DAYS } from './freshness';
	import { cachedValues, cacheValues } from './valuesCache';
	import { zeroRainShading } from './zeroRain';
	import { flowFillShading } from './flowFill';
	import { flowFlagLanes } from '$lib/calibration/flowFlags';
	import { dataAnchor, dataNavGroups, retiredDataAnchor } from './sections';
	import { foldList } from '$lib/components/common/fold';
	import SectionNav from '$lib/components/common/SectionNav.svelte';
	import { holdAnchor } from '$lib/help/anchor';

	let {
		projectId,
		readonly,
		initial = null,
		settings = null,
		gauges = [],
		timeZone = null,
		onSeriesChange,
		onadddata
	}: {
		projectId: string;
		readonly: boolean;
		/** Already-loaded list (the page's), so the first frame has the final layout. */
		initial?: SeriesMeta[] | null;
		/** Not read: "New data since the latest run" is the page's own notice (series/freshness.ts `newDataSinceRun`), on this tab as on every other. */
		runs?: RunMeta[] | null;
		/** The project's settings, the same object the Settings tab gets; null only before the page's own load finishes. */
		settings?: ProjectSettings | null;
		/** The model's gauge nodes above the outlet: a flow record can be attached to one (084_gauge_records, engine ≥ 1.4.0). */
		gauges?: readonly { id: string; name: string }[];
		/** The project's time zone: data ages count to its calendar date, as in the header and on the project list (issue #137). */
		timeZone?: string | null;
		onSeriesChange?: (list: SeriesMeta[]) => void;
		/** Opens the page's Add data dialog (the header's button): the empty state's action, and the retired `#upload-csv` link. */
		onadddata?: () => void;
	} = $props();

	/** Gauge-vs-logger thresholds; null = the engine defaults. */
	const dataQuality = $derived(settings?.dataQuality ?? null);
	// The project's data-quality limits; resolveDataQuality falls back to the defaults for anything missing or invalid, like a run does.
	const dq = $derived(resolveDataQuality(dataQuality));
	const zeroRainRuns = $derived(settings?.zeroRainRuns ?? null);

	let list = $state<SeriesMeta[]>(untrack(() => initial ?? []));
	let loading = $state(untrack(() => initial === null));
	let loadError = $state<string | null>(null);
	// A refresh that failed while a list was already drawn: a slim note with Try again; the table stays.
	let refreshError = $state<string | null>(null);
	let actionError = $state<string | null>(null);

	// Full values per series (for coverage and the chart). Input series are few
	// (one per kind, a handful of names), so fetching them all is cheap.
	// $state.raw: 16k-value daily arrays must not be wrapped in deep reactive
	// proxies — reading them element by element froze the Runs tab. Replace, never mutate.
	let values = $state.raw<Record<string, Daily>>({});
	// Series whose values failed to load, with the error: the preview says so and offers Try again
	// (without it, a preview whose every series failed showed "Loading…" for ever).
	let valuesFailed = $state.raw<Record<string, string>>({});
	// The project's calendar date, as in the header and on the project list (projects/freshness.ts).
	const today = $derived(projectToday(timeZone));

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
	/** Chart a series: a URL change, so it can be shared and Back returns; the chart, under the table, comes into view. */
	function choose(id: string, replaceState = false) {
		if (id === selectedId && seriesParam === id) return;
		void goto(withParam(page.url, 'series', id), { noScroll: true, keepFocus: true, replaceState }).then(() => {
			if (!replaceState) showChart();
		});
	}
	/** Scroll the chart just into view (its foot to the window's, less the save bar) unless it already is. */
	function showChart() {
		const el = chartEl;
		if (!el) return;
		const r = el.getBoundingClientRect();
		const dock = parseFloat(getComputedStyle(el).getPropertyValue('--dock-h')) || 0;
		if (r.top >= 0 && r.bottom <= innerHeight - dock) return;
		const behavior = matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
		const room = innerHeight - dock;
		// Below the window (it sits under the table): its foot to the window's foot less the save bar, rounded up to a
		// whole pixel. scrollIntoView's `nearest` lands on a rounded offset, which on a fractional layout left the chart's
		// last half pixel under the window's edge. Taller than the window, or above it: its top to the header's foot.
		if (r.height <= room && r.top >= 0) window.scrollTo({ top: Math.ceil(scrollY + r.bottom - room), behavior });
		else el.scrollIntoView({ block: 'start', behavior });
	}
	let flowLog = $state(false);

	const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
	const endDate = (s: { startDate: string; length: number }) => fromEpochDay(toEpochDay(s.startDate) + s.length - 1);
	const inUse = $derived(seriesInUse(list, rainSourceKinds(settings?.rainSource)));
	const gaugeInUse = $derived(gaugeRecordsInUse(list, gauges));
	// The gauge calibration scores at (settings.calibrationSiteNodeId, engine ≥ 1.41.0); null = the outlet.
	const calibrationSite = $derived(settings?.calibrationSiteNodeId ?? null);
	const siteName = (id: string) => gauges.find((g) => g.id === id)?.name ?? 'a hydrological unit no longer in the model';
	const gaugeIds = $derived(new Set(gauges.map((g) => g.id)));
	// Depth series in mm/day: rain, and daily A-pan evaporation (issue #45).
	const isRain = (k: string) => k.endsWith('_mm');

	async function load() {
		if (!list.length) loading = true;
		loadError = null;
		refreshError = null;
		try {
			list = await api.series.list(projectId);
			onSeriesChange?.(list);
			void loadValues();
		} catch (e) {
			// With a list already drawn (the page's), keep it and say the refresh failed; else the error replaces the table.
			if (list.length) refreshError = msg(e);
			else loadError = msg(e);
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
				if (s.id in valuesFailed) {
					const rest = { ...valuesFailed };
					delete rest[s.id];
					valuesFailed = rest;
				}
				const hit = cachedValues(projectId, s);
				if (hit) {
					values = { ...values, [s.id]: hit };
					return;
				}
				try {
					const v = cacheValues(projectId, await api.series.get(projectId, s.id));
					values = { ...values, [s.id]: v };
				} catch (e) {
					// The coverage cells stay "–"; the preview shows the error with Try again.
					valuesFailed = { ...valuesFailed, [s.id]: msg(e) };
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

	// The series a run reads for a kind: the first of that kind by name, among the outlet's (a gauge's record,
	// 084_gauge_records, is read only at its gauge: seriesInUse and the backend's loadLiveInput skip it too).
	const first = (k: string) => [...list].filter((s) => s.kind === k && !s.siteNodeId).sort((a, b) => a.name.localeCompare(b.name))[0];

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

	// Days a run fills in an observed flow record (settings.flowGapFill, engine ≥ 1.23.0), shaded on the record
	// a run reads (the first of its kind by name), with the filled values as a line of their own.
	const flowShading = $derived.by(() => {
		if (!viewing || !isGapFillKind(viewing.kind) || viewing.id !== first(viewing.kind)?.id) return null;
		const v = values[viewing.id];
		if (!v) return null;
		const fill = resolveFlowGapFill(settings?.flowGapFill);
		const donorKind = fill[viewing.kind]?.donor;
		const d = donorKind ? first(donorKind) : undefined;
		return flowFillShading(viewing.kind, v, fill, (d && values[d.id]) || null);
	});

	// The per-day quality flags of a flow record Fit automatically can score (CR-18, engine ≥ 1.48.0): the classes it
	// reads (and a run stores as `observed_flow_quality` for the scored one), under the current settings, over the
	// whole stored record. An outlet record takes its gauged range and the gap fill; the calibration site's record
	// (a gauge inside the network) neither (recordFlowFlags). Another gauge's record is never scored: no flags.
	const flagLanes = $derived.by(() => {
		if (!viewing || !SITED_KINDS.has(viewing.kind)) return [];
		const kind = viewing.kind as CalibrationFlowKind;
		const sited = viewing.siteNodeId ?? null;
		if (sited ? sited !== calibrationSite || !gaugeInUse.has(viewing.id) : viewing.id !== first(kind)?.id) return [];
		const v = values[viewing.id];
		if (!v) return [];
		const qualityFlags = resolveQualityFlags(settings?.qualityFlags);
		const flags = recordFlowFlags({
			kind,
			series: v,
			start: toEpochDay(v.startDate),
			days: v.values.length,
			settings: { qualityFlags, dataQuality: dq },
			siteNodeId: sited,
			flowFill: flowShading ? { [kind]: flowShading } : null
		});
		return flowFlagLanes(flags, v.startDate, qualityFlags);
	});

	// The controls that save on change (CHIRPS product, where measured, source): each says Saving…, Saved or why
	// not beside itself, and a failed save puts the control back to the stored value (the one-way `value=` doesn't
	// change when the list doesn't, so Svelte would leave the unsaved choice showing).
	let saves = $state<Record<string, { state: 'saving' | 'saved' | 'error'; text?: string }>>({});
	const saveId = (s: SeriesMeta, field: string) => `save-${s.id}-${field}`;
	async function saveOnChange(key: string, el: HTMLInputElement | HTMLSelectElement, stored: string, save: () => Promise<void>) {
		saves = { ...saves, [key]: { state: 'saving' } };
		try {
			await save();
			saves = { ...saves, [key]: { state: 'saved' } };
		} catch (e) {
			el.value = stored;
			saves = { ...saves, [key]: { state: 'error', text: msg(e) } };
		}
	}
	const saveFailed = (key: string) => saves[key]?.state === 'error';

	/** Say where a series' values came from (107_series_source.sql); '' clears it. Its values are untouched. */
	function resource(s: SeriesMeta, el: HTMLInputElement) {
		const next = el.value.trim() || null;
		if (next === (s.source ?? null)) return;
		void saveOnChange(saveId(s, 'source'), el, s.source ?? '', async () => {
			const meta = await api.series.source(projectId, s.id, next);
			list = list.map((x) => (x.id === s.id ? { ...x, source: meta.source ?? null } : x));
			onSeriesChange?.(list);
		});
	}

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
		const ok = await confirmDialog({
			title: `Delete the series “${s.name || kindLabel(s.kind)}”?`,
			message: 'Runs already stored are not affected.',
			confirmLabel: 'Delete series',
			danger: true
		});
		if (!ok) return;
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

	const labelKey = (s: SeriesMeta) => (s.product && s.productVersion ? `${s.product}/${s.productVersion}` : '');
	/** Say which CHIRPS product and version a series holds (issue #40 part c); its values are untouched. */
	function relabel(s: SeriesMeta, el: HTMLSelectElement) {
		const f = provenanceFields(el.value);
		void saveOnChange(saveId(s, 'label'), el, labelKey(s), async () => {
			const meta = await api.series.label(projectId, s.id, f.product, f.productVersion);
			list = list.map((x) => (x.id === s.id ? { ...x, product: meta.product, productVersion: meta.productVersion } : x));
			onSeriesChange?.(list);
		});
	}

	/** Move a flow record to a gauge inside the network, or back to the outlet (''). */
	function moveSite(s: SeriesMeta, el: HTMLSelectElement) {
		const nodeId = el.value;
		void saveOnChange(saveId(s, 'site'), el, s.siteNodeId ?? '', async () => {
			const meta = await api.series.site(projectId, s.id, nodeId || null);
			list = list.map((x) => (x.id === s.id ? { ...x, siteNodeId: meta.siteNodeId ?? null } : x));
			onSeriesChange?.(list);
		});
	}

	const typical = (s: SeriesMeta) => {
		const st = stats[s.id];
		if (!st) return '…';
		if (isRain(s.kind)) return st.meanAnnualMm === null ? '–' : `${fmtNum(st.meanAnnualMm)} mm/a`;
		return st.meanDaily === null ? '–' : `${fmtNum(st.meanDaily, st.meanDaily < 1 ? 3 : 2)} ${s.unit}`;
	};

	// The empty state's Upload a CSV opens the header's Add data dialog. An upload takes the empty state,
	// and the button, away, so the dialog has nothing to give focus back to: once no dialog is open
	// (the discard question closing doesn't count), the series panel's heading takes it.
	function addFromEmpty() {
		onadddata?.();
		const back = () => {
			if (document.querySelector('dialog[open]')) return;
			document.removeEventListener('close', back, true);
			requestAnimationFrame(() => {
				if (document.activeElement && document.activeElement !== document.body) return;
				const h = document.getElementById('ser-h');
				if (!h) return;
				h.tabIndex = -1;
				h.focus();
			});
		};
		document.addEventListener('close', back, true);
	}

	// --- freshness first: the badge's "behind" (freshness.ts), the rows in that order ---
	const fresh = $derived(freshness(list, today));
	const behindAge = $derived(new Map((fresh?.behind ?? []).map((b) => [b.id, b.age])));
	const rows = $derived(freshnessOrder(list, fresh?.behind ?? [], inUse));

	// --- the fold: the first few rows in that order (and the charted one), the rest behind "Show all N series" ---
	let pageW = $state(0);
	let chartEl: HTMLElement | undefined = $state();
	let open = $state(false);
	// Six rows and the chart's head sit on a 1440 × 960 first screen; in a column 640 px or narrower each row is a
	// tall card (the same container width as the CSS's `@container data-page`), so four.
	const cap = $derived(pageW > 0 && pageW <= 640 ? 4 : 6);
	const fold = $derived(foldList(rows, (r) => r.id, selectedId, open, cap));
	const CHART_H = 320;

	// The section header (workspace/SectionHeader) carries the title and the count; the tab adds Preview all data.
	$effect(() => fillHeader({ actions: headerActions }));

	// The in-page menu (common/SectionNav): only the panels drawn, as each one's condition below.
	const hasChecks = $derived(list.length > 0 && Object.keys(values).length > 0);
	let usesOpen = $state(false);
	const navGroups = $derived(
		dataNavGroups({ chart: !!viewing, agreement: !!agreement, doubleMass: !!dm?.result, checks: hasChecks })
	);
	// A link to a panel (`?tab=series#data-checks`, the menu's own links reloaded): the tab is a lazy
	// chunk and most panels wait for the series, so land on it once drawn and hold it while the page
	// settles (as Settings, Runs and River & reserve do), with focus on its heading.
	onMount(() => {
		let hash = page.url.hash.slice(1);
		// The retired Upload CSV panel's `#upload-csv`: an editor gets the Add data dialog it now lives in
		// (the fragment dropped, so Back or a reload doesn't reopen it); anyone else lands on the series.
		const moved = retiredDataAnchor(hash);
		if (moved) {
			if (!readonly && onadddata) {
				history.replaceState(history.state, '', `${page.url.pathname}${page.url.search}`);
				onadddata();
				return;
			}
			hash = moved;
		}
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

<!-- Saving…, Saved or why not, beside a control that saves on change (a polite live region, always there so it is announced). -->
{#snippet saveStatus(key: string)}
	{@const st = saves[key]}
	<span class="save-st" class:err={st?.state === 'error'} class:ok={st?.state === 'saved'} id={key} role="status" data-testid="save-status"
		>{st?.state === 'saving' ? 'Saving…' : st?.state === 'saved' ? 'Saved' : st?.state === 'error' ? `Not saved: ${st.text}` : ''}</span
	>
{/snippet}

{#snippet headerActions()}
	{#if list.length}
		<button type="button" class="btn" onclick={openPreviewAll} onpointerenter={warmPreview} onfocus={warmPreview}>Preview all data</button>
	{/if}
{/snippet}

<!-- The notices: one slim line each under the section header, as the page's own. "New data since the latest run"
     is the page's notice (newDataSinceRun, with Re-run model or the queued automatic re-run), here as on every tab. -->
{#if actionError || refreshError || rebuildingNote(list, (s) => s.name || kindLabel(s.kind))}
	<div class="notes">
		{#if actionError}<p class="note err" role="alert">{actionError}</p>{/if}
		{#if refreshError}
			<p class="note err" role="alert" data-testid="refresh-error">
				Couldn't refresh the series ({refreshError}); showing the list as last loaded.
				<button type="button" class="btn btn-sm" onclick={load}>Try again</button>
			</p>
		{/if}
		{#if rebuildingNote(list, (s) => s.name || kindLabel(s.kind))}
			<p class="note note-info" role="status" data-testid="rebuilding-note">{rebuildingNote(list, (s) => s.name || kindLabel(s.kind))}</p>
		{/if}
	</div>
{/if}

<!-- In-page menu: at the tab's top level, not in .data-page, so it sticks down the panels below the chart. -->
{#if list.length}<SectionNav groups={navGroups} label="Data sections" groupNames />{/if}

<div class="data-page" bind:clientWidth={pageW}>
<section class="panel list-panel" id="data-series" aria-labelledby="ser-h">
	<div class="panel-head">
		<h2 id="ser-h">Input time series</h2>
		<!-- The feeds that fill series daily live in Settings → Data feeds; a project that has none had no way to
		     find them from here (issue #444). -->
		{#if !readonly}
			<a class="small feeds-link" href="?tab=settings#set-feeds" data-testid="data-feeds-link">Fetch data automatically (CHIRPS rain, forecast, DWS flow) <span aria-hidden="true">→</span> Data feeds</a>
		{/if}
	</div>
	<LoadState
		{loading}
		error={loadError}
		retry={load}
		empty={list.length === 0}
		emptyText={readonly
			? 'No time series yet. An editor can upload daily rainfall and observed flow as CSV files.'
			: 'No time series yet. Upload daily rainfall (and, to calibrate, observed flow at the outflow gauge) as CSV files with Add data.'}
	>
		{#snippet emptyAction()}
			{#if !readonly && onadddata}
				<!-- Secondary: the header's Add data is the page's primary action; this is the same dialog, where the eye lands. -->
				<button type="button" class="btn" onclick={addFromEmpty}>Add a data file</button>
			{/if}
		{/snippet}
		<!-- Below 640px each row is a card (CSS grid), so the row's numbers, coverage and
		     buttons all fit a phone without scrolling the table sideways. The explicit
		     table roles keep the table semantics that some browsers (Safari) drop once
		     rows and cells stop being display: table-*. -->
		<div class="table-wrap">
			<!-- svelte-ignore a11y_no_redundant_roles -->
			<table class="data series" id="series-rows" role="table">
				<thead role="rowgroup">
					<tr role="row">
						<th scope="col" role="columnheader">Series</th>
						<th scope="col" role="columnheader">Data up to <HelpTip key="data-freshness" /></th>
						<th scope="col" role="columnheader" class="from-col">From</th>
						<th scope="col" role="columnheader" class="num">Missing<br /><span class="u">% of days</span></th>
						<th scope="col" role="columnheader" class="num">Typical<br /><span class="u">mean</span></th>
						<th scope="col" role="columnheader" class="cov">Coverage by year</th>
						<th scope="col" role="columnheader"><span class="visually-hidden">Actions</span></th>
					</tr>
				</thead>
				<tbody role="rowgroup">
					{#each fold.shown as s (s.id)}
						{@const st = stats[s.id]}
						{@const end = endDate(s)}
						{@const age = daysBetween(st?.lastValueDate ?? end, today)}
						{@const role = roleBadge(s, { list, inUse, gaugeInUse, gaugeIds, calibrationSite })}
						{@const behind = behindAge.get(s.id)}
						{@const fed = feedMark(s.feed, st?.present)}
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
											aria-describedby={saveId(s, 'label')}
											aria-invalid={saveFailed(saveId(s, 'label')) ? 'true' : undefined}
											value={labelKey(s)}
											onchange={(e) => relabel(s, e.currentTarget)}
										>
											<option value="">Version not recorded</option>
											{#each CHIRPS_CHOICES as c (c.value)}<option value={c.value}>{c.label}</option>{/each}
										</select>
										{@render saveStatus(saveId(s, 'label'))}
									{/if}
								{:else if asksFreeProvenance(s.kind) && seriesProvenance(s)}
									<span class="prov" data-testid="series-provenance">{describeProvenance(s)}</span>
								{/if}
								<!-- The data feed that wrote days of it (031_feed_days), with how many when it wrote only some. -->
								{#if fed}
									<span class="prov" data-testid="series-feed">{fed}</span>
								{/if}
								<!-- Where the values came from, and a unit conversion at upload (107): only when there is something to say. -->
								{#if s.source || (s.sourceUnit && s.sourceUnitFactor !== 1)}
									<span class="prov" data-testid="series-source">{originLabel(seriesOrigin(s), s.unit)}</span>
								{/if}
								{#if SITED_KINDS.has(s.kind) && (gauges.length || s.siteNodeId)}
									{#if readonly}
										<span class="prov" data-testid="series-site">{s.siteNodeId ? `At gauge ${siteName(s.siteNodeId)}` : 'At the outlet'}</span>
									{:else}
										<select
											class="prov"
											data-testid="series-site"
											aria-label="Where {s.name || kindLabel(s.kind)} was measured"
											aria-describedby={saveId(s, 'site')}
											aria-invalid={saveFailed(saveId(s, 'site')) ? 'true' : undefined}
											value={s.siteNodeId ?? ''}
											onchange={(e) => moveSite(s, e.currentTarget)}
										>
											<option value="">At the outlet</option>
											{#each gauges as g (g.id)}<option value={g.id}>At gauge {g.name}</option>{/each}
											{#if s.siteNodeId && !gauges.some((g) => g.id === s.siteNodeId)}
												<option value={s.siteNodeId} disabled>At a hydrological unit no longer in the model</option>
											{/if}
										</select>
										{@render saveStatus(saveId(s, 'site'))}
									{/if}
								{/if}
								{#if s.dayBoundary}
									<!-- In words, not a hover title: a day added up from sub-daily readings in these windows. -->
									<span class="prov" data-testid="series-day-boundary">{s.dayBoundary}–{s.dayBoundary} days, added up from sub-daily readings</span>
								{/if}
								{#if role}
									<!-- The badge, the kind's role as a HelpTip (keyboard and touch reach it; a title doesn't), and for a gauge record where it is checked and scored, in words. -->
									<span class="role-line">
										<span class="role" class:unused={role.unused} data-testid="series-role">{role.label}</span>
										<HelpTip key={`series.${s.kind}`} />
									</span>
									{#if role.why}<span class="prov why" data-testid="series-role-why">{role.why}</span>{/if}
								{/if}
							</th>
							<td role="cell" class="upto" data-label="Data up to">
								<span class="num">{st?.lastValueDate ?? end}</span>
								<span class="age">{agoText(age)}</span>
								<!-- In a mid-width column From folds in here (the From column is hidden from sight, kept for screen readers). -->
								<span class="from-inline" aria-hidden="true">from {s.startDate}</span>
								{#if behind !== undefined}
									<span class="behind" data-testid="series-behind" title="A run reads this series and it ends {behind} days ago, more than {STALE_DAYS}: the Data badge counts it"
										>Behind</span
									>
								{/if}
							</td>
							<!-- The start only: the end is Data up to's (issue #174). -->
							<td role="cell" class="num period from-col" data-label="From">{s.startDate}</td>
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
		{#if open || fold.hidden}
			<button type="button" class="btn btn-sm more" aria-expanded={open} aria-controls="series-rows" onclick={() => (open = !open)}>
				{open ? `Show only the first ${cap} series` : `Show all ${rows.length} series`}
			</button>
		{/if}
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
			<LineChart
				title="{kindLabel(viewing.kind)}{viewing.name ? ` · ${viewing.name}` : ''}"
				unit={isRain(viewing.kind) ? 'mm/day' : viewing.unit}
				height={CHART_H}
				series={[
					{ label: viewing.name || kindLabel(viewing.kind), startDate: values[viewing.id]!.startDate, values: values[viewing.id]!.values },
					...(flowShading?.ranges.length ? [{ label: 'Filled in a run', style: 'points' as const, startDate: flowShading.filled.startDate, values: flowShading.filled.values }] : [])
				]}
				logToggle={!isRain(viewing.kind)}
				bind:log={flowLog}
				recentDays={3 * 365}
				recentLabel="Last 3 years"
				shade={shading?.ranges ?? flowShading?.ranges ?? []}
				lanes={flagLanes}
				lanesLabel="Quality flags, as Fit automatically reads this record under the current settings"
				caption={shading?.caption ?? flowShading?.caption ?? undefined}
			/>
		{:else}
			<div class="chart-ph" role="status">Loading series…</div>
		{/if}
		<!-- The charted series' source and given unit (107_series_source.sql); an editor records the source here. -->
		<div class="origin" data-testid="series-origin">
			{#if readonly}
				<span>Source: {viewing.source ?? 'not recorded'}</span>
			{:else}
				<label for="series-source-input">Source</label>
				{#key viewing.id}
					<input
						id="series-source-input"
						maxlength="200"
						placeholder="Not recorded: e.g. DWS X1H001, farm logger file"
						aria-describedby={saveId(viewing, 'source')}
						aria-invalid={saveFailed(saveId(viewing, 'source')) ? 'true' : undefined}
						value={viewing.source ?? ''}
						onchange={(e) => resource(viewing, e.currentTarget)}
					/>
					{@render saveStatus(saveId(viewing, 'source'))}
				{/key}
			{/if}
			<span class="muted" data-testid="series-given-unit">
				{viewing.sourceUnit ? `Uploaded in ${viewing.sourceUnit}${viewing.sourceUnitFactor !== 1 ? `, converted to ${viewing.unit} (× ${viewing.sourceUnitFactor})` : ''}` : 'Upload unit not recorded'}
			</span>
			<HelpTip key="series-source" />
		</div>
	</section>
{/if}
</div>

{#if agreement}
	<section class="panel" id="data-agreement" aria-label="Gauge vs logger agreement">
		<AgreementTable {agreement} headingLevel={2} fold />
	</section>
{/if}

{#if dm?.result}
	<div id="data-double-mass"><DoubleMassPanel dm={dm.result} /></div>
{/if}

{#if hasChecks}
	<section class="panel" id="data-checks" aria-labelledby="chk-h" data-testid="series-checks">
		<div class="panel-head">
			<h2 id="chk-h">Data checks <HelpTip key="data-quality-limits" label="About the data checks" /></h2>
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

<section class="panel uses" id="data-uses" aria-labelledby="use-h">
	<div class="panel-head"><h2 id="use-h">What the model uses</h2></div>
	<!-- Reference text for each kind of series, behind a disclosure so it doesn't fill the page's foot (issue #174). -->
	<details class="uses-more" bind:open={usesOpen}>
		<summary class="btn btn-sm">{usesOpen ? 'Hide' : 'Show'} what each kind of series is for</summary>
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
	</details>
	<p class="muted small">
		A run needs at least one rainfall series; its period is the span of those series unless Settings sets one.
		With several series of one kind, the first by name is used.
	</p>
</section>

{#if previewMounted}
	<Lazy load={loadPreviewDialog}>
		{#snippet children(SeriesPreviewDialog)}
			<SeriesPreviewDialog bind:open={previewOpen} {list} {values} failed={valuesFailed} {settings} focusSeriesId={previewFocusSeriesId} onRetry={loadValues} />
		{/snippet}
	</Lazy>
{/if}

<style>
	/* A 24 px target (WCAG 2.5.8). */
	.feeds-link {
		display: inline-flex;
		align-items: center;
		min-height: 24px;
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
	/* The charted series' source (107_series_source.sql): saved on change, like the product select. */
	.origin {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.25rem 0.6rem;
		margin-top: 0.5rem;
		font-size: 0.85rem;
	}
	.origin input {
		flex: 1 1 16rem;
		max-width: 28rem;
	}
	.role-line {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.15rem;
		margin-top: 0.15rem;
	}
	.role {
		display: inline-block;
		font-size: 0.7rem;
		font-weight: 600;
		padding: 0 0.4rem;
		border-radius: 999px;
		background: var(--accent-soft);
		color: var(--accent);
	}
	.why {
		font-weight: 400;
		color: var(--text-muted);
	}
	/* Saved / not saved, beside a control that saves on change. */
	.save-st {
		display: block;
		font-size: 0.72rem;
		font-weight: 400;
		color: var(--text-muted);
	}
	.save-st:empty {
		display: none;
	}
	.save-st.ok {
		color: var(--success);
	}
	.save-st.err {
		color: var(--danger);
		font-weight: 600;
	}
	.origin .save-st {
		flex-basis: 100%;
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
	@container data-page (min-width: 641px) {
		tr.is-behind > th[scope='row'] {
			box-shadow: inset 3px 0 0 var(--warning);
		}
	}
	.from-inline {
		display: none;
	}
	/* A mid-width column (beside the sidebar, e.g. a 1024 px window): the table fits without a sideways scroll by
	   folding From under Data up to, letting the row header and coverage narrow, and wrapping the actions two to a
	   line. Container, not viewport, widths: the sidebar takes 240 px, so the viewport lies about the room. */
	@container data-page (max-width: 72rem) {
		.series th[scope='row'] {
			min-width: 9rem;
		}
		.cov {
			min-width: 7.5rem;
		}
		.series .from-col {
			position: absolute;
			width: 1px;
			height: 1px;
			padding: 0;
			overflow: hidden;
			clip: rect(0 0 0 0);
			white-space: nowrap;
			border: 0;
		}
		.from-inline {
			display: block;
			font-size: 0.75rem;
			color: var(--text-muted);
		}
		.act {
			white-space: normal;
		}
		.acts {
			flex-wrap: wrap;
			max-width: 9.5rem;
			margin-left: auto;
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
	/* The page is the one scroll: the table grows with its rows (six until "Show all", the charted one too)
	   instead of scrolling inside the global 70vh cap; it still scrolls sideways if it must. */
	.list-panel .table-wrap {
		max-height: none;
	}
	.more {
		margin-top: 0.5rem;
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
	/* A phone-width column: each series row becomes a card, so nothing hides behind a sideways scroll. */
	@container data-page (max-width: 640px) {
		.from-inline {
			display: none;
		}
		.series td.from-col {
			position: static;
			width: auto;
			height: auto;
			overflow: visible;
			clip: auto;
		}
		.acts {
			max-width: none;
			margin-left: 0;
		}
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
	/* The reference spans the page: the kinds in columns at a readable measure each, one column on a phone. */
	.roles {
		margin: 0 0 0.75rem;
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(min(100%, 22rem), 1fr));
		gap: 0.6rem 1.75rem;
	}
	.uses-more summary {
		list-style: none;
		cursor: pointer;
		margin-bottom: 0.75rem;
	}
	.uses-more summary::-webkit-details-marker {
		display: none;
	}
	.uses > p {
		max-width: 44rem;
		margin: 0;
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
