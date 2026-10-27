<script module lang="ts">
	const loadPreviewDialog = () => import('./SeriesPreviewDialog.svelte');
	// Data feeds (issue #586: moved here from Settings) is its own chunk, as it was there.
	const loadDataFeeds = () => import('#lib/components/feeds/DataFeedsPanel.svelte');
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
	// and a pick brings it into view. Data feeds (`#data-feeds`, the feeds
	// that fill series daily, issue #586) follows, then the checks and the reference.
	// Uploading is the header's Add data (series/AddDataDialog.svelte): the
	// page charts what it uploaded (`series=`), and the empty state's button
	// opens the same dialog (`onadddata`).
	import { confirmDialog } from '#lib/components/common/confirm.svelte.js';
	import { onDestroy, onMount, untrack } from 'svelte';
	import { focusAfterRemove } from '#lib/a11y/focusAfterRemove.js';
	import { goto } from '$app/navigation';
	import { followAnchors } from '#lib/nav/anchorLanding.js';
	import { page } from '$app/state';
	import { fillHeader } from '#lib/components/workspace/headerSlot.svelte.js';
	import { withParam, withoutParam } from '#lib/workspace/overlays.js';
	import {
		agreementOptions,
		checkSeries,
		doubleMass,
		doubleMassCheck,
		fromEpochDay,
		isGapFillKind,
		observedAgreement,
		recordFlowFlags,
		resolveFlowGapFill,
		resolveQualityFlags,
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
		type RainStationMeta,
		type SeriesMeta,
		ENGINE_VERSION,
		type NetworkNode,
		isLandUnit
	} from '@water-management/engine';
	import { api, type RunMeta } from '#lib/api/index.js';
	import LineChart from '#lib/components/charts/LineChart.svelte';
	import Lazy from '#lib/components/common/Lazy.svelte';
	import { prefetch } from '#lib/components/common/lazy.js';
	import LoadState from '#lib/components/common/LoadState.svelte';
	import { followRetry } from '#lib/components/common/loadState.js';
	import DownloadMenu from '#lib/components/export/DownloadMenu.svelte';
	import HelpTip from '#lib/components/help/HelpTip.svelte';
	import { downloads } from '#lib/export/index.js';
	import { fmtDay, fmtNum } from '#lib/format/number.js';
	import { projectToday } from '#lib/components/projects/freshness.js';
	import { CsvError, parseSeriesCsv, type ParsedSeries } from '#lib/series/csv.js';
	import { defaultUnit, KIND_OPTIONS, kindLabel, seriesKindLabel } from '#lib/series/kinds.js';
	import { CHIRPS_CHOICES, describeProvenance, feedMark, provenanceFields, rebuildingNote } from '#lib/series/provenance.js';
	import { firstOutletSeries } from '#lib/series/pick.js';
	import { asksSite, productField, rowSiteMark, siteText, uploadUnitText } from './details';
	import { asksStation } from './station';
	import StationFields from './StationFields.svelte';
	import AreaRainPanel from './AreaRainPanel.svelte';
	import type { AreaRainLines } from './derivedRain';
	import { ModelInputCache } from './areaInput';
	import { groupedCsv, type ExportArea, type ExportSize } from './groupedCsv';
	import {
		areaNames,
		areaRowInfo,
		CATCHMENT_ITEM_ID,
		groupSeries,
		itemOfSeries,
		stationsOf,
		stationUses,
		stationUsesText,
		type AreaItem as GroupAreaItem,
		type SeriesGroupId
	} from './groups';
	import { coverageBins, coverageStats, daysBetween, mergePreview, type Daily } from './coverage';
	import { agoText } from '#lib/format/age.js';
	import AgreementTable from './AgreementTable.svelte';
	import CoverageStrip from './CoverageStrip.svelte';
	import DoubleMassPanel from './DoubleMassPanel.svelte';
	import EditDay from './EditDay.svelte';
	import { handDayCount, handPoints, handRangesText } from '#lib/series/editDay.js';
	import { gaugeRecordsInUse, KIND_ROLES, rainSourceKinds, renameEffect, renameEffectText, roleBadge, seriesInUse, SITED_KINDS } from './roles';
	import { dataSpan, freshness, freshnessOrder, STALE_DAYS } from './freshness';
	import { cachedValues, cacheValues } from './valuesCache';
	import { zeroRainShading } from './zeroRain';
	import { flowFillShading } from './flowFill';
	import { flowFlagLanes, lanesLooksNote } from '#lib/calibration/flowFlags.js';
	import { dataAnchor, dataNavGroups, retiredDataAnchor } from './sections';
	import { foldList } from '#lib/components/common/fold.js';
	import SectionNav from '#lib/components/common/SectionNav.svelte';
	import { anchorHeading, focusHeading, landOnAnchor } from '#lib/help/anchor.js';

	let {
		projectId,
		readonly,
		initial = null,
		settings = null,
		gauges = [],
		nodes = [],
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
		/** The model's nodes: the land units the Hydrological units group lists, with their MAPs, and the catchment's MAP (issue #553). */
		nodes?: readonly NetworkNode[];
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
	/** Its Try again's refresh, in flight: a slim line in its place, which the focus follows (followRetry). */
	let refreshing = $state(false);
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
	// A `series=` link to a series no longer stored (deleted since a note or a run linked it) charted another one
	// without a word, the URL still naming the dead id (issue #586). Once the list is in, drop the stale parameter
	// (replace, no history entry) and say so in one line, as Runs & results does for a deleted run. A series deleted
	// here drops its own parameter, with no note (remove).
	let goneSeries = $state(false);
	let removedHere = '';
	$effect(() => {
		const id = seriesParam;
		if (!id || loading || loadError || list.some((s) => s.id === id)) return;
		untrack(() => {
			if (id === removedHere) return;
			goneSeries = true;
			void goto(withoutParam(page.url, 'series'), { reset: false, replace: true });
		});
	});
	// How the Series details show its product (series/details.ts): a CHIRPS select, the words, or no field.
	const viewingProduct = $derived(viewing ? productField(viewing) : null);

	let previewOpen = $state(false);
	// The preview dialog is its own chunk (preview.ts pulls in the engine's
	// run preparation): fetched on first open, warmed on hover/focus, then kept.
	let previewMounted = $state(false);
	const warmPreview = () => prefetch(loadPreviewDialog);
	let previewFocusSeriesId = $state<string | null>(null);
	// The preview's View (issue #613, preview.ts previewViews): in the URL (`preview=<view>`, written with replace)
	// while the dialog is open, so a reload reopens it on that view; kept here once it closes, so reopening it in the
	// same visit shows the view it had. The dialog reads a view it doesn't offer (a deleted unit) as All.
	const previewParam = $derived(page.url.searchParams.get('preview'));
	let previewView = $state(untrack(() => page.url.searchParams.get('preview') ?? 'all'));
	// A `preview=` link opens the dialog once the list is in, then the dialog's state writes the URL.
	let previewLinkRead = $state(false);
	$effect(() => {
		if (previewLinkRead || loading) return;
		previewLinkRead = true;
		untrack(() => {
			if (previewParam === null) return;
			previewView = previewParam;
			if (list.length) openPreviewAll();
			else void goto(withoutParam(page.url, 'preview'), { reset: false, replace: true });
		});
	});
	$effect(() => {
		if (!previewLinkRead) return;
		const want = previewOpen ? previewView : null;
		const have = previewParam;
		untrack(() => {
			if (want === have) return;
			void goto(want === null ? withoutParam(page.url, 'preview') : withParam(page.url, 'preview', want), { reset: false, replace: true });
		});
	});
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
		goneSeries = false;
		void goto(withParam(page.url, 'series', id), { reset: false, replace: replaceState }).then(() => {
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
	/** "version not recorded" as a value of its own. */
	const sentence = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
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
			refreshing = false;
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

	// The series a run reads for a kind: the first of that kind by name (byte order, lib/series/pick.ts), among the outlet's (a gauge's record,
	// 084_gauge_records, is read only at its gauge: seriesInUse and the backend's loadLiveInput skip it too).
	const first = (k: string) => firstOutletSeries(list, k);

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
		// The low-flow periods' high readings anchor nothing and are out of the donor's ratio and the clamp, as in a run (issue #567).
		return flowFillShading(viewing.kind, v, fill, (d && values[d.id]) || null, resolveQualityFlags(settings?.qualityFlags).lowFlowPeriods);
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

	/**
	 * Rename a series (issue #556). Runs read the first series of each kind (at each site) by name, so a new name
	 * that changes which one they read says so and asks first (series/pick.ts renamePickChange); one that doesn't,
	 * saves at once. Its values and the runs already stored are untouched.
	 */
	async function rename(s: SeriesMeta, el: HTMLInputElement) {
		const next = el.value.trim();
		const key = saveId(s, 'name');
		// Back to the stored name: nothing to save, and an earlier "Not saved" no longer applies.
		const revert = () => {
			el.value = s.name;
			const { [key]: _, ...rest } = saves;
			saves = rest;
		};
		if (next === s.name) return revert();
		if (!next) {
			el.value = s.name;
			saves = { ...saves, [key]: { state: 'error', text: 'a series needs a name' } };
			return;
		}
		// Judged as the role badges are (roles.ts renameEffect): a series no run reads asks nothing.
		const change = renameEffect(list, s.id, next, rainSourceKinds(settings?.rainSource), gauges);
		if (change) {
			const where = s.siteNodeId ? `at ${siteText(s.siteNodeId, gauges).replace(/^Gauge /, 'gauge ')}` : null;
			const ok = await confirmDialog({
				title: 'Change which series runs read?',
				message: `${renameEffectText(change, s.id, next, kindLabel, where)} Runs already stored are not affected.`,
				confirmLabel: 'Rename'
			});
			if (!ok) return revert();
		}
		await saveOnChange(key, el, s.name, async () => {
			const meta = await api.series.rename(projectId, s.id, next);
			list = list.map((x) => (x.id === s.id ? { ...x, name: meta.name } : x));
			onSeriesChange?.(list);
		});
	}

	/** A rainfall station's details (issue #553), saved together; the list keeps what the API stored, so Settings reads it. */
	async function saveStation(s: SeriesMeta, station: RainStationMeta | null): Promise<RainStationMeta | null> {
		const meta = await api.series.station(projectId, s.id, station);
		const stored = meta.station ?? null;
		list = list.map((x) => (x.id === s.id ? { ...x, station: stored } : x));
		onSeriesChange?.(list);
		return stored;
	}

	// The charted series' days edited by hand (212_series_hand_days) that hold a value, drawn as points.
	const viewingHand = $derived(viewing && values[viewing.id] ? handPoints(values[viewing.id]!, viewing.handDays) : null);

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
			// Its place among the rows as drawn (grouped, folded), so the View that takes the focus is the one now there.
			const at = [...document.querySelectorAll('#series-rows tr[data-series]')].findIndex((tr) => (tr as HTMLElement).dataset.series === s.id);
			removedHere = s.id;
			list = list.filter((x) => x.id !== s.id);
			onSeriesChange?.(list);
			// The deleted series was charted: back to the default, without a history entry for it.
			if (seriesParam === s.id) void goto(withoutParam(page.url, 'series'), { reset: false, replace: true });
			// Its row, and the Delete that had the focus, have gone: the View of the series now in its place takes it.
			await focusAfterRemove(at, '#series-rows button[aria-pressed]', 'ser-h');
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
	// Four rows a group (a unit's row counts once), three in a column 640 px or narrower where each row is a tall card
	// (the same container width as the CSS's `@container data-page`): a project with every group long still lists
	// each group's first rows before the chart, which a pick brings into view.
	const cap = $derived(pageW > 0 && pageW <= 640 ? 3 : 4);

	// --- the groups (issue #553 round 5, groups.ts): stations, catchment rainfall, hydrological units, flow, other,
	// each in the freshness order, each folded on its own (the charted series' row always shows, its unit opened) ---
	let openGroups = $state<Partial<Record<SeriesGroupId, boolean>>>({});
	const GROUP_NOUN: Record<SeriesGroupId, string> = { stations: 'stations', catchment: 'catchment series', units: 'units', flow: 'flow records', other: 'series' };
	const groups = $derived(groupSeries(rows, nodes, settings, new Set(behindAge.keys())));
	const selectedItem = $derived(itemOfSeries(groups, selectedId));
	const grouped = $derived(groups.map((g) => ({ ...g, noun: GROUP_NOUN[g.id], fold: foldList(g.items, (i) => i.id, selectedItem, !!openGroups[g.id], cap) })));

	// --- the derived rows: a unit, or the catchment's average rainfall (groups.ts areaRowInfo, derivedRain.ts) ---
	type AreaItem = GroupAreaItem<SeriesMeta>;
	// A row opened or closed by hand; otherwise open only while it holds the charted series.
	let expanded = $state<Record<string, boolean>>({});
	const areaOpen = (id: string) => expanded[id] ?? selectedItem === id;
	// A newly charted series reopens its unit even if it was closed by hand (Back to a series inside it, say).
	$effect(() => {
		const it = selectedItem;
		untrack(() => {
			if (it && expanded[it] === false) {
				const { [it]: _, ...rest } = expanded;
				expanded = rest;
			}
		});
	});
	const areaCtx = $derived({
		settings,
		nodes,
		stations: stationsOf(list),
		behind: new Set(behindAge.keys()),
		catchmentChirps: list.some((s) => s.kind === 'rain_chirps_mm' && !s.siteNodeId)
	});
	// The role badges' view of the units and the stations (roles.ts roleBadge, issue #553).
	const unitNames = $derived(new Map(nodes.filter(isLandUnit).map((n) => [n.id, n.name])));
	// Where each station's rain goes, as a run reads it (groups.ts stationUses): the row's line and its badge both read it.
	const stationUseMap = $derived(new Map(list.filter(asksStation).map((s) => [s.id, stationUses(s.id, settings, nodes)])));
	const areaOf = (it: AreaItem) => areaNames(it, areaCtx);
	const areaInfo = (it: AreaItem) => areaRowInfo(it, areaCtx);
	const areaPanelId = (itemId: string) => `area-${itemId.replace(':', '-')}`;
	const nodeIdOf = (itemId: string) => (itemId === CATCHMENT_ITEM_ID ? null : itemId.slice('unit:'.length));

	// The model input a run would read, fetched when a derived row opens or a grouped CSV is built (areaInput.ts),
	// dropped whenever the series, the settings or the model change. The engine code that reads it (derivedRain.ts,
	// the run preparation) is its own chunk, loaded then.
	const loadDerived = () => import('./derivedRain');
	const inputs = new ModelInputCache(() => api.runs.modelInput(projectId));
	let areaLines = $state.raw<Record<string, AreaRainLines | null>>({});
	let areaErrors = $state.raw<Record<string, string>>({});
	const pending = new Set<string>();
	$effect(() => {
		void list;
		void settings;
		void nodes;
		untrack(() => {
			inputs.invalidate();
			pending.clear();
			areaLines = {};
			areaErrors = {};
		});
	});
	/** Yield to the browser: the run preparation is main-thread work, so a "Computing…" line paints first. */
	const yieldToPaint = () => new Promise((r) => setTimeout(r, 0));
	async function computeArea(itemId: string) {
		const gen = inputs.generation;
		pending.add(itemId);
		const { [itemId]: _, ...rest } = areaErrors;
		areaErrors = rest;
		try {
			const [x, derived] = await Promise.all([inputs.get(), loadDerived()]);
			await yieldToPaint();
			const lines = derived.areaRainLines(x, nodeIdOf(itemId));
			if (inputs.current(gen)) areaLines = { ...areaLines, [itemId]: lines };
		} catch (e) {
			if (inputs.current(gen)) areaErrors = { ...areaErrors, [itemId]: msg(e) };
		} finally {
			if (inputs.current(gen)) pending.delete(itemId);
		}
	}
	// An open derived row computes its lines once per input.
	$effect(() => {
		for (const g of grouped)
			for (const it of g.fold.shown) {
				if (it.type === 'series' || !areaOpen(it.id) || !areaOf(it)) continue;
				if (it.id in areaLines || it.id in areaErrors || pending.has(it.id)) continue;
				const id = it.id;
				untrack(() => void computeArea(id));
			}
	});

	// Every area's derived lines (the catchment's and each unit's, derivedRain.ts), for the grouped CSV and Preview all
	// data: one run preparation for them all, kept until the inputs change; an answer with an area that failed isn't kept.
	let areasMemo: { gen: number; areas: Promise<ExportArea[]> } | null = null;
	function derivedAreas(): Promise<ExportArea[]> {
		const gen = inputs.generation;
		if (areasMemo?.gen === gen) return areasMemo.areas;
		const memo = { gen, areas: computeAreas() };
		areasMemo = memo;
		void memo.areas.then(
			(a) => {
				if (a.some((x) => x.error) && areasMemo === memo) areasMemo = null;
			},
			() => {
				if (areasMemo === memo) areasMemo = null;
			}
		);
		return memo.areas;
	}
	async function computeAreas(): Promise<ExportArea[]> {
		const items = groups.flatMap((g) => g.items).filter((it): it is AreaItem => it.type !== 'series' && areaOf(it) !== null);
		let read: ((nodeId: string | null) => AreaRainLines | null) | null = null;
		let inputError: string | null = null;
		if (items.length) {
			try {
				const [x, derived] = await Promise.all([inputs.get(), loadDerived()]);
				// One run preparation for every area's pairing (each area's rain used still prepares its own, in the engine).
				const prep = derived.prepareFor(x);
				read = (nodeId) => derived.areaRainLines(x, nodeId, prep);
			} catch (e) {
				inputError = msg(e);
			}
		}
		const areas: ExportArea[] = [];
		for (const it of items) {
			const nodeId = nodeIdOf(it.id);
			let lines: AreaRainLines | null = null;
			let error = inputError;
			if (read) {
				await yieldToPaint();
				try {
					lines = read(nodeId);
					if (!lines) error = 'a run reads no station for it with the settings as saved';
				} catch (e) {
					error = msg(e);
				}
			}
			areas.push({ nodeId, name: areaOf(it)!.name, sentence: areaInfo(it).sentence, lines, error });
		}
		return areas;
	}

	// The grouped CSV (groupedCsv.ts): Compact or Full, built here since its derived columns are never stored.
	async function buildExport(size: ExportSize): Promise<{ blob: Blob; filename: string }> {
		const missing = list.filter((s) => !values[s.id]).length;
		if (missing) throw new Error(`the values of ${missing} series haven’t loaded yet; try again in a moment`);
		const areas = await derivedAreas();
		const text = groupedCsv(size, groups, values, areas, { engineVersion: ENGINE_VERSION, exportedOn: today });
		return { blob: new Blob([text], { type: 'text/csv;charset=utf-8' }), filename: `data-series-${size}-${today}.csv` };
	}
	const exportItems = $derived([
		{ label: 'Compact (CSV)', url: 'build:data-compact', hint: 'Rainfall stations, the average catchment rainfall, each unit’s rain used, flow records', build: () => buildExport('compact') },
		{ label: 'Full (CSV)', url: 'build:data-full', hint: 'Every stored series, and each area’s station × ratio, corrected CHIRPS and rain used', build: () => buildExport('full') }
	]);
	const CHART_H = 320;

	// The section header (workspace/SectionHeader) carries the title and the count; the tab adds Preview all data.
	$effect(() => fillHeader({ actions: headerActions }));

	// The in-page menu (common/SectionNav): only the panels drawn, as each one's condition below. A side index
	// from 80rem of page (a 1440 px window), as Settings: the series table keeps its columns beside it.
	const DATA_RAIL_FROM_REM = 80;
	const hasChecks = $derived(list.length > 0 && Object.keys(values).length > 0);
	let usesOpen = $state(false);
	const navGroups = $derived(
		dataNavGroups({ chart: !!viewing, agreement: !!agreement, doubleMass: !!dm?.result, checks: hasChecks })
	);
	// A link to a panel (`?tab=series#data-checks`, `?rain=units#data-feeds`, the menu's own links reloaded),
	// on load or a #fragment typed or followed while the page is open (finding R2-D): the tab is a lazy chunk,
	// most panels wait for the series and Data feeds is a chunk of its own, so land on it once drawn and hold
	// it while the page settles, with focus on its heading (help/anchor.ts landOnAnchor, through
	// nav/anchorLanding.ts as Settings, Runs and Project do).
	onMount(() =>
		followAnchors({
			page: 'series',
			land(hash) {
				// The retired Upload CSV panel's `#upload-csv`: an editor gets the Add data dialog it now lives in
				// (the fragment dropped, so Back or a reload doesn't reopen it); anyone else lands on the series.
				const moved = retiredDataAnchor(hash);
				if (moved) {
					if (!readonly && onadddata) {
						history.replaceState(history.state, '', `${location.pathname}${location.search}`);
						onadddata();
						return;
					}
					hash = moved;
				}
				return dataAnchor(hash) ? landOnAnchor(hash) : undefined;
			},
			forward: (to) => void goto(to, { replace: true, reset: false })
		})
	);

	// The series panel's link to Data feeds, further down: the browser jumps to the fragment, then the
	// heading takes the focus, so Tab carries on from there (as SectionNav's links do; the fragment already
	// in the URL makes no hashchange, so then at once).
	let stopFeedsFocus = () => {};
	function toFeeds(e: MouseEvent) {
		if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
		stopFeedsFocus();
		const el = document.getElementById('data-feeds');
		const heading = el && anchorHeading(el);
		if (!heading) return;
		if (location.hash === '#data-feeds') {
			focusHeading(heading);
			return;
		}
		const land = () => {
			stopFeedsFocus();
			if (location.hash === '#data-feeds') focusHeading(heading);
		};
		window.addEventListener('hashchange', land);
		stopFeedsFocus = () => window.removeEventListener('hashchange', land);
	}
	onDestroy(() => stopFeedsFocus());
</script>

<!-- Saving…, Saved or why not, beside a control that saves on change (a polite live region, always there so it is announced). -->
{#snippet saveStatus(key: string)}
	{@const st = saves[key]}
	<span class="save-st" class:err={st?.state === 'error'} class:ok={st?.state === 'saved'} id={key} role="status" data-testid="save-status"
		>{st?.state === 'saving' ? 'Saving…' : st?.state === 'saved' ? 'Saved' : st?.state === 'error' ? `Not saved: ${st.text}` : ''}</span
	>
{/snippet}

{#snippet seriesRow(s: SeriesMeta, sub: boolean)}
	{@const st = stats[s.id]}
	{@const end = endDate(s)}
	{@const span = dataSpan(s, st)}
	{@const age = daysBetween(span.to, today)}
	{@const role = roleBadge(s, { list, inUse, gaugeInUse, gaugeIds, calibrationSite, units: unitNames, unitRainOn: settings?.unitRain?.mode === 'perUnit', stationUses: stationUseMap, catchmentStationId: settings?.rainStations?.catchment?.stationId ?? null })}
	{@const behind = behindAge.get(s.id)}
	{@const fed = feedMark(s.feed, st?.present)}
	<!-- Pointer shortcut only; the View button is the accessible control. -->
	<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions, a11y_no_redundant_roles -->
	<tr role="row" id="ser-row-{s.id}" class="pick" class:sub class:selected={s.id === selectedId} class:is-behind={behind !== undefined} data-series={s.id} onclick={(e) => rowClick(e, s.id)}>
		<th scope="row" role="rowheader">
			<span class="kind">{seriesKindLabel(s)}</span>
			<span class="nm">{s.name || '–'} <span class="u">({s.unit})</span></span>
			<!-- A rainfall station (issue #553): its MAP and where its rain goes, so the group reads without opening each one. -->
			{#if asksStation(s)}
				<span class="prov" data-testid="series-station">{s.station?.mapMm != null ? `MAP ${fmtNum(s.station.mapMm, 1)} mm${s.station.mapSource ? ` (${s.station.mapSource})` : ''}` : 'No MAP recorded'}</span>
				<span class="prov" data-testid="series-station-uses">{stationUsesText(stationUseMap.get(s.id) ?? stationUses(s.id, settings, nodes))}</span>
			{/if}
			{#if s.rebuilding}
				<span class="rebuilding" data-testid="series-rebuilding" title="A data feed is backfilling a replacement; this series stays as it is until it completes">Being replaced</span>
			{/if}
			<!-- The data feed that wrote days of it (031_feed_days), with how many when it wrote only some. -->
			{#if fed}
				<span class="prov" data-testid="series-feed">{fed}</span>
			{/if}
			<!-- Days a person typed in (212_series_hand_days, issue #477): an edited record never passes as the raw one. -->
			{#if s.handDays?.length}
				{@const n = handDayCount(s.handDays)}
				<span class="prov" data-testid="series-hand">{fmtNum(n)} {n === 1 ? 'day' : 'days'} edited by hand</span>
			{/if}
			<!-- A flow record placed at a gauge says which; the product, where measured, source and upload unit are
			     the Series details under the chart (issue #464), so the row stays short. -->
			{#if rowSiteMark(s, gauges)}
				<span class="prov" data-testid="series-site">{rowSiteMark(s, gauges)}</span>
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
			<span class="num">{fmtDay(span.to)}</span>
			<span class="age">{agoText(age)}</span>
			<!-- In a mid-width column From folds in here (the From column is hidden from sight, kept for screen readers). -->
			<span class="from-inline" aria-hidden="true">from {fmtDay(span.from)}</span>
			{#if behind !== undefined}
				<span class="behind" data-testid="series-behind" title="A run reads this series and it ends {behind} days ago, more than {STALE_DAYS}: the Data badge counts it"
					>Behind</span
				>
			{/if}
		</td>
		<!-- The start only: the end is Data up to's (issue #174). Both are the days with a value (freshness.ts dataSpan, issue #556). -->
		<td role="cell" class="num period from-col" data-label="From">{fmtDay(span.from)}</td>
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
			<DownloadMenu label="CSV" items={[{ label: `${s.name || kindLabel(s.kind)} (CSV)`, url: downloads.series(projectId, s.id), hint: `${fmtDay(span.from)} → ${fmtDay(span.to)}` }]} />
			{#if !readonly}
				<button type="button" class="btn btn-sm btn-danger" onclick={() => remove(s)} aria-label="Delete {s.name || kindLabel(s.kind)}">Delete</button>
			{/if}
			</div>
		</td>
	</tr>
{/snippet}

<!-- A derived row (issue #553 round 5): a hydrological unit, or the catchment's average rainfall under its station.
     Its sentence says what its rain is made of; its disclosure lists the unit's own series and charts the rain used. -->
{#snippet areaRow(it: AreaItem)}
	{@const info = areaInfo(it)}
	{@const open = areaOpen(it.id)}
	<!-- Explicit roles, as the table's: some browsers drop table semantics once rows stop being display: table-row. -->
	<!-- svelte-ignore a11y_no_redundant_roles -->
	<tr role="row" class="unit-row" class:is-behind={info.behind} class:open data-area={it.id}>
		<th scope="row" role="rowheader">
			<span class="kind">{info.kind}</span>
			<span class="nm">{info.name}</span>
			{#if info.map}<span class="prov" data-testid="area-map">{info.map}</span>{/if}
		</th>
		<td role="cell" colspan="5" class="area-info">
			<span data-testid="area-sentence">{info.sentence}</span>
			{#if info.seriesNote}<span class="prov" data-testid="area-series">{info.seriesNote}</span>{/if}
			{#if info.behind}<span class="behind" data-testid="series-behind">Behind</span>{/if}
		</td>
		<td role="cell" class="act">
			<div class="acts">
				{#if info.toggle}
					<button
						type="button"
						class="btn btn-sm"
						aria-expanded={open}
						aria-controls={open ? [...(it.type === 'unit' ? it.series.map((x) => `ser-row-${x.id}`) : []), ...(info.toggle === 'rain used' ? [areaPanelId(it.id)] : [])].join(' ') : undefined}
						aria-label="{open ? 'Hide' : 'Show'} {info.toggle}: {info.name}"
						onclick={() => (expanded = { ...expanded, [it.id]: !open })}>{open ? 'Hide' : 'Show'} {info.toggle}</button
					>
				{/if}
			</div>
		</td>
	</tr>
{/snippet}
{#snippet headerActions()}
	{#if list.length}
		<button type="button" class="btn" onclick={openPreviewAll} onpointerenter={warmPreview} onfocus={warmPreview}>Preview all data</button>
	{/if}
{/snippet}

<!-- The notices: one slim line each under the section header, as the page's own. "New data since the latest run"
     is the page's notice (newDataSinceRun, with Re-run model or the queued automatic re-run), here as on every tab. -->
{#if actionError || refreshError || refreshing || goneSeries || rebuildingNote(list, (s) => s.name || kindLabel(s.kind))}
	<div class="notes">
		{#if actionError}<p class="note err" role="alert">{actionError}</p>{/if}
		{#if goneSeries}
			<p class="note note-info" role="status" data-testid="gone-series">
				The series that link named is no longer stored{viewing ? `: showing ${viewing.name || kindLabel(viewing.kind)} instead` : ''}.
			</p>
		{/if}
		{#if refreshing}
			<p class="note note-info" role="status" data-loading>Refreshing the series…</p>
		{/if}
		{#if refreshError}
			<p class="note err" role="alert" data-testid="refresh-error">
				Couldn't refresh the series ({refreshError}); showing the list as last loaded.
				<!-- The notices may all go with it: the focus lands on the series list it refreshed (followRetry). -->
				<button
					type="button"
					class="btn btn-sm"
					data-retry
					onclick={(e) => {
						followRetry(e.currentTarget, { scope: e.currentTarget.closest('.notes')?.parentElement, landing: document.getElementById('data-series') });
						refreshing = true;
						load();
					}}>Try again</button
				>
			</p>
		{/if}
		{#if rebuildingNote(list, (s) => s.name || kindLabel(s.kind))}
			<p class="note note-info" role="status" data-testid="rebuilding-note">{rebuildingNote(list, (s) => s.name || kindLabel(s.kind))}</p>
		{/if}
	</div>
{/if}

<!-- In-page menu: around every panel, so it sticks down them all (as a bar) or stands beside them (the side index,
     from 80rem of page, issue #462). Its group names show on the bar too. -->
<SectionNav groups={list.length ? navGroups : []} label="Data sections" groupNames railFrom={DATA_RAIL_FROM_REM}>

<div class="data-page" bind:clientWidth={pageW}>
<section class="panel list-panel" id="data-series" aria-labelledby="ser-h">
	<div class="panel-head">
		<h2 id="ser-h">Input time series</h2>
		<div class="head-tools">
			<!-- The feeds that fill series daily are Data feeds, further down this page (issue #586; before, Settings, and a
			     project with none had no way to find them from here, issue #444). Followed, it lands on its heading. -->
			{#if !readonly}
				<a class="small feeds-link" href="#data-feeds" data-testid="data-feeds-link" onclick={toFeeds}>Fetch data automatically (CHIRPS rain, forecast, DWS flow) <span aria-hidden="true">→</span> Data feeds</a>
			{/if}
			<!-- The grouped list as one CSV (issue #553 round 5): Compact or Full, each with what every area's rain is made of. -->
			{#if list.length}
				<span data-testid="data-export"><DownloadMenu label="Download (CSV)" items={exportItems} /></span>
			{/if}
		</div>
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
				{#each grouped as g (g.id)}
					<tbody role="rowgroup" id="grp-{g.id}" aria-labelledby="grp-{g.id}-h" data-group={g.id}>
						<tr role="row" class="grp-row">
							<th scope="rowgroup" role="rowheader" colspan="7"><h3 id="grp-{g.id}-h" class="grp-h">{g.title}</h3></th>
						</tr>
						{#each g.fold.shown as it (it.id)}
							{#if it.type === 'series'}
								{@render seriesRow(it.series, false)}
							{:else}
								{@render areaRow(it)}
								{#if areaOpen(it.id)}
									{#if it.type === 'unit'}
										{#each it.series as s (s.id)}{@render seriesRow(s, true)}{/each}
									{/if}
									{#if areaOf(it)}
										{@const a = areaOf(it)!}
										<tr role="row" class="area-panel-row">
											<td role="cell" colspan="7">
												<AreaRainPanel
													id={areaPanelId(it.id)}
													name={a.name}
													stationName={a.stationName}
													correctingName={a.correctingName}
													lines={areaLines[it.id] ?? null}
													loading={!(it.id in areaLines) && !areaErrors[it.id]}
													error={areaErrors[it.id] ?? null}
													onretry={() => computeArea(it.id)}
												/>
											</td>
										</tr>
									{/if}
								{/if}
							{/if}
						{/each}
						{#if openGroups[g.id] || g.fold.hidden}
							<tr role="row" class="grp-more">
								<td role="cell" colspan="7">
									<button type="button" class="btn btn-sm" aria-expanded={!!openGroups[g.id]} aria-controls="grp-{g.id}" onclick={() => (openGroups = { ...openGroups, [g.id]: !openGroups[g.id] })}>
										{openGroups[g.id] ? `Show only the first ${cap} ${g.noun}` : `Show all ${g.items.length} ${g.noun}`}
									</button>
								</td>
							</tr>
						{/if}
					</tbody>
				{/each}
			</table>
		</div>
		<!-- Each swatch or pill stays on one line with its words: a phone wrapped "no data" away from its colour. -->
		<p class="muted small key" data-testid="series-key">
			<span class="key-item"><span class="sw full"></span> complete year</span>
			<span class="key-item"><span class="sw part"></span> some days missing</span>
			<span class="key-item"><span class="sw none"></span> no data.</span>
			<span>Rainfall’s typical value is its mean annual total; flow’s, its mean daily flow.</span>
			<span><span class="behind">Behind</span> a series a run reads, more than {STALE_DAYS} days old.</span>
		</p>
	</LoadState>
</section>

{#if viewing}
	<section class="panel chart-panel" id="data-chart" aria-labelledby="chart-h" bind:this={chartEl}>
		<h2 id="chart-h" class="visually-hidden">Series chart</h2>
		{#if values[viewing.id]}
			<LineChart
				title="{seriesKindLabel(viewing)}{viewing.name ? ` · ${viewing.name}` : ''}"
				unit={isRain(viewing.kind) ? 'mm/day' : viewing.unit}
				height={CHART_H}
				series={[
					{ label: viewing.name || kindLabel(viewing.kind), startDate: values[viewing.id]!.startDate, values: values[viewing.id]!.values },
					...(flowShading?.ranges.length ? [{ label: 'Filled in a run', style: 'points' as const, startDate: flowShading.filled.startDate, values: flowShading.filled.values }] : []),
					...(viewingHand ? [{ label: 'Edited by hand', style: 'points' as const, startDate: viewingHand.startDate, values: viewingHand.values }] : [])
				]}
				logToggle={!isRain(viewing.kind)}
				bind:log={flowLog}
				recentDays={3 * 365}
				recentLabel="Last 3 years"
				shade={shading?.ranges ?? flowShading?.ranges ?? []}
				lanes={flagLanes}
				lanesNote={lanesLooksNote(flagLanes)}
				lanesLabel="Quality flags, as Fit automatically reads this record under the current settings"
				caption={shading?.caption ?? flowShading?.caption ?? undefined}
			/>
		{:else}
			<div class="chart-ph" role="status">Loading series…</div>
		{/if}
		<!-- Series details (issue #464): the charted series' product, where it was measured, source and upload unit,
		     each under a visible label; the ones an editor sets save on change. Keyed, so a failed save's
		     reverted value or a half-typed source never carries over to the next series picked. -->
		<div class="details" role="group" aria-labelledby="details-h" data-testid="series-details">
			<!-- The tip beside the heading, not in it, so the group is named "Series details" alone. -->
			<div class="details-h"><h3 id="details-h">Series details</h3><HelpTip key="series-source" /></div>
			{#key viewing.id}
				<dl class="details-list">
					<!-- The name (issue #556): editors rename it here, saved on change like the source; viewers read it. A
					     series a data feed writes keeps its name (the feed writes by it), so it reads as words with why. One an
					     API key writes or lists by name (which an editor can't read) is refused by the server, whose reason shows
					     as Not saved under the box. -->
					<div class="detail detail-name">
						{#if readonly || viewing.feed}
							<dt>Name</dt>
							<dd>
								<span data-testid="series-name">{viewing.name || 'Not named'}</span>
								{#if !readonly && viewing.feed}
									<span class="name-why" data-testid="series-name-fed">A data feed writes into this series by its name, so it keeps it.</span>
								{/if}
							</dd>
						{:else}
							<dt><label for="series-name-input">Name</label></dt>
							<dd>
								<input
									id="series-name-input"
									data-testid="series-name"
									maxlength="100"
									placeholder="Not named: shown as {seriesKindLabel(viewing)}"
									aria-describedby={saveId(viewing, 'name')}
									aria-invalid={saveFailed(saveId(viewing, 'name')) ? 'true' : undefined}
									value={viewing.name}
									onchange={(e) => rename(viewing, e.currentTarget)}
								/>
								{@render saveStatus(saveId(viewing, 'name'))}
							</dd>
						{/if}
					</div>
					{#if viewingProduct}
						<div class="detail">
							{#if viewingProduct === 'chirps' && !readonly}
								<dt><label for="series-product-input">Product</label></dt>
								<dd>
									<select
										id="series-product-input"
										data-testid="series-provenance"
										aria-describedby={saveId(viewing, 'label')}
										aria-invalid={saveFailed(saveId(viewing, 'label')) ? 'true' : undefined}
										value={labelKey(viewing)}
										onchange={(e) => relabel(viewing, e.currentTarget)}
									>
										<option value="">Version not recorded</option>
										{#each CHIRPS_CHOICES as c (c.value)}<option value={c.value}>{c.label}</option>{/each}
									</select>
									{@render saveStatus(saveId(viewing, 'label'))}
								</dd>
							{:else}
								<dt>Product</dt>
								<dd data-testid="series-provenance">{sentence(describeProvenance(viewing))}</dd>
							{/if}
						</div>
					{/if}
					{#if asksSite(viewing, gauges)}
						<div class="detail">
							{#if readonly}
								<dt>Measured at</dt>
								<dd data-testid="series-measured-at">{siteText(viewing.siteNodeId, gauges)}</dd>
							{:else}
								<dt><label for="series-site-input">Measured at</label></dt>
								<dd>
									<select
										id="series-site-input"
										data-testid="series-measured-at"
										aria-describedby={saveId(viewing, 'site')}
										aria-invalid={saveFailed(saveId(viewing, 'site')) ? 'true' : undefined}
										value={viewing.siteNodeId ?? ''}
										onchange={(e) => moveSite(viewing, e.currentTarget)}
									>
										<option value="">{siteText(null, gauges)}</option>
										{#each gauges as g (g.id)}<option value={g.id}>{siteText(g.id, gauges)}</option>{/each}
										{#if viewing.siteNodeId && !gauges.some((g) => g.id === viewing.siteNodeId)}
											<option value={viewing.siteNodeId} disabled>{siteText(viewing.siteNodeId, gauges)}</option>
										{/if}
									</select>
									{@render saveStatus(saveId(viewing, 'site'))}
								</dd>
							{/if}
						</div>
					{/if}
					<div class="detail detail-source">
						{#if readonly}
							<dt>Source</dt>
							<dd data-testid="series-source">{viewing.source ?? 'Not recorded'}</dd>
						{:else}
							<dt><label for="series-source-input">Source</label></dt>
							<dd>
								<input
									id="series-source-input"
									data-testid="series-source"
									maxlength="200"
									placeholder="Not recorded: e.g. DWS X1H001, farm logger file"
									aria-describedby={saveId(viewing, 'source')}
									aria-invalid={saveFailed(saveId(viewing, 'source')) ? 'true' : undefined}
									value={viewing.source ?? ''}
									onchange={(e) => resource(viewing, e.currentTarget)}
								/>
								{@render saveStatus(saveId(viewing, 'source'))}
							</dd>
						{/if}
					</div>
					<div class="detail">
						<dt>Upload unit</dt>
						<dd data-testid="series-given-unit">{uploadUnitText(viewing)}</dd>
					</div>
					{#if viewing.handDays?.length}
						<div class="detail">
							<dt>Edited by hand</dt>
							<dd data-testid="series-hand-days">{handRangesText(viewing.handDays)}</dd>
						</div>
					{/if}
				</dl>
				{#if asksStation(viewing)}
					<StationFields series={viewing} {readonly} onsave={(st) => saveStation(viewing, st)} />
				{/if}
				{#if !readonly}
					<EditDay {projectId} series={viewing} values={values[viewing.id] ?? null} onsaved={() => load()} />
				{/if}
			{/key}
		</div>
	</section>
{/if}
</div>

<!-- Data feeds (issue #586, from Settings): every reader, as there (owners attach, editors run one now, viewers read).
     The id sits outside the lazy panel, so a #data-feeds link and the section menu find it while the chunk loads. -->
<div id="data-feeds">
	<Lazy load={loadDataFeeds}>
		{#snippet children(DataFeedsPanel)}<DataFeedsPanel {projectId} />{/snippet}
	</Lazy>
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
			<!-- What the checks look for is the ⓘ's (issue #464), not a line under the heading; beside the heading, not in
			     it, so the heading (and a #data-checks landing) is named "Data checks" alone. -->
			<div class="chk-h"><h2 id="chk-h">Data checks</h2><HelpTip key="data-quality-limits" label="About the data checks" /></div>
		</div>
		{#if checks.length}
			<ul class="checks">
				{#each checks as c (c.id)}
					<li>
						<span class="badge badge-warn">{CHECK_LABEL[c.check.check]}</span>
						<!-- The series named charts it, as its row's View does (the check was a dead end: issue #586). -->
						<button type="button" class="chk-series" data-testid="check-series" aria-pressed={c.series.id === selectedId} onclick={() => choose(c.series.id)}
							><span class="visually-hidden">Chart </span>{c.series.name || kindLabel(c.series.kind)}</button
						>
						<span class="muted">({seriesKindLabel(c.series)})</span>:
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
		A run needs at least one rainfall series; its period is the span of those series unless the
		<a href="?tab=settings#set-period" data-testid="uses-period-link">Simulation period</a> setting sets one.
		With several series of one kind, the first by name is used, in character order: digits and capitals before lower case.
	</p>
</section>
</SectionNav>

{#if previewMounted}
	<Lazy load={loadPreviewDialog}>
		{#snippet children(SeriesPreviewDialog)}
			<SeriesPreviewDialog bind:open={previewOpen} bind:view={previewView} {nodes} {list} {values} failed={valuesFailed} {settings} focusSeriesId={previewFocusSeriesId} onRetry={loadValues} loadAreas={derivedAreas} />
		{/snippet}
	</Lazy>
{/if}

<style>
	/* A 24 px target (WCAG 2.5.8) that wraps as text: inline-flex made the words and the arrow
	   separate columns on a phone (issue #586 R1-D). */
	.feeds-link {
		display: inline-block;
		min-height: 24px;
		line-height: 24px;
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
		font-size: 0.85rem;
	}
	.rebuilding {
		display: inline-block;
		margin-top: 0.15rem;
		font-size: var(--font-xs);
		font-weight: 600;
		padding: 0 0.4rem;
		border-radius: 999px;
		background: var(--warning-soft);
		color: var(--warning);
	}
	.prov {
		display: block;
		margin-top: 0.15rem;
		font-size: var(--font-xs);
		max-width: 100%;
	}
	/* Series details (issue #464): the charted series' product, where measured, source and upload unit, one labelled
	   field each across the chart's foot, wrapping to a column in a narrow page. */
	.details {
		margin-top: 0.75rem;
		padding-top: 0.6rem;
		border-top: 1px solid var(--border);
	}
	.details-h {
		display: flex;
		align-items: center;
		gap: 0.25rem;
		margin: 0 0 0.4rem;
	}
	.details-h h3 {
		margin: 0;
		font-size: 0.9rem;
	}
	.details-list {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr));
		gap: 0.5rem 1rem;
		margin: 0;
		font-size: 0.85rem;
	}
	/* The name and the source take two columns: both hold up to 100–200 characters (issue #556). */
	.detail-source,
	.detail-name {
		grid-column: span 2;
	}
	@container data-page (max-width: 640px) {
		.detail-source,
		.detail-name {
			grid-column: auto;
		}
	}
	.name-why {
		display: block;
		font-size: var(--font-sm);
		color: var(--text-2);
	}
	.detail dt {
		font-size: var(--font-sm);
		font-weight: 600;
		color: var(--text-2);
	}
	.detail dd {
		margin: 0.15rem 0 0;
		overflow-wrap: anywhere;
	}
	.detail select,
	.detail input {
		width: 100%;
		max-width: 28rem;
	}
	/* The ⓘ stays beside its badge: in a narrow column (a 1024 px window) a long badge wraps inside itself, and the
	   tip used to drop to a line of its own under it. */
	.role-line {
		display: flex;
		align-items: flex-start;
		gap: 0.15rem;
		margin-top: 0.15rem;
	}
	.role {
		display: inline-block;
		font-size: var(--font-xs);
		font-weight: 600;
		padding: 0 0.4rem;
		/* Not a full pill: a badge that wraps reads as one rounded box, not a lozenge pinched at each line. */
		border-radius: 0.6rem;
		background: var(--accent-soft);
		color: var(--accent);
		min-width: 0;
	}
	.why {
		font-weight: 400;
		color: var(--text-muted);
	}
	/* Saved / not saved, beside a control that saves on change. */
	.save-st {
		display: block;
		font-size: var(--font-xs);
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
	.role.unused {
		background: var(--surface-2);
		color: var(--text-muted);
	}
	.period {
		font-size: 0.85rem;
		text-align: left;
	}
	.upto .num {
		display: block;
		text-align: left;
	}
	.age {
		font-size: var(--font-xs);
		color: var(--text-muted);
	}
	/* "Behind": the Data badge's rule (freshness.ts), in words as well as colour. */
	.behind {
		display: inline-block;
		margin-left: 0.3rem;
		font-size: var(--font-xs);
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
	   line. Container, not viewport, widths: the sidebar takes 240 px, so the viewport lies about the room. Up to 76rem (at the
root's 14 px, a 1280 px window under the bar): at 72rem a 1280 px window kept the From column and squeezed the
series names to 190 px, wrapping each role badge. */
	@container data-page (max-width: 76rem) {
		.series th[scope='row'] {
			min-width: 9rem;
		}
		/* .series: the plain `.cov` rule below comes later in the file and would win a tie. */
		.series .cov {
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
			font-size: var(--font-xs);
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
	/* The groups (issue #553 round 5): a heading row over each, a unit's own series indented under it, an open
	   derived row's chart across the table. */
	.grp-row > th {
		padding: 0.9rem 0.5rem 0.3rem;
		border-bottom: 1px solid var(--border);
		background: var(--surface);
	}
	tbody:first-of-type .grp-row > th {
		padding-top: 0.4rem;
	}
	.grp-h {
		margin: 0;
		font-size: 0.9rem;
	}
	tr.unit-row > th[scope='row'],
	tr.unit-row > td {
		background: var(--surface-2);
	}
	tr.pick.sub > th[scope='row'] {
		padding-left: 1.5rem;
	}
	.area-info {
		font-size: 0.85rem;
		color: var(--text-2);
		max-width: 48rem;
	}
	.area-panel-row > td {
		padding: 0 0.5rem;
	}
	.grp-more > td {
		padding: 0.4rem 0.5rem 0.6rem;
		border-bottom: 0;
	}
	.head-tools {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem 1rem;
	}
	.data-page {
		container: data-page / inline-size;
	}
	/* The page is the one scroll: the table grows with its rows (six until "Show all", the charted one too)
	   instead of scrolling inside the global 70vh cap; it still scrolls sideways if it must. */
	.list-panel .table-wrap {
		max-height: none;
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
		font-size: var(--font-xs);
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
	.key-item {
		white-space: nowrap;
	}
	.chk-h {
		display: flex;
		align-items: center;
		gap: 0.25rem;
	}
	.chk-h h2 {
		margin: 0;
	}
	/* A series named in a check, as a link: it charts that series. */
	.chk-series {
		padding: 0;
		border: 0;
		background: none;
		font: inherit;
		font-weight: 600;
		color: var(--accent);
		text-decoration: underline;
		cursor: pointer;
	}
	.chk-series[aria-pressed='true'] {
		color: var(--text);
		text-decoration: none;
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
		.series tr.grp-row,
		.series tr.grp-more,
		.series tr.area-panel-row,
		.series tr.grp-row > th,
		.series tr.grp-more > td,
		.series tr.area-panel-row > td {
			display: block;
		}
		.series tr.unit-row {
			display: grid;
			grid-template-columns: minmax(0, 1fr);
			gap: 0.4rem;
			padding: 0.75rem;
			border-bottom: 1px solid var(--border);
			background: var(--surface-2);
		}
		.series tr.unit-row > th,
		.series tr.unit-row > td {
			display: block;
			padding: 0;
			border: 0;
			background: none;
			text-align: left;
		}
		.series tr.unit-row .acts {
			justify-content: flex-start;
		}
		.series tr.unit-row.is-behind {
			box-shadow: inset 3px 0 0 var(--warning);
		}
		.series tr.pick.sub > th[scope='row'] {
			padding-left: 0;
		}
		.series tr.pick.sub {
			padding-left: 1.25rem;
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
			/* A number cell doesn't wrap; its label must, or "Missing (% of days)" runs into the next at 320 px (issue #586). */
			white-space: normal;
			font-size: var(--font-xs);
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
		font-size: 0.85rem;
		color: var(--text-2);
	}
	.have {
		font-size: var(--font-xs);
		font-weight: 600;
		color: var(--success);
		margin-left: 0.3rem;
	}
</style>
