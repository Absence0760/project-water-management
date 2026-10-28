<script module lang="ts">
	// Every lazy section below that draws on each visit shares one chunk, lazySections.ts (issue #521), with
	// CalibrationSettings.svelte's (on the Calibration page): they load as the tab opens, so one request and one gzip
	// stream instead of seven.
	const loadSections = () => import('./lazySections');
	// Settings → Evidence, the declared uncertainty rule (issue #71): out of the tab's chunk, loaded when the section
	// draws, so the Settings tab chunk stays under its size ceiling.
	const loadEvidenceRule = () => loadSections().then((m) => ({ default: m.EvidenceRuleFields }));
	// Settings → Drought restrictions (engine ≥ 1.54.0, WP-3.8): its own chunk, for the same reason.
	const loadDroughtRestriction = () => import('./DroughtRestrictionFields.svelte');
	// The daily EWR at the outlet (engine ≥ 1.77.0, issue #455): its own chunk, for the same reason.
	const loadEwrDailySource = () => import('./EwrDailySourceFields.svelte');
	// Rain for each unit (settings.unitRain, issue #482): out of the tab's chunk, for the same reason; its areal body its own.
	const loadUnitRain = () => loadSections().then((m) => ({ default: m.UnitRainFields }));
	// Model selection for flow generation → Per unit's station table (issue #553 round 3): in the same chunk, drawn whenever Per unit is chosen.
	const loadFlowGenUnits = () => loadSections().then((m) => ({ default: m.FlowGenerationUnits }));
	// … and the catchment's station (issue #612 follow-up), in the same chunk, drawn under both methods.
	const loadFlowGenCatchment = () => loadSections().then((m) => ({ default: m.FlowGenerationCatchment }));
	// Each unit's MAP from the MAP grid (issue #482): editors only, while rain for each unit is on; its own chunk too.
	const loadUnitMap = () => import('./UnitMapProposal.svelte');
	// Rain gaps' three cards, Gap-filling product (issue #604), CHIRPS gap filling and Flagged rain (issue #521), inside the fold that is one closed
	// line at the defaults (most projects): out of the tab's chunk for the same reason, with its three sections.
	const loadRainGaps = () => loadSections().then((m) => ({ default: m }));
</script>

