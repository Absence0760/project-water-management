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
		fitRecordCaveats,
		fitRecordStatus,
		hasPotentialEvaporation,
		PAN_COEFFICIENT_PRESET_SOURCE,
		PAN_COEFFICIENT_PRESETS,
		PAN_COEFFICIENT_TYPICAL_MAX,
		PAN_COEFFICIENT_TYPICAL_MIN,
		PE_SOURCE_MAX,
		panCoefficientOutOfRange,
		type CalibrationParams,
		type CalibrationReport,
		type FitRecord,
		type FlowShareMethod,
		type PeInput,
		type ProjectSettings,
		type SeriesProvenance,
		type ApanDailyFingerprint,
		type AllocationMode,
		type SeriesMeta
	} from '@water-management/engine';
	import { apanDailyOfValues } from '$lib/series/provenance';
	import { applyReport } from '$lib/calibration/fit';
	import CalibrationExclusions from '$lib/components/calibration/CalibrationExclusions.svelte';
	import FitPanel from '$lib/components/calibration/FitPanel.svelte';
	import FitProvenance from '$lib/components/calibration/FitProvenance.svelte';
	import { api, type Project } from '$lib/api';
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
	import { AUTO_RUN_DEBOUNCE_MAX, AUTO_RUN_MAX_WAIT_MINUTES, autoRunError, resolveAutoRun } from '$lib/components/autorun/autoRun';
	import type { AutoRunSettings, OutcomeSettings, OutlookSettings } from '$lib/api/types';
	import { outcomesError, resolveOutcomes } from '$lib/components/outcomes/outcomeSettings';
	import { outlookError, resolveOutlook } from '$lib/components/outlook/settings';
	import { CHIRPS_BIAS_OPTIONS } from './rain';
	import { AFTER_FORM_LABELS, saveBlockers, SETTINGS_SECTIONS, settingsNavGroups } from './sections';
	import SectionNav from '$lib/components/common/SectionNav.svelte';
	import MonthlyBars from './MonthlyBars.svelte';
	import Wr2012Section from './Wr2012Section.svelte';
	import EwrRulesSection from './EwrRulesSection.svelte';
	import ZeroRainSection from './ZeroRainSection.svelte';
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
	import DataFeedsPanel from '$lib/components/feeds/DataFeedsPanel.svelte';
	import PanCoefficientHelper from './PanCoefficientHelper.svelte';
	import ReportSchedulesPanel from '$lib/components/report/ReportSchedulesPanel.svelte';
	import ApiKeysPanel from '$lib/components/apiKeys/ApiKeysPanel.svelte';
	import OutcomeSettingsSection from '$lib/components/outcomes/OutcomeSettingsSection.svelte';
	import OutlookSettingsSection from '$lib/components/outlook/OutlookSettingsSection.svelte';

	let {
		project,
		editor,
		seriesKinds = null,
		chirpsSource,
		apanSeries,
		readonly,
		onProjectChange
	}: {
		project: Project;
		editor?: ModelEditor;
		/** Kinds of the project's input series, to limit the calibration flow choices. */
		seriesKinds?: string[] | null;
		/** The CHIRPS series' product and version a run would use (issue #40c); undefined when not known. */
		chirpsSource?: SeriesProvenance | null;
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
	const reportError = $derived(
		s.reportStart && s.reportEnd && s.reportStart > s.reportEnd ? 'The reporting window must start before it ends.' : null
	);
	const dqError = $derived(dataQualityError(s.dataQuality));
	const autoError = $derived(autoRunError(s.autoRun));
	const outError = $derived(outcomesError(s.outcomes));
	const outlookErr = $derived(outlookError(s.outlook));
	let wr2012Error = $state<string | null>(null);
	let reserveError = $state<string | null>(null);
	const blocked = $derived(
		!!dateError || !!calWindowError || !!exclusionsError || !!zeroRainError || !!fitPeriodError || !!rainSourceError || !!peError || !!arealError || !!reportError || !!dqError || !!wr2012Error || !!reserveError || !!autoError || !!outError || !!outlookErr
	);
	// What blocks Save, by group, so the save bar can link to each one.
	const blockers = $derived(
		saveBlockers([
			{ id: 'set-record', message: calWindowError },
			{ id: 'set-record', message: exclusionsError },
			{ id: 'set-rain', message: fitPeriodError },
			{ id: 'set-rain', message: zeroRainError },
			{ id: 'set-rain', message: rainSourceError },
			{ id: 'set-flow', message: peError },
			{ id: 'set-flow', message: arealError },
			{ id: 'set-wr2012', message: wr2012Error },
			{ id: 'set-ewr', message: reportError },
			{ id: 'set-reserve', message: reserveError },
			{ id: 'set-period', message: dateError },
			{ id: 'set-quality', message: dqError },
			{ id: 'set-outcomes', message: outError },
			{ id: 'set-outlook', message: outlookErr },
			{ id: 'set-auto', message: autoError }
		])
	);
	const farmAreaKm2 = $derived(
		(editor?.model.nodes ?? []).filter((n) => n.kind === 'farm').reduce((t, n) => t + (n.areaKm2 || 0), 0)
	);
	const ewrAnnual = $derived(annualMm3(s.ewrPragmaticM3PerDay, s.februaryDays));
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

	/** Choose where GR4J's PE comes from; a monthly row switched away from is remembered until saved or discarded. */
	function setPeKind(kind: EditablePe['kind']) {
		if (pe.kind === 'monthly') lastMonthlyPe = $state.snapshot(pe) as EditablePe;
		s.pe = withPeKind(s, kind, lastMonthlyPe);
	}

	/** Writes a fit's parameters, and its record, into the form (unsaved). */
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
	const navLabel = (id: string) => SETTINGS_SECTIONS.find((sec) => sec.id === id)?.label ?? AFTER_FORM_LABELS[id] ?? id;
	const navGroups = $derived(
		settingsNavGroups(project.role === 'owner').map((g) => ({
			label: g.label,
			sections: g.ids.map((id) => ({ id, label: navLabel(id), problem: blockers.some((b) => b.id === id) }))
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
			<div class="field">
				<span class="lbl"><label for="st-feb">Days in February</label><HelpTip key="settings.februaryDays" /></span>
				<NumberInput id="st-feb" min={28} max={29} step={0.01} disabled={readonly} bind:value={s.februaryDays} aria-describedby="st-feb-h" />
				<span class="hint" id="st-feb-h">Converts monthly volumes to per-day figures. 28.25 averages leap years, as the workbook does.</span>
				<FieldHistoryLine field="settings:februaryDays" />
			</div>
		</div>
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
				<select id="st-pan-preset" disabled={readonly} value={panPreset} onchange={(e) => applyPanPreset(e.currentTarget.value)} aria-describedby="st-pan-preset-h">
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
		<!-- Always mounted, like the other sections that feed the Save blocker: a list left invalid
		     after turning bias correction off must stay visible, or Save is blocked with nothing to fix. -->
		<ChirpsFitPeriodSection
			bind:value={s.chirpsFitPeriod}
			bind:error={fitPeriodError}
			{readonly}
			inactive={s.chirpsBiasCorrection !== 'monthly'}
			propose={() => proposeFitRanges(project.id, s.zeroRainRuns)}
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
			bind:error={calWindowError}
			{readonly}
			availableKinds={seriesKinds}
		/>
		<CalibrationExclusions bind:list={s.calibrationExclusions} bind:error={exclusionsError} {readonly} />
	</section>

	<div class="panel" id="set-fit">
		<FitPanel
			projectId={project.id}
			{x2Open}
			settings={() => $state.snapshot(s) as unknown as ProjectSettings}
			model={() => (editor?.dirty ? editor.snapshot() : undefined)}
			hasObserved={seriesKinds === null || seriesKinds.some((k) => (CALIBRATION_FLOW_KINDS as readonly string[]).includes(k))}
			{seriesKinds}
			calibrationFlowKind={s.calibrationFlowKind}
			{readonly}
			onApply={applyFit}
		/>
		{#if s.fitRecord}
			<FitProvenance record={s.fitRecord} settings={s as unknown as ProjectSettings} heading="Fit record of these parameters" context="form" {chirpsSource} apanDaily={apanNow} />
		{/if}
	</div>


	<div id="set-wr2012">
		<Wr2012Section
			bind:value={s.wr2012}
			bind:error={wr2012Error}
			{readonly}
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
			<fieldset class="plain hilo">
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
				<span class="hint">
					{s.flowShareMethod === 'hiLo' ? 'Should add up to 100 %. Default 81 / 19.' : 'Only used by the high/low MAP method.'}
				</span>
			</fieldset>
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
			<div class="ewr-side">
				<MonthlyBars values={s.ewrPragmaticM3PerDay} unit="m³/day" label="Pragmatic EWR" caption="Pragmatic EWR by month, Oct–Sep, m³/day" />
				<p class="muted small">
					{fmtQty(ewrAnnual, 3)} Mm³/a in total · mean {fmtQty((ewrAnnual * 1e6) / 86_400 / 365.25, 3)} m³/s
				</p>
			</div>
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
				water year within its volumes; a full allocation scales each unit’s demand to its volumes, for “if every registered user took their entitlement”. Licence
				conditions (months, rates) aren’t applied yet.
			</span>
			<span class="hint" id="st-alloc-tol-h">Modelled use within this share of a registered volume counts as “within band”. ±10 % by default, pending the hydrologist.</span>
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

	<!-- Data quality ------------------------------------------------------------------>
	<section class="panel" id="set-quality" aria-labelledby="dq-h">
		<div class="panel-head">
			<h2 id="dq-h">Data quality <HelpTip key="settings.dataQuality" /></h2>
			<span class="muted small">Gauge vs logger check on the Data tab and in run warnings</span>
			<NotesDrawer projectId={project.id} target={settingTarget('quality')} />
		</div>
		<div class="fields">
			<div class="field">
				<label for="dq-min">Lowest gauge/logger ratio <span class="u">(%)</span></label>
				<NumberInput id="dq-min" decimals={1} min={1} max={100} scale={100} disabled={readonly} bind:value={s.dataQuality.agreementMinRatio} aria-describedby="dq-min-h" />
				<span class="hint" id="dq-min-h">Flag a water year when the gauge reads less than this share of the logger. Default 66.7 % (two thirds).</span>
				<FieldHistoryLine field="settings:dataQuality.agreementMinRatio" />
			</div>
			<div class="field">
				<label for="dq-max">Highest gauge/logger ratio <span class="u">(%)</span></label>
				<NumberInput id="dq-max" decimals={1} min={100} max={10_000} scale={100} disabled={readonly} bind:value={s.dataQuality.agreementMaxRatio} aria-describedby="dq-max-h" />
				<span class="hint" id="dq-max-h">… or more than this share. Default 150 %.</span>
				<FieldHistoryLine field="settings:dataQuality.agreementMaxRatio" />
			</div>
			<div class="field">
				<label for="dq-days">Minimum shared days <span class="u">(days)</span></label>
				<NumberInput id="dq-days" min={1} max={366} step={1} disabled={readonly} bind:value={s.dataQuality.agreementMinDays} aria-describedby="dq-days-h" />
				<span class="hint" id="dq-days-h">Water years with fewer days on which both records have a reading are not judged. Default 90.</span>
				<FieldHistoryLine field="settings:dataQuality.agreementMinDays" />
			</div>
		</div>
		<p class="hint muted">These thresholds only decide which years are flagged; they never change the model results.</p>
		{#if dqError}<p class="err" role="alert">{dqError}</p>{/if}
	</section>

	<!-- Outcome matrix (issue #53 R4): how results are read, never a model input -------------------->
	<div id="set-outcomes">
		<OutcomeSettingsSection bind:value={s.outcomes} {readonly} error={outError} />
	</div>
	<div id="set-outlook">
		<OutlookSettingsSection bind:value={s.outlook} {readonly} error={outlookErr} />
	</div>

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
			<button type="button" class="btn" disabled={!dirty || saving} onclick={discard}>Discard</button>
			<button type="submit" class="btn btn-primary" disabled={!dirty || saving || blocked}>
				{saving ? 'Saving…' : 'Save settings'}
			</button>
		</div>
	{/if}
</form>

<!-- Outside the form: feeds, keys and schedules save themselves, never through Save settings. -->
{#if !readonly}
	<p class="muted small after-form">
		Data feeds{project.role === 'owner' ? ', API keys' : ''} and scheduled reports save as you change them, not with Save settings.
	</p>
{/if}
<DataFeedsPanel projectId={project.id} />

{#if project.role === 'owner'}
	<ApiKeysPanel projectId={project.id} />
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
	/* The monthly row gets the full width (beside it, the chart squeezed the
	   row into a sideways scroll even at 1600px); the chart sits under it. */
	.ewr {
		display: grid;
		gap: 0.75rem;
	}
	.ewr-side {
		max-width: 420px;
	}
	.ewr-side p {
		margin: 0.3rem 0 0;
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
