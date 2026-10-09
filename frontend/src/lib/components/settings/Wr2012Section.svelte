<!--
	Settings → WR2012 check (issue #4 phase 8): the quaternary's naturalised
	flow, entered by the user from the public WR2012 study (never bundled), and
	how runs compare with it. Bind `value` (settings.wr2012); `error` is set
	while anything would be rejected, so the parent form can block saving.
	Bind `last` and `lastBand` to the page's draft (settingsDraft `kept`): what
	unticking the check or the MAR band turned off, brought back when ticked
	again until the form is saved or discarded.
-->
<script module lang="ts">
	// "Propose from the map" (issue #288) is its own chunk, fetched when asked for: the Settings tab's chunk stays as it was.
	const loadProposal = () => import('./QuaternaryProposal.svelte');
</script>

<script lang="ts">
	import { tick } from 'svelte';
	import { WR2012_MONTHLY_SUM_TOLERANCE, type Wr2012Settings } from '@water-management/engine';
	import HelpTip from '$lib/components/help/HelpTip.svelte';
	import NotesDrawer from '$lib/components/notes/NotesDrawer.svelte';
	import { settingTarget } from '$lib/components/notes/notes';
	import NumberInput from '$lib/components/common/NumberInput.svelte';
	import MonthPicker from '$lib/components/common/MonthPicker.svelte';
	import Lazy from '$lib/components/common/Lazy.svelte';
	import { fmtNum } from '$lib/format/number';
	import { describeMonths, WATER_YEAR_MONTHS } from '$lib/format/months';
	import { mm3MonthToM3s, monthlySum, waterYearLabel, withMarBand, withReference, wr2012Errors, type MarBand, type Wr2012Draft } from './wr2012';

	let {
		/** What the panel is set to now, under its heading (settings/summaries.ts). */
		summary = null,
		value = $bindable(),
		error = $bindable(null),
		readonly = false,
		projectId = null,
		modelAreaKm2,
		last = $bindable(),
		lastBand = $bindable()
	}: {
		summary?: string | null;
		value: Wr2012Settings;
		error?: string | null;
		/** The reference unticking the check turned off, kept until saved or discarded. */
		last?: unknown;
		/** The MAR band's bounds unticking it turned off, likewise. */
		lastBand?: unknown;
		readonly?: boolean;
		/** For "Propose from the map" (the quaternary lookup, issue #288); without it the form is typed only. */
		projectId?: string | null;
		/** The modelled catchment's area (km²), for the scaling preview. */
		modelAreaKm2: number;
	} = $props();

	const uid = $props.id();
	let proposing = $state(false);
	const FLAG_FIELDS = [
		{ key: 'notePct', label: 'Note it' },
		{ key: 'queryPct', label: 'Query it' },
		{ key: 'queryWetterPct', label: '…or query it when wetter by' },
		{ key: 'unusablePct', label: 'Not usable for EWR findings' }
	] as const;
	// The form edits a draft whose numbers may still be blank.
	const ref = $derived(value.reference as Wr2012Draft | null);
	const errors = $derived(wr2012Errors(value));
	const sum = $derived(ref ? monthlySum(ref.monthlyMm3) : null);
	const areaFactor = $derived(ref?.areaKm2 ? modelAreaKm2 / ref.areaKm2 : null);
	let ownMonths = $state(value.lowFlowMonths !== null);
	let ownBand = $state(value.calibrationPenalty.marLowMm3 !== null || value.calibrationPenalty.marHighMm3 !== null);
	// Both blank counts as "no band" (a single target) at the engine level, so it never blocks Save;
	// this is just a nudge while the checkbox is ticked and nothing has been entered yet.
	const bandBlank = $derived(ownBand && value.calibrationPenalty.marLowMm3 === null && value.calibrationPenalty.marHighMm3 === null);

	$effect(() => {
		const n = Object.keys(errors).length;
		error = n ? `The WR2012 check has ${n} problem${n === 1 ? '' : 's'} to fix.` : null;
	});

	function setEnabled(on: boolean) {
		if (!on && ref) last = { reference: $state.snapshot(ref), penalty: value.calibrationPenalty.enabled };
		const kept = last as { reference: Wr2012Draft; penalty: boolean } | null | undefined;
		value.reference = withReference(on, kept?.reference) as unknown as Wr2012Settings['reference'];
		value.calibrationPenalty.enabled = on ? (kept?.penalty ?? false) : false;
		if (!on) proposing = false;
	}

	function setOwnMonths(on: boolean) {
		ownMonths = on;
		value.lowFlowMonths = on ? (value.lowFlowMonths ?? [12, 1, 2]) : null;
	}

	function setOwnBand(on: boolean) {
		ownBand = on;
		const p = value.calibrationPenalty;
		if (!on && (p.marLowMm3 !== null || p.marHighMm3 !== null)) lastBand = { marLowMm3: p.marLowMm3, marHighMm3: p.marHighMm3 };
		const b = withMarBand(on, lastBand as MarBand | null | undefined);
		p.marLowMm3 = b.marLowMm3;
		p.marHighMm3 = b.marHighMm3;
	}

	const err = (k: string) => errors[k];

	// "Propose from the map" opens the lookup in place; Close puts the button back and the focus on it.
	let proposeBtn: HTMLButtonElement | undefined = $state();
	async function closeProposal() {
		proposing = false;
		await tick();
		proposeBtn?.focus();
	}
</script>

<section class="panel" aria-labelledby="{uid}-h">
	<div class="panel-head">
		<h2 id="{uid}-h">WR2012 check <HelpTip key="settings.wr2012" /></h2>
		{#if projectId}<NotesDrawer {projectId} target={settingTarget('wr2012')} />{/if}
	</div>
	{#if summary}<p class="summary" data-testid="summary-wr2012">{summary}</p>{/if}
	<p class="hint muted explain">Optional: compare simulated natural flow with the quaternary’s naturalised flow.</p>
	<p class="hint muted explain">
		Enter the naturalised flow the WR2012 study publishes for the quaternary catchment this project lies in. Each run then compares its
		<strong>simulated natural flow</strong> (before hydrological units and dams take any water) with it, scaled to the modelled catchment. The numbers are
		yours to enter (or to take, one by one, from the quaternary under a point on the map, when a quaternary dataset is loaded); the app doesn’t ship WR2012 data.
	</p>
	<label class="check">
		<input type="checkbox" disabled={readonly} checked={ref !== null} onchange={(e) => setEnabled(e.currentTarget.checked)} />
		Compare runs with WR2012 naturalised flow
	</label>

	{#if ref}
		{#if projectId && !readonly}
			{#if proposing}
				<Lazy load={loadProposal}>
					{#snippet children(QuaternaryProposal)}
						<QuaternaryProposal {projectId} bind:ref={() => ref!, (v) => (value.reference = v as unknown as Wr2012Settings['reference'])} />
					{/snippet}
				</Lazy>
				<p class="propose">
					<button type="button" class="btn btn-sm btn-ghost" onclick={closeProposal}>Close the proposal</button>
				</p>
			{:else}
				<p class="propose">
					<button type="button" class="btn btn-sm" onclick={() => (proposing = true)} bind:this={proposeBtn}>Propose from the map</button>
					<span class="hint muted explain">Look up the quaternary under a point and use its reference values one by one.</span>
				</p>
			{/if}
		{/if}
		<div class="fields">
			<div class="field">
				<label for="{uid}-q">Quaternary catchment <HelpTip key="quaternary" /></label>
				<input id="{uid}-q" readonly={readonly} maxlength="16" placeholder="e.g. A21B" bind:value={ref.quaternary} aria-invalid={err('quaternary') ? 'true' : undefined} aria-describedby="{uid}-q-e" />
				{#if err('quaternary')}<span class="err" id="{uid}-q-e">{err('quaternary')}</span>{/if}
			</div>
			<div class="field">
				<label for="{uid}-area">Quaternary area <span class="u">(km²)</span></label>
				<NumberInput id="{uid}-area" min={0} nullable disabled={readonly} bind:value={ref.areaKm2} aria-invalid={err('areaKm2') ? 'true' : undefined} aria-describedby="{uid}-area-e" />
				{#if err('areaKm2')}<span class="err" id="{uid}-area-e">{err('areaKm2')}</span>{/if}
			</div>
			<div class="field">
				<label for="{uid}-map">Quaternary MAP <span class="u">(mm, optional)</span></label>
				<NumberInput id="{uid}-map" min={0} nullable disabled={readonly} bind:value={ref.mapMm} aria-invalid={err('mapMm') ? 'true' : undefined} aria-describedby="{uid}-map-h" />
				<span class="hint" id="{uid}-map-h">{#if err('mapMm')}<span class="err">{err('mapMm')}</span>{:else}Mean annual precipitation. Enables the rainfall scaling and the check that the MAR is less than the rain.{/if}</span>
			</div>
			<div class="field">
				<label for="{uid}-mar">Naturalised MAR <span class="u">(Mm³/a)</span></label>
				<NumberInput id="{uid}-mar" min={0} nullable disabled={readonly} bind:value={ref.marMm3} aria-invalid={err('marMm3') ? 'true' : undefined} aria-describedby="{uid}-mar-e" />
				{#if err('marMm3')}<span class="err" id="{uid}-mar-e">{err('marMm3')}</span>{/if}
			</div>
			<fieldset class="plain period">
				<legend>Period the reference covers <span class="u">(water years)</span></legend>
				<div class="form-row">
					<div class="field">
						<label for="{uid}-from">From</label>
						<NumberInput id="{uid}-from" min={1800} max={2200} step={1} nullable disabled={readonly} bind:value={ref.periodStart} aria-describedby="{uid}-per-h" />
					</div>
					<div class="field">
						<label for="{uid}-to">To</label>
						<NumberInput id="{uid}-to" min={1800} max={2200} step={1} nullable disabled={readonly} bind:value={ref.periodEnd} aria-invalid={err('periodEnd') ? 'true' : undefined} aria-describedby="{uid}-per-h" />
					</div>
				</div>
				<span class="hint" id="{uid}-per-h">
					{#if err('periodEnd')}<span class="err">{err('periodEnd')}</span>{:else if ref.periodStart != null && ref.periodEnd != null}{waterYearLabel(ref.periodStart)} to {waterYearLabel(ref.periodEnd)}: each year starts in October.{:else}Each water year is labelled by the year it starts in (1920 = Oct 1920 – Sep 1921).{/if}
				</span>
			</fieldset>
			<div class="field wide">
				<label for="{uid}-src">Source</label>
				<input id="{uid}-src" readonly={readonly} maxlength="500" placeholder="Study, volume, table" bind:value={ref.source} aria-invalid={err('source') ? 'true' : undefined} aria-describedby="{uid}-src-e" />
				{#if err('source')}<span class="err" id="{uid}-src-e">{err('source')}</span>{/if}
			</div>
		</div>

		<div class="table-wrap">
			<table class="data compact monthly">
				<caption class="visually-hidden">Mean naturalised flow per month</caption>
				<thead>
					<tr>
						<th scope="col" class="sticky">Month</th>
						{#each WATER_YEAR_MONTHS as m (m)}<th scope="col" class="num">{m}</th>{/each}
						<th scope="col" class="num">Sum</th>
					</tr>
				</thead>
				<tbody>
					<tr>
						<th scope="row" class="sticky">Mean naturalised flow <span class="u">Mm³</span></th>
						{#each WATER_YEAR_MONTHS as m, i (m)}
							<td>
								<NumberInput
									label="WR2012 monthly mean, {m}, Mm³"
									min={0}
									nullable
									disabled={readonly}
									bind:value={ref.monthlyMm3[i]}
									aria-invalid={err('monthlyMm3') ? 'true' : undefined}
									aria-describedby={err('monthlyMm3') ? `${uid}-monthly-e` : undefined}
								/>
							</td>
						{/each}
						<td class="num">{sum === null ? '–' : fmtNum(sum, 3)}</td>
					</tr>
					<tr class="derived">
						<th scope="row" class="sticky">Equivalent <span class="u">m³/s</span></th>
						{#each ref.monthlyMm3 as v, i (i)}<td class="num">{v == null ? '–' : fmtNum(mm3MonthToM3s(v, i), 3)}</td>{/each}
						<td></td>
					</tr>
				</tbody>
			</table>
		</div>
		<p class="hint muted" id="{uid}-monthly-h">
			Monthly volumes in <strong>million m³ per month</strong>, October → September, as the WR2012 tables give them (not m³/s). They should add
			up to the MAR within {WR2012_MONTHLY_SUM_TOLERANCE * 100} %.
		</p>
		{#if err('monthlyMm3')}<p class="err" id="{uid}-monthly-e">{err('monthlyMm3')}</p>{/if}

		<div class="fields">
			<div class="field">
				<label for="{uid}-scale">Scale the reference by <HelpTip key="wr2012-check" label="About scaling the reference" /></label>
				<select id="{uid}-scale" disabled={readonly} bind:value={value.scaling} aria-describedby="{uid}-scale-h">
					<option value="area">Area ratio</option>
					<option value="areaRain">Area and rainfall ratio</option>
				</select>
				<span class="hint" id="{uid}-scale-h">
					{#if areaFactor !== null}Area ratio now: {fmtNum(modelAreaKm2, 2)} ÷ {fmtNum(ref.areaKm2, 2)} km² = {fmtNum(areaFactor, 3)}.{/if}
					{value.scaling === 'areaRain'
						? ' Also × the run’s mean annual rain ÷ the quaternary MAP; falls back to area alone (with a warning) without them.'
						: ''}
				</span>
			</div>
		</div>
		<fieldset class="plain months">
			<legend>Dry-season months <span class="muted">({ownMonths ? describeMonths(value.lowFlowMonths ?? []) : 'from each run'})</span></legend>
			<label class="check">
				<input type="checkbox" disabled={readonly} checked={ownMonths} onchange={(e) => setOwnMonths(e.currentTarget.checked)} />
				Choose the dry-season months
			</label>
			{#if ownMonths && value.lowFlowMonths}
				<div aria-describedby={err('lowFlowMonths') ? `${uid}-months-e` : undefined} role="group" aria-label="Dry-season months">
					<MonthPicker label="Dry-season months" disabled={readonly} bind:months={value.lowFlowMonths} />
				</div>
			{/if}
			{#if err('lowFlowMonths')}<p class="err" id="{uid}-months-e">{err('lowFlowMonths')}</p>{/if}
			<span class="hint explain">
				Unticked, each run uses the project’s own low-flow months: those whose simulated natural flow is below half the average month.
			</span>
		</fieldset>

		<fieldset class="plain flags">
			<legend>When the simulated MAR differs from WR2012 by… <HelpTip key="wr2012-check" label="About the MAR thresholds" /></legend>
			<div class="fields">
				{#each FLAG_FIELDS as f (f.key)}
					<div class="field">
						<label for="{uid}-{f.key}">{f.label} <span class="u">(%)</span></label>
						<NumberInput
							id="{uid}-{f.key}"
							min={0}
							max={1000}
							disabled={readonly}
							bind:value={value.flags[f.key]}
							aria-invalid={err(f.key) ? 'true' : undefined}
							aria-describedby={err(f.key) ? `${uid}-${f.key}-e` : undefined}
						/>
						{#if err(f.key)}<span class="err" id="{uid}-{f.key}-e">{err(f.key)}</span>{/if}
					</div>
				{/each}
			</div>
			<span class="hint explain">Shown as run warnings. Defaults 10, 25 (or 15 wetter) and 50 %.</span>
		</fieldset>

		<fieldset class="plain penalty">
			<legend>Automatic calibration <HelpTip key="wr2012-penalty" /></legend>
			<label class="check">
				<input type="checkbox" disabled={readonly} bind:checked={value.calibrationPenalty.enabled} />
				Add a soft penalty on the MAR when fitting automatically
			</label>
			{#if value.calibrationPenalty.enabled}
				<div class="field weight">
					<label for="{uid}-w">Penalty weight</label>
					<NumberInput id="{uid}-w" min={0} max={10} step={0.1} disabled={readonly} bind:value={value.calibrationPenalty.weight} aria-describedby="{uid}-w-h" />
					<span class="hint" id="{uid}-w-h">{#if err('weight')}<span class="err">{err('weight')}</span>{:else}Loss + weight × |ln(simulated MAR ÷ target)|. Default 0.5.{/if}</span>
				</div>
				<label class="check">
					<input type="checkbox" disabled={readonly} checked={ownBand} onchange={(e) => setOwnBand(e.currentTarget.checked)} />
					Use a MAR band instead of one target
				</label>
				{#if ownBand}
					<div class="fields">
						<div class="field">
							<label for="{uid}-lo">Band low <span class="u">(Mm³/a)</span></label>
							<NumberInput
								id="{uid}-lo"
								min={0}
								nullable
								disabled={readonly}
								bind:value={value.calibrationPenalty.marLowMm3}
								aria-invalid={err('marLowMm3') ? 'true' : undefined}
								aria-describedby="{uid}-band-h"
							/>
						</div>
						<div class="field">
							<label for="{uid}-hi">Band high <span class="u">(Mm³/a)</span></label>
							<NumberInput
								id="{uid}-hi"
								min={0}
								nullable
								disabled={readonly}
								bind:value={value.calibrationPenalty.marHighMm3}
								aria-invalid={err('marHighMm3') ? 'true' : undefined}
								aria-describedby="{uid}-band-h"
							/>
						</div>
					</div>
					<span class="hint" id="{uid}-band-h">
						{#if err('marLowMm3')}<span class="err">{err('marLowMm3')}</span>{:else if err('marHighMm3')}<span class="err">{err('marHighMm3')}</span
							>{:else if bandBlank}<span class="err">Enter both bounds, or untick “Use a MAR band instead of one target”.</span
							>{:else}Already scaled to the modelled catchment (not the quaternary's own figure): use this when two published natural-MAR estimates for this
						catchment disagree. The penalty is zero inside the band, weight × |ln(simulated ÷ the nearer bound)| outside it.{/if}
					</span>
				{/if}
			{/if}
			<span class="hint explain">Off by default. The fit then also runs without it, so you can see what it changed.</span>
		</fieldset>
	{/if}
</section>

<style>
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
	.field.wide {
		grid-column: 1 / -1;
		max-width: 60ch;
	}
	.plain {
		border: 0;
		padding: 0;
		margin: 0.25rem 0 0.75rem;
		min-width: 0;
	}
	.plain legend {
		font-weight: 500;
		font-size: 0.85rem;
		color: var(--text-2);
		margin-bottom: 0.35rem;
		padding: 0;
	}
	.period .field {
		width: 120px;
	}
	.months,
	.penalty {
		display: grid;
		gap: 0.35rem;
	}
	.weight {
		max-width: 240px;
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
		font-size: 0.8rem;
	}
	.check {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		min-height: 36px;
	}
	.err {
		color: var(--danger);
		font-size: 0.8rem;
	}
	.propose {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		align-items: center;
		margin: 0.75rem 0;
	}
	h2 :global(.helptip),
	legend :global(.helptip) {
		margin-left: 0.15rem;
	}
</style>
