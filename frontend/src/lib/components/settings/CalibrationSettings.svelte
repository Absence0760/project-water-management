<script module lang="ts">
	// The four calibration panels' lazy parts: SettingsTab.svelte's loaders, moved with the panels (issue #586). The
	// lazy sections that draw on each visit share one chunk, lazySections.ts (issue #521), with the tab's own.
	const loadSections = () => import('./lazySections');
	// Calibration record's quality flags and flow gaps (issue #66): loaded when the section draws, so the tab chunk
	// stays under its size ceiling. The quality flags' Save blocker (`error`) is set once its fields load: nothing can
	// be edited before.
	const loadQualityFlags = () => loadSections().then((m) => ({ default: m.QualityFlagsFields }));
	// The calibration locations (issue #659; several gauges since #555): their own chunk, loaded only with a location to tick.
	const loadLocations = () => import('#lib/components/calibration/CalibrationLocationsTable.svelte');
	const loadFlowGapFill = () => loadSections().then((m) => ({ default: m.FlowGapFillFields }));
	// Automated calibration's rules and run (issue #153): their own chunks, for the same reason.
	const loadCalibrationRules = () => import('./CalibrationRulesFields.svelte');
	const loadAutoFit = () => import('#lib/components/calibration/AutoFitPanel.svelte');
	// The regional GR4J prior (issue #622): its own chunk, as the evaporation proposal's.
	const loadPrior = () => import('#lib/components/calibration/RegionalPriorPanel.svelte');
	// Evaporation from the map (issue #326 B-evap): out of the tab's chunk, for the same reason; it loads its proposal on mount.
	const loadEvaporationProposal = () => loadSections().then((m) => ({ default: m.EvaporationProposal }));
	// The FAO-56 pan-coefficient helper: editors only, under pan coefficient × A-pan, so a viewer or a monthly-PE
	// project never draws it; its own chunk keeps the tab under its ceiling (the side index, issue #468, grew it).
	const loadPanHelper = () => import('./PanCoefficientHelper.svelte');
	// The areal rainfall correction's body: its own chunk (issue #521), as most projects leave the correction off.
	const loadArealRain = () => import('./ArealRainBody.svelte');
</script>

