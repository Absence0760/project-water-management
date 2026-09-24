<script lang="ts">
	import { untrack } from 'svelte';
	import {
		CALIBRATION_FLOW_KINDS,
		hasPotentialEvaporation,
		PAN_COEFFICIENT_PRESET_SOURCE,
		PAN_COEFFICIENT_PRESETS,
		PAN_COEFFICIENT_TYPICAL_MAX,
		PAN_COEFFICIENT_TYPICAL_MIN,
		panCoefficientOutOfRange,
		type CalibrationParams,
		type CalibrationReport,
		type FitRecord,
		type FlowShareMethod,
		type ProjectSettings
	} from '@water-management/engine';
	import { applyReport } from '$lib/calibration/fit';
	import CalibrationExclusions from '$lib/components/calibration/CalibrationExclusions.svelte';
	import FitPanel from '$lib/components/calibration/FitPanel.svelte';
	import FitProvenance from '$lib/components/calibration/FitProvenance.svelte';
	import { api, type Project } from '$lib/api';
	import CalibrationWindowFields from '$lib/components/calibration/CalibrationWindowFields.svelte';
	import HelpTip from '$lib/components/help/HelpTip.svelte';
	import NumberInput from '$lib/components/common/NumberInput.svelte';
	import { annualMm3 } from '$lib/components/crops/demand';
	import MonthPicker from '$lib/components/transfers/MonthPicker.svelte';
	import { fmtNum, fmtPct } from '$lib/format/number';
	import { describeMonths, WATER_YEAR_MONTHS } from '$lib/format/months';
	import type { ModelEditor } from '$lib/model/editor.svelte';
	import {
		ADVANCED_PARAMS,
		calibrationFields,
		FLOW_PARAMS,
		GR4J_FIELDS,
		KNOWN_CAL_KEYS,
		parseNumberList,
		RUNOFF_MODEL_OPTIONS,
		TABLE_PARAMS,
		typicalRange
	} from './calibration';
	import { dataQualityError } from './dataQuality';
	import { CHIRPS_BIAS_OPTIONS } from './rain';
	import { saveBlockers, SETTINGS_SECTIONS } from './sections';
	import { activeSectionId } from '$lib/components/runs/sections';
	import MonthlyBars from './MonthlyBars.svelte';
	import Wr2012Section from './Wr2012Section.svelte';
	import ZeroRainSection from './ZeroRainSection.svelte';

	let {
		project,
		editor,
		seriesKinds = null,
		readonly,
		onProjectChange
	}: {
		project: Project;
		editor?: ModelEditor;
		/** Kinds of the project's input series, to limit the calibration flow choices. */
		seriesKinds?: string[] | null;
		readonly: boolean;
		onProjectChange: (p: Project) => void;
	} = $props();

	// Mutable view of the settings (the engine's Monthly type is a readonly tuple).
	type Editable = Omit<ProjectSettings, 'apanMm' | 'ewrPragmaticM3PerDay' | 'panCoefficient' | 'calibration'> & {
		apanMm: number[];
		ewrPragmaticM3PerDay: number[];
		panCoefficient: number[];
		calibration: CalibrationParams & Record<string, unknown>;
	};
	const clone = (v: ProjectSettings): Editable => JSON.parse(JSON.stringify(v));

	let s = $state<Editable>(clone(untrack(() => project.settings)));
	let saved = $state(JSON.stringify(untrack(() => project.settings)));
	let listText = $state<Record<string, string>>({});
	let listInvalid = $state<Record<string, boolean>>({});
	let saving = $state(false);
	let error = $state<string | null>(null);
	let justSaved = $state(false);
	// X2 (groundwater exchange) is fixed at 0 unless the user opts in.
	let x2Open = $state(untrack(() => project.settings.gr4j?.x2 !== 0));
	// The preset picker itself is never saved — it only fills panCoefficient, then resets.
	let panPreset = $state('');

	const dirty = $derived(JSON.stringify(s) !== saved);
	const cal = $derived(s.calibration);
	const otherFields = $derived(
		calibrationFields(s.calibration as Record<string, unknown>).filter((f) => !KNOWN_CAL_KEYS.has(f.key))
	);
	const hiLoSum = $derived((s.hiLoSplit.hi || 0) + (s.hiLoSplit.lo || 0));
	const dateError = $derived(
		s.simulationStart && s.simulationEnd && s.simulationStart > s.simulationEnd
			? 'Simulation start must be before the end.'
			: null
	);
	const hasInvalidList = $derived(Object.values(listInvalid).some(Boolean));
	let calWindowError = $state<string | null>(null);
	let exclusionsError = $state<string | null>(null);
	let zeroRainError = $state<string | null>(null);
	const reportError = $derived(
		s.reportStart && s.reportEnd && s.reportStart > s.reportEnd ? 'The reporting window must start before it ends.' : null
	);
	const dqError = $derived(dataQualityError(s.dataQuality));
	let wr2012Error = $state<string | null>(null);
	const blocked = $derived(!!dateError || hasInvalidList || !!calWindowError || !!exclusionsError || !!zeroRainError || !!reportError || !!dqError || !!wr2012Error);
	// What blocks Save, by group, so the save bar can link to each one.
	const blockers = $derived(
		saveBlockers([
			{ id: 'set-flow', message: calWindowError },
			{ id: 'set-flow', message: exclusionsError },
			{ id: 'set-flow', message: zeroRainError },
			{ id: 'set-flow', message: hasInvalidList ? 'A parameter list under Advanced has a value that is not a number.' : null },
			{ id: 'set-wr2012', message: wr2012Error },
			{ id: 'set-ewr', message: reportError },
			{ id: 'set-period', message: dateError },
			{ id: 'set-quality', message: dqError }
		])
	);
	const farmAreaKm2 = $derived(
		(editor?.model.nodes ?? []).filter((n) => n.kind === 'farm').reduce((t, n) => t + (n.areaKm2 || 0), 0)
	);
	const ewrAnnual = $derived(annualMm3(s.ewrPragmaticM3PerDay, s.februaryDays));
	const apanAnnual = $derived(s.apanMm.reduce((t, v) => t + (v || 0), 0));
	const panOutOfRange = $derived(panCoefficientOutOfRange(s.panCoefficient));

	// Free-text lists only for calibration keys the tab doesn't know about.
	function resetListText() {
		listText = Object.fromEntries(
			otherFields.filter((f) => f.kind === 'list').map((f) => [f.key, (f.value as number[]).join(', ')])
		);
		listInvalid = {};
	}
	resetListText();

	function setList(key: string, text: string) {
		listText[key] = text;
		const parsed = parseNumberList(text);
		listInvalid[key] = parsed === null;
		if (parsed) s.calibration[key] = parsed;
	}

	function setX2Open(open: boolean) {
		x2Open = open;
		if (!open) s.gr4j.x2 = 0;
	}

	/** Fills panCoefficient with a preset's values (still editable after); doesn't store which preset was picked. */
	function applyPanPreset(id: string) {
		const preset = PAN_COEFFICIENT_PRESETS.find((p) => p.id === id);
		if (preset) s.panCoefficient = [...preset.values];
		panPreset = '';
	}

	/** Writes a fit's parameters, and its record, into the form (unsaved). */
	function applyFit(report: CalibrationReport, record: FitRecord) {
		s = { ...applyReport(s, report), fitRecord: record };
		if (report.model === 'gr4j' && s.gr4j.x2 !== 0) x2Open = true;
	}

	function discard() {
		s = clone(JSON.parse(saved));
		x2Open = s.gr4j.x2 !== 0;
		resetListText();
		error = null;
	}

	async function save(e: SubmitEvent) {
		e.preventDefault();
		if (blocked) return;
		saving = true;
		error = null;
		justSaved = false;
		try {
			const p = await api.projects.update(project.id, { settings: $state.snapshot(s) as unknown as ProjectSettings });
			onProjectChange(p);
			s = clone(p.settings);
			saved = JSON.stringify(p.settings);
			x2Open = s.gr4j.x2 !== 0;
			resetListText();
			justSaved = true;
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
		} finally {
			saving = false;
		}
	}

	const METHODS: { value: FlowShareMethod; label: string; help: string }[] = [
		{ value: 'area', label: 'By catchment area', help: "Each farm's share = its area ÷ the total farm area." },
		{
			value: 'hiLo',
			label: 'High/low MAP split',
			help: 'High-MAP areas share the high part of the split and low-MAP areas the low part (WR90/WR2012 practice).'
		},
		{ value: 'manual', label: 'Manual share per farm', help: 'Shares typed per farm on the Network tab ("Manual flow share").' }
	];
	const method = $derived(METHODS.find((m) => m.value === s.flowShareMethod));
	const runoffOption = $derived(RUNOFF_MODEL_OPTIONS.find((o) => o.value === s.runoffModel));
	const chirpsOption = $derived(CHIRPS_BIAS_OPTIONS.find((o) => o.value === s.chirpsBiasCorrection));
	const isGr4j = $derived(s.runoffModel === 'gr4j');
	// The engine refuses a GR4J run without it (runoff/simulate.ts).
	const petMissing = $derived(!hasPotentialEvaporation(s));
	const num = (k: string) => cal[k] as number;

	// The sticky in-page menu, and which group is being read (scroll spy, as on
	// Runs & results). The menu and the save bar both stick, so in-page jumps and
	// focus scrolling keep clear of them (WCAG 2.4.11) while this tab is shown.
	let navHeight = $state(0);
	let actionsHeight = $state(0);
	let activeSection = $state<string | null>(null);
	let navList = $state<HTMLUListElement>();
	// On a phone the menu is one sideways strip: keep the marked link in it in view.
	$effect(() => {
		const link = activeSection ? navList?.querySelector<HTMLElement>(`a[href="#${activeSection}"]`) : null;
		if (!navList || !link || navList.scrollWidth <= navList.clientWidth) return;
		const left = link.offsetLeft - navList.offsetLeft;
		if (left < navList.scrollLeft || left + link.offsetWidth > navList.scrollLeft + navList.clientWidth) {
			navList.scrollLeft = left - 16;
		}
	});
	$effect(() => {
		const root = document.documentElement;
		const header = parseFloat(getComputedStyle(root).getPropertyValue('--header-h')) || 0;
		root.style.scrollPaddingTop = `${header + navHeight + 12}px`;
		root.style.scrollPaddingBottom = actionsHeight ? `${actionsHeight + 12}px` : '';
		return () => {
			root.style.scrollPaddingTop = '';
			root.style.scrollPaddingBottom = '';
		};
	});
	$effect(() => {
		let frame = 0;
		const update = () => {
			frame = 0;
			const root = document.documentElement;
			// A group counts as reached once its top passes under the sticky menu.
			const line = (parseFloat(getComputedStyle(root).scrollPaddingTop) || 0) + 8;
			const tops = SETTINGS_SECTIONS.flatMap(({ id }) => {
				const el = document.getElementById(id);
				return el ? [{ id, top: el.getBoundingClientRect().top }] : [];
			});
			activeSection = activeSectionId(tops, line, window.innerHeight + window.scrollY >= root.scrollHeight - 2);
		};
		const schedule = () => {
			if (!frame) frame = requestAnimationFrame(update);
		};
		update();
		window.addEventListener('scroll', schedule, { passive: true });
		window.addEventListener('resize', schedule);
		// Groups open and close (Advanced, the WR2012 fields, a fit's result), which moves every later one.
		const grow = new ResizeObserver(schedule);
		grow.observe(document.body);
		return () => {
			cancelAnimationFrame(frame);
			window.removeEventListener('scroll', schedule);
			window.removeEventListener('resize', schedule);
			grow.disconnect();
		};
	});
