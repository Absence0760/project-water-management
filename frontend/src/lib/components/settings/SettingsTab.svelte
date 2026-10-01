<script module lang="ts">
	// Settings → Calibration record's quality flags and flow gaps (issue #66): each its own chunk,
	// loaded when the section draws, so the Settings tab chunk stays under its size ceiling. The
	// quality flags' Save blocker (`error`) is set once its fields load: nothing can be edited before.
	const loadQualityFlags = () => import('./QualityFlagsFields.svelte');
	const loadFlowGapFill = () => import('./FlowGapFillFields.svelte');
	// Automated calibration's rules and run (issue #153): their own chunks, for the same reason.
	const loadCalibrationRules = () => import('./CalibrationRulesFields.svelte');
	const loadAutoFit = () => import('$lib/components/calibration/AutoFitPanel.svelte');
	// Settings → Evidence, the declared uncertainty rule (issue #71): its own chunk, for the same reason.
	const loadEvidenceRule = () => import('./EvidenceRuleFields.svelte');
	// Settings → Drought restrictions (engine ≥ 1.54.0, WP-3.8): its own chunk, for the same reason.
	const loadDroughtRestriction = () => import('./DroughtRestrictionFields.svelte');
	// API keys render for owners only, so the rest of the team never downloads them.
	const loadApiKeys = () => import('$lib/components/apiKeys/ApiKeysPanel.svelte');
	// Its own chunk (issue #69): the Settings tab chunk sits at its size ceiling, and the feeds panel loads its list on mount anyway.
	const loadDataFeeds = () => import('$lib/components/feeds/DataFeedsPanel.svelte');
	// Preview the unsaved settings against the last run (issue #284): its own chunk, fetched when first wanted.
	const loadUnsavedPreview = () => import('$lib/components/preview/UnsavedPreviewDialog.svelte');
</script>