<script lang="ts">
	import DayInput from '#lib/components/common/DayInput.svelte';
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { withParam } from '#lib/workspace/overlays.js';
	import { landOnAnchor } from '#lib/help/anchor.js';
	import NotesDrawer from '#lib/components/notes/NotesDrawer.svelte';
	import { settingTarget } from '#lib/components/notes/notes.js';
	import {
		fitFlowMethod,
		flowMethodOf as fitMethodOf,
		LAKE_FACTOR_PRESETS,
		lakeFactorPresetFill,
		lakeFactorPresetNamed,
		lakeFactorPresetStale,
		PE_SOURCE_MAX,
		QM_MIN_WET_DAYS,
		QM_WET_DAY_MM_MAX,
		QM_WET_DAY_MM_MIN,
		type UnitRainSettings,
		type SeriesMeta,
		type ModelInput,
		defaultProjectSettings,
		resolveCatchmentAreaKm2
	} from '@water-management/engine';
	import { hasRole, type Project } from '#lib/api/index.js';
	import HelpTip from '#lib/components/help/HelpTip.svelte';
	import NumberInput from '#lib/components/common/NumberInput.svelte';
	import FieldHistoryLine from '#lib/components/history/FieldHistoryLine.svelte';
	import { annualMm3 } from '#lib/components/crops/demand.js';
	import { fmtNum, fmtPct, fmtQty } from '#lib/format/number.js';
	import { WATER_YEAR_MONTHS } from '#lib/format/months.js';
	import type { ModelEditor } from '#lib/model/editor.svelte.js';
	import { fillHeader } from '#lib/components/workspace/headerSlot.svelte.js';
	import { dataQualityError } from './dataQuality';
	import DataQualitySection from './DataQualitySection.svelte';
	import { AUTO_RUN_DEBOUNCE_MAX, AUTO_RUN_MAX_WAIT_MINUTES, autoRunError } from '#lib/components/autorun/autoRun.js';
	import { outcomesError } from '#lib/components/outcomes/outcomeSettings.js';
	import { outlookError } from '#lib/components/outlook/settings.js';
	import { CHIRPS_BIAS_OPTIONS, rainGapsAtDefaults, rainGapsLine, withChirpsQuantileMap } from './rain';
	import { FLOW_GENERATION_HEADING, settingsElsewhere, settingsNavGroups } from './sections';
	import { periodError, reportingError } from './blockers';
	import { followAnchors } from '#lib/nav/anchorLanding.js';
	import { settingsSummaries, type SummaryInput } from './summaries';
	import type { CatchmentStation } from './unitRain';
	import SectionNav from '#lib/components/common/SectionNav.svelte';
	import MonthlyPasteDialog from './MonthlyPasteDialog.svelte';
	import EwrRulesSection from './EwrRulesSection.svelte';
	import EwrHeadlineField from './EwrHeadlineField.svelte';
	import Lazy from '#lib/components/common/Lazy.svelte';
	import ExplainSwitch from '#lib/components/common/ExplainSwitch.svelte';
	import { explainSwitch } from '#lib/components/common/explain.svelte.js';
	import Fold from '#lib/components/common/Fold.svelte';
	import { proposeFitRanges } from './proposeFitRanges';
	import { apanSourceNote, withLakeMonthly } from './peInput';
	import { withUnitRain } from './unitRain';
	import { FLOW_METHODS, flowMethodOf, methodLabel, stationOptions, unitsOnCatchmentRain, type FlowGenerationMethod } from './flowGeneration';
	import { calibrationHref } from '#lib/components/calibration/links.js';
	// These panels render on every visit of the tab (the pan-coefficient helper aside, above), so they are in its chunk rather than chunks of
	// their own: split, they only added overhead (6 KB gzip, issue #17; tab chunks have their own
	// ceiling in scripts/guards/check_web_bundle_budget.mjs). Data feeds, API keys and scheduled
	// reports save through their own APIs, never through the save bar (docs/ui.md § Data feeds,
	// § API keys, § Scheduled reports); the outcome matrix (issue #53 R4) and seasonal outlook
	// (R5) settings are part of the form.
	import OutcomeSettingsSection from '#lib/components/outcomes/OutcomeSettingsSection.svelte';
	import OutlookSettingsSection from '#lib/components/outlook/OutlookSettingsSection.svelte';
	import type { SettingsDraft } from './settingsDraft.svelte';
	import type { RecordOption } from './recordPeriods';

	let {
		project,
		editor,
		draft,
		seriesKinds = null,
		catchmentRain,
		rainSeries,
		rainRecords = null,
		readonly,
		onModelChanged = () => {}
	}: {
		project: Project;
		editor?: ModelEditor;
		/**
		 * The unsaved settings, held by the workspace page (settingsDraft.svelte.ts): its save bar saves,
		 * discards and previews them with the model's edits and the Calibration page's, so this form has no save
		 * bar of its own.
		 */
		draft: SettingsDraft;
		/** Kinds of the project's input series: where Demand's A-pan comes from. */
		seriesKinds?: string[] | null;
		/** The catchment rain series a run reads, whose station MAP Rain for each unit reads (issue #553): null = none, undefined = not loaded. */
		catchmentRain?: CatchmentStation | null;
		/** The project's catchment rain series, the rainfall stations Model selection for flow generation → Per unit assigns (issue #553); undefined = not loaded. */
		rainSeries?: (Pick<SeriesMeta, 'id' | 'name' | 'kind' | 'station'> & { siteNodeId?: string | null })[];
		/** The project's rain records, each one's unreliable periods on Flagged rain (issue #611, recordPeriods.ts rainRecordOptions); null = not loaded. */
		rainRecords?: RecordOption[] | null;
		readonly: boolean;
		/** A proposal saved to the model on the server (the units' MAP from the grid): the workspace reloads it. */
		onModelChanged?: () => Promise<void> | void;
	} = $props();

	// The form edits the page's draft in place (settings/settingsDraft.svelte.ts), so a tab change keeps it.
	const s = $derived(draft.s);
	// The lake-factor preset picker (engine ≥ 1.49.0) fills lakeEvapFactorMonthly and its source note; the picker
	// itself is never saved: it only fills the row and its source note, then resets.
	let lakePreset = $state('');
	let lakePresetError = $state<string | null>(null);

	const cal = $derived(s.calibration);
	const dateError = $derived(periodError(s));
	// Model selection for flow generation (issue #553 round 3): the radio is settings.unitRain on or off, as the checkbox it replaced was, so
	// no stored project changes. The one switched off is kept until saved, so switching back brings it back as it was.
	const flowMethod = $derived(flowMethodOf(s.unitRain));
	const stations = $derived(rainSeries ? stationOptions(rainSeries) : undefined);
	// The land units on the catchment rain (issue #615): their share follows their area, under both methods.
	const onCatchmentRain = $derived(rainSeries ? unitsOnCatchmentRain(editor?.model.nodes ?? [], s, rainSeries) : []);
	const NAMES_SHOWN = 6;
	const namesOf = (units: readonly { name: string }[]) =>
		units.length > NAMES_SHOWN ? `${units.slice(0, NAMES_SHOWN).map((u) => u.name || 'unnamed').join(', ')} and ${units.length - NAMES_SHOWN} more` : units.map((u) => u.name || 'unnamed').join(', ');
	function setFlowMethod(m: FlowGenerationMethod) {
		if (m === flowMethod) return;
		if (m === 'fragmentation') {
			// The Per unit setup stays (issue #615): Fragmentation's EWR shares run on it, so only the mode changes.
			if (s.unitRain) draft.kept.unitRain = $state.snapshot(s.unitRain);
			s.unitRain = withUnitRain(false, s.unitRain);
		} else {
			// A stored `catchment` setting (its gauge MAP, its period) comes back on too.
			const last = (draft.kept.unitRain as UnitRainSettings | null | undefined) ?? s.unitRain ?? null;
			s.unitRain = withUnitRain(true, last);
		}
	}
	// The CHIRPS gap map (engine ≥ 1.53.0, CR-23); the threshold it was switched off with is kept until saved.
	function setGapMapOn(on: boolean) {
		if (!on && s.chirpsQuantileMap) draft.lastGapMap = { ...s.chirpsQuantileMap };
		s.chirpsQuantileMap = withChirpsQuantileMap(on, draft.lastGapMap);
	}
	// Demand's A-pan row's paste from a spreadsheet (issue #477, MonthlyPasteDialog): its button and the row's onpaste open it.
	let monthlyPaste = $state<ReturnType<typeof MonthlyPasteDialog> | undefined>(undefined);
	const openMonthlyPaste = () => monthlyPaste?.openPaste();
	// Monthly lake factors (WP-3.5): the twelve switched off come back when it is ticked again, until saved.
	function setLakeMonthlyOn(on: boolean) {
		if (!on && s.lakeEvapFactorMonthly) draft.lastLakeMonthly = [...s.lakeEvapFactorMonthly];
		s.lakeEvapFactorMonthly = withLakeMonthly(on, s.lakeEvapFactor, draft.lastLakeMonthly);
	}
	const reportError = $derived(reportingError(s));
	const dqError = $derived(dataQualityError(s.dataQuality));
	const autoError = $derived(autoRunError(s.autoRun));
	const outError = $derived(outcomesError(s.outcomes));
	const outlookErr = $derived(outlookError(s.outlook));
	// What blocks Save is the draft's to work out (blockers.ts), for this page's panels and Calibration's alike, so the
	// save bar lists every problem whichever page is shown; the menu marks this page's.
	const blockers = $derived(draft.blockers);
	// The daily EWR's area ratio numerator: the area the run's natural flow is made on (the engine's own choice: the
	// land units' under per-unit rain, else the calibration override, else the units' areas summed).
	const ewrModelAreaKm2 = $derived(resolveCatchmentAreaKm2(s.calibration, { model: { nodes: editor?.model.nodes ?? [] }, settings: s } as unknown as ModelInput));
	const ewrAnnual = $derived(annualMm3(s.ewrPragmaticM3PerDay, s.februaryDays));
	// The daily EWR at the outlet from the DRM tables (engine ≥ 1.77.0): the pragmatic row then isn't read.
	const dailyFromDrm = $derived(!!s.ewrDailySource && s.ewrDailySource.method !== 'pragmatic');
	const dailyEwrHead = $derived(
		!dailyFromDrm ? 'Pragmatic EWR at the outflow gauge' : s.ewrDailySource!.method === 'tab' ? 'Daily EWR from the DRM TAB file' : 'Daily EWR from the DRM percentile tables'
	);
	// Days in February sits behind an advanced disclosure (issue #174); its summary names the value, and says when it
	// isn't the default, so a changed value is never hidden.
	const FEB_DEFAULT = defaultProjectSettings().februaryDays;
	const febChanged = $derived(Math.abs((s.februaryDays ?? FEB_DEFAULT) - FEB_DEFAULT) > 1e-9);
	const apanAnnual = $derived(s.apanMm.reduce((t, v) => t + (v || 0), 0));

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

	// The declared uncertainty rule as saved (issue #71): switching it off withdraws this one.
	const savedEvidenceRule = $derived(draft.saved.evidenceUncertaintyRule);

	const chirpsOption = $derived(CHIRPS_BIAS_OPTIONS.find((o) => o.value === s.chirpsBiasCorrection));
	// Where Demand's A-pan comes from: a daily A-pan series (issue #45) is A-pan too, on the days it covers.
	const apanSource = $derived(apanSourceNote(seriesKinds));

	/**
	 * From this content width (rem, 14 px) the menu is a side index (issue #468): at 1440 px the content is
	 * ~84rem, and beside a 13rem index every monthly row still fits; at 1280 px (~73rem) it would scroll
	 * sideways, so the bar stays there.
	 */
	const RAIL_FROM_REM = 80;
	let navLayout = $state<'bar' | 'rail'>('bar');
	// Each link is marked while its panel has something to fix before saving.
	const navGroups = $derived(
		settingsNavGroups().map((g) => ({
			label: g.label,
			sections: g.sections.map((sec) => ({ ...sec, problem: blockers.some((b) => b.id === sec.id) }))
		}))
	);

	/**
	 * The fit's method when the parameters were fitted under the other one: "parameters not fitted for this method"
	 * (the engine's fitRecordStatus methodChanged, which reads only these two).
	 */
	const fitMismatch = $derived.by(() => {
		const m = s.fitRecord ? fitFlowMethod(s.fitRecord) : null;
		return m !== null && m !== fitMethodOf(s.unitRain) ? m : null;
	});
	// Rain gaps at its defaults: one line that opens its three cards (rain.ts).
	const rainAtDefaults = $derived(rainGapsAtDefaults(s));
	// Each panel's line of what it is set to now (summaries.ts).
	const summaries = $derived(
		settingsSummaries({
			s: s as unknown as SummaryInput['s'],
			ewrAnnualMm3: ewrAnnual,
			ewrSource: dailyEwrHead
		})
	);
	// The header names where the fit went (issue #586 round 3): its line and "Fit the parameters" are Calibration's now.
	$effect(() => fillHeader({ context: headerContext }));

	// A link into a group from elsewhere (`?tab=settings#set-ewr`, a note's link), on load or followed while
	// the page is open (a #fragment typed or followed here, finding R2-D): the tab is a lazy chunk, so the
	// browser's own jump found nothing. Land on the group once drawn, hold it while the panels settle (as EWR
	// does), and focus its heading once that is drawn too: some panels (Evaporation from the map) are lazy
	// chunks of their own, drawn after this mounts (landOnAnchor waits for them). A link to a panel that
	// moved away (#set-feeds, #set-api-keys, #set-report-schedules: an old email, a bookmark, a note) goes on
	// to its new page instead, every other parameter kept, replacing this entry so Back skips it; that page
	// lands on the panel (nav/anchorMoves.ts, issue #586 round 1). reset: false, so SvelteKit leaves the
	// focus to the new page's landing. (`?tab=calibration` opened this page at Flow calibration until
	// Calibration got a page of its own, issue #586; its #set- links come here, but for the four panels that
	// moved there in round 3.)
	onMount(() => {
		const stopAnchors = followAnchors({
			page: 'settings',
			land: (id) => (id.startsWith('set-') ? landOnAnchor(id) : undefined),
			forward: (to) => void goto(to, { replace: true, reset: false })
		});
		return stopAnchors;
	});
