<script lang="ts">
	import { untrack } from 'svelte';
	import type { CalibrationParams, FlowShareMethod, ProjectSettings } from '@water-management/engine';
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
		KNOWN_CAL_KEYS,
		parseNumberList,
		TABLE_PARAMS
	} from './calibration';
	import { dataQualityError } from './dataQuality';
	import MonthlyBars from './MonthlyBars.svelte';

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
	type Editable = Omit<ProjectSettings, 'apanMm' | 'ewrPragmaticM3PerDay' | 'calibration'> & {
		apanMm: number[];
		ewrPragmaticM3PerDay: number[];
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
	const reportError = $derived(
		s.reportStart && s.reportEnd && s.reportStart > s.reportEnd ? 'The reporting window must start before it ends.' : null
	);
	const dqError = $derived(dataQualityError(s.dataQuality));
	const blocked = $derived(!!dateError || hasInvalidList || !!calWindowError || !!reportError || !!dqError);
	const farmAreaKm2 = $derived(
		(editor?.model.nodes ?? []).filter((n) => n.kind === 'farm').reduce((t, n) => t + (n.areaKm2 || 0), 0)
	);
	const ewrAnnual = $derived(annualMm3(s.ewrPragmaticM3PerDay, s.februaryDays));
	const apanAnnual = $derived(s.apanMm.reduce((t, v) => t + (v || 0), 0));

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

	function discard() {
		s = clone(JSON.parse(saved));
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
			label: 'Pitman high/low MAP split',
			help: 'High-MAP areas share the high part of the split and low-MAP areas the low part (WR90/WR2012 practice).'
		},
		{ value: 'manual', label: 'Manual share per farm', help: 'Shares typed per farm on the Network tab ("Manual flow share").' }
	];
	const method = $derived(METHODS.find((m) => m.value === s.flowShareMethod));
	const num = (k: string) => cal[k] as number;
</script>

<form onsubmit={save} novalidate>
	{#if error}<div class="alert alert-error" role="alert">{error}</div>{/if}

	<p class="muted small lead">
		Grouped by what each setting drives: irrigation <strong>demand</strong>, natural <strong>flow generation</strong> from rainfall, how
		flow is <strong>shared</strong> between farms, and the <strong>EWR</strong> at the outflow gauge. Monthly values run through the water
		year, October → September.
	</p>

	<!-- Demand ------------------------------------------------------------------>
	<section class="panel" aria-labelledby="dem-h">
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
				<span class="hint" id="st-erf-h">Share of each day's rain on the cropped area that the crop can use, reducing that day's irrigation demand. The workbook default is 65 %.</span>
			</div>
			<div class="field">
				<span class="lbl"><label for="st-feb">Days in February</label><HelpTip key="settings.februaryDays" /></span>
				<NumberInput id="st-feb" min={28} max={29} step={0.01} disabled={readonly} bind:value={s.februaryDays} aria-describedby="st-feb-h" />
				<span class="hint" id="st-feb-h">Converts monthly volumes to per-day figures. 28.25 averages leap years, as the workbook does.</span>
			</div>
		</div>
	</section>

	<!-- Flow generation ------------------------------------------------------------>
	<section class="panel" aria-labelledby="cal-h">
		<div class="panel-head">
			<h2 id="cal-h">Flow calibration (rain → natural flow)</h2>
			<span class="muted small">Tune against observed flow; check NSE and PBIAS on Runs & results</span>
		</div>
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
		<fieldset class="plain summer">
			<legend>Summer months <span class="muted">({describeMonths(cal.summerMonths ?? [])})</span> <HelpTip key="calibration.summerMonths" /></legend>
			<MonthPicker label="Summer months" disabled={readonly} bind:months={s.calibration.summerMonths} />
			<span class="hint">
				Months always treated as summer (the summer factor applies). In other months a big rain day switches to winter behaviour
				— see Advanced.
			</span>
		</fieldset>

		<div class="cal-window">
			<CalibrationWindowFields
				bind:start={s.calibrationStart}
				bind:end={s.calibrationEnd}
				bind:flowKind={s.calibrationFlowKind}
				bind:error={calWindowError}
				{readonly}
				availableKinds={seriesKinds}
			/>
		</div>

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
	</section>

	<!-- Flow share ----------------------------------------------------------------->
	<section class="panel" aria-labelledby="share-h">
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
	<section class="panel" aria-labelledby="ewr-h">
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
	<section class="panel" aria-labelledby="per-h">
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
			Leave blank to simulate the full length of the rainfall (or Pitman flow) series. Set a window to focus a run on a drought or
			a calibration period.
		</p>
		{#if dateError}<p class="err" role="alert">{dateError}</p>{/if}
	</section>

	<!-- Data quality ------------------------------------------------------------------>
	<section class="panel" aria-labelledby="dq-h">
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
		<div class="actions">
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
	.ewr {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(220px, 360px);
		gap: 1rem;
		align-items: start;
	}
	@media (max-width: 1000px) {
		.ewr {
			grid-template-columns: minmax(0, 1fr);
		}
	}
	.ewr-side p {
		margin: 0.3rem 0 0;
	}
	.report {
		margin-top: 1rem;
		display: grid;
		gap: 0.25rem;
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