<script lang="ts">
	// Flow calibration, Calibration record, Fit the parameters and the WR2012 check (issue #586): the panels that set up
	// a fit, on the Calibration page's "Set up the fit" (calibration/CalibrationTab.svelte, round 3; they were on
	// Settings until then). They edit the workspace page's draft (settingsDraft.svelte.ts) in place, so the one save bar
	// saves them with Model settings' edits, and Fit automatically's session (calibration/fitSession.svelte.ts) is the
	// page's too, so a fit outlives a tab change. The ids (#set-flow, #set-record, #set-fit, #set-wr2012,
	// #set-evaporation) are on the panels here (settings/sections.ts CALIBRATION_SETTINGS_SECTIONS); the draft works out
	// their Save blockers (blockers.ts). No wrapper element: the page gives them a `settings-form explain-scope`
	// ancestor, whose panel lines', cards' and explanations' rules are app.css's.
	import NotesDrawer from '#lib/components/notes/NotesDrawer.svelte';
	import { settingTarget } from '#lib/components/notes/notes.js';
	import {
		CALIBRATION_FLOW_KINDS,
		calibrationSeriesKey,
		calibrationSites,
		hasPotentialEvaporation,
		PAN_COEFFICIENT_PRESET_SOURCE,
		PAN_COEFFICIENT_PRESETS,
		PAN_COEFFICIENT_TYPICAL_MAX,
		PAN_COEFFICIENT_TYPICAL_MIN,
		PE_SOURCE_MAX,
		panCoefficientOutOfRange,
		type ApanDailyFingerprint,
		type CalibrationFlowKind,
		type CalibrationReport,
		type FitRecord,
		type Gr4jParams,
		type LocationKey,
		type PeInput,
		type ProjectSettings,
		type SeriesOrigin,
		type SeriesProvenance
	} from '@water-management/engine';
	import { applyReport, marPenaltyOn } from '#lib/calibration/fit.js';
	import { headlineLocation, locationName } from '@water-management/engine';
	import { headlineView, isLegacyLocations, normalizedLocations, withZoneFields } from '#lib/calibration/zones.js';
	import { measuredAtHref, unplacedAdvice, unplacedRecords, unplacedWhy } from '#lib/calibration/unplaced.js';
	import type { FitSession } from '#lib/calibration/fitSession.svelte.js';
	import type { RunBlocker } from '#lib/calibration/autoFit.js';
	import CalibrationExclusions from '#lib/components/calibration/CalibrationExclusions.svelte';
	import FlowMissingPeriods from '#lib/components/calibration/FlowMissingPeriods.svelte';
	import type { RecordOption } from './recordPeriods';
	import CalibrationWindowFields from '#lib/components/calibration/CalibrationWindowFields.svelte';
	import FitPanel from '#lib/components/calibration/FitPanel.svelte';
	import FitProvenance from '#lib/components/calibration/FitProvenance.svelte';
	import LowFlowPeriods from '#lib/components/calibration/LowFlowPeriods.svelte';
	import { fitRecordLine } from '#lib/components/calibration/provenance.js';
	import { api, type Project } from '#lib/api/index.js';
	import HelpTip from '#lib/components/help/HelpTip.svelte';
	import NumberInput from '#lib/components/common/NumberInput.svelte';
	import Lazy from '#lib/components/common/Lazy.svelte';
	import Fold from '#lib/components/common/Fold.svelte';
	import FieldHistoryLine from '#lib/components/history/FieldHistoryLine.svelte';
	import { fmtNum } from '#lib/format/number.js';
	import { WATER_YEAR_MONTHS } from '#lib/format/months.js';
	import type { ModelEditor } from '#lib/model/editor.svelte.js';
	import { GR4J_FIELDS, RUNOFF_MODEL_HELP, RUNOFF_MODEL_LABEL, typicalRange } from './calibration';
	import { qualityFlagsAtDefaults, qualityFlagsSummary } from './qualityFlagsLine';
	import MarPenaltyFields from './MarPenaltyFields.svelte';
	import MonthlyPasteDialog from './MonthlyPasteDialog.svelte';
	import Wr2012Section from './Wr2012Section.svelte';
	import { annualGr4jPeMm, apanSourceNote, PE_KIND_OPTIONS, PE_MONTH_MAX_MM, peFormError, peOf, withPeKind, type EditablePe } from './peInput';
	import { arealRainFormError, storedArealRain, withArealRain, type EditableArealRain } from './arealRain';
	import { calibrationSummaries, type SummaryInput } from './summaries';
	import type { SettingsDraft } from './settingsDraft.svelte';

	let {
		project,
		editor,
		draft,
		fit,
		seriesKinds = null,
		gaugeRecords = null,
		chirpsSource,
		observedOrigins,
		apanDaily,
		et0Daily,
		flowRecordId = null,
		flowRecords = null,
		series = null,
		readonly,
		onProjectChange
	}: {
		project: Project;
		/** The model being edited: its land units' areas (the catchment area's default), its outlet and gauges (the calibration locations) and unsaved edits (a fit runs on them). */
		editor?: ModelEditor;
		/** The unsaved settings, held by the workspace page (settingsDraft.svelte.ts): its save bar saves them. */
		draft: SettingsDraft;
		/** Fit automatically's choices, progress and result, held by the workspace page so a tab change keeps them. */
		fit: FitSession;
		/** Kinds of the project's input series, to limit the calibration flow choices. */
		seriesKinds?: string[] | null;
		/** The flow records attached to gauges inside the network (084_gauge_records), for the calibration site's choices; null = not known. */
		gaugeRecords?: { kind: string; siteNodeId: string }[] | null;
		/** The CHIRPS series' product and version a run would use (issue #40c); undefined when not known. */
		chirpsSource?: SeriesProvenance | null;
		/** Each observed record's source and given unit a run would read (107_series_source.sql), by model-input key; undefined when not known. */
		observedOrigins?: Partial<Record<string, SeriesOrigin | null>>;
		/**
		 * The daily A-pan series now, as the fit record fingerprints it (issue #45), so the record can say whether the
		 * forcing changed since the fit: null for none, undefined while not known. The page fetches it (it reads the
		 * whole series), once for both its header and these panels.
		 */
		apanDaily?: ApanDailyFingerprint | null;
		/** The daily reference ET series now (issue #604 R5-E), the same way; undefined while not known. */
		et0Daily?: ApanDailyFingerprint | null;
		/** A flow record the calibration can score against, for the link to where its site is set (the Data tab). */
		flowRecordId?: string | null;
		/** The project's flow records, for each one's missing periods (settings.flowMissing, issue #611); null = not loaded. */
		flowRecords?: RecordOption[] | null;
		/** The project's input series, for the flow records not placed in the network (issue #659); null = not loaded. */
		series?: readonly { id: string; kind: string; name?: string; siteNodeId?: string | null }[] | null;
		readonly: boolean;
		/** The server saved an automated fit or a proposal: the project as it now is. */
		onProjectChange: (p: Project) => void;
	} = $props();

	// The panels edit the page's draft in place, so a tab change keeps it.
	const s = $derived(draft.s);
	const cal = $derived(s.calibration);
	const dirty = $derived(draft.dirty);
	/** The fit record's fold: open where the page has room for it (1024 px and up), read once. */
	const fitRecordOpen = typeof window !== 'undefined' && window.matchMedia('(min-width: 1024px)').matches;
	// The preset picker itself is never saved: it only fills the row and its source note, then resets.
	let panPreset = $state('');
	/** GR4J's default warm-up (days): the warm-up fold starts closed at it. */
	const GR4J_WARMUP_DEFAULT = 365;
	// Automated calibration's panel: the rules card's head runs it (its start() and canRun()).
	let autoFit = $state<{ start: () => void; canRun: () => boolean; runBlocker: () => RunBlocker | null } | undefined>(undefined);
	// The pan coefficient row's paste dialog (MonthlyPasteDialog): its button and the row's onpaste open it.
	let monthlyPaste = $state<ReturnType<typeof MonthlyPasteDialog> | undefined>(undefined);
	const openMonthlyPaste = () => monthlyPaste?.openPaste();

	// GR4J's PE input (issue #39).
	const pe = $derived(peOf(s));
	const peError = $derived(peFormError(pe));
	const peAnnual = $derived(annualGr4jPeMm(s));
	const peSourceBad = $derived(pe.kind === 'monthly' && (!pe.source.trim() || pe.source.length > PE_SOURCE_MAX));
	// The areal rainfall correction on GR4J's rain (engine ≥ 1.13.0, §2.4g); the one switched off is kept until saved.
	const areal = $derived((s.arealRain ?? null) as unknown as EditableArealRain | null);
	const arealError = $derived(arealRainFormError(areal));
	function setArealOn(on: boolean) {
		if (!on && areal) draft.lastAreal = $state.snapshot(areal) as EditableArealRain;
		s.arealRain = storedArealRain(withArealRain(on, draft.lastAreal));
	}
	const farmAreaKm2 = $derived(
		(editor?.model.nodes ?? []).filter((n) => n.kind === 'farm').reduce((t, n) => t + (n.areaKm2 || 0), 0)
	);
	const apanAnnual = $derived(s.apanMm.reduce((t, v) => t + (v || 0), 0));
	const panOutOfRange = $derived(panCoefficientOutOfRange(s.panCoefficient));

	const x2 = GR4J_FIELDS.find((f) => f.key === 'x2')!;

	function setX2Open(open: boolean) {
		draft.x2Open = open;
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

	/** Choose where GR4J's PE comes from; a monthly row switched away from is remembered until saved or discarded. */
	function setPeKind(kind: EditablePe['kind']) {
		if (pe.kind === 'monthly') draft.lastMonthlyPe = $state.snapshot(pe) as EditablePe;
		s.pe = withPeKind(s, kind, draft.lastMonthlyPe);
	}

	// The rules as saved: the server runs automated calibration only on these (issue #153).
	const savedRules = $derived(draft.saved.calibrationRules);

	/**
	 * The server saved an automated fit or a proposal (issue #153): take the project's settings as they now
	 * are. A rebase, not a load: an edit typed while it was applied stays unsaved, but a setting the apply
	 * changed shows the applied value. The page's onProjectChange then finds nothing more to rebase.
	 */
	async function reloadAfterApply() {
		const p = await api.projects.get(project.id);
		draft.rebase(p.settings, 'saved');
		onProjectChange(p);
	}

	/**
	 * Writes a fit's steps into the form (unsaved), as one (issue #659): each location's parameters and fit record
	 * where it keeps them, the outlet's (key null) in the top-level settings (its fitted parameters over the form's),
	 * a gauge's in its row.
	 */
	function applyFit(steps: { key: LocationKey; report: CalibrationReport; params: Gr4jParams; record: FitRecord }[]) {
		// In the locations shape first (a fit applied before the page adopted it): a gauge's row of a legacy inner site
		// would otherwise be rebuilt from the top level when read, losing what the fit wrote into it.
		let next = isLegacyLocations(s) ? normalizedLocations({ ...s }, nodes, outletRecords.length > 0) : { ...s };
		for (const st of steps) {
			if (st.key === null) next = { ...applyReport(next, st.report), fitRecord: st.record };
			else next = { ...next, calibrationZones: withZoneFields(next.calibrationZones, st.key, { gr4j: st.params, fitRecord: st.record }) };
		}
		draft.s = next;
		if (draft.s.gr4j.x2 !== 0) draft.x2Open = true;
	}

	// The engine refuses a GR4J run without potential evaporation (runoff/simulate.ts).
	// A daily A-pan series (issue #45) is A-pan too, on the days it covers.
	const apanSource = $derived(apanSourceNote(seriesKinds));
	// The calibration locations (issue #659, engine 1.110.0): the outlet, with a record of its own, and every gauge
	// inside the network with one (engine ≥ 1.41.0); the headline's records decide what a fit can validate against.
	const nodes = $derived(editor?.model.nodes ?? []);
	const calSites = $derived(editor && gaugeRecords ? calibrationSites(editor.model, Object.fromEntries(gaugeRecords.map((r) => [calibrationSeriesKey(r.kind as CalibrationFlowKind, r.siteNodeId), true]))) : []);
	const outletRecords = $derived((seriesKinds ?? []).filter((k): k is CalibrationFlowKind => (CALIBRATION_FLOW_KINDS as readonly string[]).includes(k)));
	// Settings from before engine 1.110.0 read as calibration locations, on the saved copy and the form alike, so it
	// isn't an edit (settingsDraft adopt): once the nodes and the outlet's records are known.
	$effect(() => {
		if (!editor || seriesKinds === null || !isLegacyLocations(draft.s)) return;
		const ns = editor.model.nodes;
		const has = outletRecords.length > 0;
		draft.adopt((x) => normalizedLocations(x, ns, has));
	});
	const headline = $derived(nodes.length ? headlineLocation(nodes, s as unknown as ProjectSettings) : null);
	/** The form read at its headline location (zones.ts headlineView): its fit record and the settings it is checked against. */
	const hs = $derived(headlineView(s as unknown as ProjectSettings, nodes));
	const recordKinds = $derived(headline === null ? seriesKinds : (calSites.find((x) => x.nodeId === headline)?.records ?? []));
	const hasRecord = $derived(recordKinds === null || recordKinds.some((k) => (CALIBRATION_FLOW_KINDS as readonly string[]).includes(k)));
	const nodeName = (id: string) => editor?.model.nodes.find((n) => n.id === id)?.name;
	const outletName = $derived(editor?.model.nodes.find((n) => n.downstreamNodeId === null)?.name ?? 'the outlet');
	// Flow records no location can be fitted on (issue #659): flagged here with a link to their Measured at.
	const unplaced = $derived(unplacedRecords((series ?? []).map((x) => ({ ...x, name: x.name ?? '' })), nodes));
	let showAllUnplaced = $state(false);
	/** The table's edits: its location keys, written into the form as given. */
	function editLocations(next: Partial<ProjectSettings>) {
		const n = next as unknown as Record<string, unknown>;
		const f = s as unknown as Record<string, unknown>;
		for (const k of ['calibrationZones', 'calibrateAtOutlet', 'calibrationRest', 'calibrationSiteNodeId', 'unitParamsFrom'])
			if (JSON.stringify(n[k]) !== JSON.stringify(f[k])) f[k] = n[k] === undefined ? undefined : JSON.parse(JSON.stringify(n[k]));
	}
	/** The Calibration record panel's line: the ticked locations, and the headline when there are several. */
	function locationsLine(): { names: string[]; headline: string | null; outlet: boolean } {
		const names = [
			...(s.calibrateAtOutlet === true ? [outletName] : []),
			...(s.calibrationZones ?? []).filter((z) => z.enabled).map((z) => nodeName(z.nodeId) ?? 'a gauge no longer in the model')
		];
		return { names, headline: names.length > 1 ? locationName(nodes, headline) : null, outlet: s.calibrateAtOutlet === true };
	}
	// The window above and the locations' rows each report an error; the save bar reads one (the window's first).
	let mainWindowError = $state<string | null>(null);
	let zonesError = $state<string | null>(null);
	$effect(() => {
		draft.errors.calWindow = mainWindowError ?? zonesError;
	});
	const petMissing = $derived(
		!hasPotentialEvaporation(
			{ apanMm: s.apanMm, panCoefficient: s.panCoefficient, pe: s.pe as PeInput | undefined },
			apanSource?.daily ?? false,
			// A daily reference ET series (issue #604 R5-E) is PE under a monthly row, on the days it covers.
			seriesKinds?.includes('evap_et0_mm') ?? false
		)
	);
	// Each panel's line of what it is set to now (summaries.ts).
	const summaries = $derived(
		calibrationSummaries({
			s: s as unknown as SummaryInput['s'],
			unitAreaKm2: farmAreaKm2,
			peAnnualMm: peAnnual,
			locations: nodes.length ? locationsLine() : null
		})
	);
</script>

<!-- Flow calibration ----------------------------------------------------------->
<section class="panel" id="set-flow" aria-labelledby="cal-h">
	<div class="panel-head">
		<h3 id="cal-h">Flow calibration</h3>
		<NotesDrawer projectId={project.id} target={settingTarget('flow')} />
	</div>
	<p class="summary" data-testid="summary-flow">{summaries['set-flow']}</p>
	<p class="hint explain">Rain → natural flow. Tune against observed flow, run the model, then check NSE and PBIAS under <a href="#cal-fit">How the shown run fits</a>.</p>
	{#if petMissing}
		<p class="alert alert-warning" role="status">
			{#if pe.kind === 'monthly'}
				GR4J needs potential evaporation, and the monthly PE row (below) is 0 in every month. Without it the catchment would never dry out,
				so runs and fits are refused.
			{:else}
				GR4J needs A-pan evaporation (<a href="?tab=settings#set-demand">Demand</a>, on Model settings) and a pan coefficient above 0 (below).
				Without them the catchment would never dry out, so runs and fits are refused.
			{/if}
		</p>
	{/if}
	<!-- Three cards (issue #521): the parameters a fit writes, the rain GR4J runs on, and its potential evaporation;
	     then Evaporation from the map, which saves straight away, as its own card. Rarely changed settings fold into
	     one line of their values (ui-playbook.md § 2). -->
	<div class="sub-card" data-testid="flow-gr4j-card">
		<!-- Its jump to Fit the parameters is the page header's alone (issue #586, C19). -->
		<h4 class="sub first">GR4J parameters</h4>
		<div class="fields gr4j-fields">
			{#each GR4J_FIELDS.filter((f) => !f.fixedByDefault) as p (p.key)}
				<div class="field">
					<span class="lbl"><label for="gr4j-{p.key}">{p.label} <span class="u">({p.unit})</span></label><HelpTip key="settings.gr4j" label="About GR4J, for {p.label}" /></span>
					<!-- A fit writes nine decimals; three show (display only, as the fit record does). -->
					<NumberInput id="gr4j-{p.key}" min={p.min} max={p.max} step={p.step} decimals={3} disabled={readonly} bind:value={s.gr4j[p.key]} aria-describedby="gr4j-{p.key}-h" />
					<span class="hint explain" id="gr4j-{p.key}-h">{p.help} {typicalRange(p)}</span>
					<FieldHistoryLine field="settings:gr4j.{p.key}" />
				</div>
			{/each}
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
				<!-- Per unit (the only method, issue #658): each unit makes its runoff over its own area, so with a unit with land the
				     override isn't used (the engine's resolveCatchmentAreaKm2; the run warns). A state line, not an explanation. -->
				<span class="hint" id="cal-area-h" data-testid="cal-area-hint">
					Area the rain falls on. Leave blank to use the sum of the hydrological unit areas —
					<strong>{fmtNum(farmAreaKm2, 2)} km²</strong> now.{#if cal.catchmentAreaKm2 != null && Math.abs(cal.catchmentAreaKm2 - farmAreaKm2) > 0.005}
						{#if farmAreaKm2 > 0}
							Not used: each unit makes its runoff over its own area, so the units’ {fmtNum(farmAreaKm2, 2)} km² is used, not {fmtNum(cal.catchmentAreaKm2, 2)} km², and the run warns.
						{:else}
							Overridden: {fmtNum(cal.catchmentAreaKm2, 2)} km² is used.
						{/if}{/if}
				</span>
				<FieldHistoryLine field="settings:calibration.catchmentAreaKm2" />
			</div>
			<div class="field">
				<span class="lbl">Runoff model <HelpTip key="settings.runoffModel" /></span>
				<strong data-testid="runoff-model">{RUNOFF_MODEL_LABEL}</strong>
				<span class="hint explain">{RUNOFF_MODEL_HELP}</span>
			</div>
		</div>
		<fieldset class="plain x2" data-testid="gr4j-x2">
			<legend>Groundwater exchange (X2) <HelpTip key="gr4j" label="About groundwater exchange (X2)" /></legend>
			<label class="check">
				<input type="checkbox" disabled={readonly} checked={draft.x2Open} onchange={(e) => setX2Open(e.currentTarget.checked)} />
				Let the catchment gain or lose groundwater
			</label>
			{#if draft.x2Open}
				<div class="field">
					<label for="gr4j-x2">{x2.label} <span class="u">({x2.unit})</span></label>
					<NumberInput id="gr4j-x2" min={x2.min} max={x2.max} step={x2.step} disabled={readonly} bind:value={s.gr4j.x2} aria-describedby="gr4j-x2-h" />
				</div>
			{/if}
			<span class="hint explain" id="gr4j-x2-h">{x2.help} Off, X2 is 0 and the water balance closes within the catchment; on, the exchange is reported as its own series.</span>
			<FieldHistoryLine field="settings:gr4j.x2" />
		</fieldset>
		<Fold {readonly} name="More:" line="warm-up {fmtNum(s.gr4j.warmupDays)} days" atDefaults={s.gr4j.warmupDays === GR4J_WARMUP_DEFAULT} spaced testid="flow-more" lineTestid="flow-more-summary">
			<div class="field">
				<span class="lbl"><label for="gr4j-warmup">Warm-up <span class="u">(days)</span></label><HelpTip key="settings.gr4j" label="About the warm-up" /></span>
				<NumberInput id="gr4j-warmup" min={0} max={3650} step={1} disabled={readonly} bind:value={s.gr4j.warmupDays} aria-describedby="gr4j-warmup-h" />
				<span class="hint explain" id="gr4j-warmup-h">Days run before the first simulated day, repeating the start of the record, so the stores begin at a realistic level. Never shown or scored. Default 365.</span>
				<FieldHistoryLine field="settings:gr4j.warmupDays" />
			</div>
		</Fold>
	</div>
	<div class="sub-card" data-testid="flow-rain-card">
		<h4 class="sub first">Rain into GR4J</h4>
		<!-- The areal rainfall correction (settings.arealRain, engine ≥ 1.13.0): GR4J's rain only;
		     irrigation demand's effective rain and rain on the dams keep the recorded rain. -->
		<fieldset class="plain areal" data-testid="areal-rain">
			<!-- Each sub-group of a card is an h5 (in its legend) under the card’s h4, so heading navigation reaches it. -->
			<legend><h5 class="sub">Areal rainfall correction <HelpTip key="settings.arealRain" /></h5></legend>
			<label class="check">
				<input type="checkbox" disabled={readonly} checked={!!areal} onchange={(e) => setArealOn(e.currentTarget.checked)} />
				Scale the rain GR4J runs on to the catchment’s areal rain
			</label>
			<span class="hint explain" id="st-areal-h">
				For a rain record that misses the catchment’s rain, such as a valley gauge or CHIRPS under a mountain range. A fixed input with its
				source, never a calibrated parameter. Demand and the dams keep the recorded rain.
			</span>
			<!-- A state line, not an explanation: it stays when the explanations are off. Per unit is the only method (issue #658). -->
			<span class="hint" role="note" data-testid="areal-rain-unit-note">Each unit runs on its own rain (<a href="?tab=settings#set-share">Flow generation</a> on Model settings), so it applies only to the units that fall back to the catchment rain.</span>
			{#if areal}
				<!-- Its own chunk (issue #521): most projects leave the correction off. -->
				<Lazy load={loadArealRain}>
					{#snippet children(ArealRainBody)}<ArealRainBody
							bind:value={s.arealRain}
							{arealError}
							{readonly}
							projectId={project.id}
							settings={() => $state.snapshot(s) as unknown as ProjectSettings}
							model={() => (editor?.dirty ? editor.snapshot() : undefined)}
						/>{/snippet}
				</Lazy>
			{/if}
		</fieldset>
	</div>
	<div class="sub-card" data-testid="flow-pe-card">
		<!-- Where GR4J's potential evaporation comes from (settings.pe, issue #39). Irrigation
		     demand and dam evaporation read the A-pan row whichever is chosen. -->
		<fieldset class="plain pe" data-testid="gr4j-pe" aria-describedby="st-pe-annual st-pe-h">
			<legend><h4 class="sub">GR4J potential evaporation <HelpTip key="settings.pe" /></h4></legend>
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
			<span class="hint explain" id="st-pe-h">
				{#if pe.kind === 'monthly'}
					GR4J runs on the monthly PE row below. Irrigation demand and dam evaporation still use the A-pan row (<a href="?tab=settings#set-demand">Demand</a>,
					on Model settings), and GR4J doesn’t use the pan coefficient.
				{:else}
					GR4J runs on pan coefficient × A-pan. The A-pan row (<a href="?tab=settings#set-demand">Demand</a>, on Model settings) also drives
					irrigation demand and dam evaporation, so changing it moves all three; to change GR4J’s PE alone, enter a monthly PE.
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
							<th scope="row" class="sticky">Monthly PE <span class="u">mm</span> <HelpTip key="settings.pe" label="About the monthly PE row" /></th>
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
					aria-describedby={peError ? 'st-pe-source-h st-pe-err' : 'st-pe-source-h'}
					oninput={(e) => {
						if (s.pe?.kind === 'monthly') s.pe.source = e.currentTarget.value;
					}}
				/>
				<span class="hint" id="st-pe-source-h">Required: where the values come from, e.g. the station, the method, any factor applied and the years.</span>
				{#if peError}<span class="err" id="st-pe-err">{peError}</span>{/if}
			</div>
		{:else}
			<div class="table-wrap">
				<table class="data compact monthly">
					<thead>
						<tr>
							<th scope="col" class="sticky">Month</th>
							{#each WATER_YEAR_MONTHS as m (m)}<th scope="col" class="num">{m}</th>{/each}
						</tr>
					</thead>
					<tbody onpaste={readonly ? undefined : (e) => monthlyPaste?.paste(e, 'panCoefficient')}>
						<tr>
							<th scope="row" class="sticky">Pan coefficient <HelpTip key="settings.panCoefficient" label="About the monthly pan coefficients" /></th>
							{#each WATER_YEAR_MONTHS as m, i (m)}
								<td data-paste-col={i}><NumberInput label="Pan coefficient, {m}" min={0} max={2} step={0.01} disabled={readonly} bind:value={s.panCoefficient[i]} /></td>
							{/each}
						</tr>
					</tbody>
				</table>
			</div>
			<p class="hint muted explain">Potential evaporation = pan coefficient × A-pan, per month. 0.7 is a common flat value.</p>
			{#if panOutOfRange.length}
				<p class="alert alert-warning small" role="status">
					Pan coefficient is outside FAO-56's typical Class A pan range ({PAN_COEFFICIENT_TYPICAL_MIN}–{PAN_COEFFICIENT_TYPICAL_MAX}) in
					{panOutOfRange.map((i) => WATER_YEAR_MONTHS[i]).join(', ')}: confirm against local humidity and wind.
				</p>
			{/if}
			<Fold {readonly} name="Fill or edit the row:" line="preset, FAO-56 helper, paste · source: {s.panCoefficientSource?.trim() || 'not given'}" body="none" testid="pan-tools" lineTestid="pan-tools-summary" lineClass="pan-tools-line">
				<div class="fold-body stack">
					<div class="field pan-preset">
						<span class="lbl"><label for="st-pan-preset">Pan-coefficient preset</label><HelpTip key="settings.panCoefficient" label="About the pan-coefficient presets" /></span>
						<select id="st-pan-preset" disabled={readonly} value={panPreset} onchange={(e) => {
								applyPanPreset(e.currentTarget.value);
								// Back to "Choose a preset…": panPreset was '' already, so setting it again doesn't touch the DOM.
								e.currentTarget.value = '';
							}} aria-describedby="st-pan-preset-h">
							<option value="">Choose a preset…</option>
							{#each PAN_COEFFICIENT_PRESETS as p (p.id)}<option value={p.id}>{p.label}</option>{/each}
						</select>
						<span class="hint explain" id="st-pan-preset-h">Fills the row below with these monthly values, which stay editable; the source note below records which preset. {PAN_COEFFICIENT_PRESET_SOURCE}.</span>
					</div>
					{#if !readonly}
						<!-- The FAO-56 Table 5 helper (issue #39): only fills the row below; it is collapsed until opened. -->
						<Lazy load={loadPanHelper}>
							{#snippet children(PanCoefficientHelper)}
								<PanCoefficientHelper
									onapply={(v: number[], note: string) => {
										s.panCoefficient = [...v] as typeof s.panCoefficient;
										s.panCoefficientSource = note.slice(0, PE_SOURCE_MAX);
									}}
								/>
							{/snippet}
						</Lazy>
						<div class="toolbar grid-actions" data-testid="grid-actions">
							<button type="button" class="btn btn-sm" onclick={openMonthlyPaste}>Paste from a spreadsheet…</button>
						</div>
					{/if}
					<div class="field pan-source">
						<span class="lbl"><label for="st-pan-source">Pan coefficient source</label><HelpTip key="settings.panCoefficientSource" label="About where the pan coefficient comes from" /></span>
						<input
							id="st-pan-source"
							readonly={readonly}
							maxlength={PE_SOURCE_MAX}
							value={s.panCoefficientSource ?? ''}
							placeholder="e.g. FAO-56 Table 5, Case A, 10 m fetch; RH and wind from a nearby station"
							aria-describedby="st-pan-source-h"
							oninput={(e) => (s.panCoefficientSource = e.currentTarget.value)}
						/>
						<span class="hint explain" id="st-pan-source-h">Optional: where the row comes from. A preset or the FAO-56 helper fills it; it is recorded with each fit and run, and changing it alone doesn't mark a fit's forcing as changed.</span>
					</div>
				</div>
			</Fold>
			<!-- The pan coefficient row's paste (issue #477): this row only, as Demand's A-pan row is on Model settings (issue #586). -->
			<MonthlyPasteDialog bind:this={monthlyPaste} {draft} rows="pan" {readonly} />
		{/if}
	</div>
	<div class="sub-card" data-testid="flow-evaporation-card">
		<!-- Evaporation from the map (issue #326 B-evap): saves straight to the project, then the form reloads the saved settings. -->
		<Lazy load={loadEvaporationProposal}>
			{#snippet children(EvaporationProposal)}<EvaporationProposal projectId={project.id} {readonly} formDirty={dirty} onApplied={reloadAfterApply} />{/snippet}
		</Lazy>
		<Lazy load={() => import('#lib/components/evaporation/EvaporationStationProposal.svelte')}>{#snippet children(EvaporationStationProposal)}<EvaporationStationProposal projectId={project.id} {readonly} formDirty={dirty} onApplied={reloadAfterApply} />{/snippet}</Lazy>
	</div>
</section>

<section class="panel" id="set-record" aria-labelledby="rec-h">
	<div class="panel-head">
		<h3 id="rec-h">Calibration record</h3>
		<NotesDrawer projectId={project.id} target={settingTarget('record')} />
	</div>
	<p class="summary" data-testid="summary-record">{summaries['set-record']}</p>
	<p class="hint explain">The observed flow the parameters are scored against, and what is left out.</p>
	<!-- The calibration locations (issue #659, model.md §2.10n): the outlet and every gauge with a record, each ticked or
	     not, the headline, and what the units with no location downstream take. -->
	<!-- Only once the form is in the locations shape (the $effect above adopts settings from before engine 1.110.0 when the
	     records are known): an edit to a legacy form would set calibrateAtOutlet and skip moving an inner site into its row. -->
	{#if editor && !isLegacyLocations(s) && (calSites.length || outletRecords.length || s.calibrateAtOutlet === true || (s.calibrationZones ?? []).some((z) => z.enabled))}
		<Lazy load={loadLocations}>
			{#snippet children(CalibrationLocationsTable)}
				<CalibrationLocationsTable
					settings={s as unknown as Partial<ProjectSettings>}
					onedit={editLocations}
					bind:error={zonesError}
					projectId={project.id}
					{nodes}
					sites={calSites}
					{outletRecords}
					{readonly}
				/>
			{/snippet}
		</Lazy>
	{/if}
	{#if unplaced.length}
		<!-- A flow record no location can be fitted on (issue #659): where it says it was measured is on Data. -->
		{@const advice = unplacedAdvice(unplaced, { innerGauges: nodes.some((n) => n.kind === 'gauge' && n.downstreamNodeId !== null), readonly })}
		<div class="alert alert-warning unplaced" role="status" data-testid="calibration-unplaced">
			<p>
				{unplaced.length === 1 ? 'A flow record is' : `${unplaced.length} flow records are`} not placed in the network, so no location can be calibrated on
				{unplaced.length === 1 ? 'it' : 'them'}.{#if advice}{' '}{advice}{/if}
			</p>
			<!-- The first three, the rest behind Show all (ui-playbook.md § 2, a long warning list on a first screen). -->
			<ul>
				{#each showAllUnplaced ? unplaced : unplaced.slice(0, 3) as u (u.id)}
					<li data-testid="calibration-unplaced-record"><a href={measuredAtHref(u.id)}>{u.name || 'A flow record'}</a>: {unplacedWhy(u)}.</li>
				{/each}
			</ul>
			{#if unplaced.length > 3 && !showAllUnplaced}
				<button type="button" class="btn btn-sm" onclick={() => (showAllUnplaced = true)}>Show all {unplaced.length}</button>
			{/if}
		</div>
	{/if}
	<!-- The outlet location's own settings (the top level, issue #659 D1): its window and record, the exclusions, the
	     records' missing periods, the low-flow periods and the quality flags, which are the outlet records'. -->
	<h4 class="sub" data-testid="outlet-record-h">At the outlet: {outletName}</h4>
	{#if s.calibrateAtOutlet === false}
		<!-- A state line, not an explanation: these fields read as live otherwise (issue #659). -->
		<p class="hint" data-testid="outlet-not-location">
			The outlet isn’t a calibration location (its Calibrate here is unticked), so no fit uses this window; its quality flags still apply to the run’s
			checks of the outlet’s record.
		</p>
	{/if}
	<CalibrationWindowFields
		bind:start={s.calibrationStart}
		bind:end={s.calibrationEnd}
		bind:flowKind={s.calibrationFlowKind}
		bind:error={mainWindowError}
		{readonly}
		availableKinds={seriesKinds}
		atGauges={calSites.length > 0}
		dataHref={flowRecordId ? `?tab=series&series=${encodeURIComponent(flowRecordId)}#data-chart` : null}
	/>
	<div id="fld-cal-exclusions"><CalibrationExclusions bind:list={s.calibrationExclusions} bind:error={draft.errors.exclusions} {readonly} /></div>
	<!-- One record's own missing periods (issue #611): the exclusions above leave days out of the outlet's records, these out of one.
	     Emptied, the setting goes back to how it was saved (absent or null), so adding and removing a period isn't an edit. -->
	<FlowMissingPeriods
		bind:value={() => s.flowMissing, (v) => (s.flowMissing = v ?? (draft.saved.flowMissing === undefined ? undefined : null))}
		bind:error={draft.errors.flowMissing}
		records={flowRecords}
		{readonly}
	/>
	<!-- Periods in which only a record's low flows are valid (issue #557): stored with the quality flags, shown beside the exclusions. -->
	<LowFlowPeriods
		bind:list={() => s.qualityFlags.lowFlowPeriods ?? [], (v) => (s.qualityFlags = { ...s.qualityFlags, lowFlowPeriods: v.length ? v : undefined })}
		bind:error={draft.errors.lowFlow}
		{readonly}
		{seriesKinds}
		flowKind={s.calibrationFlowKind ?? null}
		outletTicked={s.calibrateAtOutlet !== false}
	/>
	<!-- Rarely changed: the gauged ranges, the day rules, the river-stop months and gap filling, folded into one line of
	     their values (ui-playbook.md § 2, "Rarely changed settings fold into their values"). -->
	<Fold
		{readonly}
		name="Quality flags:"
		line={qualityFlagsSummary(s.qualityFlags, s.flowGapFill, seriesKinds)}
		atDefaults={qualityFlagsAtDefaults(s.qualityFlags, s.flowGapFill)}
		body="stack"
		spaced
		testid="record-flags"
		lineTestid="record-flags-summary"
	>
		<Lazy load={loadQualityFlags}>
			{#snippet children(QualityFlagsFields)}<QualityFlagsFields bind:value={s.qualityFlags} bind:error={draft.errors.qualityFlags} {readonly} {seriesKinds} />{/snippet}
		</Lazy>
		<!-- Gap filling of the observed records (engine ≥ 1.23.0, issue #66); the server merges its default into every project's settings. -->
		{#if s.flowGapFill}
			<!-- Its own chunk (issue #66): the Settings tab chunk sits at its size ceiling. -->
			<Lazy load={loadFlowGapFill}>
				{#snippet children(FlowGapFillFields)}<FlowGapFillFields bind:value={s.flowGapFill} bind:last={draft.kept.flowGapFill} {readonly} {seriesKinds} />{/snippet}
			</Lazy>
		{/if}
	</Fold>
</section>

<section class="panel" id="set-fit" aria-labelledby="fit-h">
	<div class="panel-head">
		<h3 id="fit-h">Fit the parameters</h3>
		<NotesDrawer projectId={project.id} target={settingTarget('fit')} />
	</div>
	<p class="summary" data-testid="summary-fit">{summaries['set-fit']}</p>
	<p class="hint explain">Fit automatically, the fit record of the parameters above, and automated calibration under declared rules.</p>
	<!-- Two cards (2026-10-10): fit now with its record at its foot, and the declared rules with their run in the
	     head beside the sign-off (issue #521). Each card's main action sits right under its deciding choices or in
	     its head, never under the other's fields. -->
	<!-- The regional GR4J prior (issue #622): its ranges, donors and skill, and Start from the prior; Fit automatically
	     below uses it as a penalty or its search box. Its own chunk, loaded when the section draws. -->
	<div class="sub-card" data-testid="prior-card">
		<Lazy load={loadPrior}>
			{#snippet children(RegionalPriorPanel)}
				<RegionalPriorPanel
					projectId={project.id}
					{readonly}
					formDirty={dirty}
					zones={(s.calibrationZones ?? []).filter((z) => z.enabled).map((z) => ({ nodeId: z.nodeId, name: nodeName(z.nodeId) ?? 'a gauge' }))}
					currentParams={(zone) => (zone === null ? s.gr4j : ((s.calibrationZones ?? []).find((z) => z.nodeId === zone)?.gr4j ?? s.gr4j))}
					onApplied={reloadAfterApply}
				/>
			{/snippet}
		</Lazy>
	</div>
	<div class="sub-card" data-testid="fit-now-card">
	<FitPanel
		projectId={project.id}
		x2Open={draft.x2Open}
		settings={() => $state.snapshot(s) as unknown as ProjectSettings}
		model={() => (editor?.dirty ? editor.snapshot() : undefined)}
		{nodes}
		outletHasRecord={outletRecords.length > 0}
		hasObserved={hasRecord || calSites.length > 0 || outletRecords.length > 0}
		seriesKinds={recordKinds}
		calibrationFlowKind={s.calibrationFlowKind}
		{readonly}
		onApply={applyFit}
		session={fit}
	>
		<!-- The WR2012 MAR penalty: a saved setting (the save bar), beside the fit it changes (issue #521; it was in the WR2012 check). -->
		{#snippet penaltyFields()}<MarPenaltyFields bind:value={s.wr2012} {readonly} />{/snippet}
	</FitPanel>
	<!-- The fit record of the parameters, at the foot of the card whose Apply writes it (issue #521), folded into its
	     first line: open from 1024 px, closed on a phone, where its ~1,300 px stood between the two cards (round 5). -->
	<!-- The headline location's fit record (issue #659): the outlet's is the top level's, a gauge's its row's. -->
	{#if hs.fitRecord}
		<Fold name="Fit record:" line={fitRecordLine(hs.fitRecord)} change="Show" open={fitRecordOpen} problem={false} body="none" spaced testid="fit-record-fold">
		<FitProvenance
			record={hs.fitRecord}
			settings={hs}
			heading={headline === null ? 'Fit record of these parameters' : `Fit record at ${locationName(nodes, headline)}, the headline`}
			headingLevel={5}
			context="form"
			{chirpsSource}
			{apanDaily}
			{et0Daily}
			observedOrigin={observedOrigins ? (observedOrigins[calibrationSeriesKey(hs.fitRecord.flowKind as CalibrationFlowKind, hs.fitRecord.siteNodeId)] ?? null) : undefined}
			{nodeName}
		/>
		</Fold>
	{/if}
	</div>
	<!-- Automated calibration (issue #153): its rules, saved with the form, then the run under the saved rules. -->
	{#if s.calibrationRules}
		<div class="sub-card" data-testid="rules-card">
		<Lazy load={loadCalibrationRules}>
			{#snippet children(CalibrationRulesFields)}
				<CalibrationRulesFields bind:value={s.calibrationRules} bind:error={draft.errors.rules} bind:lastShare={draft.kept.flaggedShare} {readonly}>
					<!-- The card's main action in its head, beside the sign-off (issue #521); AutoFitPanel below runs it and shows the result. -->
					{#snippet headAction()}
						<button
							type="button"
							class="btn btn-primary"
							onclick={() => autoFit?.start()}
							disabled={!autoFit?.canRun()}
							aria-describedby={autoFit?.runBlocker() ? 'rules-run-why' : undefined}>Run the calibration rules</button
						>
					{/snippet}
					<!-- Why it can't run, under it rather than ~700 px down at the card's foot (issue #586, C3). -->
					{#snippet headNote()}
						{@const why = autoFit?.runBlocker()}
						{#if why}
							<p class="hint run-why" id="rules-run-why" data-testid="rules-run-why" data-kind={why.kind}>
								{why.text}{#if why.kind === 'record'}{' '}<a href="?tab=series">Add one on Data</a>.{/if}
							</p>
						{/if}
					{/snippet}
				</CalibrationRulesFields>
			{/snippet}
		</Lazy>
		<Lazy load={loadAutoFit}>
			{#snippet children(AutoFitPanel)}
				<AutoFitPanel
					bind:this={autoFit}
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
		</div>
	{/if}
</section>

<div id="set-wr2012">
	<Wr2012Section
		summary={summaries['set-wr2012']}
		bind:value={s.wr2012}
		bind:error={draft.errors.wr2012}
		bind:last={draft.kept.wr2012}
		bind:lastBand={draft.kept.wr2012Band}
		{readonly}
		projectId={project.id}
		modelAreaKm2={farmAreaKm2 > 0 || cal.catchmentAreaKm2 == null || cal.catchmentAreaKm2 <= 0 ? farmAreaKm2 : cal.catchmentAreaKm2}
	/>
</div>

<style>
	/* SettingsTab.svelte's styles for these panels, moved with them (issue #586): the same rules, so the panels look the
	   same as Model settings' own. SettingsTab keeps its copy of the shared ones for its own panels. The panel line
	   (.summary) and the cards (.sub-card) are app.css's `.settings-form` rules, the wrapper the page gives them. */
	.u {
		font-weight: 400;
		color: var(--text-muted);
		font-size: var(--font-sm);
	}
	.hint {
		display: block;
		font-size: var(--font-sm);
		max-width: 75ch;
	}
	.panel > .hint {
		margin: 0.5rem 0 0.75rem;
	}
	/* Evaporation from the map as a card of its own: its heading at the card's top, not 1rem under it. */
	.sub-card :global(.proposals.inline) {
		margin-top: 0;
	}
	.sub-card > .sub.first {
		margin: 0 0 0.25rem;
	}
	/* A fold whose body is a column of blocks (a table helper, a toolbar), not a grid of fields. */
	.fold-body.stack {
		grid-template-columns: minmax(0, 1fr);
	}
	/* "Changed 1× · last by …" under a parameter: one line, so a changed field's cell is as tall as its neighbours';
	   the whole text is the link's name and its title, and History has it in full. */
	.gr4j-fields :global(.field-history) {
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	:global(.pan-tools-line) {
		min-width: 0;
		max-width: 60ch;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.fields {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
		gap: 0 1.25rem;
		margin-top: 0.5rem;
	}
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
	/* The monthly rows fit beside the side index at 1440 px and beside the workspace sidebar at 1280 px: a month
	   cell is as narrow as a six-digit value allows, with no spin buttons (SettingsTab.svelte says why in full). */
	.monthly td {
		width: calc(6.5ch + 0.7rem + 2px + 0.4rem);
		padding-left: 0.1rem;
		padding-right: 0.1rem;
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
		width: 13rem;
		white-space: normal;
	}
	/* A narrow panel (a phone): the row label takes a narrow column and wraps, its unit on a line of its own. */
	.table-wrap {
		container: monthly / inline-size;
	}
	@container monthly (max-width: 30rem) {
		.monthly th.sticky {
			width: 6.5rem;
			min-width: 6.5rem;
		}
		.monthly th.sticky .u {
			display: block;
		}
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
	.pan-source {
		max-width: 40rem;
		margin-top: 0.5rem;
	}
	.pe-source input,
	.pan-source input {
		width: 100%;
	}
	.check {
		display: inline-flex;
		align-items: center;
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
	h3 :global(.helptip),
	h4 :global(.helptip),
	h5 :global(.helptip),
	th :global(.helptip) {
		margin-left: 0.15rem;
	}
	/* The page's parts are its h2s (CalibrationTab.svelte, issue #586 round 3), so a panel's heading is an h3, a card's
	   an h4 and a card's sub-group an h5: each keeps the size it had one level up on Model settings. */
	.panel-head > h3 {
		font-size: 1.1rem;
	}
	h4.sub {
		font-size: 0.95rem;
	}
	h5.sub {
		font-size: 1em;
	}
	.sub {
		margin: 1rem 0 0.35rem;
	}
	legend .sub {
		margin: 0;
	}
	.err {
		color: var(--danger);
		font-size: var(--font-sm);
	}
	.unplaced {
		margin: 0.75rem 0;
		max-width: 75ch;
	}
	.unplaced p,
	.unplaced ul {
		margin: 0;
	}
	.unplaced ul {
		padding-left: 1.25rem;
	}
	input.invalid {
		border-color: var(--danger);
	}
</style>