</script>

{#snippet headerContext()}<span class="settings-context" data-testid="settings-context">What the model runs on, and how its results are read. The runoff parameters’ fit is on <a href="?tab=calibration">Calibration</a>.</span>{/snippet}

<!-- In-page menu (issue #468): from a content width where the monthly rows still fit beside it, a sticky
     index on the left, grouped by task, with a find box; narrower, the bar that sticks under the app header
     and a sideways strip on a phone. -->
<SectionNav groups={navGroups} label="Settings sections" find="Find a setting" elsewhere={settingsElsewhere(hasRole(project.role, 'owner'))} railFrom={RAIL_FROM_REM} bind:layout={navLayout}>
<!-- Not a <form>: the page's save bar saves it, and the notes' and the quaternary lookup's own forms
     inside the panels would otherwise be nested forms (invalid HTML) whose submit reached this one. -->
<div class="settings-form explain-scope" class:explained={explainSwitch.on}>

	<!-- The explanations under the fields (issue #468), above the first panel since it has explanations too: off, the controls come first; each field keeps its ⓘ tip,
	     and the hidden text stays its description for screen readers. Remembered on this device. -->
	<ExplainSwitch />

	<!-- Model selection for flow generation (issue #553 round 3; "Flow generation" until issue #614) ------------->
	<!-- First on the page (issue #614: the client's main modelling choice, above the EWR the results are judged by).
	     How natural flow is made: one choice, Fragmentation or Per unit (settings.unitRain off or `perUnit`, docs/model.md
	     §2.4h, §2.5), with each method's settings under it. Its id stays set-share, so the links to the flow share and the
	     panel's notes (settingTarget('share')) still land here. The lead card (data-lead): an accent frame and a tinted
     head, and the two methods as choice cards, so the main modelling choice stands out (issue #614). -->
	<section class="panel lead" id="set-share" aria-labelledby="share-h" data-lead>
		<div class="panel-head">
			<h2 id="share-h">{FLOW_GENERATION_HEADING}</h2>
			<NotesDrawer projectId={project.id} target={settingTarget('share')} />
		</div>
		<p class="summary" data-testid="summary-share">{summaries['set-share']}</p>
		<!-- Which "flow" panel is which (issue #586 E14): this one makes natural flow from rain; Calibration's Flow
		     calibration sets the runoff model's parameters. A where-line, not an explanation, so it stays with the
		     explanations off, as the comparison band's line under EWR does. -->
		<p class="hint" data-testid="flowgen-where">
			The runoff model’s parameters are fitted on Calibration, under <a href={calibrationHref(null, 'set-flow')}>Flow calibration</a>.
		</p>
		<fieldset class="plain flowgen-method" data-testid="flowgen-method" aria-describedby="st-flowgen-h">
			<legend>How natural flow is made <HelpTip key="settings.unitRain" /></legend>
			<!-- Each method a choice card: its name, then what it does in plain words, always shown (its name alone said
			     nothing). The radio stays a radio; its label covers the card, so a click anywhere on it picks it. -->
			<div class="radios">
				{#each FLOW_METHODS as m (m.value)}
					<span class="opt">
						<label class="check">
							<input type="radio" name="st-flowgen" value={m.value} checked={flowMethod === m.value} disabled={readonly} onchange={() => setFlowMethod(m.value)} aria-describedby="st-flowgen-{m.value}" />
							{m.label}
						</label>
						<span class="opt-what" id="st-flowgen-{m.value}" data-testid="flowgen-what">{m.short}</span>
					</span>
				{/each}
			</div>
			<span class="hint explain" id="st-flowgen-h">
				{FLOW_METHODS.find((m) => m.value === flowMethod)?.help} GR4J’s parameters depend on the rain they were fitted on, so switching method needs a refit.
			</span>
		</fieldset>
		{#if fitMismatch}
			<!-- A state line, not an explanation (it stays when the explanations are off): the fit is the other method's. -->
			<p class="alert alert-warning" role="status" data-testid="flowgen-refit">
				Parameters not fitted for this method: the GR4J parameters were fitted under {methodLabel(fitMismatch)}. <a href="?tab=calibration#set-fit">Fit the parameters</a>
				again on Calibration before relying on the results.
			</p>
		{/if}
		<!-- The Per unit setup (issue #615): under Per unit it makes each unit's runoff; under Fragmentation it makes only each
		     unit's natural MAR share of the EWR (docs/model.md §2.5b), so it shows under both. -->
		{#if flowMethod === 'fragmentation'}
			<p class="hint" role="note" data-testid="flowgen-share-setup">
				Under Fragmentation the setup below sets only how the EWR is split: GR4J also runs once on each unit’s own rain, for each unit’s natural MAR share, and the catchment’s one run still makes the flow.
			</p>
		{/if}
		<!-- The catchment's rainfall station (settings.rainStations.catchment, issue #612 follow-up): the catchment rain under
		     either method (GR4J's one run under Fragmentation; demand and the dams always), so it shows under both. -->
		<div class="sub-card" data-testid="flowgen-catchment-card">
			<h3 class="sub first">The catchment’s rainfall station <HelpTip key="catchment-rain-station" /></h3>
			<Lazy load={loadFlowGenCatchment}>
				{#snippet children(FlowGenerationCatchment)}
					<FlowGenerationCatchment bind:value={s.rainStations} {readonly} {stations} projectId={project.id} nodes={editor?.model.nodes ?? []} />
				{/snippet}
			</Lazy>
		</div>
		<div class="sub-card" data-testid="flowgen-stations-card">
			<h3 class="sub first">Each unit’s rainfall station <HelpTip key="settings.rainStations" /></h3>
			<Lazy load={loadFlowGenUnits}>
				{#snippet children(FlowGenerationUnits)}
					<FlowGenerationUnits bind:value={s.rainStations} {readonly} nodes={editor?.model.nodes ?? []} {stations} projectId={project.id} />
				{/snippet}
			</Lazy>
		</div>
		<div class="sub-card" data-testid="flowgen-chain-card">
			<!-- What a unit without a station runs on (settings.unitRain, issue #482): the rule from before stations. -->
			<Lazy load={loadUnitRain}>
				{#snippet children(UnitRainFields)}
					<UnitRainFields bind:value={s.unitRain} {readonly} nodes={editor?.model.nodes ?? []} {catchmentRain} />
				{/snippet}
			</Lazy>
			{#if !readonly && editor}
				<!-- Each unit's MAP from the MAP grid: saves straight to the model, then the workspace reloads it. -->
				<Lazy load={loadUnitMap}>
					{#snippet children(UnitMapProposal)}<UnitMapProposal projectId={project.id} modelDirty={editor.dirty} {onModelChanged} />{/snippet}
				</Lazy>
			{/if}
		</div>
		<div class="sub-card" data-testid="flowgen-share-card">
			<h3 class="sub first">Flow share and the EWR split</h3>
			<!-- One share per unit, its natural MAR share, under both methods (issues #615, #616; docs/model.md §2.5, §2.5b):
			     it splits the EWR, the land-cover low-flow threshold and the priority users' demand, and under Fragmentation
			     GR4J's one run's flow too. The area, Hi/Lo MAP and specific methods are gone (#616), so nothing here is set. -->
			<!-- A state line, not an explanation: it stays when the explanations are off, as the areal rain note does. -->
			<p class="hint" role="note" data-testid="ewr-split-hint">
				Each unit’s share is its natural MAR: its own GR4J runoff over the run’s complete water years ÷ the units’ total{flowMethod === 'perUnit' ? '' : ', from the runs on each unit’s own rain above'}. It splits the EWR, the land cover’s low-flow threshold and the priority users’ demand between the units. The run’s summary lists each unit’s share, and the <a href={withParam(page.url, 'grid', 'nodes')}>hydrological unit table</a>’s In use column the latest run’s.
			</p>
			{#if onCatchmentRain.length}
				<p class="hint" role="note" data-testid="ewr-split-catchment-rain">
					{onCatchmentRain.length === 1 ? 'One unit has' : `${onCatchmentRain.length} units have`} no rain of {onCatchmentRain.length === 1 ? 'its' : 'their'} own (no station, rain gauge, CHIRPS, or MAP with a gauge MAP), so {onCatchmentRain.length === 1 ? 'it runs' : 'they run'} on the catchment rain and {onCatchmentRain.length === 1 ? 'its' : 'their'} share follows {onCatchmentRain.length === 1 ? 'its' : 'their'} area:
					{namesOf(onCatchmentRain)}.
				</p>
			{/if}
			{#if flowMethod === 'perUnit'}
				<p class="hint" role="note" data-testid="share-hint" data-unit-rain="on">
					Each unit makes its own runoff, so the shares don’t split the flow.
				</p>
			{:else}
				<p class="hint explain" data-testid="share-hint" data-unit-rain="off">
					GR4J runs once on the catchment rain, and the units’ shares split its flow between them. To give each unit its own runoff, choose Per unit above.
				</p>
			{/if}
		</div>
	</section>

	<!-- EWR the results are judged by (issue #444; "Judge results by" until issue #586 E14): first, as the client
	     asked, until issue #614 put the model selection above it; it reads results and changes none. In the lead
	     group with no name, after the model selection (sections.ts); the EWR page's "Change" links here (#set-judge). -->
	<EwrHeadlineField
		bind:value={s.ewrHeadline}
		ewrRules={s.ewrRules}
		ewrPragmatic={s.ewrPragmaticM3PerDay}
		ewrDaily={s.ewrDailySource}
		chargeSource={s.ewrChargeSource}
		nodes={editor?.model.nodes ?? []}
		{readonly}
	/>

	<!-- Period ------------------------------------------------------------------------>
	<!-- Blank (the default) runs over the whole rain record, so the blank fields say that rather than DayInput's
	     example day, which read as a stored start and end of 15 Nov 2021. -->
	<section class="panel" id="set-period" aria-labelledby="per-h">
		<div class="panel-head">
			<h2 id="per-h">Simulation period <HelpTip key="settings.simulationStart" /></h2>
			<NotesDrawer projectId={project.id} target={settingTarget('period')} />
		</div>
		<p class="summary" data-testid="summary-period">{summaries['set-period']}</p>
		<div class="form-row">
			<div class="field">
				<label for="st-start">Simulation start</label>
				<DayInput
					id="st-start"
					readonly={readonly}
					value={s.simulationStart ?? ''}
					placeholder="First day with rain"
					onchange={(v) => (s.simulationStart = v || null)}
					aria-invalid={dateError ? 'true' : undefined}
					aria-describedby={dateError ? 'st-period-err' : undefined}
				/>
			</div>
			<div class="field">
				<label for="st-end">Simulation end</label>
				<DayInput
					id="st-end"
					readonly={readonly}
					value={s.simulationEnd ?? ''}
					placeholder="Last day with rain"
					onchange={(v) => (s.simulationEnd = v || null)}
					aria-invalid={dateError ? 'true' : undefined}
					aria-describedby={dateError ? 'st-period-err' : undefined}
				/>
			</div>
		</div>
		<p class="hint muted explain">
			Leave blank to simulate from the first to the last day with rain; flow recorded outside that is left out,
			and the run says so. Set a window to focus a run on a drought or a calibration period, or to reach past the
			rain record.
		</p>
		{#if dateError}<p class="err" id="st-period-err">{dateError}</p>{/if}
	</section>

	<!-- How missing catchment rain is filled: CHIRPS, bias-corrected or raw, on
	     blank days and on the zero-rain runs treated as missing. -->
	<section class="panel" id="set-rain" aria-labelledby="rain-h">
		<div class="panel-head">
			<h2 id="rain-h">Rain gaps</h2>
			<NotesDrawer projectId={project.id} target={settingTarget('rain')} />
		</div>
		<p class="summary" data-testid="summary-rain">{summaries['set-rain']}</p>
		<p class="hint explain">Which product fills blank days in the catchment rain (CHIRPS, or ERA5-Land and IMERG Late), how CHIRPS is corrected, and periods taken from another gauge.</p>
		<!-- Three cards, Gap-filling product, CHIRPS gap filling and Flagged rain, the last two's lists each with its add actions in its own head row; at the
		     defaults (most projects) all are one line that opens them (ui-playbook.md § 2, "Settings at their defaults
		     are one line"). Always mounted (once its chunk loads, loadRainGaps), like the other sections that feed the Save blocker: a list left invalid
		     after turning bias correction off must stay in the page, where the fold's line says it needs fixing. -->
		<Fold {readonly} testid="rain-defaults" name={rainAtDefaults ? 'All defaults:' : 'Now:'} line={rainGapsLine(s)} atDefaults={rainAtDefaults} body="stack" spaced>
			<Lazy load={loadRainGaps}>
				{#snippet children(R)}
			<!-- The gap-filling product (settings.gapRain, engine ≥ 1.101.0, issue #604): first, as it decides what the CHIRPS card corrects. -->
			<R.GapRainFields bind:value={s.gapRain} {readonly} station={!!s.rainStations?.catchment} />
			<R.ChirpsFitPeriodSection
				bind:value={s.chirpsFitPeriod}
				bind:error={draft.errors.fitPeriod}
				{readonly}
				inactive={s.chirpsBiasCorrection !== 'monthly'}
				propose={() => proposeFitRanges(project.id, s.zeroRainRuns, s.dataQuality)}
			>
				<div class="fields">
					<div class="field">
						<span class="lbl"><label for="st-chirps-bias">CHIRPS bias correction</label><HelpTip key="settings.chirpsBiasCorrection" /></span>
						<select id="st-chirps-bias" disabled={readonly} bind:value={s.chirpsBiasCorrection} aria-describedby="st-chirps-bias-h">
							{#each CHIRPS_BIAS_OPTIONS as o (o.value)}<option value={o.value}>{o.label}</option>{/each}
						</select>
						<span class="hint explain" id="st-chirps-bias-h">{chirpsOption?.help}</span>
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
					<span class="hint" class:explain={s.chirpsBiasCorrection === 'monthly'} id="st-chirps-qm-h">
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
			</R.ChirpsFitPeriodSection>
			<div class="sub-card" data-testid="flagged-rain-card">
				<h3 class="card-title">Flagged rain</h3>
				<R.ZeroRainSection bind:value={s.zeroRainRuns} bind:error={draft.errors.zeroRain} {readonly} />
				<R.RainSourceSection bind:value={s.rainSource} bind:error={draft.errors.rainSource} {readonly} />
				<!-- Any rain record's unreliable periods (issue #611): a station's, a unit's own gauge's, the alternative gauge's.
				     Emptied, the setting goes back to how it was saved (absent or null). -->
				<R.RainRecordPeriods
					bind:value={() => s.rainStations, (v) => (s.rainStations = v ?? (draft.saved.rainStations === undefined ? undefined : null))}
					bind:error={draft.errors.rainUnreliable}
					records={rainRecords}
					{readonly}
				/>
			</div>
				{/snippet}
			</Lazy>
		</Fold>
	</section>

	<!-- Data quality (DataQualitySection: gauge vs logger, outliers, flat stretches, zero-rain runs, low vs CHIRPS) -->
	<DataQualitySection summary={summaries['set-quality']} bind:value={s.dataQuality} projectId={project.id} {readonly} error={dqError} />

	<!-- Demand ------------------------------------------------------------------>
	<section class="panel" id="set-demand" aria-labelledby="dem-h">
		<div class="panel-head">
			<h2 id="dem-h">Demand</h2>
			<NotesDrawer projectId={project.id} target={settingTarget('demand')} />
		</div>
		<p class="summary" data-testid="summary-demand">{summaries['set-demand']}</p>
		<p class="hint explain">Gross irrigation need = A-pan × crop factor × area.</p>
		{#if !readonly}
			<div class="toolbar grid-actions" data-testid="grid-actions">
				<button type="button" class="btn btn-sm" onclick={openMonthlyPaste}>Paste from a spreadsheet…</button>
			</div>
		{/if}
		<div class="table-wrap">
			<!-- `short`: a month's A-pan is at most a few hundred mm, so its cells are narrower than the EWR row's
			     six-digit m³/day, and the row label keeps one line beside the side index at 1440 (issue #586 R4-B). -->
			<table class="data compact monthly short" data-testid="apan-row">
				<thead>
					<tr>
						<th scope="col" class="sticky">Parameter</th>
						{#each WATER_YEAR_MONTHS as m (m)}<th scope="col" class="num">{m}</th>{/each}
						<th scope="col" class="num">Year</th>
					</tr>
				</thead>
				<tbody onpaste={readonly ? undefined : (e) => monthlyPaste?.paste(e, 'apanMm')}>
					<tr>
						<th scope="row" class="sticky">A-pan evaporation <span class="u">mm</span> <HelpTip key="settings.apanMm" /></th>
						{#each WATER_YEAR_MONTHS as m, i (m)}
							<td data-paste-col={i}><NumberInput label="A-pan evaporation, {m}, mm" min={0} disabled={readonly} bind:value={s.apanMm[i]} /></td>
						{/each}
						<td class="num muted">{fmtNum(apanAnnual)}</td>
					</tr>
				</tbody>
			</table>
		</div>
		<p class="hint muted explain">
			Monthly Class-A pan evaporation for the catchment, usually from the WR90 / WR2012 tables for its quaternary catchment. When an A-pan grid is
			loaded, <a href="?tab=calibration#set-evaporation">Evaporation from the map</a> (on Calibration, under Flow calibration) proposes it from the catchment boundary.
		</p>
		{#if apanSource}<p class="hint" data-testid="apan-source" data-daily={apanSource.daily}>{apanSource.text} <a href="?tab=series">{apanSource.link}</a>.</p>{/if}
		<!-- Demand's own paste (issue #477), the A-pan row only: Flow calibration's pan coefficient row, on Calibration, has its own. -->
		<MonthlyPasteDialog bind:this={monthlyPaste} {draft} rows="apan" {readonly} />
		{#if s.lakeEvapFactorMonthly}
			<div class="table-wrap">
				<table class="data compact monthly short" data-testid="lake-factor-row">
					<caption class="visually-hidden">Dam evaporation factor by month, × A-pan</caption>
					<thead>
						<tr>
							<th scope="col" class="sticky">Parameter</th>
							{#each WATER_YEAR_MONTHS as m (m)}<th scope="col" class="num">{m}</th>{/each}
						</tr>
					</thead>
					<tbody>
						<tr>
							<th scope="row" class="sticky">Dam evaporation factor <span class="u">× A-pan</span> <HelpTip key="settings.lakeEvapFactorMonthly" label="About the monthly dam evaporation factors" /></th>
							{#each WATER_YEAR_MONTHS as m, i (m)}
								<td><NumberInput label="Dam evaporation factor, {m}, × A-pan" min={0} max={2} step={0.01} disabled={readonly} bind:value={s.lakeEvapFactorMonthly[i]} /></td>
							{/each}
						</tr>
					</tbody>
				</table>
			</div>
			<p class="hint muted explain">These replace the single dam evaporation factor below, month by month. Untick “Vary it by month” to go back to one factor.</p>
		{/if}
		<div class="fields">
			<div class="field">
				<span class="lbl"><label for="st-erf">Effective rainfall <span class="u">(%)</span></label><HelpTip key="settings.effectiveRainFraction" /></span>
				<NumberInput id="st-erf" min={0} max={100} scale={100} disabled={readonly} bind:value={s.effectiveRainFraction} aria-describedby="st-erf-h" />
				<span class="hint explain" id="st-erf-h">Share of each day's rain on the cropped area that the crop can use, reducing irrigation demand. The workbook default is 65 %.</span>
				<FieldHistoryLine field="settings:effectiveRainFraction" />
			</div>
			<div class="field">
				<span class="lbl"><label for="st-ers">Soil-water store <span class="u">(mm)</span></label><HelpTip key="settings.effectiveRainStoreMm" /></span>
				<NumberInput id="st-ers" min={0} max={500} step={1} disabled={readonly} bind:value={s.effectiveRainStoreMm} aria-describedby="st-ers-h" />
				<span class="hint explain" id="st-ers-h">Effective rain the crop can't use on the day is kept for the next days, up to this depth. 25 mm (FAO-56) by default; 0 carries nothing over, as the workbook does.</span>
				<FieldHistoryLine field="settings:effectiveRainStoreMm" />
			</div>
			<div class="field">
				<span class="lbl"><label for="cal-rainThresholdMm">Rain threshold for demand <span class="u">(mm)</span></label><HelpTip key="calibration.rainThresholdMm" /></span>
				<NumberInput id="cal-rainThresholdMm" min={0} step={0.1} disabled={readonly} value={cal.rainThresholdMm} aria-describedby="cal-thr-h" onchange={(v) => { if (v !== null) s.calibration.rainThresholdMm = v; }} />
				<span class="hint explain" id="cal-thr-h">Under GR4J this only decides which rain days reduce irrigation demand; the runoff model uses all rain.</span>
				<FieldHistoryLine field="settings:calibration.rainThresholdMm" />
			</div>
			<div class="field">
				<span class="lbl"><label for="st-lef">Dam evaporation factor <span class="u">(× A-pan)</span></label><HelpTip key="settings.lakeEvapFactor" label="About the evaporation factor of the dam" /></span>
				<NumberInput id="st-lef" min={0} max={2} step={0.01} disabled={readonly} bind:value={s.lakeEvapFactor} aria-describedby="st-lef-h" />
				<span class="hint explain" id="st-lef-h">Open-water evaporation from the hydrological units’ dams as a multiple of A-pan. 0.75 by default; 0 turns dam evaporation off. WR90 lake factors are S-pan based: don't enter them here unchanged.</span>
				<FieldHistoryLine field="settings:lakeEvapFactor" />
				<!-- The box, its words and its ⓘ on one row, as a .lbl keeps a label and its tip (issue #586, C13). -->
				<span class="check-row" data-testid="lake-monthly-row">
					<label class="check">
						<input
							type="checkbox"
							disabled={readonly}
							checked={!!s.lakeEvapFactorMonthly}
							onchange={(e) => setLakeMonthlyOn(e.currentTarget.checked)}
						/>
						Vary it by month
					</label>
					<HelpTip key="settings.lakeEvapFactorMonthly" label="About varying the dam evaporation factor by month" />
				</span>
			</div>
		</div>
		<div class="field lake-preset">
			<span class="lbl"><label for="st-lake-preset">Dam evaporation preset</label><HelpTip key="settings.lakeEvapFactorSource" label="About the dam evaporation presets" /></span>
			<select id="st-lake-preset" disabled={readonly} value={lakePreset} onchange={(e) => {
					applyLakePreset(e.currentTarget.value);
					// Back to "Fill from a preset…" (lakePreset stays '', so the binding alone wouldn't reset it).
					e.currentTarget.value = '';
				}} aria-describedby="st-lake-preset-h">
				<option value="">Fill from a preset…</option>
				{#each LAKE_FACTOR_PRESETS as p (p.id)}<option value={p.id}>{p.label}</option>{/each}
			</select>
			<span class="hint explain" id="st-lake-preset-h">
				Fills the monthly factors (still editable) and the source note below. The WR90 lake factors are S-pan ratios, so the WR90 presets convert them to A-pan at this project's monthly A-pan: enter the A-pan first, and fill again after changing it.
			</span>
			{#if lakePresetError}<span class="err" role="status" data-testid="lake-preset-error">{lakePresetError}</span>{/if}
		</div>
		<div class="field lake-source">
			<span class="lbl"><label for="st-lake-source">Dam evaporation factor source</label><HelpTip key="settings.lakeEvapFactorSource" label="About where the dam evaporation factors come from" /></span>
			<input
				id="st-lake-source"
				readonly={readonly}
				maxlength={PE_SOURCE_MAX}
				value={s.lakeEvapFactorSource ?? ''}
				placeholder="e.g. a preset, or a site study of this dam"
				aria-describedby="st-lake-source-h"
				oninput={(e) => (s.lakeEvapFactorSource = e.currentTarget.value)}
			/>
			<span class="hint explain" id="st-lake-source-h">Optional: where the factors come from. A preset fills it; it is recorded with each run and shown in run comparisons and the report.</span>
			<FieldHistoryLine field="settings:lakeEvapFactorSource" />
		</div>
		{#if lakePresetStale}
			<p class="alert alert-warning small" role="status" data-testid="lake-preset-stale">
				The dam evaporation factors no longer match the “{lakePresetStale.label}” preset the source note names (a factor or the A-pan changed since it was filled): fill it again, or update the note.
			</p>
		{/if}
		<!-- Rarely changed: folded into its value (common/Fold, issue #521 round 5; it was its own <details>). -->
		<Fold
			{readonly}
			name="Advanced, days in February:"
			line="{fmtNum(s.februaryDays, 2, true)}{febChanged ? ` (not the default ${fmtNum(FEB_DEFAULT, 2)})` : ''}"
			spaced
			testid="feb-advanced"
			lineTestid="feb-line"
		>
			<div class="field">
				<span class="lbl"><label for="st-feb">Days in February</label><HelpTip key="settings.februaryDays" /></span>
				<NumberInput id="st-feb" min={28} max={29} step={0.01} disabled={readonly} bind:value={s.februaryDays} aria-describedby="st-feb-h" />
				<span class="hint explain" id="st-feb-h">Converts monthly volumes to per-day figures. 28.25 averages leap years, as the workbook does.</span>
				<FieldHistoryLine field="settings:februaryDays" />
			</div>
		</Fold>
	</section>

	<!-- Drought restrictions (engine ≥ 1.54.0, WP-3.8) ---------------------------------------->
	<section class="panel" id="set-restrict" aria-labelledby="restrict-h">
		<div class="panel-head">
			<h2 id="restrict-h">Drought restrictions <HelpTip key="settings.droughtRestriction" /></h2>
			<NotesDrawer projectId={project.id} target={settingTarget('restrict')} />
		</div>
		<p class="summary" data-testid="summary-restrict">{summaries['set-restrict']}</p>
		<p class="hint explain">Cut demand by level when the farm dams fall below a share of their capacity.</p>
		<Lazy load={loadDroughtRestriction}>
			{#snippet children(DroughtRestrictionFields)}
				<DroughtRestrictionFields bind:value={s.droughtRestriction} bind:error={draft.errors.restrict} {readonly} baseline nodes={editor?.model.nodes ?? []} projectId={project.id} />
			{/snippet}
		</Lazy>
		<FieldHistoryLine field="settings:droughtRestriction" />
	</section>

	<!-- Reporting (issue #521): the window the curtailment targets and the assurance of supply average over, and
	     when a water year counts as met. Moved here from EWR: they read the supply results, not the river. -->
	<section class="panel" id="set-reporting" aria-labelledby="reporting-h">
		<div class="panel-head">
			<h2 id="reporting-h">Reporting</h2>
			<NotesDrawer projectId={project.id} target={settingTarget('reporting')} />
		</div>
		<p class="summary" data-testid="summary-reporting">{summaries['set-reporting']}</p>
		<div class="reporting">
			<fieldset class="plain report">
				<legend>Curtailment reporting window <HelpTip key="settings.reportStart" /></legend>
				<div class="form-row">
					<div class="field">
						<label for="st-rep-start">From</label>
						<DayInput
							id="st-rep-start"
							readonly={readonly}
							value={s.reportStart ?? ''}
							onchange={(v) => (s.reportStart = v || null)}
							aria-invalid={reportError ? 'true' : undefined}
							aria-describedby={reportError ? 'st-rep-err' : undefined}
						/>
					</div>
					<div class="field">
						<label for="st-rep-end">To</label>
						<DayInput
							id="st-rep-end"
							readonly={readonly}
							value={s.reportEnd ?? ''}
							onchange={(v) => (s.reportEnd = v || null)}
							aria-invalid={reportError ? 'true' : undefined}
							aria-describedby={reportError ? 'st-rep-err' : undefined}
						/>
					</div>
				</div>
				<span class="hint explain">
					Period the curtailment targets and the assurance of supply on Hydrological units average over, e.g. the last dry season. Leave blank for the whole run.
				</span>
				{#if reportError}<p class="err" id="st-rep-err">{reportError}</p>{/if}
			</fieldset>
			<!-- Its own field, after the window: screen readers announced it as part of the window's group. -->
			<div class="field assurance">
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
				<span class="hint explain" id="st-aat-h">A water year counts as met when at least this share of a hydrological unit's demand was supplied. 90 % by default: a project choice, not a standard.</span>
				<FieldHistoryLine field="settings:assuranceAnnualThreshold" />
			</div>
		</div>
	</section>

	<!-- Flow calibration, Calibration record, Fit the parameters and the WR2012 check moved to the Calibration page
	     (issue #586 round 3, CalibrationSettings.svelte): the same draft, saved by the same save bar. -->

	<!-- EWR -------------------------------------------------------------------------->
	<section class="panel" id="set-ewr" aria-labelledby="ewr-h">
		<div class="panel-head">
			<h2 id="ewr-h">EWR</h2>
			<NotesDrawer projectId={project.id} target={settingTarget('ewr')} />
		</div>
		<p class="summary" data-testid="summary-ewr">{summaries['set-ewr']}</p>
		<p class="hint muted explain">
			The environmental water requirement: the flow that must stay in the river for the ecosystem (the Ecological Reserve). The workbook's <em>pragmatic</em> EWR is one fixed
			flow per month, so farmers can plan for it; the model checks it at the EWR sites (the outlet and every gauge ticked as one) and charges
			each shortfall to the hydrological units upstream by their net impact that day.
		</p>
		<!-- Where the daily EWR comes from (engine ≥ 1.77.0, issue #455) first: it decides whether the row below is used. -->
		<Lazy load={loadEwrDailySource}>
			{#snippet children(EwrDailySourceFields)}
				<EwrDailySourceFields bind:value={s.ewrDailySource} bind:error={draft.errors.ewrSource} {readonly} modelAreaKm2={ewrModelAreaKm2} projectId={project.id} />
			{/snippet}
		</Lazy>
		<FieldHistoryLine field="settings:ewrDailySource" />
		{#if dailyFromDrm}<p class="hint" data-testid="pragmatic-unused">Not used while the daily EWR comes from the DRM tables: kept for switching back.</p>{/if}
		<div class="ewr">
			<div class="table-wrap">
				<table class="data compact monthly" data-testid="ewr-row">
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
		<!-- The registered-volumes band moved to Allocations, beside what it changes (issue #521). -->
		<p class="hint muted" data-testid="ewr-band-moved">The registered-volumes comparison band is on <a href="?tab=allocations#alloc-band">Allocations</a>.</p>
	</section>

	<!-- Reserve rule tables (engine ≥ 0.21.0) -------------------------------------->
	<div id="set-reserve">
		<EwrRulesSection
			summary={summaries['set-reserve']}
			bind:value={s.ewrRules}
			bind:error={draft.errors.reserve}
			bind:chargeSource={s.ewrChargeSource}
			bind:lowFlowMeasure={s.lowFlowMeasure}
			{readonly}
			nodes={editor?.model.nodes ?? []}
			projectId={project.id}
			daily={s.ewrDailySource}
		/>
	</div>

	<!-- Outcome matrix (issue #53 R4): how results are read, never a model input -------------------->
	<div id="set-outcomes">
		<OutcomeSettingsSection projectId={project.id} summary={summaries['set-outcomes']} bind:value={s.outcomes} {readonly} error={outError} daily={s.ewrDailySource} />
	</div>
	<div id="set-outlook">
		<OutlookSettingsSection projectId={project.id} summary={summaries['set-outlook']} bind:value={s.outlook} {readonly} error={outlookErr} />
	</div>

	<!-- Evidence (issue #71, evidence-report.md ER3): the uncertainty rule an evidence report's bands must follow; changes no result. -->
	<section class="panel" id="set-evidence" aria-labelledby="evid-h">
		<div class="panel-head">
			<h2 id="evid-h">Evidence <HelpTip key="settings.evidenceUncertaintyRule" /></h2>
			<NotesDrawer projectId={project.id} target={settingTarget('evidence')} />
		</div>
		<p class="summary" data-testid="summary-evidence">{summaries['set-evidence']}</p>
		<p class="hint explain">The uncertainty rule an evidence report’s bands must follow, declared before any band is seen.</p>
		<Lazy load={loadEvidenceRule}>
			{#snippet children(EvidenceRuleFields)}
				<EvidenceRuleFields bind:value={s.evidenceUncertaintyRule} bind:error={draft.errors.evidence} bind:last={draft.kept.evidence} saved={savedEvidenceRule} {readonly} />
			{/snippet}
		</Lazy>
	</section>

	<!-- Automatic runs (WP-2.11) ------------------------------------------------------------------>
	<section class="panel" id="set-auto" aria-labelledby="auto-h">
		<div class="panel-head">
			<h2 id="auto-h">Automatic runs</h2>
			<NotesDrawer projectId={project.id} target={settingTarget('auto')} />
		</div>
		<p class="summary" data-testid="summary-auto">{summaries['set-auto']}</p>
		<p class="hint explain">Run the model by itself when new data arrives.</p>
		<label class="check">
			<input type="checkbox" disabled={readonly} bind:checked={s.autoRun.enabled} aria-describedby="auto-on-h" />
			Re-run the model after new data
		</label>
		<p class="hint explain" id="auto-on-h">
			An upload, a data feed or a logger queues one run, labelled “Auto · data to …”. Only the newest automatic run is kept (unless it is
			pinned or published), so automatic runs never push out the runs you made.
		</p>
		<div class="fields">
			<div class="field">
				<label for="auto-wait">Wait after the latest new data <span class="u">(minutes)</span></label>
				<NumberInput id="auto-wait" min={0} max={AUTO_RUN_DEBOUNCE_MAX} step={1} disabled={readonly || !s.autoRun.enabled} bind:value={s.autoRun.debounceMinutes} aria-describedby="auto-wait-h" />
				<span class="hint explain" id="auto-wait-h">More data within the wait pushes the run back, but never more than {AUTO_RUN_MAX_WAIT_MINUTES / 60} hours after the first of it. Default 15.</span>
			</div>
			<div class="field">
				<label for="auto-publish">Publishing</label>
				<select id="auto-publish" disabled={readonly || !s.autoRun.enabled} bind:value={s.autoRun.publish} aria-describedby="auto-publish-h">
					<option value="never">Never: a person publishes (default)</option>
					<option value="if_no_new_warnings">Publish if there are no new warnings</option>
				</select>
				<span class="hint explain" id="auto-publish-h">
					With “no new warnings”, an automatic run replaces the published baseline when it raises no warning the published run didn’t and
					every self-check passes; the notice carries over. The first publication is always yours.
				</span>
			</div>
		</div>
		{#if autoError}<p class="err" role="alert">{autoError}</p>{/if}
	</section>

</div>

</SectionNav>

<style>
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
	/* The header's line (it renders in SectionHeader's muted context): its link to Calibration is underlined, as a link
	   in a line of text must be (WCAG 1.4.1, axe link-in-text-block). */
	.settings-context a {
		text-decoration: underline;
	}
	/* The explanations switch, the panel lines (.summary) and the cards (.sub-card) are app.css's `.settings-form`
	   rules, shared with the Calibration page's settings panels. */
	/* Rain gaps' Flagged rain card (ChirpsFitPeriodSection's card titles itself the same way). */
	.card-title {
		font-size: 1rem;
		margin: 0 0 0.75rem;
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
	.fields {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
		gap: 0 1.25rem;
		margin-top: 0.5rem;
	}
	.check-row {
		display: flex;
		align-items: center;
		gap: 0.25rem;
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
		/* A preferred width, so spare room keeps the label on one line first. The padding is slim, so
		   twelve months and a year total fit beside the side index at 1440 px (issue #468). */
		width: calc(6.5ch + 0.7rem + 2px + 0.4rem);
		padding-left: 0.1rem;
		padding-right: 0.1rem;
	}
	table.data.monthly td :global(input) {
		min-width: calc(6.5ch + 0.7rem + 2px);
	}
	/* Demand's rows (A-pan in mm, the dam evaporation factors): five characters ("250.5", "0.75") are enough, so
	   twelve months, the year total and the label "A-pan evaporation mm" on one line fit beside the side index at
	   1440 px; at 6.5ch the label wrapped to three lines and the year total ran past the panel (issue #586 R4-B). */
	.monthly.short td {
		width: calc(5ch + 0.7rem + 2px + 0.4rem);
	}
	table.data.monthly.short td :global(input) {
		min-width: calc(5ch + 0.7rem + 2px);
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
	/* A narrow panel (a phone): the row label takes a narrow column and wraps, its unit on a line of its own,
	   so about four months show beside it instead of two. A container query on the scroll box: the app
	   frame's width isn't the viewport's. */
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
	.derived td,
	.derived th {
		color: var(--text-muted);
		font-size: var(--font-sm);
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
	/* The monthly row gets the full width; the annual total sits under it. */
	.ewr {
		display: grid;
		gap: 0.3rem;
	}
	.ewr p {
		margin: 0;
	}
	/* Reporting (issue #521): the window and the threshold side by side, stacked when narrow. */
	.reporting {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-start;
		gap: 0.5rem 2rem;
	}
	.report {
		display: grid;
		gap: 0.25rem;
		max-width: 75ch;
	}
	.assurance {
		max-width: 75ch;
	}
	/* A percentage: a field as wide as the others in the grid, not the whole text measure. */
	.assurance :global(input) {
		max-width: 240px;
	}
	.lake-preset,
	.lake-source {
		max-width: 40rem;
		margin-top: 0.5rem;
	}
	.lake-source input {
		width: 100%;
	}
	.check {
		display: inline-flex;
		align-items: center;
		min-height: 36px;
	}
	/* The page's lead card (issue #614): Model selection for flow generation, the main modelling choice, framed in
	   the accent with its head tinted, so it reads as the page's first decision rather than one panel among many.
	   Tokens only (--accent, --accent-soft carry their dark values). The head spans the panel's padding. */
	.panel.lead {
		border: 2px solid var(--accent);
	}
	.panel.lead > .panel-head {
		margin: -1rem -1.1rem 0.75rem;
		padding: 0.75rem 1.1rem;
		background: var(--accent-soft);
		border-bottom: 1px solid color-mix(in srgb, var(--accent) 30%, transparent);
		border-radius: calc(var(--radius) - 2px) calc(var(--radius) - 2px) 0 0;
	}
	/* The summary line's pull toward a bare heading (.settings-form .summary) touched the tinted band's rule. */
	.panel.lead > .panel-head + .summary {
		margin-top: 0;
	}
	/* Its two methods as choice cards (issue #614), side by side where they fit and one under the other on a phone:
	   each name, then what it does under it, lined up with the name's words (past the radio's box, its margins and
	   the gap). The picked card takes the accent. */
	.radios {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(min(100%, 18rem), 1fr));
		gap: 0.5rem;
		margin-top: 0.25rem;
	}
	.opt {
		position: relative;
		/* The lifted radio's z-index orders only inside its card (ui-playbook § 4, stretched links). */
		isolation: isolate;
		display: block;
		padding: 0.35rem 0.75rem 0.6rem;
		border: 1px solid var(--border-strong);
		border-radius: var(--radius);
		background: var(--surface);
	}
	.opt:has(input:checked) {
		border-color: var(--accent);
		box-shadow: inset 0 0 0 1px var(--accent);
		background: var(--accent-soft);
	}
	/* An editor's card says it is one target: the pointer, and a stronger outline on hover (a viewer's radios are disabled). */
	.opt:has(input:enabled) {
		cursor: pointer;
	}
	.opt:has(input:enabled):hover:not(:has(input:checked)) {
		border-color: var(--border-input);
	}
	/* One focus ring, the card's, clear of the picked card's accent frame. */
	.opt:has(input:focus-visible) {
		outline: 2px solid var(--focus);
		outline-offset: 3px;
	}
	.opt input:focus-visible {
		outline: none;
	}
	.opt > .check {
		font-weight: 600;
	}
	/* The label covers the card, so the card is one target; the radio stays above that cover, so a click or a
	   pointer on the radio itself reaches it directly. The cost, as with a card's stretched link (ui-playbook § 4):
	   the method's words can't be selected. Don't move them into the label to fix that: they would join the
	   radio's name, which is the method's name alone (its words are its description, aria-describedby). */
	.opt > .check::after {
		content: '';
		position: absolute;
		inset: 0;
		border-radius: inherit;
	}
	.opt > .check > input {
		position: relative;
		z-index: 1;
	}
	.opt-what {
		display: block;
		padding-left: calc(21px + 0.4rem);
		margin-top: -0.35rem;
		color: var(--text-2);
		font-size: var(--font-sm);
	}
	.flowgen-method + .alert {
		margin-top: 0.5rem;
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
	h3 :global(.helptip),
	th :global(.helptip) {
		margin-left: 0.15rem;
	}
	.sub {
		margin: 1rem 0 0.35rem;
	}
	.err {
		color: var(--danger);
		font-size: var(--font-sm);
	}
</style>