<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { page } from '$app/state';
	import { holdAnchor } from '$lib/help/anchor';
	import NotesDrawer from '$lib/components/notes/NotesDrawer.svelte';
	import { settingTarget } from '$lib/components/notes/notes';
	import {
		ALLOCATION_MODE_LABEL,
		ALLOCATION_MODES,
		CALIBRATION_FLOW_KINDS,
		calibrationSeriesKey,
		calibrationSites,
		fitRecordCaveats,
		fitRecordStatus,
		hasPotentialEvaporation,
		LAKE_FACTOR_PRESETS,
		lakeFactorPresetFill,
		lakeFactorPresetNamed,
		lakeFactorPresetStale,
		PAN_COEFFICIENT_PRESET_SOURCE,
		PAN_COEFFICIENT_PRESETS,
		PAN_COEFFICIENT_TYPICAL_MAX,
		PAN_COEFFICIENT_TYPICAL_MIN,
		PE_SOURCE_MAX,
		QM_MIN_WET_DAYS,
		QM_WET_DAY_MM_MAX,
		QM_WET_DAY_MM_MIN,
		panCoefficientOutOfRange,
		type ChirpsQuantileMap,
		type CalibrationParams,
		type CalibrationReport,
		type FitRecord,
		type FlowShareMethod,
		type PeInput,
		type ProjectSettings,
		type CalibrationFlowKind,
		type SeriesOrigin,
		type SeriesProvenance,
		type ApanDailyFingerprint,
		type AllocationMode,
		type SeriesMeta,
		defaultProjectSettings
	} from '@water-management/engine';
	import { apanDailyOfValues } from '$lib/series/provenance';
	import { applyReport, marPenaltyOn } from '$lib/calibration/fit';
	import CalibrationExclusions from '$lib/components/calibration/CalibrationExclusions.svelte';
	import FitPanel from '$lib/components/calibration/FitPanel.svelte';
	import FitProvenance from '$lib/components/calibration/FitProvenance.svelte';
	import { api, type Project, type RunMeta } from '$lib/api';
	import type { UnsavedEdits } from '$lib/preview/overlay';
	import CalibrationWindowFields from '$lib/components/calibration/CalibrationWindowFields.svelte';
	import HelpTip from '$lib/components/help/HelpTip.svelte';
	import NumberInput from '$lib/components/common/NumberInput.svelte';
	import FieldHistoryLine from '$lib/components/history/FieldHistoryLine.svelte';
	import { annualMm3 } from '$lib/components/crops/demand';
	import { fmtNum, fmtPct, fmtQty } from '$lib/format/number';
	import { WATER_YEAR_MONTHS } from '$lib/format/months';
	import type { ModelEditor } from '$lib/model/editor.svelte';
	import { fitSummary, GR4J_FIELDS, RUNOFF_MODEL_HELP, RUNOFF_MODEL_LABEL, typicalRange } from './calibration';
	import { fillHeader } from '$lib/components/workspace/headerSlot.svelte';
	import { dataQualityError } from './dataQuality';
	import DataQualitySection from './DataQualitySection.svelte';
	import { AUTO_RUN_DEBOUNCE_MAX, AUTO_RUN_MAX_WAIT_MINUTES, autoRunError, resolveAutoRun } from '$lib/components/autorun/autoRun';
	import type { AutoRunSettings, OutcomeSettings, OutlookSettings } from '$lib/api/types';
	import { outcomesError, resolveOutcomes } from '$lib/components/outcomes/outcomeSettings';
	import { outlookError, resolveOutlook } from '$lib/components/outlook/settings';
	import { CHIRPS_BIAS_OPTIONS, withChirpsQuantileMap } from './rain';
	import { saveBlockers, SETTINGS_SECTIONS, settingsNavGroups } from './sections';
	import SectionNav from '$lib/components/common/SectionNav.svelte';
	import Wr2012Section from './Wr2012Section.svelte';
	import EwrRulesSection from './EwrRulesSection.svelte';
	import ZeroRainSection from './ZeroRainSection.svelte';
	import Lazy from '$lib/components/common/Lazy.svelte';
	import ChirpsFitPeriodSection from './ChirpsFitPeriodSection.svelte';
	import RainSourceSection from './RainSourceSection.svelte';
	import { proposeFitRanges } from './proposeFitRanges';
	import { annualGr4jPeMm, apanSourceNote, PE_KIND_OPTIONS, PE_MONTH_MAX_MM, peFormError, peOf, withPeKind, type EditablePe } from './peInput';
	import { AREAL_METHOD_OPTIONS, arealRainFormError, flatFactor, storedArealRain, withArealRain, withFactorEveryMonth, type EditableArealRain } from './arealRain';
	// These panels render on every visit of the tab, so they are in its chunk rather than chunks of
	// their own: split, they only added overhead (6 KB gzip, issue #17; tab chunks have their own
	// ceiling in scripts/guards/check_web_bundle_budget.mjs). Data feeds, API keys and scheduled
	// reports save through their own APIs, never through Save settings (docs/ui.md § Data feeds,
	// § API keys, § Scheduled reports); the outcome matrix (issue #53 R4) and seasonal outlook
	// (R5) settings are part of the form.
	import PanCoefficientHelper from './PanCoefficientHelper.svelte';
	import ReportSchedulesPanel from '$lib/components/report/ReportSchedulesPanel.svelte';
	import OutcomeSettingsSection from '$lib/components/outcomes/OutcomeSettingsSection.svelte';
	import OutlookSettingsSection from '$lib/components/outlook/OutlookSettingsSection.svelte';

	let {
		project,
		editor,
		seriesKinds = null,
		gaugeRecords = null,
		chirpsSource,
		observedOrigins,
		apanSeries,
		readonly,
		onProjectChange,
		runs = null
	}: {
		project: Project;
		editor?: ModelEditor;
		/** The project's runs, newest first (null while they load): the Preview starts from the last one. */
		runs?: RunMeta[] | null;
		/** Kinds of the project's input series, to limit the calibration flow choices. */
		seriesKinds?: string[] | null;
		/** The flow records attached to gauges inside the network (084_gauge_records), for the calibration site's choices; null = not known. */
		gaugeRecords?: { kind: string; siteNodeId: string }[] | null;
		/** The CHIRPS series' product and version a run would use (issue #40c); undefined when not known. */
		chirpsSource?: SeriesProvenance | null;
		/** Each observed record's source and given unit a run would read (107_series_source.sql), by model-input key; undefined when not known. */
		observedOrigins?: Partial<Record<string, SeriesOrigin | null>>;
		/** The daily A-pan series a run would read (issue #45): null for none, undefined while the list loads. */
		apanSeries?: Pick<SeriesMeta, 'id' | 'updatedAt'> | null;
		readonly: boolean;
		onProjectChange: (p: Project) => void;
	} = $props();

	// Mutable view of the settings (the engine's Monthly type is a readonly tuple).
	type Editable = Omit<ProjectSettings, 'apanMm' | 'ewrPragmaticM3PerDay' | 'panCoefficient' | 'calibration' | 'pe' | 'lakeEvapFactorMonthly'> & {
		apanMm: number[];
		/** Monthly lake factors (WP-3.5); null = lakeEvapFactor in every month. */
		lakeEvapFactorMonthly?: number[] | null;
		ewrPragmaticM3PerDay: number[];
		panCoefficient: number[];
		calibration: CalibrationParams & Record<string, unknown>;
		/** Absent on settings saved before engine 0.31.0: pan coefficient × A-pan. */
		pe?: EditablePe;
		/** When the project re-runs itself after new data (WP-2.11); defaults filled in for an older API. */
		autoRun: AutoRunSettings;
		/** How the outcome matrix reads a sweep (issue #53 R4); defaults filled in for an older API. */
		outcomes: OutcomeSettings;
		/** How a seasonal outlook is set up (issue #53 R5); defaults filled in for an older API. */
		outlook: OutlookSettings;
	};
	const clone = (v: ProjectSettings & { autoRun?: Partial<AutoRunSettings>; outcomes?: OutcomeSettings; outlook?: OutlookSettings }): Editable => {
		const c = JSON.parse(JSON.stringify(v)) as Editable;
		c.autoRun = resolveAutoRun(v);
		c.outcomes = resolveOutcomes(v);
		c.outlook = resolveOutlook(v);
		return c;
	};

	let s = $state<Editable>(clone(untrack(() => project.settings)));
	let saved = $state(JSON.stringify(clone(untrack(() => project.settings))));
	let saving = $state(false);
	let error = $state<string | null>(null);
	let justSaved = $state(false);
	// X2 (groundwater exchange) is fixed at 0 unless the user opts in.
	let x2Open = $state(untrack(() => project.settings.gr4j?.x2 !== 0));
	// The preset picker itself is never saved — it only fills panCoefficient, then resets.
	let panPreset = $state('');
	// Likewise the lake-factor preset picker (engine ≥ 1.49.0): it fills lakeEvapFactorMonthly and its source note, then resets.
	let lakePreset = $state('');
	let lakePresetError = $state<string | null>(null);

	const dirty = $derived(JSON.stringify(s) !== saved);
	const cal = $derived(s.calibration);
	const hiLoSum = $derived((s.hiLoSplit.hi || 0) + (s.hiLoSplit.lo || 0));
	const dateError = $derived(
		s.simulationStart && s.simulationEnd && s.simulationStart > s.simulationEnd
			? 'Simulation start must be before the end.'
			: null
	);
	let calWindowError = $state<string | null>(null);
	let exclusionsError = $state<string | null>(null);
	let zeroRainError = $state<string | null>(null);
	let fitPeriodError = $state<string | null>(null);
	let rainSourceError = $state<string | null>(null);
	// GR4J's PE input (issue #39).
	const pe = $derived(peOf(s));
	const peError = $derived(peFormError(pe));
	const peAnnual = $derived(annualGr4jPeMm(s));
	const peSourceBad = $derived(pe.kind === 'monthly' && (!pe.source.trim() || pe.source.length > PE_SOURCE_MAX));
	// A monthly row the form had before switching to pan, so switching back brings it back (unsaved).
	let lastMonthlyPe = $state<EditablePe | null>(null);
	// The areal rainfall correction on GR4J's rain (engine ≥ 1.13.0, §2.4g); the one switched off is kept until saved.
	const areal = $derived((s.arealRain ?? null) as unknown as EditableArealRain | null);
	const arealError = $derived(arealRainFormError(areal));
	const arealFlat = $derived(areal ? flatFactor(areal) : null);
	let lastAreal = $state<EditableArealRain | null>(null);
	function setArealOn(on: boolean) {
		if (!on && areal) lastAreal = $state.snapshot(areal) as EditableArealRain;
		s.arealRain = storedArealRain(withArealRain(on, lastAreal));
	}
	// The CHIRPS gap map (engine ≥ 1.53.0, CR-23); the threshold it was switched off with is kept until saved.
	let lastGapMap = $state<ChirpsQuantileMap | null>(null);
	function setGapMapOn(on: boolean) {
		if (!on && s.chirpsQuantileMap) lastGapMap = { ...s.chirpsQuantileMap };
		s.chirpsQuantileMap = withChirpsQuantileMap(on, lastGapMap);
	}
	const reportError = $derived(
		s.reportStart && s.reportEnd && s.reportStart > s.reportEnd ? 'The reporting window must start before it ends.' : null
	);
	const dqError = $derived(dataQualityError(s.dataQuality));
	const autoError = $derived(autoRunError(s.autoRun));
	const outError = $derived(outcomesError(s.outcomes));
	const outlookErr = $derived(outlookError(s.outlook));
	let wr2012Error = $state<string | null>(null);
	let qualityFlagsErr = $state<string | null>(null);
	let rulesErr = $state<string | null>(null);
	let reserveError = $state<string | null>(null);
	let evidenceErr = $state<string | null>(null);
	let restrictErr = $state<string | null>(null);
	const blocked = $derived(
		!!evidenceErr || !!restrictErr || !!dateError || !!calWindowError || !!exclusionsError || !!qualityFlagsErr || !!rulesErr || !!zeroRainError || !!fitPeriodError || !!rainSourceError || !!peError || !!arealError || !!reportError || !!dqError || !!wr2012Error || !!reserveError || !!autoError || !!outError || !!outlookErr
	);
	// What blocks Save, by group, so the save bar can link to each one.
	const blockers = $derived(
		saveBlockers([
			{ id: 'set-record', message: calWindowError },
			{ id: 'set-record', message: exclusionsError },
			{ id: 'set-record', message: qualityFlagsErr },
			{ id: 'set-fit', message: rulesErr },
			{ id: 'set-rain', message: fitPeriodError },
			{ id: 'set-rain', message: zeroRainError },
			{ id: 'set-rain', message: rainSourceError },
			{ id: 'set-flow', message: peError },
			{ id: 'set-flow', message: arealError },
			{ id: 'set-wr2012', message: wr2012Error },
			{ id: 'set-ewr', message: reportError },
			{ id: 'set-reserve', message: reserveError },
			{ id: 'set-restrict', message: restrictErr },
			{ id: 'set-period', message: dateError },
			{ id: 'set-quality', message: dqError },
			{ id: 'set-outcomes', message: outError },
			{ id: 'set-outlook', message: outlookErr },
			{ id: 'set-evidence', message: evidenceErr },
			{ id: 'set-auto', message: autoError }
		])
	);
	const farmAreaKm2 = $derived(
		(editor?.model.nodes ?? []).filter((n) => n.kind === 'farm').reduce((t, n) => t + (n.areaKm2 || 0), 0)
	);
	const ewrAnnual = $derived(annualMm3(s.ewrPragmaticM3PerDay, s.februaryDays));
	// Days in February sits behind an advanced disclosure (issue #174); its summary names the value, and says when it
	// isn't the default, so a changed value is never hidden.
	const FEB_DEFAULT = defaultProjectSettings().februaryDays;
	const febChanged = $derived(Math.abs((s.februaryDays ?? FEB_DEFAULT) - FEB_DEFAULT) > 1e-9);
	const apanAnnual = $derived(s.apanMm.reduce((t, v) => t + (v || 0), 0));
	const panOutOfRange = $derived(panCoefficientOutOfRange(s.panCoefficient));

	const x2 = GR4J_FIELDS.find((f) => f.key === 'x2')!;

	function setX2Open(open: boolean) {
		x2Open = open;
		if (!open) s.gr4j.x2 = 0;
	}

	/** Fills panCoefficient with a preset's values (still editable after), and its source note with the preset's name. */
	function applyPanPreset(id: string) {
		const preset = PAN_COEFFICIENT_PRESETS.find((p) => p.id === id);
		if (preset) {
			s.panCoefficient = [...preset.values];
			s.panCoefficientSource = `${preset.label} preset: ${PAN_COEFFICIENT_PRESET_SOURCE}`;
		}
		panPreset = '';
	}

	/**
	 * Fills the monthly dam evaporation factors from a lake-factor preset (still editable after) and the source note
	 * with its citation and pan conversion. A WR90 preset needs the monthly A-pan, since it converts S-pan factors at it.
	 */
	function applyLakePreset(id: string) {
		lakePreset = '';
		if (!id) return;
		const fill = lakeFactorPresetFill(id, $state.snapshot(s.apanMm));
		if (!fill.ok) {
			lakePresetError = `Can't fill from that preset: ${fill.reason}.`;
			return;
		}
		lakePresetError = null;
		s.lakeEvapFactorMonthly = [...fill.values];
		s.lakeEvapFactorSource = fill.note;
	}

	/** The preset the source note names, when the factors or the A-pan have moved on since it was filled. */
	const lakePresetStale = $derived(
		lakeFactorPresetStale({ lakeEvapFactor: s.lakeEvapFactor, lakeEvapFactorMonthly: s.lakeEvapFactorMonthly, lakeEvapFactorSource: s.lakeEvapFactorSource, apanMm: s.apanMm })
			? lakeFactorPresetNamed(s.lakeEvapFactorSource)
			: null
	);

	/** Choose where GR4J's PE comes from; a monthly row switched away from is remembered until saved or discarded. */
	function setPeKind(kind: EditablePe['kind']) {
		if (pe.kind === 'monthly') lastMonthlyPe = $state.snapshot(pe) as EditablePe;
		s.pe = withPeKind(s, kind, lastMonthlyPe);
	}

	/** Writes a fit's parameters, and its record, into the form (unsaved). */
	// The rules as saved: the server runs automated calibration only on these (issue #153).
	const savedRules = $derived((JSON.parse(saved) as ProjectSettings).calibrationRules);
	// The declared uncertainty rule as saved (issue #71): switching it off withdraws this one.
	const savedEvidenceRule = $derived((JSON.parse(saved) as ProjectSettings).evidenceUncertaintyRule);

	/** The server saved an automated fit (issue #153): take the project's settings as they now are. */
	async function reloadAfterApply() {
		const p = await api.projects.get(project.id);
		onProjectChange(p);
		s = clone(p.settings);
		saved = JSON.stringify(clone(p.settings));
		x2Open = s.gr4j.x2 !== 0;
	}

	function applyFit(report: CalibrationReport, record: FitRecord) {
		s = { ...applyReport(s, report), fitRecord: record };
		if (report.model === 'gr4j' && s.gr4j.x2 !== 0) x2Open = true;
	}

	function discard() {
		s = clone(JSON.parse(saved));
		x2Open = s.gr4j.x2 !== 0;
		lastMonthlyPe = null;
		lastAreal = null;
		error = null;
		reason = '';
	}

	/** The optional "why" of the save, kept with the change in the History tab. */
	let reason = $state('');

	// Preview (issue #284): the unsaved settings, and any unsaved model edits that have no problems, on the last run.
	let previewOpen = $state(false);
	let previewMounted = $state(false);
	const previewModel = $derived(!!editor?.dirty && editor.issues.length === 0);
	function previewEdits(): UnsavedEdits {
		return {
			settings: { saved: JSON.parse(saved), draft: $state.snapshot(s) as unknown as NonNullable<UnsavedEdits['settings']>['draft'] },
			...(editor && previewModel ? { model: { saved: editor.savedModel(), draft: editor.snapshot() } } : {})
		};
	}
	function openPreview() {
		previewMounted = true;
		previewOpen = true;
	}

	async function save(e: SubmitEvent) {
		e.preventDefault();
		if (blocked) return;
		saving = true;
		error = null;
		justSaved = false;
		try {
			const why = reason.trim();
			const p = await api.projects.update(project.id, { settings: $state.snapshot(s) as unknown as ProjectSettings, ...(why ? { reason: why } : {}) });
			reason = '';
			onProjectChange(p);
			s = clone(p.settings);
			saved = JSON.stringify(clone(p.settings));
			x2Open = s.gr4j.x2 !== 0;
				justSaved = true;
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
		} finally {
			saving = false;
		}
	}

	const METHODS: { value: FlowShareMethod; label: string; help: string }[] = [
		{ value: 'area', label: 'By catchment area', help: "Each hydrological unit's share = its area ÷ the total hydrological unit area." },
		{
			value: 'hiLo',
			label: 'High/low MAP split',
			help: 'High-MAP areas share the high part of the split and low-MAP areas the low part (WR90/WR2012 practice).'
		},
		{ value: 'manual', label: 'Manual share per hydrological unit', help: 'Shares typed per hydrological unit on the Network tab ("Manual flow share").' }
	];
	const method = $derived(METHODS.find((m) => m.value === s.flowShareMethod));
	const chirpsOption = $derived(CHIRPS_BIAS_OPTIONS.find((o) => o.value === s.chirpsBiasCorrection));
	// The engine refuses a GR4J run without it (runoff/simulate.ts).
	// A daily A-pan series (issue #45) is A-pan too, on the days it covers.
	const apanSource = $derived(apanSourceNote(seriesKinds));
	// Where calibration can score besides the outlet (engine ≥ 1.41.0): the inner gauges with a record,
	// and the records at the chosen site (the outlet's otherwise), which decide what a fit can use.
	const calSites = $derived(editor && gaugeRecords ? calibrationSites(editor.model, Object.fromEntries(gaugeRecords.map((r) => [calibrationSeriesKey(r.kind as CalibrationFlowKind, r.siteNodeId), true]))) : []);
	const recordKinds = $derived(s.calibrationSiteNodeId ? (calSites.find((x) => x.nodeId === s.calibrationSiteNodeId)?.records ?? []) : seriesKinds);
	const hasRecord = $derived(recordKinds === null || recordKinds.some((k) => (CALIBRATION_FLOW_KINDS as readonly string[]).includes(k)));
	const nodeName = (id: string) => editor?.model.nodes.find((n) => n.id === id)?.name;
	// The daily A-pan series now, as the fit record fingerprints it (issue #45): fetched and hashed only
	// when the record tracked one, so "forcing changed since fit" can say whether it was replaced.
	let apanNow = $state<ApanDailyFingerprint | null | undefined>(undefined);
	const apanTracked = $derived(s.fitRecord?.forcing?.apanDaily !== undefined);
	$effect(() => {
		const meta = apanSeries;
		const tracked = apanTracked;
		apanNow = meta === null ? null : undefined;
		if (!meta || !tracked) return;
		let live = true;
		api.series
			.get(project.id, meta.id)
			.then(apanDailyOfValues)
			.then((f) => {
				if (live) apanNow = f;
			})
			.catch(() => {
				// Unknown, not "changed": the caveat then waits for a value it can compare.
				if (live) apanNow = undefined;
			});
		return () => {
			live = false;
		};
	});
	const petMissing = $derived(
		!hasPotentialEvaporation({ apanMm: s.apanMm, panCoefficient: s.panCoefficient, pe: s.pe as PeInput | undefined }, apanSource?.daily ?? false)
	);

	// The in-page menu (SectionNav) and the save bar both stick, so in-page jumps
	// and focus scrolling keep clear of them (WCAG 2.4.11) while this tab is shown.
	let actionsHeight = $state(0);
	$effect(() => {
		const root = document.documentElement;
		root.style.scrollPaddingBottom = actionsHeight ? `${actionsHeight + 12}px` : '';
		return () => {
			root.style.scrollPaddingBottom = '';
		};
	});
	const navLabel = (id: string) => SETTINGS_SECTIONS.find((sec) => sec.id === id)?.label ?? id;
	// A link that stands for several panels ("Automation & access") takes the group's name and shows a problem on any of them.
	const navGroups = $derived(
		settingsNavGroups(project.role === 'owner').map((g) => ({
			label: g.label,
			sections: g.ids.map((id) => {
				const covers = g.covers?.[id];
				return { id, label: covers ? g.label : navLabel(id), problem: blockers.some((b) => (covers ?? [id]).includes(b.id)) };
			})
		}))
	);

	// The section header (issue #17): where the parameters came from, and the way to the fit.
	const fitStatus = $derived(s.fitRecord ? fitRecordStatus(s as unknown as ProjectSettings, s.fitRecord, { chirpsSource, apanDaily: apanNow }) : null);
	const summary = $derived(fitSummary(s.fitRecord, !!fitStatus && fitRecordCaveats(fitStatus).length > 0));
	$effect(() => fillHeader({ context: headerContext, actions: headerActions }));

	// A link into a group from elsewhere (`?tab=settings#set-ewr`, a note's link): the tab is a lazy
	// chunk, so the browser's own jump found nothing. Land on the group once drawn, hold it while the
	// panels settle (as River & reserve does), and focus its heading.
	onMount(() => {
		const hash = page.url.hash.slice(1);
		const el = hash.startsWith('set-') ? document.getElementById(hash) : null;
		if (!el) return;
		const release = holdAnchor(el);
		const heading = el.querySelector<HTMLElement>('h2, h3');
		if (heading) {
			if (!heading.hasAttribute('tabindex')) heading.tabIndex = -1;
			heading.focus({ preventScroll: true });
		}
		return release;
	});
