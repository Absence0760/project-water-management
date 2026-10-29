<!--
	Calibration → Fit the parameters → "Regional prior" (issue #622 step 5;
	docs/ui.md § Calibration, docs/model.md §2.10m). GR4J's parameter ranges
	from calibrated, similar, nearby gauged basins (the donors), for the
	catchment or, under calibration zones, one zone's own land units: each
	parameter's p10–p50–p90 beside its value now, the donors kept (distance,
	weight, their own fit), the method's leave-one-out skill with "No skill"
	when it has none, and the soil relation's state. "Start from the prior"
	(editors, in the heading's row, marked "Saves now") writes the medians into
	that target's parameters as one settings revision naming the donors; it
	waits while the form has unsaved changes. Fit automatically (below) uses the
	same prior as a penalty or its search box. The donor and soil datasets'
	credits show with it.
-->
<script lang="ts">
	import { untrack } from 'svelte';
	import { api, type Gr4jPrior } from '#lib/api/index.js';
	import { confirmDialog } from '#lib/components/common/confirm.svelte.js';
	import ProposalPanel from '#lib/components/proposals/ProposalPanel.svelte';
	import ProposalSynthetic from '#lib/components/proposals/ProposalSynthetic.svelte';
	import { fmtNum } from '#lib/format/number.js';
	import { donorLine, rangeRows, skillText } from '#lib/calibration/prior.js';

	let {
		projectId,
		readonly,
		formDirty,
		zones = [],
		currentParams,
		onApplied
	}: {
		projectId: string;
		readonly: boolean;
		/** Unsaved settings: Start waits until they are saved or discarded (it saves straight to the project). */
		formDirty: boolean;
		/** The ticked calibration zones (issue #555), each a target of its own; [] = the catchment alone. */
		zones?: readonly { nodeId: string; name: string }[];
		/** The GR4J parameters the form holds now for a target (null = the catchment, or the site's own zone). */
		currentParams: (zoneNodeId: string | null) => { x1?: number; x2?: number; x3?: number; x4?: number } | null | undefined;
		/** The settings changed on the server: the form takes them as they now are. */
		onApplied: () => Promise<void> | void;
	} = $props();

	const uid = $props.id();
	const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

	let zone = $state<string | null>(null);
	let data = $state.raw<Gr4jPrior | null>(null);
	let loading = $state(false);
	let error = $state<string | null>(null);
	let busy = $state(false);
	let startError = $state<string | null>(null);
	let notice = $state<string | null>(null);
	let frame = $state<ProposalPanel | null>(null);
	let seq = 0;

	async function load() {
		const mine = ++seq;
		loading = true;
		error = null;
		try {
			const d = await api.gr4jPrior.get(projectId, { zone });
			if (mine === seq) data = d;
		} catch (e) {
			if (mine === seq) error = msg(e);
		} finally {
			if (mine === seq) loading = false;
		}
	}
	$effect(() => {
		void projectId;
		void zone;
		untrack(() => void load());
	});
	// A zone unticked since: back to the catchment.
	$effect(() => {
		if (zone !== null && !zones.some((z) => z.nodeId === zone)) zone = null;
	});

	const ok = $derived(data?.prior?.ok && data.ranges && data.provenance ? data : null);
	const rows = $derived(ok ? rangeRows(ok.ranges!, currentParams(zone)) : []);
	const skill = $derived(ok?.prior?.ok ? skillText(ok.prior.leaveOneOut?.skill, ok.prior.leaveOneOut?.n) : null);
	const soil = $derived(ok?.prior?.ok ? ok.prior.soil : null);
	const targetName = $derived(zone === null ? (zones.length ? 'the calibration site’s own zone' : 'the catchment') : `the zone at ${zones.find((z) => z.nodeId === zone)?.name ?? 'its gauge'}`);
	const km = (v: number) => fmtNum(v, v >= 10 ? 0 : 1);
	const pct = (w: number) => `${fmtNum(Math.round(w * 100))} %`;

	async function start() {
		if (!ok?.ranges || !ok.provenance) return;
		const confirmed = await confirmDialog({
			title: 'Start GR4J from the regional prior?',
			message: `Writes the donors’ medians (X1 ${rows[0]!.p50} mm, X3 ${rows[2]!.p50} mm, X4 ${rows[3]!.p50} days) into ${targetName}’s GR4J parameters and saves them now, as a settings revision naming the ${ok.provenance.donors.length} donors. They are not calibrated: fit them to a flow record when there is one.`,
			confirmLabel: 'Start from the prior'
		});
		if (!confirmed) return;
		busy = true;
		startError = null;
		try {
			await api.gr4jPrior.start(projectId, { zone, ...(ok.dataset ? { dataset: ok.dataset.dataset } : {}) });
			notice = `GR4J’s parameters for ${targetName} now start from the regional prior’s medians, saved as a settings revision.`;
			await Promise.all([load(), onApplied()]);
			await frame?.focusNotice();
		} catch (e) {
			startError = msg(e);
		} finally {
			busy = false;
		}
	}
</script>

<ProposalPanel
	bind:this={frame}
	testid="regional-prior"
	prefix="prior"
	id="set-prior"
	variant="inline"
	title="Regional prior"
	level={4}
	helpKey="regional-prior"
	what="regional prior"
	{notice}
	{loading}
	loaded={data !== null}
	{error}
	onretry={load}
>
	{#snippet actions()}
		{#if ok && !readonly && !ok.started}
			<span class="saves-now" id="{uid}-now">Saves now</span>
			<button type="button" class="btn btn-sm" disabled={busy || formDirty} aria-describedby={formDirty ? `${uid}-now ${uid}-dirty` : `${uid}-now`} onclick={start} data-testid="prior-start"
				>{busy ? 'Saving…' : 'Start from the prior'}</button
			>
		{/if}
	{/snippet}
	{#snippet intro()}<p class="hint muted explain">
			GR4J’s parameters in gauged basins like this one nearby (the donors), each fitted on the same CHIRPS rain and dPET evaporation the app uses. A start for a
			catchment with no flow record, and a penalty or search box for Fit automatically below.
		</p>{/snippet}
	{#snippet controls()}
		{#if zones.length}
			<div class="field">
				<label for="{uid}-zone">For</label>
				<select id="{uid}-zone" bind:value={zone} data-testid="prior-zone">
					<option value={null}>The calibration site’s own zone</option>
					{#each zones as z (z.nodeId)}<option value={z.nodeId}>The zone at {z.name}</option>{/each}
				</select>
			</div>
		{/if}
	{/snippet}
	{#if formDirty && ok && !readonly && !ok.started}<p class="hint" id="{uid}-dirty">Save or discard the form’s changes first: Start saves straight to the project.</p>{/if}
	{#if startError}<p class="alert alert-error" role="alert">{startError}</p>{/if}
	{#if data && !ok}
		<p class="muted small" data-testid="prior-problem">{data.problem ?? 'There is no prior for this catchment.'}</p>
	{:else if ok}
		{#if ok.dataset?.synthetic}<ProposalSynthetic testid="prior-synthetic" subject="The donor set" notWhat="GRDC-Caravan basins" forWhat="prior or calibration" />{/if}
		{#if ok.started}
			<p class="small" data-testid="prior-started">The parameters of {targetName} were started from this prior and haven’t been changed since: the donors’ medians, not a fit.</p>
		{/if}
		<p class="small" data-testid="prior-skill">
			<strong>Skill:</strong>
			{skill?.text}{#if skill?.noSkill}
				<span class="badge badge-warn" data-testid="prior-no-skill">No skill</span>{/if}
		</p>
		<div class="table-wrap">
			<table class="data compact" data-testid="prior-ranges">
				<caption>Parameter ranges for {targetName}</caption>
				<thead>
					<tr><th scope="col">Parameter</th><th scope="col" class="num">p10</th><th scope="col" class="num">p50</th><th scope="col" class="num">p90</th><th scope="col" class="num">Now</th></tr>
				</thead>
				<tbody>
					{#each rows as r (r.key)}
						<tr>
							<th scope="row">{r.label}{r.unit ? ` (${r.unit})` : ''}{r.key === 'x1' && ok.provenance?.x1From === 'soil' ? ', from soil water capacity' : ''}</th>
							<td class="num">{r.p10}</td>
							<td class="num">{r.p50}</td>
							<td class="num">{r.p90}</td>
							<td class="num">{r.current}{r.where === 'below' ? ' (below p10)' : r.where === 'above' ? ' (above p90)' : ''}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
		<p class="small muted">
			{donorLine(ok.provenance!)}, compared on {[ok.target?.attributes.areaKm2 != null ? `area (${fmtNum(ok.target.attributes.areaKm2, 0)} km²)` : null, ok.target?.attributes.mapMm != null ? `mean annual rain (${fmtNum(ok.target.attributes.mapMm, 0)} mm over ${ok.target.climateYears} water years)` : null, ok.target?.attributes.aridity != null ? `aridity (${fmtNum(ok.target.attributes.aridity, 2)})` : null].filter(Boolean).join(', ') || 'distance alone'} and distance from the {ok.target?.positionFrom === 'gauge' ? 'zone’s gauge' : 'catchment boundary’s centre'}.
			{soil?.status === 'used' ? `X1’s range is from the soil water capacity relation (leave-one-out R² ${fmtNum(soil.looR2, 2)}) at ${fmtNum(ok.target?.pawcMm ?? 0, 0)} mm.` : soil ? `The soil relation for X1 isn’t used: ${soil.reason}.` : ''}
			{ok.target?.soilProblem ? `No soil water capacity: ${ok.target.soilProblem}.` : ''}
		</p>
		<details class="donors">
			<summary>The {ok.donors.length} donors</summary>
			<div class="table-wrap">
				<table class="data compact" data-testid="prior-donors">
					<caption class="visually-hidden">The donor basins the prior kept</caption>
					<thead>
						<tr>
							<th scope="col">Basin</th>
							<th scope="col" class="num">Weight</th>
							<th scope="col" class="num">Distance (km)</th>
							<th scope="col" class="num">Area (km²)</th>
							<th scope="col" class="num">KGE′ (own fit)</th>
							<th scope="col" class="num">X1, X3, X4</th>
						</tr>
					</thead>
					<tbody>
						{#each ok.donors as d (d.id)}
							<tr>
								<th scope="row">{d.id}</th>
								<td class="num">{pct(d.weight)}</td>
								<td class="num">{km(d.distanceKm)}</td>
								<td class="num">{fmtNum(d.areaKm2, 0)}</td>
								<td class="num">{fmtNum(d.kgeFit, 2)}{d.kgeValidation !== null ? ` (${fmtNum(d.kgeValidation, 2)} validation)` : ''}</td>
								<td class="num">{fmtNum(d.params.x1, 0)}, {fmtNum(d.params.x3, 0)}, {fmtNum(d.params.x4, 2)}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		</details>
		<p class="small muted" data-testid="prior-credits">
			{ok.dataset?.attribution}{ok.soil && ok.provenance?.x1From === 'soil' ? ` ${ok.soil.attribution}` : ''} Donor set {ok.dataset?.version}, SHA-256 {ok.dataset?.donorSetSha256.slice(0, 12)}…; <a href="/data-sources#grdc-caravan">data sources</a>.
		</p>
	{/if}
</ProposalPanel>

<style>
	.saves-now {
		font-size: var(--font-xs);
		font-weight: 600;
		padding: 0.05rem 0.45rem;
		border-radius: 999px;
		background: var(--warning-soft);
	}
	.donors summary {
		cursor: pointer;
	}
	.badge {
		margin-left: 0.4em;
	}
</style>