</script>

<form onsubmit={save} novalidate>
	{#if error}<div class="alert alert-error" role="alert">{error}</div>{/if}

	<p class="muted small lead">
		Grouped by what each setting drives: irrigation <strong>demand</strong>, natural <strong>flow generation</strong> from rainfall, how
		flow is <strong>shared</strong> between farms, and the <strong>EWR</strong> at the outflow gauge. Monthly values run through the water
		year, October → September.
	</p>

	<!-- In-page menu: sticks under the app header down this long form and marks
	     the group being read. A wrapping row on wide screens, one scrolling strip
	     on phones. -->
	<nav class="sections" aria-label="Settings sections" bind:clientHeight={navHeight}>
		<span class="nav-h" aria-hidden="true">On this page</span>
		<ul bind:this={navList}>
			{#each SETTINGS_SECTIONS as sec (sec.id)}
				<li>
					<a href="#{sec.id}" aria-current={sec.id === activeSection ? 'location' : undefined}>
						{sec.label}{#if blockers.some((b) => b.id === sec.id)}<span class="dot" aria-hidden="true"></span><span class="visually-hidden"> (has a problem)</span>{/if}
					</a>
				</li>
			{/each}
		</ul>
	</nav>

	<!-- Demand ------------------------------------------------------------------>
	<section class="panel" id="set-demand" aria-labelledby="dem-h">
		<div class="panel-head">
			<h2 id="dem-h">Demand</h2>
			<span class="muted small">Gross irrigation need = A-pan × crop factor × area</span>
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
		<div class="fields">
			<div class="field">
				<span class="lbl"><label for="st-erf">Effective rainfall <span class="u">(%)</span></label><HelpTip key="settings.effectiveRainFraction" /></span>
				<NumberInput id="st-erf" min={0} max={100} scale={100} disabled={readonly} bind:value={s.effectiveRainFraction} aria-describedby="st-erf-h" />
				<span class="hint" id="st-erf-h">Share of each day's rain on the cropped area that the crop can use, reducing irrigation demand. The workbook default is 65 %.</span>
			</div>
			<div class="field">
				<span class="lbl"><label for="st-ers">Soil-water store <span class="u">(mm)</span></label><HelpTip key="settings.effectiveRainStoreMm" /></span>
				<NumberInput id="st-ers" min={0} max={500} step={1} disabled={readonly} bind:value={s.effectiveRainStoreMm} aria-describedby="st-ers-h" />
				<span class="hint" id="st-ers-h">Effective rain the crop can't use on the day is kept for the next days, up to this depth. 25 mm (FAO-56) by default; 0 carries nothing over, as the workbook does.</span>
			</div>
			<div class="field">
				<span class="lbl"><label for="st-feb">Days in February</label><HelpTip key="settings.februaryDays" /></span>
				<NumberInput id="st-feb" min={28} max={29} step={0.01} disabled={readonly} bind:value={s.februaryDays} aria-describedby="st-feb-h" />
				<span class="hint" id="st-feb-h">Converts monthly volumes to per-day figures. 28.25 averages leap years, as the workbook does.</span>
			</div>
		</div>
	</section>

	<!-- Flow generation ------------------------------------------------------------>
	<section class="panel" id="set-flow" aria-labelledby="cal-h">
		<div class="panel-head">
			<h2 id="cal-h">Flow calibration (rain → natural flow)</h2>
			<span class="muted small">Tune against observed flow; check NSE and PBIAS on Runs & results</span>
		</div>
		<div class="fields">
			<div class="field">
				<span class="lbl"><label for="st-runoff">Runoff model</label><HelpTip key="settings.runoffModel" /></span>
				<select id="st-runoff" disabled={readonly} bind:value={s.runoffModel} aria-describedby="st-runoff-h">
					{#each RUNOFF_MODEL_OPTIONS as o (o.value)}<option value={o.value}>{o.label}</option>{/each}
				</select>
				<span class="hint" id="st-runoff-h">{runoffOption?.help}</span>
			</div>
			<div class="field">
				<span class="lbl"><label for="st-chirps-bias">CHIRPS bias correction</label><HelpTip key="settings.chirpsBiasCorrection" /></span>
				<select id="st-chirps-bias" disabled={readonly} bind:value={s.chirpsBiasCorrection} aria-describedby="st-chirps-bias-h">
					{#each CHIRPS_BIAS_OPTIONS as o (o.value)}<option value={o.value}>{o.label}</option>{/each}
				</select>
				<span class="hint" id="st-chirps-bias-h">{chirpsOption?.help}</span>
			</div>
			<div class="field">
				<span class="lbl"><label for="cal-catchmentAreaKm2">Catchment area <span class="u">(km²)</span></label><HelpTip key="calibration.catchmentAreaKm2" /></span>
				<NumberInput
					id="cal-catchmentAreaKm2"
					min={0}
					nullable
					placeholder="{fmtNum(farmAreaKm2, 2)} (sum of farms)"
					disabled={readonly}
					bind:value={s.calibration.catchmentAreaKm2}
					aria-describedby="cal-area-h"
				/>
				<span class="hint" id="cal-area-h">
					Area the rain falls on. Leave blank to use the sum of the farm areas —
					<strong>{fmtNum(farmAreaKm2, 2)} km²</strong> now.{#if cal.catchmentAreaKm2 != null && Math.abs(cal.catchmentAreaKm2 - farmAreaKm2) > 0.005}
						Overridden: {fmtNum(cal.catchmentAreaKm2, 2)} km² is used.{/if}
				</span>
			</div>
		</div>
		{#if isGr4j}
			{#if petMissing}
				<p class="alert alert-warning" role="status">
					GR4J needs A-pan evaporation (Demand, above) and a pan coefficient above 0 (below). Without them the catchment would never dry
					out, so runs and fits are refused.
				</p>
			{/if}
			<div class="fields">
				{#each GR4J_FIELDS.filter((f) => !f.fixedByDefault) as p (p.key)}
					<div class="field">
						<span class="lbl"><label for="gr4j-{p.key}">{p.label} <span class="u">({p.unit})</span></label><HelpTip key="settings.gr4j" /></span>
						<NumberInput id="gr4j-{p.key}" min={p.min} max={p.max} step={p.step} disabled={readonly} bind:value={s.gr4j[p.key]} aria-describedby="gr4j-{p.key}-h" />
						<span class="hint" id="gr4j-{p.key}-h">{p.help} {typicalRange(p)}</span>
					</div>
				{/each}
				<div class="field">
					<span class="lbl"><label for="gr4j-warmup">Warm-up <span class="u">(days)</span></label></span>
					<NumberInput id="gr4j-warmup" min={0} max={3650} step={1} disabled={readonly} bind:value={s.gr4j.warmupDays} aria-describedby="gr4j-warmup-h" />
					<span class="hint" id="gr4j-warmup-h">Days run before the first simulated day, repeating the start of the record, so the stores begin at a realistic level. Never shown or scored. Default 365.</span>
				</div>
				<div class="field">
					<span class="lbl"><label for="cal-rainThresholdMm">Rain threshold for demand <span class="u">(mm)</span></label><HelpTip key="calibration.rainThresholdMm" /></span>
					<NumberInput id="cal-rainThresholdMm" min={0} step={0.1} disabled={readonly} value={num('rainThresholdMm')} aria-describedby="cal-thr-h" onchange={(v) => { if (v !== null) s.calibration.rainThresholdMm = v; }} />
					<span class="hint" id="cal-thr-h">Under GR4J this only decides which rain days reduce irrigation demand; the runoff model uses all rain.</span>
				</div>
			</div>
			{@const x2 = GR4J_FIELDS.find((f) => f.key === 'x2')!}
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
			</fieldset>
			<div class="field pan-preset">
				<span class="lbl"><label for="st-pan-preset">Pan-coefficient preset</label></span>
				<select id="st-pan-preset" disabled={readonly} value={panPreset} onchange={(e) => applyPanPreset(e.currentTarget.value)} aria-describedby="st-pan-preset-h">
					<option value="">Choose a preset…</option>
					{#each PAN_COEFFICIENT_PRESETS as p (p.id)}<option value={p.id}>{p.label}</option>{/each}
				</select>
				<span class="hint" id="st-pan-preset-h">Fills the row below with these monthly values, which stay editable; nothing is stored about which preset was picked. {PAN_COEFFICIENT_PRESET_SOURCE}.</span>
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
							<th scope="row" class="sticky">Pan coefficient <HelpTip key="settings.panCoefficient" /></th>
							{#each WATER_YEAR_MONTHS as m, i (m)}
								<td><NumberInput label="Pan coefficient, {m}" min={0} max={2} step={0.01} disabled={readonly} bind:value={s.panCoefficient[i]} /></td>
							{/each}
						</tr>
					</tbody>
				</table>
			</div>
			<p class="hint muted">Potential evaporation = pan coefficient × A-pan, per month. 0.7 is a common flat value.</p>
			{#if panOutOfRange.length}
				<p class="alert alert-warning small" role="status">
					Pan coefficient is outside FAO-56's typical Class A pan range ({PAN_COEFFICIENT_TYPICAL_MIN}–{PAN_COEFFICIENT_TYPICAL_MAX}) in
					{panOutOfRange.map((i) => WATER_YEAR_MONTHS[i]).join(', ')}: confirm against local humidity and wind.
				</p>
			{/if}
		{:else}
			<div class="fields">
				{#each FLOW_PARAMS as p (p.key)}
					<div class="field">
						<span class="lbl"><label for="cal-{p.key}">{p.label}{#if p.unit}{" "}<span class="u">({p.unit})</span>{/if}</label><HelpTip key={`calibration.${p.key}`} /></span>
						<NumberInput
							id="cal-{p.key}"
							step={p.step ?? 'any'}
							disabled={readonly}
							value={num(p.key)}
							aria-describedby="cal-{p.key}-h"
							onchange={(v) => {
								if (v !== null) s.calibration[p.key] = v;
							}}
						/>
						<span class="hint" id="cal-{p.key}-h">{p.help}</span>
					</div>
				{/each}
			</div>
			<fieldset class="plain summer">
				<legend>Summer months <span class="muted">({describeMonths(cal.summerMonths ?? [])})</span> <HelpTip key="calibration.summerMonths" /></legend>
				<MonthPicker label="Summer months" disabled={readonly} bind:months={s.calibration.summerMonths} />
				<span class="hint">
					Months always treated as summer (the summer factor applies). In other months a big rain day switches to winter behaviour
					— see Advanced.
				</span>
			</fieldset>
		{/if}
		<div class="cal-window">
			<CalibrationWindowFields
				bind:start={s.calibrationStart}
				bind:end={s.calibrationEnd}
				bind:flowKind={s.calibrationFlowKind}
				bind:error={calWindowError}
				{readonly}
				availableKinds={seriesKinds}
			/>
			<CalibrationExclusions bind:list={s.calibrationExclusions} bind:error={exclusionsError} {readonly} />
		</div>
		<ZeroRainSection bind:value={s.zeroRainRuns} bind:error={zeroRainError} {readonly} />

		<div id="set-fit">
			<FitPanel
				projectId={project.id}
				runoffModel={s.runoffModel}
				{x2Open}
				settings={() => $state.snapshot(s) as unknown as ProjectSettings}
				model={() => (editor?.dirty ? editor.snapshot() : undefined)}
				hasObserved={seriesKinds === null || seriesKinds.some((k) => (CALIBRATION_FLOW_KINDS as readonly string[]).includes(k))}
				{seriesKinds}
				calibrationFlowKind={s.calibrationFlowKind}
				{readonly}
				onApply={applyFit}
			/>
		</div>
		{#if s.fitRecord}
			<FitProvenance record={s.fitRecord} settings={s as unknown as ProjectSettings} heading="Fit record of these parameters" context="form" />
		{/if}

		{#if !isGr4j}
			<details class="advanced">
				<summary>Advanced: winter switch, recession and base flow</summary>
				<div class="fields">
					{#each ADVANCED_PARAMS as p (p.key)}
						<div class="field">
							<span class="lbl"><label for="cal-{p.key}">{p.label}{#if p.unit}{" "}<span class="u">({p.unit})</span>{/if}</label><HelpTip key={`calibration.${p.key}`} /></span>
							<NumberInput
								id="cal-{p.key}"
								step={p.step ?? 'any'}
								disabled={readonly}
								value={num(p.key)}
								aria-describedby="cal-{p.key}-h"
								onchange={(v) => {
									if (v !== null) s.calibration[p.key] = v;
								}}
							/>
							<span class="hint" id="cal-{p.key}-h">{p.help}</span>
						</div>
					{/each}
				</div>
				{#each TABLE_PARAMS as p (p.key)}
					{@const arr = (cal[p.key] as number[] | undefined) ?? []}
					<h3 class="tbl-h">{p.label}{#if p.unit}{" "}<span class="u">({p.unit})</span>{/if} <span class="muted small">· {arr.length} values</span></h3>
					<p class="hint muted">{p.help}</p>
					<div class="table-wrap">
						<table class="data compact curve">
							<thead>
								<tr>
									<th scope="col">Index</th>
									{#each Array(10) as _, c (c)}<th scope="col" class="num">+{c}</th>{/each}
								</tr>
							</thead>
							<tbody>
								{#each Array(Math.ceil(arr.length / 10)) as _, r (r)}
									<tr>
										<th scope="row" class="num">{r * 10 + 1}</th>
										{#each Array(10) as _, c (c)}
											{@const i = r * 10 + c}
											<td>
												{#if i < arr.length}
													<NumberInput
														label="{p.label}, index {i + 1}"
														disabled={readonly}
														value={arr[i] ?? 0}
														onchange={(v) => {
															if (v !== null) (s.calibration[p.key] as number[])[i] = v;
														}}
													/>
												{/if}
											</td>
										{/each}
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
				{/each}
				{#if otherFields.length}
					<h3 class="tbl-h">Other parameters</h3>
					<div class="fields">
						{#each otherFields as f (f.key)}
							<div class="field">
								<label for="cal-{f.key}">{f.label}</label>
								{#if f.kind === 'number'}
									<NumberInput id="cal-{f.key}" disabled={readonly} value={f.value} onchange={(v) => { if (v !== null) s.calibration[f.key] = v; }} />
								{:else if f.kind === 'list'}
									<input
										id="cal-{f.key}"
										readonly={readonly}
										value={listText[f.key] ?? ''}
										aria-invalid={listInvalid[f.key] || undefined}
										class:invalid={listInvalid[f.key]}
										oninput={(e) => setList(f.key, e.currentTarget.value)}
									/>
									{#if listInvalid[f.key]}<span class="err">Enter numbers separated by commas.</span>{/if}
								{:else if f.kind === 'boolean'}
									<input id="cal-{f.key}" type="checkbox" disabled={readonly} checked={f.value} onchange={(e) => (s.calibration[f.key] = e.currentTarget.checked)} />
								{:else}
									<input id="cal-{f.key}" readonly value={JSON.stringify(f.value)} class="mono" />
									<span class="hint">Structured value — edit via the API.</span>
								{/if}
							</div>
						{/each}
					</div>
				{/if}
			</details>
		{/if}
	</section>

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
			<h2 id="share-h">Flow share between farms</h2>
			<span class="muted small">Splits catchment natural flow and the EWR into per-farm parts</span>
		</div>
		<div class="fields">
			<div class="field">
				<span class="lbl"><label for="st-method">Method</label><HelpTip key="settings.flowShareMethod" /></span>
				<select id="st-method" disabled={readonly} bind:value={s.flowShareMethod} aria-describedby="st-method-h">
					{#each METHODS as m (m.value)}<option value={m.value}>{m.label}</option>{/each}
				</select>
				<span class="hint" id="st-method-h">{method?.help} The resulting share per farm is shown on the Network tab.</span>
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
		</div>
		<p class="hint muted">
			The flow that must stay in the river for the ecosystem (the Ecological Reserve). b023's <em>pragmatic</em> EWR is one fixed
			flow per month, so farmers can plan for it; the model reports days when simulated outflow falls below it, and splits it
			between farms by flow share.
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
				<MonthlyBars values={s.ewrPragmaticM3PerDay} unit="m³/day" label="Pragmatic EWR" />
				<p class="muted small">
					{fmtNum(ewrAnnual, 3)} Mm³/a in total · mean {fmtNum((ewrAnnual * 1e6) / 86_400 / 365.25, 3)} m³/s
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
				Period the curtailment targets on Runs & results average over, e.g. the last dry season. Leave blank for the whole run.
			</span>
			{#if reportError}<p class="err" role="alert">{reportError}</p>{/if}
		</fieldset>
	</section>

	<!-- Period ------------------------------------------------------------------------>
	<section class="panel" id="set-period" aria-labelledby="per-h">
		<div class="panel-head"><h2 id="per-h">Simulation period <HelpTip key="settings.simulationStart" /></h2></div>
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
			Leave blank to simulate the full length of the rainfall series. Set a window to focus a run on a drought or
			a calibration period.
		</p>
		{#if dateError}<p class="err" role="alert">{dateError}</p>{/if}
	</section>

	<!-- Data quality ------------------------------------------------------------------>
	<section class="panel" id="set-quality" aria-labelledby="dq-h">
		<div class="panel-head">
			<h2 id="dq-h">Data quality <HelpTip key="settings.dataQuality" /></h2>
			<span class="muted small">Gauge vs logger check on the Time series tab and in run warnings</span>
		</div>
		<div class="fields">
			<div class="field">
				<label for="dq-min">Lowest gauge/logger ratio <span class="u">(%)</span></label>
				<NumberInput id="dq-min" min={1} max={100} scale={100} disabled={readonly} bind:value={s.dataQuality.agreementMinRatio} aria-describedby="dq-min-h" />
				<span class="hint" id="dq-min-h">Flag a water year when the gauge reads less than this share of the logger. Default 67 %.</span>
			</div>
			<div class="field">
				<label for="dq-max">Highest gauge/logger ratio <span class="u">(%)</span></label>
				<NumberInput id="dq-max" min={100} max={10_000} scale={100} disabled={readonly} bind:value={s.dataQuality.agreementMaxRatio} aria-describedby="dq-max-h" />
				<span class="hint" id="dq-max-h">… or more than this share. Default 150 %.</span>
			</div>
			<div class="field">
				<label for="dq-days">Minimum shared days <span class="u">(days)</span></label>
				<NumberInput id="dq-days" min={1} max={366} step={1} disabled={readonly} bind:value={s.dataQuality.agreementMinDays} aria-describedby="dq-days-h" />
				<span class="hint" id="dq-days-h">Water years with fewer days on which both records have a reading are not judged. Default 90.</span>
			</div>
		</div>
		<p class="hint muted">These thresholds only decide which years are flagged; they never change the model results.</p>
		{#if dqError}<p class="err" role="alert">{dqError}</p>{/if}
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
			<button type="button" class="btn" disabled={!dirty || saving} onclick={discard}>Discard</button>
			<button type="submit" class="btn btn-primary" disabled={!dirty || saving || blocked}>
				{saving ? 'Saving…' : 'Save settings'}
			</button>
		</div>
	{/if}
</form>

<style>
	.small {
		font-size: 0.8rem;
	}
	.lead {
		max-width: 80ch;
		margin: -0.25rem 0 0.9rem;
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
	.panel > .hint {
		margin: 0.5rem 0 0.75rem;
	}
	.fields {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
		gap: 0 1.25rem;
		margin-top: 0.5rem;
	}
	.field :global(input),
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
	.monthly td {
		min-width: 92px;
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
	.summer {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
		margin: 0.25rem 0 0.75rem;
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
	.advanced {
		border-top: 1px solid var(--border);
		padding-top: 0.6rem;
	}
	.advanced summary {
		cursor: pointer;
		font-weight: 600;
		color: var(--accent);
		min-height: 36px;
		display: flex;
		align-items: center;
	}
	.tbl-h {
		margin: 1rem 0 0.2rem;
	}
	.curve td {
		min-width: 86px;
	}
	.curve th[scope='row'] {
		color: var(--text-muted);
		font-weight: 400;
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
	.check {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		min-height: 36px;
	}
	.cal-window {
		margin: 0.25rem 0 0.75rem;
		padding-top: 0.75rem;
		border-top: 1px solid var(--border);
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
	/* In-page menu (as on Runs & results, but a bar: the monthly input rows need the full width). */
	.sections {
		position: sticky;
		top: var(--header-h);
		z-index: 15;
		display: flex;
		align-items: center;
		gap: 0.6rem;
		margin: 0 0 1rem;
		padding: 0.45rem 0;
		background: var(--bg);
		border-bottom: 1px solid var(--border);
	}
	.nav-h {
		flex: none;
		font-size: 0.75rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--text-muted);
	}
	.sections ul {
		list-style: none;
		display: flex;
		flex-wrap: wrap;
		gap: 0.35rem;
		margin: 0;
		padding: 0;
		min-width: 0;
	}
	.sections a {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		min-height: 30px;
		padding: 0 0.65rem;
		border: 1px solid var(--border);
		border-radius: 999px;
		background: var(--surface);
		font-size: 0.8rem;
		color: var(--text-2);
		text-decoration: none;
		white-space: nowrap;
	}
	.sections a:hover {
		border-color: var(--accent);
		color: var(--accent);
	}
	.sections a[aria-current='location'] {
		border-color: var(--accent);
		background: var(--accent-soft);
		color: var(--accent);
		font-weight: 600;
	}
	.dot {
		width: 0.45rem;
		height: 0.45rem;
		border-radius: 50%;
		background: var(--danger);
	}
	/* Phones: one row that scrolls sideways inside the bar, never the page. */
	@media (max-width: 640px) {
		.nav-h {
			display: none;
		}
		.sections ul {
			flex-wrap: nowrap;
			overflow-x: auto;
			scrollbar-width: none;
		}
		.sections a {
			min-height: 36px;
		}
	}
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