</script>

{#snippet headerContext()}<span data-testid="fit-summary">{summary}</span>{/snippet}
{#snippet headerActions()}
	{#if !readonly}<a class="btn" href="#set-fit">Fit the parameters</a>{:else if s.fitRecord}<a class="btn" href="#set-fit">Fit record</a>{/if}
{/snippet}

<!-- In-page menu: sticks under the app header down this long form and marks the group being read.
     Its groups (model inputs, how results are read, what runs by itself) replace the old intro line;
     the header's context says where the parameters came from. Outside the form, so it stays stuck
     down the panels after it too (inside, it scrolled away at Data feeds). -->
<!-- No visible group names: with them its links no longer fit two rows at 1280 px, so its
     links are evenly spaced instead (common/SectionNav, issue #162). -->
<SectionNav groups={navGroups} label="Settings sections" />

<form onsubmit={save} novalidate>
	{#if error}<div class="alert alert-error" role="alert">{error}</div>{/if}

	<!-- Demand ------------------------------------------------------------------>
	<section class="panel" id="set-demand" aria-labelledby="dem-h">
		<div class="panel-head">
			<h2 id="dem-h">Demand</h2>
			<span class="muted small">Gross irrigation need = A-pan × crop factor × area</span>
			<NotesDrawer projectId={project.id} target={settingTarget('demand')} />
		</div>
		<div class="table-wrap">
			<table class="data compact monthly">
				<thead>
					<tr>
						<th scope="col" class="sticky">Parameter</th>
						{#each WATER_YEAR_MONTHS as m (m)}<th scope="col" class="num">{m}</th>{/each}
						<th scope="col" class="num">Year</th>
					</tr>
				</thead>
				<tbody>
					<tr>
						<th scope="row" class="sticky">A-pan evaporation <span class="u">mm</span> <HelpTip key="settings.apanMm" /></th>
						{#each WATER_YEAR_MONTHS as m, i (m)}
							<td><NumberInput label="A-pan evaporation, {m}, mm" min={0} disabled={readonly} bind:value={s.apanMm[i]} /></td>
						{/each}
						<td class="num muted">{fmtNum(apanAnnual)}</td>
					</tr>
				</tbody>
			</table>
		</div>
		<p class="hint muted">
			Monthly Class-A pan evaporation for the catchment, usually from the WR90 / WR2012 tables for its quaternary catchment.
		</p>
		{#if apanSource}<p class="hint" data-testid="apan-source" data-daily={apanSource.daily}>{apanSource.text}</p>{/if}
		{#if s.lakeEvapFactorMonthly}
			<div class="table-wrap">
				<table class="data compact monthly" data-testid="lake-factor-row">
					<caption class="visually-hidden">Dam evaporation factor by month, × A-pan</caption>
					<thead>
						<tr>
							<th scope="col" class="sticky">Parameter</th>
							{#each WATER_YEAR_MONTHS as m (m)}<th scope="col" class="num">{m}</th>{/each}
						</tr>
					</thead>
					<tbody>
						<tr>
							<th scope="row" class="sticky">Dam evaporation factor <span class="u">× A-pan</span> <HelpTip key="settings.lakeEvapFactorMonthly" /></th>
							{#each WATER_YEAR_MONTHS as m, i (m)}
								<td><NumberInput label="Dam evaporation factor, {m}, × A-pan" min={0} max={2} step={0.01} disabled={readonly} bind:value={s.lakeEvapFactorMonthly[i]} /></td>
							{/each}
						</tr>
					</tbody>
				</table>
			</div>
			<p class="hint muted">These replace the single dam evaporation factor below, month by month. Untick “Vary it by month” to go back to one factor.</p>
		{/if}
		<div class="fields">
			<div class="field">
				<span class="lbl"><label for="st-erf">Effective rainfall <span class="u">(%)</span></label><HelpTip key="settings.effectiveRainFraction" /></span>
				<NumberInput id="st-erf" min={0} max={100} scale={100} disabled={readonly} bind:value={s.effectiveRainFraction} aria-describedby="st-erf-h" />
				<span class="hint" id="st-erf-h">Share of each day's rain on the cropped area that the crop can use, reducing irrigation demand. The workbook default is 65 %.</span>
				<FieldHistoryLine field="settings:effectiveRainFraction" />
			</div>
			<div class="field">
				<span class="lbl"><label for="st-ers">Soil-water store <span class="u">(mm)</span></label><HelpTip key="settings.effectiveRainStoreMm" /></span>
				<NumberInput id="st-ers" min={0} max={500} step={1} disabled={readonly} bind:value={s.effectiveRainStoreMm} aria-describedby="st-ers-h" />
				<span class="hint" id="st-ers-h">Effective rain the crop can't use on the day is kept for the next days, up to this depth. 25 mm (FAO-56) by default; 0 carries nothing over, as the workbook does.</span>
				<FieldHistoryLine field="settings:effectiveRainStoreMm" />
			</div>
			<div class="field">
				<span class="lbl"><label for="st-lef">Dam evaporation factor <span class="u">(× A-pan)</span></label><HelpTip key="settings.lakeEvapFactor" /></span>
				<NumberInput id="st-lef" min={0} max={2} step={0.01} disabled={readonly} bind:value={s.lakeEvapFactor} aria-describedby="st-lef-h" />
				<span class="hint" id="st-lef-h">Open-water evaporation from the hydrological units’ dams as a multiple of A-pan. 0.75 by default; 0 turns dam evaporation off. WR90 lake factors are S-pan based: don't enter them here unchanged.</span>
				<FieldHistoryLine field="settings:lakeEvapFactor" />
				<label class="check">
					<input
						type="checkbox"
						disabled={readonly}
						checked={!!s.lakeEvapFactorMonthly}
						onchange={(e) => (s.lakeEvapFactorMonthly = e.currentTarget.checked ? new Array(12).fill(s.lakeEvapFactor) : null)}
					/>
					Vary it by month <HelpTip key="settings.lakeEvapFactorMonthly" />
				</label>
			</div>
		</div>
		<div class="field lake-preset">
			<span class="lbl"><label for="st-lake-preset">Dam evaporation preset</label><HelpTip key="settings.lakeEvapFactorSource" /></span>
			<select id="st-lake-preset" disabled={readonly} value={lakePreset} onchange={(e) => {
					applyLakePreset(e.currentTarget.value);
					// Back to "Fill from a preset…" (lakePreset stays '', so the binding alone wouldn't reset it).
					e.currentTarget.value = '';
				}} aria-describedby="st-lake-preset-h">
				<option value="">Fill from a preset…</option>
				{#each LAKE_FACTOR_PRESETS as p (p.id)}<option value={p.id}>{p.label}</option>{/each}
			</select>
			<span class="hint" id="st-lake-preset-h">
				Fills the monthly factors (still editable) and the source note below. The WR90 lake factors are S-pan ratios, so the WR90 presets convert them to A-pan at this project's monthly A-pan: enter the A-pan first, and fill again after changing it.
			</span>
			{#if lakePresetError}<span class="err" role="status" data-testid="lake-preset-error">{lakePresetError}</span>{/if}
		</div>
		<div class="field lake-source">
			<span class="lbl"><label for="st-lake-source">Dam evaporation factor source</label><HelpTip key="settings.lakeEvapFactorSource" /></span>
			<input
				id="st-lake-source"
				readonly={readonly}
				maxlength={PE_SOURCE_MAX}
				value={s.lakeEvapFactorSource ?? ''}
				placeholder="e.g. a preset, or a site study of this dam"
				aria-describedby="st-lake-source-h"
				oninput={(e) => (s.lakeEvapFactorSource = e.currentTarget.value)}
			/>
			<span class="hint" id="st-lake-source-h">Optional: where the factors come from. A preset fills it; it is recorded with each run and shown in run comparisons and the report.</span>
			<FieldHistoryLine field="settings:lakeEvapFactorSource" />
		</div>
		{#if lakePresetStale}
			<p class="alert alert-warning small" role="status" data-testid="lake-preset-stale">
				The dam evaporation factors no longer match the “{lakePresetStale.label}” preset the source note names (a factor or the A-pan changed since it was filled): fill it again, or update the note.
			</p>
		{/if}
		<details class="advanced" data-testid="feb-advanced">
			<summary>
				Advanced: days in February, {fmtNum(s.februaryDays, 2, true)}{#if febChanged}{' '}<span class="changed">(not the default {fmtNum(FEB_DEFAULT, 2)})</span>{/if}
			</summary>
			<div class="field">
				<span class="lbl"><label for="st-feb">Days in February</label><HelpTip key="settings.februaryDays" /></span>
				<NumberInput id="st-feb" min={28} max={29} step={0.01} disabled={readonly} bind:value={s.februaryDays} aria-describedby="st-feb-h" />
				<span class="hint" id="st-feb-h">Converts monthly volumes to per-day figures. 28.25 averages leap years, as the workbook does.</span>
				<FieldHistoryLine field="settings:februaryDays" />
			</div>
		</details>
	</section>

	<!-- Flow generation ------------------------------------------------------------>
	<section class="panel" id="set-flow" aria-labelledby="cal-h">
		<div class="panel-head">
			<h2 id="cal-h">Flow calibration (rain → natural flow)</h2>
			<span class="muted small">Tune against observed flow; check NSE and PBIAS on Runs & results</span>
			<NotesDrawer projectId={project.id} target={settingTarget('flow')} />
		</div>
		<div class="fields">
			<div class="field">
				<span class="lbl">Runoff model <HelpTip key="settings.runoffModel" /></span>
				<strong data-testid="runoff-model">{RUNOFF_MODEL_LABEL}</strong>
				<span class="hint">{RUNOFF_MODEL_HELP}</span>
			</div>
			<div class="field">
				<span class="lbl"><label for="cal-catchmentAreaKm2">Catchment area <span class="u">(km²)</span></label><HelpTip key="calibration.catchmentAreaKm2" /></span>
				<NumberInput
					id="cal-catchmentAreaKm2"
					min={0}
					nullable
					placeholder="{fmtNum(farmAreaKm2, 2)} (sum of hydrological units)"
					disabled={readonly}
					bind:value={s.calibration.catchmentAreaKm2}
					aria-describedby="cal-area-h"
				/>
				<span class="hint" id="cal-area-h">
					Area the rain falls on. Leave blank to use the sum of the hydrological unit areas —
					<strong>{fmtNum(farmAreaKm2, 2)} km²</strong> now.{#if cal.catchmentAreaKm2 != null && Math.abs(cal.catchmentAreaKm2 - farmAreaKm2) > 0.005}
						Overridden: {fmtNum(cal.catchmentAreaKm2, 2)} km² is used.{/if}
				</span>
				<FieldHistoryLine field="settings:calibration.catchmentAreaKm2" />
			</div>
		</div>
		{#if petMissing}
			<p class="alert alert-warning" role="status">
				{#if pe.kind === 'monthly'}
					GR4J needs potential evaporation, and the monthly PE row (below) is 0 in every month. Without it the catchment would never dry out,
					so runs and fits are refused.
				{:else}
					GR4J needs A-pan evaporation (Demand, above) and a pan coefficient above 0 (below). Without them the catchment would never dry
					out, so runs and fits are refused.
				{/if}
			</p>
		{/if}
		<div class="fields">
			{#each GR4J_FIELDS.filter((f) => !f.fixedByDefault) as p (p.key)}
				<div class="field">
					<span class="lbl"><label for="gr4j-{p.key}">{p.label} <span class="u">({p.unit})</span></label><HelpTip key="settings.gr4j" /></span>
					<!-- A fit writes nine decimals; three show (display only, as the fit record does). -->
					<NumberInput id="gr4j-{p.key}" min={p.min} max={p.max} step={p.step} decimals={3} disabled={readonly} bind:value={s.gr4j[p.key]} aria-describedby="gr4j-{p.key}-h" />
					<span class="hint" id="gr4j-{p.key}-h">{p.help} {typicalRange(p)}</span>
					<FieldHistoryLine field="settings:gr4j.{p.key}" />
				</div>
			{/each}
			<div class="field">
				<span class="lbl"><label for="gr4j-warmup">Warm-up <span class="u">(days)</span></label></span>
				<NumberInput id="gr4j-warmup" min={0} max={3650} step={1} disabled={readonly} bind:value={s.gr4j.warmupDays} aria-describedby="gr4j-warmup-h" />
				<span class="hint" id="gr4j-warmup-h">Days run before the first simulated day, repeating the start of the record, so the stores begin at a realistic level. Never shown or scored. Default 365.</span>
				<FieldHistoryLine field="settings:gr4j.warmupDays" />
			</div>
			<div class="field">
				<span class="lbl"><label for="cal-rainThresholdMm">Rain threshold for demand <span class="u">(mm)</span></label><HelpTip key="calibration.rainThresholdMm" /></span>
				<NumberInput id="cal-rainThresholdMm" min={0} step={0.1} disabled={readonly} value={cal.rainThresholdMm} aria-describedby="cal-thr-h" onchange={(v) => { if (v !== null) s.calibration.rainThresholdMm = v; }} />
				<span class="hint" id="cal-thr-h">Under GR4J this only decides which rain days reduce irrigation demand; the runoff model uses all rain.</span>
				<FieldHistoryLine field="settings:calibration.rainThresholdMm" />
			</div>
		</div>
		<fieldset class="plain x2">
			<legend>Groundwater exchange (X2)</legend>
			<label class="check">
				<input type="checkbox" disabled={readonly} checked={x2Open} onchange={(e) => setX2Open(e.currentTarget.checked)} />
				Let the catchment gain or lose groundwater
			</label>
			{#if x2Open}
				<div class="field">
					<label for="gr4j-x2">{x2.label} <span class="u">({x2.unit})</span></label>
					<NumberInput id="gr4j-x2" min={x2.min} max={x2.max} step={x2.step} disabled={readonly} bind:value={s.gr4j.x2} aria-describedby="gr4j-x2-h" />
				</div>
			{/if}
			<span class="hint" id="gr4j-x2-h">{x2.help} Off, X2 is 0 and the water balance closes within the catchment; on, the exchange is reported as its own series.</span>
			<FieldHistoryLine field="settings:gr4j.x2" />
		</fieldset>
		<!-- The areal rainfall correction (settings.arealRain, engine ≥ 1.13.0): GR4J's rain only;
		     irrigation demand's effective rain and rain on the dams keep the recorded rain. -->
		<fieldset class="plain areal" data-testid="areal-rain">
			<legend>Areal rainfall correction <HelpTip key="settings.arealRain" /></legend>
			<label class="check">
				<input type="checkbox" disabled={readonly} checked={!!areal} onchange={(e) => setArealOn(e.currentTarget.checked)} />
				Scale the rain GR4J runs on to the catchment’s areal rain
			</label>
			<span class="hint" id="st-areal-h">
				For a rain record that misses the catchment’s rain, such as a valley gauge or CHIRPS under a mountain range. A fixed input with its
				source, never a calibrated parameter. Demand and the dams keep the recorded rain.
			</span>
			{#if areal}
				<div class="fields">
					<div class="field">
						<span class="lbl"><label for="st-areal-all">Factor in every month <span class="u">(×)</span></label></span>
						<NumberInput
							id="st-areal-all"
							min={0.25}
							max={4}
							step={0.01}
							decimals={3}
							disabled={readonly}
							value={arealFlat}
							aria-describedby="st-areal-all-h"
							onchange={(v) => {
								if (v !== null && s.arealRain) s.arealRain = storedArealRain(withFactorEveryMonth(areal, v));
							}}
						/>
						<span class="hint" id="st-areal-all-h">An independent MAP ÷ the forcing’s mean annual rain gives one factor. {arealFlat === null ? 'The months differ now (below).' : ''}</span>
					</div>
					<div class="field">
						<span class="lbl"><label for="st-areal-method">Derived from</label></span>
						<select
							id="st-areal-method"
							disabled={readonly}
							value={areal.method}
							aria-describedby="st-areal-method-h"
							onchange={(e) => {
								if (s.arealRain) s.arealRain = storedArealRain({ ...areal, method: e.currentTarget.value as EditableArealRain['method'] });
							}}
						>
							{#each AREAL_METHOD_OPTIONS as o (o.value)}<option value={o.value}>{o.label}</option>{/each}
						</select>
						<span class="hint" id="st-areal-method-h">{AREAL_METHOD_OPTIONS.find((o) => o.value === areal.method)?.hint}</span>
					</div>
				</div>
				<div class="table-wrap">
					<table class="data compact monthly">
						<thead>
							<tr>
								<th scope="col" class="sticky">Month</th>
								{#each WATER_YEAR_MONTHS as m (m)}<th scope="col" class="num">{m}</th>{/each}
							</tr>
						</thead>
						<tbody>
							<tr>
								<th scope="row" class="sticky">Areal factor <span class="u">×</span></th>
								{#each WATER_YEAR_MONTHS as m, i (m)}
									<td>
										<NumberInput
											label="Areal rainfall factor, {m}"
											min={0.25}
											max={4}
											step={0.01}
											decimals={3}
											disabled={readonly}
											value={areal.factors[i] ?? 1}
											onchange={(v) => {
												if (v !== null && s.arealRain) s.arealRain = storedArealRain({ ...areal, factors: areal.factors.map((f, j) => (j === i ? v : f)) });
											}}
										/>
									</td>
								{/each}
							</tr>
						</tbody>
					</table>
				</div>
				<div class="field pe-source">
					<span class="lbl"><label for="st-areal-source">Source</label></span>
					<input
						id="st-areal-source"
						readonly={readonly}
						required
						value={areal.source}
						placeholder="e.g. catchment MAP 560 mm (reference) ÷ CHIRPS mean 2001–2024"
						aria-invalid={(!!arealError && !areal.source.trim()) || undefined}
						aria-describedby="st-areal-source-h"
						oninput={(e) => {
							if (s.arealRain) s.arealRain = storedArealRain({ ...areal, source: e.currentTarget.value });
						}}
					/>
					<span class="hint" id="st-areal-source-h">Required: the MAP or gauges and their reference, and the years compared. A fit records the factors, so changing them marks it “Forcing changed since fit”.</span>
					{#if arealError}<span class="err" role="status">{arealError}</span>{/if}
				</div>
				<FieldHistoryLine field="settings:arealRain" />
			{/if}
		</fieldset>
		<!-- Where GR4J's potential evaporation comes from (settings.pe, issue #39). Irrigation
		     demand and dam evaporation read the A-pan row whichever is chosen. -->
		<fieldset class="plain pe" data-testid="gr4j-pe" aria-describedby="st-pe-annual st-pe-h">
			<legend>GR4J potential evaporation <HelpTip key="settings.pe" /></legend>
			{#each PE_KIND_OPTIONS as o (o.value)}
				<label class="check">
					<input type="radio" name="st-pe-kind" value={o.value} checked={pe.kind === o.value} disabled={readonly} onchange={() => setPeKind(o.value)} />
					{o.label}
				</label>
			{/each}
			<p class="pe-annual" id="st-pe-annual" data-testid="gr4j-pe-annual">
				Annual GR4J PE: <strong>{fmtNum(peAnnual)} mm</strong>
				<span class="muted">{pe.kind === 'monthly' ? '(the monthly PE row below)' : `(pan coefficient × A-pan; A-pan ${fmtNum(apanAnnual)} mm a year)`}</span>
			</p>
			<span class="hint" id="st-pe-h">
				{#if pe.kind === 'monthly'}
					GR4J runs on the monthly PE row below. Irrigation demand and dam evaporation still use the A-pan row (Demand, above), and GR4J
					doesn’t use the pan coefficient.
				{:else}
					GR4J runs on pan coefficient × A-pan. The A-pan row (Demand, above) also drives irrigation demand and dam evaporation, so changing
					it moves all three; to change GR4J’s PE alone, enter a monthly PE.
				{/if}
			</span>
		</fieldset>
		{#if pe.kind === 'monthly'}
			<div class="table-wrap">
				<table class="data compact monthly">
					<thead>
						<tr>
							<th scope="col" class="sticky">Month</th>
							{#each WATER_YEAR_MONTHS as m (m)}<th scope="col" class="num">{m}</th>{/each}
							<th scope="col" class="num">Year</th>
						</tr>
					</thead>
					<tbody>
						<tr>
							<th scope="row" class="sticky">Monthly PE <span class="u">mm</span> <HelpTip key="settings.pe" /></th>
							{#each WATER_YEAR_MONTHS as m, i (m)}
								<td>
									<NumberInput
										label="Monthly PE, {m}, mm"
										min={0}
										max={PE_MONTH_MAX_MM}
										disabled={readonly}
										value={pe.mm[i] ?? 0}
										onchange={(v) => {
											if (v !== null && s.pe?.kind === 'monthly') s.pe.mm[i] = v;
										}}
									/>
								</td>
							{/each}
							<td class="num muted">{fmtNum(peAnnual)}</td>
						</tr>
					</tbody>
				</table>
			</div>
			<div class="field pe-source">
				<span class="lbl"><label for="st-pe-source">Source</label></span>
				<input
					id="st-pe-source"
					readonly={readonly}
					required
					value={pe.source}
					placeholder="e.g. station FAO-56 ET₀ × 1.0, 2015–2020"
					aria-invalid={peSourceBad || undefined}
					class:invalid={peSourceBad}
					aria-describedby="st-pe-source-h"
					oninput={(e) => {
						if (s.pe?.kind === 'monthly') s.pe.source = e.currentTarget.value;
					}}
				/>
				<span class="hint" id="st-pe-source-h">Required: where the values come from, e.g. the station, the method, any factor applied and the years.</span>
				{#if peError}<span class="err" role="status">{peError}</span>{/if}
			</div>
		{:else}
			<div class="field pan-preset">
				<span class="lbl"><label for="st-pan-preset">Pan-coefficient preset</label></span>
				<select id="st-pan-preset" disabled={readonly} value={panPreset} onchange={(e) => {
						applyPanPreset(e.currentTarget.value);
						// Back to "Choose a preset…": panPreset was '' already, so setting it again doesn't touch the DOM.
						e.currentTarget.value = '';
					}} aria-describedby="st-pan-preset-h">
					<option value="">Choose a preset…</option>
					{#each PAN_COEFFICIENT_PRESETS as p (p.id)}<option value={p.id}>{p.label}</option>{/each}
				</select>
				<span class="hint" id="st-pan-preset-h">Fills the row below with these monthly values, which stay editable; the source note below records which preset. {PAN_COEFFICIENT_PRESET_SOURCE}.</span>
			</div>
			{#if !readonly}
				<!-- The FAO-56 Table 5 helper (issue #39): only fills the row below; it is collapsed until opened. -->
				<PanCoefficientHelper
					onapply={(v: number[], note: string) => {
						s.panCoefficient = [...v] as typeof s.panCoefficient;
						s.panCoefficientSource = note.slice(0, PE_SOURCE_MAX);
					}}
				/>
			{/if}
			<div class="table-wrap">
				<table class="data compact monthly">
					<thead>
						<tr>
							<th scope="col" class="sticky">Month</th>
							{#each WATER_YEAR_MONTHS as m (m)}<th scope="col" class="num">{m}</th>{/each}
						</tr>
					</thead>
					<tbody>
						<tr>
							<th scope="row" class="sticky">Pan coefficient <HelpTip key="settings.panCoefficient" /></th>
							{#each WATER_YEAR_MONTHS as m, i (m)}
								<td><NumberInput label="Pan coefficient, {m}" min={0} max={2} step={0.01} disabled={readonly} bind:value={s.panCoefficient[i]} /></td>
							{/each}
						</tr>
					</tbody>
				</table>
			</div>
			<p class="hint muted">Potential evaporation = pan coefficient × A-pan, per month. 0.7 is a common flat value.</p>
			<div class="field pan-source">
				<span class="lbl"><label for="st-pan-source">Pan coefficient source</label><HelpTip key="settings.panCoefficientSource" /></span>
				<input
					id="st-pan-source"
					readonly={readonly}
					maxlength={PE_SOURCE_MAX}
					value={s.panCoefficientSource ?? ''}
					placeholder="e.g. FAO-56 Table 5, Case A, 10 m fetch; RH and wind from a nearby station"
					aria-describedby="st-pan-source-h"
					oninput={(e) => (s.panCoefficientSource = e.currentTarget.value)}
				/>
				<span class="hint" id="st-pan-source-h">Optional: where the row comes from. A preset or the FAO-56 helper fills it; it is recorded with each fit and run, and changing it alone doesn't mark a fit's forcing as changed.</span>
			</div>
			{#if panOutOfRange.length}
				<p class="alert alert-warning small" role="status">
					Pan coefficient is outside FAO-56's typical Class A pan range ({PAN_COEFFICIENT_TYPICAL_MIN}–{PAN_COEFFICIENT_TYPICAL_MAX}) in
					{panOutOfRange.map((i) => WATER_YEAR_MONTHS[i]).join(', ')}: confirm against local humidity and wind.
				</p>
			{/if}
		{/if}
	</section>

	<!-- How missing catchment rain is filled: CHIRPS, bias-corrected or raw, on
	     blank days and on the zero-rain runs treated as missing. -->
	<section class="panel" id="set-rain" aria-labelledby="rain-h">
		<div class="panel-head">
			<h2 id="rain-h">Rain gaps and CHIRPS</h2>
			<span class="muted small">Which days CHIRPS fills in the catchment rain, and how, and periods taken from another gauge</span>
			<NotesDrawer projectId={project.id} target={settingTarget('rain')} />
		</div>
		<div class="fields">
			<div class="field">
				<span class="lbl"><label for="st-chirps-bias">CHIRPS bias correction</label><HelpTip key="settings.chirpsBiasCorrection" /></span>
				<select id="st-chirps-bias" disabled={readonly} bind:value={s.chirpsBiasCorrection} aria-describedby="st-chirps-bias-h">
					{#each CHIRPS_BIAS_OPTIONS as o (o.value)}<option value={o.value}>{o.label}</option>{/each}
				</select>
				<span class="hint" id="st-chirps-bias-h">{chirpsOption?.help}</span>
			</div>
		</div>
		<!-- The CHIRPS gap map (settings.chirpsQuantileMap, engine ≥ 1.53.0, CR-23): maps bias-corrected CHIRPS, so it waits for bias correction. -->
		<fieldset class="plain" data-testid="chirps-quantile-map">
			<legend>CHIRPS quantile map <HelpTip key="settings.chirpsQuantileMap" /></legend>
			<label class="check">
				<input
					type="checkbox"
					disabled={readonly || s.chirpsBiasCorrection !== 'monthly'}
					checked={!!s.chirpsQuantileMap}
					onchange={(e) => setGapMapOn(e.currentTarget.checked)}
					aria-describedby="st-chirps-qm-h"
				/>
				Quantile-map the CHIRPS that fills gaps onto the catchment rain (each month’s total kept)
			</label>
			{#if s.chirpsQuantileMap}
				{@const q = s.chirpsQuantileMap}
				<div class="field">
					<label for="st-chirps-qm-wet">Wet day from <span class="u">(mm)</span></label>
					<NumberInput
						id="st-chirps-qm-wet"
						min={QM_WET_DAY_MM_MIN}
						max={QM_WET_DAY_MM_MAX}
						step={0.1}
						disabled={readonly || s.chirpsBiasCorrection !== 'monthly'}
						value={q.wetDayMm}
						onchange={(v) => v !== null && (s.chirpsQuantileMap = { wetDayMm: v })}
					/>
				</div>
			{/if}
			<span class="hint" id="st-chirps-qm-h">
				{#if s.chirpsBiasCorrection !== 'monthly'}
					Needs bias correction: the map reshapes bias-corrected CHIRPS.{#if s.chirpsQuantileMap}{' '}A run ignores it and says so.{/if}
				{:else}
					Off, gap days take CHIRPS × the monthly factor. On, CHIRPS is also fitted to the catchment rain month by month over the fit period: where it is wet more
					often, its drizzle days go dry; its wet days take the catchment’s spread of falls; and each month is scaled back to its corrected total, so the volume
					doesn’t change. A month with fewer than {QM_MIN_WET_DAYS} wet days uses its three-month season, else keeps the factor alone (the run warns).
				{/if}
			</span>
			<FieldHistoryLine field="settings:chirpsQuantileMap" />
		</fieldset>
		<!-- Always mounted, like the other sections that feed the Save blocker: a list left invalid
		     after turning bias correction off must stay visible, or Save is blocked with nothing to fix. -->
		<ChirpsFitPeriodSection
			bind:value={s.chirpsFitPeriod}
			bind:error={fitPeriodError}
			{readonly}
			inactive={s.chirpsBiasCorrection !== 'monthly'}
			propose={() => proposeFitRanges(project.id, s.zeroRainRuns, s.dataQuality)}
		/>
		<ZeroRainSection bind:value={s.zeroRainRuns} bind:error={zeroRainError} {readonly} />
		<RainSourceSection bind:value={s.rainSource} bind:error={rainSourceError} {readonly} />
	</section>

	<section class="panel" id="set-record" aria-labelledby="rec-h">
		<div class="panel-head">
			<h2 id="rec-h">Calibration record</h2>
			<span class="muted small">The observed flow the parameters are scored against, and what is left out</span>
			<NotesDrawer projectId={project.id} target={settingTarget('record')} />
		</div>
		<CalibrationWindowFields
			bind:start={s.calibrationStart}
			bind:end={s.calibrationEnd}
			bind:flowKind={s.calibrationFlowKind}
			bind:siteNodeId={s.calibrationSiteNodeId}
			bind:error={calWindowError}
			{readonly}
			availableKinds={seriesKinds}
			sites={calSites}
		/>
		<CalibrationExclusions bind:list={s.calibrationExclusions} bind:error={exclusionsError} {readonly} />
		<Lazy load={loadQualityFlags}>
			{#snippet children(QualityFlagsFields)}<QualityFlagsFields bind:value={s.qualityFlags} bind:error={qualityFlagsErr} {readonly} {seriesKinds} />{/snippet}
		</Lazy>
		<!-- Gap filling of the observed records (engine ≥ 1.23.0, issue #66); the server merges its default into every project's settings. -->
		{#if s.flowGapFill}
			<!-- Its own chunk (issue #66): the Settings tab chunk sits at its size ceiling. -->
			<Lazy load={loadFlowGapFill}>
				{#snippet children(FlowGapFillFields)}<FlowGapFillFields bind:value={s.flowGapFill} {readonly} {seriesKinds} />{/snippet}
			</Lazy>
		{/if}
	</section>

	<div class="panel" id="set-fit">
		<FitPanel
			projectId={project.id}
			{x2Open}
			settings={() => $state.snapshot(s) as unknown as ProjectSettings}
			model={() => (editor?.dirty ? editor.snapshot() : undefined)}
			hasObserved={hasRecord}
			seriesKinds={recordKinds}
			calibrationFlowKind={s.calibrationFlowKind}
			{readonly}
			onApply={applyFit}
		/>
		{#if s.fitRecord}
			<FitProvenance
				record={s.fitRecord}
				settings={s as unknown as ProjectSettings}
				heading="Fit record of these parameters"
				context="form"
				{chirpsSource}
				apanDaily={apanNow}
				observedOrigin={observedOrigins ? (observedOrigins[calibrationSeriesKey(s.fitRecord.flowKind as CalibrationFlowKind, s.fitRecord.siteNodeId)] ?? null) : undefined}
				{nodeName}
			/>
		{/if}
		<!-- Automated calibration (issue #153): its rules, saved with the form, then the run under the saved rules. -->
		{#if s.calibrationRules}
			<Lazy load={loadCalibrationRules}>
				{#snippet children(CalibrationRulesFields)}<CalibrationRulesFields bind:value={s.calibrationRules} bind:error={rulesErr} {readonly} />{/snippet}
			</Lazy>
			<Lazy load={loadAutoFit}>
				{#snippet children(AutoFitPanel)}
					<AutoFitPanel
						projectId={project.id}
						{savedRules}
						formRules={s.calibrationRules}
						formDirty={dirty}
						penalty={marPenaltyOn(s as unknown as ProjectSettings)}
						hasObserved={hasRecord}
						{readonly}
						onApplied={reloadAfterApply}
					/>
				{/snippet}
			</Lazy>
		{/if}
	</div>


	<div id="set-wr2012">
		<Wr2012Section
			bind:value={s.wr2012}
			bind:error={wr2012Error}
			{readonly}
			projectId={project.id}
			modelAreaKm2={cal.catchmentAreaKm2 != null && cal.catchmentAreaKm2 > 0 ? cal.catchmentAreaKm2 : farmAreaKm2}
		/>
	</div>

	<!-- Flow share ----------------------------------------------------------------->
	<section class="panel" id="set-share" aria-labelledby="share-h">
		<div class="panel-head">
			<h2 id="share-h">Flow share between hydrological units</h2>
			<span class="muted small">Splits catchment natural flow and the EWR into parts per hydrological unit</span>
			<NotesDrawer projectId={project.id} target={settingTarget('share')} />
		</div>
		<div class="fields">
			<div class="field">
				<span class="lbl"><label for="st-method">Method</label><HelpTip key="settings.flowShareMethod" /></span>
				<select id="st-method" disabled={readonly} bind:value={s.flowShareMethod} aria-describedby="st-method-h">
					{#each METHODS as m (m.value)}<option value={m.value}>{m.label}</option>{/each}
				</select>
				<span class="hint" id="st-method-h">{method?.help} The resulting share per hydrological unit is shown on the Network tab.</span>
				<FieldHistoryLine field="settings:flowShareMethod" />
			</div>
			<!-- Only the high/low MAP method reads the split, so it shows only then (issue #174); the saved value is kept. -->
			{#if s.flowShareMethod === 'hiLo'}
				<fieldset class="plain hilo" data-testid="hilo-split">
					<legend>High/low MAP split <HelpTip key="settings.hiLoSplit" /></legend>
					<div class="form-row">
						<div class="field">
							<label for="st-hi">High <span class="u">(%)</span></label>
							<NumberInput id="st-hi" min={0} max={100} scale={100} disabled={readonly} bind:value={s.hiLoSplit.hi} />
						</div>
						<div class="field">
							<label for="st-lo">Low <span class="u">(%)</span></label>
							<NumberInput id="st-lo" min={0} max={100} scale={100} disabled={readonly} bind:value={s.hiLoSplit.lo} />
						</div>
						<div class="field">
							<span class="label">Sum</span>
							<span class="sum" class:warn={Math.abs(hiLoSum - 1) > 1e-6}>{fmtPct(hiLoSum, 1)}</span>
						</div>
					</div>
					<span class="hint">Should add up to 100 %. Default 50 / 50; an imported workbook brings its own.</span>
				</fieldset>
			{/if}
		</div>
	</section>

	<!-- EWR -------------------------------------------------------------------------->
	<section class="panel" id="set-ewr" aria-labelledby="ewr-h">
		<div class="panel-head">
			<h2 id="ewr-h">Environmental water requirement (EWR)</h2>
			<span class="muted small">Pragmatic EWR at the outflow gauge</span>
			<NotesDrawer projectId={project.id} target={settingTarget('ewr')} />
		</div>
		<p class="hint muted">
			The flow that must stay in the river for the ecosystem (the Ecological Reserve). b023's <em>pragmatic</em> EWR is one fixed
			flow per month, so farmers can plan for it; the model checks it at the EWR sites (the outlet and every gauge) and charges
			each shortfall to the hydrological units upstream by their net impact that day.
		</p>
		<div class="ewr">
			<div class="table-wrap">
				<table class="data compact monthly">
					<thead>
						<tr>
							<th scope="col" class="sticky">Month</th>
							{#each WATER_YEAR_MONTHS as m (m)}<th scope="col" class="num">{m}</th>{/each}
						</tr>
					</thead>
					<tbody>
						<tr>
							<th scope="row" class="sticky">Pragmatic EWR <span class="u">m³/day</span> <HelpTip key="settings.ewrPragmaticM3PerDay" /></th>
							{#each WATER_YEAR_MONTHS as m, i (m)}
								<td><NumberInput label="Pragmatic EWR, {m}, m³/day" min={0} disabled={readonly} bind:value={s.ewrPragmaticM3PerDay[i]} /></td>
							{/each}
						</tr>
						<tr class="derived">
							<th scope="row" class="sticky">Equivalent <span class="u">l/s</span></th>
							{#each s.ewrPragmaticM3PerDay as v, i (i)}<td class="num">{fmtNum(((v || 0) * 1000) / 86_400, 0)}</td>{/each}
						</tr>
					</tbody>
				</table>
			</div>
			<p class="muted small" data-testid="ewr-annual">
				{fmtQty(ewrAnnual, 3)} Mm³/a in total · mean {fmtQty((ewrAnnual * 1e6) / 86_400 / 365.25, 3)} m³/s
			</p>
		</div>
		<fieldset class="plain report">
			<legend>Curtailment reporting window <HelpTip key="settings.reportStart" /></legend>
			<div class="form-row">
				<div class="field">
					<label for="st-rep-start">From</label>
					<input id="st-rep-start" type="date" readonly={readonly} value={s.reportStart ?? ''} onchange={(e) => (s.reportStart = e.currentTarget.value || null)} />
				</div>
				<div class="field">
					<label for="st-rep-end">To</label>
					<input id="st-rep-end" type="date" readonly={readonly} value={s.reportEnd ?? ''} onchange={(e) => (s.reportEnd = e.currentTarget.value || null)} />
				</div>
			</div>
			<span class="hint">
				Period the curtailment targets and the assurance of supply on Hydrological units average over, e.g. the last dry season. Leave blank for the whole run.
			</span>
			{#if reportError}<p class="err" role="alert">{reportError}</p>{/if}
			<div class="field">
				<span class="lbl"><label for="st-aat">Annual assurance threshold <span class="u">(%)</span></label><HelpTip key="settings.assuranceAnnualThreshold" /></span>
				<NumberInput
					id="st-aat"
					min={1}
					max={100}
					scale={100}
					disabled={readonly}
					value={s.assuranceAnnualThreshold ?? 0.9}
					onchange={(v) => (s.assuranceAnnualThreshold = v ?? undefined)}
					aria-describedby="st-aat-h"
				/>
				<span class="hint" id="st-aat-h">A water year counts as met when at least this share of a hydrological unit's demand was supplied. 90 % by default: a project choice, not a standard.</span>
				<FieldHistoryLine field="settings:assuranceAnnualThreshold" />
			</div>
		</fieldset>
		<fieldset class="plain" data-testid="settings-allocations">
			<legend>Registered volumes <HelpTip key="settings.allocationMode" /></legend>
			<div class="form-row">
				<div class="field">
					<label for="st-alloc-mode">Allocation mode</label>
					<select
						id="st-alloc-mode"
						disabled={readonly}
						value={s.allocationMode ?? 'none'}
						onchange={(e) => (s.allocationMode = e.currentTarget.value as AllocationMode)}
						aria-describedby="st-alloc-mode-h"
					>
						{#each ALLOCATION_MODES as m (m)}<option value={m}>{ALLOCATION_MODE_LABEL[m]}</option>{/each}
					</select>
				</div>
				<div class="field">
					<span class="lbl"><label for="st-alloc-tol">Comparison band <span class="u">(± %)</span></label><HelpTip key="settings.allocationTolerance" /></span>
					<NumberInput
						id="st-alloc-tol"
						min={0}
						max={99}
						scale={100}
						disabled={readonly}
						value={s.allocationTolerance ?? 0.1}
						onchange={(v) => (s.allocationTolerance = v ?? undefined)}
						aria-describedby="st-alloc-tol-h"
					/>
					<FieldHistoryLine field="settings:allocationTolerance" />
				</div>
			</div>
			<span class="hint" id="st-alloc-mode-h">
				What the Allocations tab’s registered volumes do to a run. Compare only (the default) changes nothing; a cap keeps each unit’s surface and groundwater use per
				water year within its volumes, and within its licences’ months and maximum rates; a full allocation scales each unit’s demand to its volumes, for “if every
				registered or licensed volume were taken in full” (a registration is not an entitlement).
			</span>
			<span class="hint" id="st-alloc-tol-h">Modelled use within this share of a registered volume counts as “within band”. ±10 % by default, a provisional default not yet confirmed by the catchment’s hydrologist.</span>
			<FieldHistoryLine field="settings:allocationMode" />
		</fieldset>
	</section>

	<!-- Reserve rule tables (engine ≥ 0.21.0) -------------------------------------->
	<div id="set-reserve">
		<EwrRulesSection
			bind:value={s.ewrRules}
			bind:error={reserveError}
			bind:chargeSource={s.ewrChargeSource}
			bind:lowFlowMeasure={s.lowFlowMeasure}
			{readonly}
			nodes={editor?.model.nodes ?? []}
		/>
	</div>

	<!-- Drought restrictions (engine ≥ 1.54.0, WP-3.8) ---------------------------------------->
	<section class="panel" id="set-restrict" aria-labelledby="restrict-h">
		<div class="panel-head">
			<h2 id="restrict-h">Drought restrictions <HelpTip key="settings.droughtRestriction" /></h2>
			<span class="muted small">Cut demand by level when the farm dams fall below a share of their capacity</span>
		</div>
		<Lazy load={loadDroughtRestriction}>
			{#snippet children(DroughtRestrictionFields)}
				<DroughtRestrictionFields bind:value={s.droughtRestriction} bind:error={restrictErr} {readonly} nodes={editor?.model.nodes ?? []} projectId={project.id} />
			{/snippet}
		</Lazy>
		<FieldHistoryLine field="settings:droughtRestriction" />
	</section>

	<!-- Period ------------------------------------------------------------------------>
	<section class="panel" id="set-period" aria-labelledby="per-h">
		<div class="panel-head">
			<h2 id="per-h">Simulation period <HelpTip key="settings.simulationStart" /></h2>
			<NotesDrawer projectId={project.id} target={settingTarget('period')} />
		</div>
		<div class="form-row">
			<div class="field">
				<label for="st-start">Simulation start</label>
				<input
					id="st-start"
					type="date"
					readonly={readonly}
					value={s.simulationStart ?? ''}
					onchange={(e) => (s.simulationStart = e.currentTarget.value || null)}
				/>
			</div>
			<div class="field">
				<label for="st-end">Simulation end</label>
				<input
					id="st-end"
					type="date"
					readonly={readonly}
					value={s.simulationEnd ?? ''}
					onchange={(e) => (s.simulationEnd = e.currentTarget.value || null)}
				/>
			</div>
		</div>
		<p class="hint muted">
			Leave blank to simulate from the first to the last day with rain; flow recorded outside that is left out,
			and the run says so. Set a window to focus a run on a drought or a calibration period, or to reach past the
			rain record.
		</p>
		{#if dateError}<p class="err" role="alert">{dateError}</p>{/if}
	</section>

	<!-- Data quality (DataQualitySection: gauge vs logger, outliers, flat stretches, zero-rain runs, low vs CHIRPS) -->
	<DataQualitySection bind:value={s.dataQuality} projectId={project.id} {readonly} error={dqError} />

	<!-- Outcome matrix (issue #53 R4): how results are read, never a model input -------------------->
	<div id="set-outcomes">
		<OutcomeSettingsSection bind:value={s.outcomes} {readonly} error={outError} />
	</div>
	<div id="set-outlook">
		<OutlookSettingsSection bind:value={s.outlook} {readonly} error={outlookErr} />
	</div>

	<!-- Evidence (issue #71, evidence-report.md ER3): the uncertainty rule an evidence report's bands must follow; changes no result. -->
	<section class="panel" id="set-evidence" aria-labelledby="evid-h">
		<div class="panel-head">
			<h2 id="evid-h">Evidence <HelpTip key="settings.evidenceUncertaintyRule" /></h2>
			<span class="muted small">The uncertainty rule an evidence report’s bands must follow, declared before any band is seen</span>
		</div>
		<Lazy load={loadEvidenceRule}>
			{#snippet children(EvidenceRuleFields)}
				<EvidenceRuleFields bind:value={s.evidenceUncertaintyRule} bind:error={evidenceErr} saved={savedEvidenceRule} {readonly} />
			{/snippet}
		</Lazy>
	</section>

	<!-- Automatic runs (WP-2.11) ------------------------------------------------------------------>
	<section class="panel" id="set-auto" aria-labelledby="auto-h">
		<div class="panel-head">
			<h2 id="auto-h">Automatic runs</h2>
			<span class="muted small">Run the model by itself when new data arrives</span>
		</div>
		<label class="check">
			<input type="checkbox" disabled={readonly} bind:checked={s.autoRun.enabled} aria-describedby="auto-on-h" />
			Re-run the model after new data
		</label>
		<p class="hint" id="auto-on-h">
			An upload, a data feed or a logger queues one run, labelled “Auto · data to …”. Only the newest automatic run is kept (unless it is
			pinned or published), so automatic runs never push out the runs you made.
		</p>
		<div class="fields">
			<div class="field">
				<label for="auto-wait">Wait after the latest new data <span class="u">(minutes)</span></label>
				<NumberInput id="auto-wait" min={0} max={AUTO_RUN_DEBOUNCE_MAX} step={1} disabled={readonly || !s.autoRun.enabled} bind:value={s.autoRun.debounceMinutes} aria-describedby="auto-wait-h" />
				<span class="hint" id="auto-wait-h">More data within the wait pushes the run back, but never more than {AUTO_RUN_MAX_WAIT_MINUTES / 60} hours after the first of it. Default 15.</span>
			</div>
			<div class="field">
				<label for="auto-publish">Publishing</label>
				<select id="auto-publish" disabled={readonly || !s.autoRun.enabled} bind:value={s.autoRun.publish} aria-describedby="auto-publish-h">
					<option value="never">Never: a person publishes (default)</option>
					<option value="if_no_new_warnings">Publish if there are no new warnings</option>
				</select>
				<span class="hint" id="auto-publish-h">
					With “no new warnings”, an automatic run replaces the published baseline when it raises no warning the published run didn’t and
					every self-check passes; the notice carries over. The first publication is always yours.
				</span>
			</div>
		</div>
		{#if autoError}<p class="err" role="alert">{autoError}</p>{/if}
	</section>

	{#if !readonly}
		<div class="actions" bind:clientHeight={actionsHeight}>
			<!-- What blocks Save, each linking to the group where it is fixed. -->
			<div class="blockers" role="status">
				{#if dirty && blockers.length}
					<span class="err">{blockers.length} {blockers.length === 1 ? 'group has a problem' : 'groups have problems'} to fix before saving:</span>
					<ul>
						{#each blockers as b (b.id)}
							<li><a href="#{b.id}" aria-label="{b.label}: {b.message}">{b.label}</a></li>
						{/each}
					</ul>
				{/if}
			</div>
			{#if justSaved && !dirty}<span class="muted" role="status">Settings saved.</span>{/if}
			{#if dirty}<span class="unsaved">Unsaved settings</span>{/if}
			{#if dirty}
				<label class="reason">
					<span class="visually-hidden">Reason for this change (optional)</span>
					<input type="text" maxlength="500" placeholder="Reason for this change (optional)" bind:value={reason} disabled={saving} />
				</label>
			{/if}
			<!-- The model's save bar hides its own Preview on this tab: this one takes the model's edits too. -->
			{#if dirty || previewModel}
				<button type="button" class="btn" disabled={saving || (dirty && blocked)} onclick={openPreview}>Preview</button>
			{/if}
			<button type="button" class="btn" disabled={!dirty || saving} onclick={discard}>Discard</button>
			<button type="submit" class="btn btn-primary" disabled={!dirty || saving || blocked}>
				{saving ? 'Saving…' : 'Save settings'}
			</button>
		</div>
	{/if}
</form>

{#if previewMounted}
	<Lazy load={loadUnsavedPreview}>
		{#snippet children(UnsavedPreviewDialog)}
			<UnsavedPreviewDialog
				bind:open={previewOpen}
				projectId={project.id}
				{runs}
				what={dirty && previewModel ? 'settings and model edits' : dirty ? 'settings' : 'model edits'}
				edits={previewEdits}
				left={editor?.dirty && !previewModel ? ['your unsaved model edits, which have problems to fix first'] : []}
			/>
		{/snippet}
	</Lazy>
{/if}

<!-- Outside the form: feeds, keys and schedules save themselves, never through Save settings. -->
{#if !readonly}
	<p class="muted small after-form">
		Data feeds{project.role === 'owner' ? ', API keys' : ''} and scheduled reports save as you change them, not with Save settings.
	</p>
{/if}
<!-- The id sits outside the lazy panel, so a #set-feeds link and the section menu find it while the chunk loads. -->
<div id="set-feeds">
	<Lazy load={loadDataFeeds}>
		{#snippet children(DataFeedsPanel)}<DataFeedsPanel projectId={project.id} />{/snippet}
	</Lazy>
</div>

{#if project.role === 'owner'}
	<Lazy load={loadApiKeys}>
		{#snippet children(ApiKeysPanel)}<ApiKeysPanel projectId={project.id} />{/snippet}
	</Lazy>
{/if}

<ReportSchedulesPanel projectId={project.id} canEdit={project.role === 'editor' || project.role === 'owner'} />

<style>
	.after-form {
		margin: 1.5rem 0 0.75rem;
	}
	.u {
		font-weight: 400;
		color: var(--text-muted);
		font-size: 0.8rem;
	}
	.hint {
		font-size: 0.8rem;
		max-width: 75ch;
	}
	/* Fit automatically opens its own panel: no separator above its heading. */
	#set-fit > :global(.fit:first-child) {
		border-top: 0;
		padding-top: 0;
		margin-top: 0;
	}
	.panel > .hint {
		margin: 0.5rem 0 0.75rem;
	}
	.fields {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
		gap: 0 1.25rem;
		margin-top: 0.5rem;
	}
	/* Not a checkbox: stretched, "Vary it by month" sat half a field away from its box. */
	.field :global(input:not([type='checkbox'])),
	.field select {
		width: 100%;
	}
	th.sticky {
		position: sticky;
		left: 0;
		z-index: 2;
		background: var(--surface);
		white-space: nowrap;
	}
	thead th.sticky {
		background: var(--surface-2);
		z-index: 3;
	}
	/* Twelve months plus the row label fit a 1280px screen beside the
	   workspace sidebar (shown from 1100px): a month cell is as narrow as a
	   six-digit value (170800) allows, measured in the input's own digits,
	   and gets any width to spare. No spin buttons, as in the Network table:
	   Chrome keeps room for them, which pushed the row past the panel (arrow
	   keys still step). When the row is still short of room the label wraps
	   before the page scrolls sideways. */
	.monthly td {
		/* A preferred width, so spare room keeps the label on one line first. */
		width: calc(6.5ch + 0.7rem + 2px + 0.4rem);
		padding-left: 0.2rem;
		padding-right: 0.2rem;
	}
	table.data.monthly td :global(input) {
		min-width: calc(6.5ch + 0.7rem + 2px);
	}
	.monthly td :global(input[type='number']) {
		appearance: textfield;
		-moz-appearance: textfield;
	}
	.monthly td :global(input[type='number']::-webkit-inner-spin-button),
	.monthly td :global(input[type='number']::-webkit-outer-spin-button) {
		-webkit-appearance: none;
		margin: 0;
	}
	.monthly th.sticky {
		/* Preferred widths on every column share spare room out in proportion;
		   13rem holds the longest row label on one line. */
		width: 13rem;
		white-space: normal;
	}
	.derived td,
	.derived th {
		color: var(--text-muted);
		font-size: 0.8rem;
	}
	.plain {
		border: 0;
		padding: 0;
		margin: 0;
		min-width: 0;
	}
	.plain legend {
		font-weight: 500;
		font-size: 0.85rem;
		color: var(--text-2);
		margin-bottom: 0.35rem;
		padding: 0;
	}
	.hilo .field {
		width: 110px;
	}
	.sum {
		padding: 0.35rem 0;
		font-variant-numeric: tabular-nums;
	}
	.sum.warn {
		color: var(--warning);
		font-weight: 600;
	}
	/* The monthly row gets the full width; the annual total sits under it. */
	.ewr {
		display: grid;
		gap: 0.3rem;
	}
	.ewr p {
		margin: 0;
	}
	.advanced {
		margin-top: 0.75rem;
	}
	.advanced summary {
		cursor: pointer;
		font-size: 0.875rem;
		color: var(--text-2);
	}
	.advanced > .field {
		margin-top: 0.5rem;
		max-width: 75ch;
	}
	.changed {
		color: var(--warning);
		font-weight: 600;
	}
	.report {
		margin-top: 1rem;
		display: grid;
		gap: 0.25rem;
	}
	.x2 {
		display: grid;
		gap: 0.35rem;
		margin: 0.25rem 0 0.75rem;
		max-width: 75ch;
	}
	.x2 .field {
		max-width: 240px;
	}
	/* GR4J's PE source (issue #39): the choice, the annual total and what the A-pan row drives. */
	.pe {
		display: grid;
		justify-items: start;
		gap: 0.2rem;
		margin: 0.25rem 0 0.75rem;
		max-width: 75ch;
	}
	.pe-annual {
		margin: 0.3rem 0 0;
	}
	.pe-source,
	.pan-source,
	.lake-preset,
	.lake-source {
		max-width: 40rem;
		margin-top: 0.5rem;
	}
	.pe-source input,
	.pan-source input,
	.lake-source input {
		width: 100%;
	}
	.check {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		min-height: 36px;
	}
	.lbl {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
	}
	.lbl label {
		font-weight: 500;
		font-size: 0.85rem;
		color: var(--text-2);
	}
	legend :global(.helptip),
	h2 :global(.helptip),
	th :global(.helptip) {
		margin-left: 0.15rem;
	}
	.err {
		color: var(--danger);
		font-size: 0.8rem;
	}
	input.invalid {
		border-color: var(--danger);
	}
	/* Sticks above the model save bar when that is showing (--dock-h). */
	.actions {
		position: sticky;
		bottom: var(--dock-h, 0px);
		z-index: 20;
		display: flex;
		justify-content: flex-end;
		align-items: center;
		flex-wrap: wrap;
		gap: 0.6rem;
		padding: 0.75rem 0;
		background: var(--bg);
		border-top: 1px solid var(--border);
	}
	.actions .reason {
		flex: 0 1 22rem;
		min-width: 12rem;
	}
	.actions .reason input {
		width: 100%;
	}
	/* In-page menu (as on Runs & results, but a bar: the monthly input rows need the full width). */
	.blockers {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.2rem 0.6rem;
		margin-right: auto;
		min-width: 0;
	}
	.blockers ul {
		list-style: none;
		display: flex;
		flex-wrap: wrap;
		gap: 0.2rem 0.6rem;
		margin: 0;
		padding: 0;
	}
	.blockers a {
		font-size: 0.85rem;
		font-weight: 500;
		display: inline-flex;
		align-items: center;
		min-height: 24px;
	}
	.unsaved {
		color: var(--warning);
		font-weight: 500;
	}
	@media (max-width: 640px) {
		.actions .btn {
			min-height: 44px;
		}
	}
</style>
