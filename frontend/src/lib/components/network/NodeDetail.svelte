<script lang="ts">
	// One node's fields as a labelled form with help text: the node sheet's
	// form (NetworkTab.svelte). Its sections run in the order water moves
	// through a unit (nodeSections.ts), each a fieldset the sheet's jump row
	// can scroll to.
	import { BOREHOLE_RULES, GA538_GROUNDWATER_RATES, MAP_MM_MAX, MAP_MM_MIN, onRiverDam, PE_SOURCE_MAX, type Borehole, type DemandObject, type DemandObjectCategory, type BoreholeRule, type FlowShareMethod, type LandCoverPatch, type NetworkNode, type NodeKind } from '@water-management/engine';
	import FlowUnitSelect from './FlowUnitSelect.svelte';
	import NumberInput from '$lib/components/common/NumberInput.svelte';
	import HelpTip from '$lib/components/help/HelpTip.svelte';
	import { fmtNum, fmtPct } from '$lib/format/number';
	import { pctText } from '$lib/model/systems';
	import type { FarmPlanting } from '$lib/components/crops/farmDrawer';
	import { damHints, fieldScale, fieldUnused, hasDam, hiLoHint, isPct, NODE_FIELDS, returnFlowHint, setNodeField, type NodeField } from './fields';
	import { fieldShows, nodeSections, SECTION_TITLE, sectionId } from './nodeSections';
	import DamStorageFields from './DamStorageFields.svelte';
	import DevelopmentFields from './DevelopmentFields.svelte';
	import UserFields from './UserFields.svelte';
	import LandCoverFields from './LandCoverFields.svelte';
	import BoreholeFields from './BoreholeFields.svelte';
	import DemandObjectFields from './DemandObjectFields.svelte';
	import SupplyFields from './SupplyFields.svelte';
	import RiverToDamFields from './RiverToDamFields.svelte';
	import FieldHistoryLine from '$lib/components/history/FieldHistoryLine.svelte';
	import { ewrSiteIssue, unitMapProblem, withUnitMap } from '$lib/model/validate';

	let {
		node,
		nodes,
		share,
		readonly,
		onremove,
		onmakeoutlet,
		landCover = [],
		onaddcover,
		onremovecover,
		boreholes = [],
		onaddborehole,
		onremoveborehole,
		demandObjects = [],
		onadddemand,
		onremovedemand,
		farmersNote = null,
		previewHref = null,
		mapHref = null,
		method = 'area',
		planting = null,
		plantedHref = null,
		efficiency = null,
		systemsLine = null,
		ownEfficiency = false,
		transfersLine = null,
		transfersHref = null
	}: {
		node: NetworkNode;
		nodes: NetworkNode[];
		/** Computed flow share (0–1) with the current method; null for gauges. */
		share: number | null;
		readonly: boolean;
		onremove?: () => void;
		onmakeoutlet?: () => void;
		/** This node's land-cover patches (WP-1.35; farms only). */
		landCover?: LandCoverPatch[];
		onaddcover?: () => void;
		onremovecover?: (id: string) => void;
		/** This node's individual boreholes (WP-3.9; farms and other users). */
		boreholes?: Borehole[];
		onaddborehole?: () => void;
		onremoveborehole?: (id: string) => void;
		/** This unit's demand objects (engine ≥ 1.7.0, issue #54 item 2b; units only). */
		demandObjects?: DemandObject[];
		onadddemand?: (category: DemandObjectCategory) => void;
		onremovedemand?: (id: string) => void;
		/** "N farmers are linked…" for a farm with linked farmers (WP-2.1); null otherwise. */
		farmersNote?: string | null;
		/** A farm's page as its farmer sees it (WP-2.6); null for other nodes. */
		previewHref?: string | null;
		/** This node on the Map tab (issue #326 A2); null when no map feature is linked to it. */
		mapHref?: string | null;
		/** The project's flow-share method (Settings & calibration): fields only another method reads show read-only. */
		method?: FlowShareMethod;
		/** A unit's planted areas (Crops), for the Irrigation section's pointer to them; null for other nodes. */
		planting?: FarmPlanting | null;
		/** The unit's efficiency as a run takes it: its crops' irrigation systems blended (engine ≥ 1.72.0); farms only. */
		efficiency?: number | null;
		/** Each crop it plants on its system, in words; null when it plants none. */
		systemsLine?: string | null;
		/** Some crop here is on no system, so a run uses the unit's own efficiency for it, which is then edited here (model/systems.ts ownEfficiencyUsed). */
		ownEfficiency?: boolean;
		/** Opens the unit's planted areas (the farm drawer). */
		plantedHref?: string | null;
		/** "2 transfers, from Dam A, to Dam B": the unit's transfers, for the same pointer; null with none. */
		transfersLine?: string | null;
		transfersHref?: string | null;
	} = $props();

	/** Each field group's fields that show on this kind of node. */
	const groupFields = $derived.by(() => {
		const out = new Map<NodeField['group'], NodeField[]>();
		for (const f of NODE_FIELDS) {
			if (!fieldShows(f, node.kind)) continue;
			if (!out.has(f.group)) out.set(f.group, []);
			out.get(f.group)!.push(f);
		}
		return out;
	});
	const sections = $derived(nodeSections(node, demandObjects.length));
	const hiLo = $derived(method === 'hiLo' ? hiLoHint(node) : null);
	const id = (k: string) => `nd-${k}-${node.id}`;
	const BOREHOLE_RULE_LABEL: Record<BoreholeRule, string> = {
		supplemental: 'Supplemental: after the dam and river',
		primary: 'Primary: first, the dam and river cover the rest',
		drought: 'Drought: supplemental while the dam is below the trigger'
	};
	const hints = $derived(damHints(node));
	// History's unit filter takes units (farms); another node's link filters by its name alone.
	const unit = $derived(node.kind === 'farm' ? node.id : null);
	/** The EWR site flag (engine ≥ 1.5.0): shown on a gauge, and on any node that has it off so it can be put right. */
	const showEwrSite = $derived(node.kind === 'gauge' || node.ewrSite === false);
	const ewrSiteProblem = $derived(ewrSiteIssue(node));
	/** The unit's MAP and its source (issue #482): checked as the API checks them, the problem under the field it is in. */
	const mapIssue = $derived(unitMapProblem(node));
	// Under its field it starts the sentence; the save bar puts the unit's name in front instead.
	const mapProblem = $derived(mapIssue ? `${mapIssue.message.charAt(0).toUpperCase()}${mapIssue.message.slice(1)}` : null);
	const mapOnSource = $derived(mapIssue?.field === 'source');
	/** River to dam set by month (engine ≥ 1.32.0): the one value is then inert. */
	const byMonth = $derived(node.divertMonthlyM3Day != null);
	/** River to dam's one value, read-only while it is set by month. */
	const divertByMonth = (f: NodeField) => f.key === 'divertCapacityM3Day' && byMonth; // gitleaks:allow (a field name, not a secret)
</script>

<div class="detail">
	<div class="ident">
		<div class="field">
			<label for={id('name')}>Name</label>
			<input id={id('name')} maxlength="100" readonly={readonly} bind:value={node.name} />
		</div>
		<div class="field">
			<span class="lbl"><label for={id('kind')}>Kind</label><HelpTip key="node.kind" /></span>
			<select id={id('kind')} disabled={readonly} bind:value={node.kind}>
				<option value={'farm' satisfies NodeKind}>Hydrological unit (farm, sub-catchment or stand-alone dam)</option>
				<option value={'gauge' satisfies NodeKind}>Gauge</option>
				<option value={'user' satisfies NodeKind}>Other water user (town, industry, unlisted)</option>
			</select>
		</div>
		<div class="field">
			<span class="lbl"><label for={id('down')}>Drains into</label><HelpTip key="node.downstreamNodeId" /></span>
			<select
				id={id('down')}
				disabled={readonly}
				value={node.downstreamNodeId ?? ''}
				onchange={(e) => (node.downstreamNodeId = e.currentTarget.value || null)}
			>
				<option value="">— Outlet (none) —</option>
				{#each nodes as other (other.id)}
					{#if other.id !== node.id}<option value={other.id}>{other.name || '(unnamed)'}</option>{/if}
				{/each}
			</select>
			<span class="hint">
				{node.downstreamNodeId === null
					? 'This is the outflow gauge: the catchment outlet where simulated outflow is compared with observed flow and the EWR.'
					: 'The hydrological unit directly downstream. Its outflow joins that unit’s upstream inflow.'}
			</span>
			<FieldHistoryLine field="node:{node.id}:downstreamNodeId" {unit} />
		</div>
	</div>

	{#if farmersNote}<p class="hint gauge-note" role="note">{farmersNote}</p>{/if}
	{#if mapHref}<p class="hint gauge-note"><a href={mapHref} data-testid="node-detail-map">Show on map</a>: the features linked to this hydrological unit on the catchment map.</p>{/if}
	{#if previewHref}<p class="hint gauge-note"><a href={previewHref}>Preview as farmer</a>: this hydrological unit’s page in the farmer view, as its farmer sees it, from the current publication.</p>{/if}
	{#if showEwrSite}
		<div class="field ewr-site">
			<label class="check">
				<input
					id={id('ewrSite')}
					type="checkbox"
					disabled={readonly || (node.downstreamNodeId === null && node.ewrSite !== false)}
					checked={node.ewrSite !== false}
					onchange={(e) => (node.ewrSite = e.currentTarget.checked)}
				/>
				EWR site
			</label>
			<HelpTip key="node.ewrSite" />
			<span class="hint">
				{node.downstreamNodeId === null
					? 'The outlet is always an EWR site.'
					: node.ewrSite === false
						? 'Measures flow only: its EWR shortfall is shown but charges nobody, and a Reserve rule table here is skipped.'
						: 'The EWR is assessed here: a shortfall is charged to the hydrological units upstream. Untick for a gauge that only records flow.'}
			</span>
			{#if ewrSiteProblem}<p class="problem" role="alert">{ewrSiteProblem.charAt(0).toUpperCase() + ewrSiteProblem.slice(1)}</p>{/if}
			<FieldHistoryLine field="node:{node.id}:ewrSite" {unit} />
		</div>
	{/if}
	{#if node.kind === 'gauge'}
		<p class="hint gauge-note">
			A gauge passes all upstream flow through; it has no dam, demand or flow share of its own.
		</p>
		<!-- A gauge takes no water: an abstraction start left from another kind is shown so it can be cleared (the save refuses it). -->
		{#if node.abstractionFrom}<DevelopmentFields {node} {readonly} part="abstraction" />{/if}
	{:else if node.kind === 'user'}
		<p class="hint gauge-note">
			An other water user takes its demand from the river where it sits, with no land, dam or crops of its own.
		</p>
		<fieldset>
			<legend>Other water user</legend>
			<UserFields {node} {readonly} />
			<DevelopmentFields {node} {readonly} part="abstraction" />
		</fieldset>
	{/if}

	{#each sections as sec (sec)}
		<fieldset id={sectionId(node.id, sec)} tabindex="-1">
			<legend>{SECTION_TITLE[sec]}</legend>
			{#if sec === 'damSurvey'}
				<!-- A dam's development fields (engine ≥ 1.30.0) also show on a node without a dam that still carries them, so they can be cleared. -->
				{#if hasDam(node)}<DamStorageFields {node} {readonly} />{/if}
				<DevelopmentFields {node} {readonly} part="dam" />
			{:else if sec === 'supply'}
				<SupplyFields {node} {nodes} {readonly} />
			{:else if sec === 'demand'}
				<!-- A unit's; one left on a node turned into a gauge or user is shown so it can be removed (the save refuses it). -->
				<DemandObjectFields {node} objects={demandObjects} {readonly} onadd={onadddemand} onremove={onremovedemand} />
			{:else if sec === 'boreholes'}
				<BoreholeFields {node} {boreholes} {readonly} onadd={onaddborehole} onremove={onremoveborehole} />
			{:else if sec === 'cover'}
				<LandCoverFields {node} patches={landCover} {readonly} onadd={onaddcover} onremove={onremovecover} />
			{:else}
				{@const g = sec as NodeField['group']}
				{@const fields = groupFields.get(g) ?? []}
				{#if g === 'reach'}
					<p class="hint section-note" data-testid="reach-note">
						Water lost into the river bed and banks between {node.name || 'this hydrological unit'} and the next one downstream: it leaves the catchment
						and doesn’t come back as baseflow. The next unit receives the outflow less the loss; senior water users downstream are still passed
						their demand in full. Leave it at 0 % unless the flow records show the river losing water here.
					</p>
				{/if}
				{#if g === 'groundwater'}
					<p class="hint section-note">
						One daily capacity for all of {node.name || 'this hydrological unit'}’s boreholes, under one rule: use it when only the total is known. List
						boreholes under Individual boreholes below when each has its own yield, annual cap or mode. If both are set, both run.
					</p>
				{/if}
				<div class="grid">
					{#each fields as f (f.key)}
						{@const unused = fieldUnused(f, node, method)}
						<div class="field">
							{#if f.derived && !ownEfficiency}
								<!-- Every crop here is on a system (engine ≥ 1.72.0): the efficiency is theirs blended, text, not an input. -->
								<span class="lbl"><label for={id(f.key)}>{f.label} <span class="u">({f.unit})</span></label><HelpTip key={`node.${f.key}`} /></span>
								<output id={id(f.key)} class="derived" aria-describedby="{id(f.key)}-h" data-testid="node-efficiency">{efficiency === null ? '–' : pctText(efficiency)}</output>
							{:else}
							<!-- A flow rate's unit is the select beside it, for everyone (display only); the label keeps it for a screen reader. -->
							<span class="lbl"
								><label for={id(f.key)}>{f.derived ? 'Efficiency for crops with no system' : f.label}{#if f.flowUnit}{' '}<span class="visually-hidden">({f.unit})</span>{:else}{' '}<span class="u">({f.unit})</span>{/if}</label>{#if f.flowUnit}<FlowUnitSelect unit={f.flowUnit} label="Unit of {f.label.toLowerCase()}" />{/if}<HelpTip key={`node.${f.key}`} /></span
							>
							<NumberInput
								id={id(f.key)}
								min={0}
								max={isPct(f) ? 100 : undefined}
								scale={fieldScale(f)}
								nullable={f.nullable}
								grouped={!isPct(f)}
								placeholder={f.nullable ? 'not set' : undefined}
								disabled={readonly || unused !== null || divertByMonth(f)}
								aria-describedby="{id(f.key)}-h"
								value={node[f.key] ?? null}
								onchange={(v) => setNodeField(node, f.key, v)}
							/>
							{/if}
							<span class="hint" id="{id(f.key)}-h"
								>{unused ?? (divertByMonth(f) ? 'Not used: River to dam is set by month below.' : f.help)}{#if f.derived && ownEfficiency && efficiency !== null && Math.abs(efficiency - (node.irrigationEfficiency ?? 0)) > 0.0005}{' '}With its crops' systems, a run uses {pctText(efficiency)}.{/if}</span
							>
							{#if f.key === 'returnFlowFraction' && efficiency !== null}
								{@const over = returnFlowHint(node.returnFlowFraction, efficiency)}
								{#if over}<span class="alert alert-warning small" role="status" data-testid="return-flow-over">{over}</span>{/if}
							{/if}
							<FieldHistoryLine field="node:{node.id}:{f.key}" {unit} />
						</div>
					{/each}
					{#if g === 'irrigation' && node.kind === 'farm'}
						<!-- Each crop's irrigation system on this unit (engine ≥ 1.72.0): set in its crops, so the efficiency above is theirs. -->
						<p class="hint systems-line" data-testid="node-systems">
							{#if systemsLine}Irrigation systems: {systemsLine}.{:else}No crops planted, so no irrigation system yet.{/if}
							{#if plantedHref}{' '}<a href={plantedHref}>Change them in its crops</a>.{/if}
						</p>
					{/if}
					{#if g === 'groundwater'}
						<div class="field">
							<span class="lbl"><label for={id('bh-rule')}>Borehole rule</label><HelpTip key="node.boreholeRule" /></span>
							<select id={id('bh-rule')} disabled={readonly} value={node.boreholeRule ?? 'supplemental'} onchange={(e) => (node.boreholeRule = e.currentTarget.value as BoreholeRule)}>
								{#each BOREHOLE_RULES as r (r)}<option value={r}>{BOREHOLE_RULE_LABEL[r]}</option>{/each}
							</select>
						</div>
						<div class="field">
							<span class="lbl"><label for={id('ga-rate')}>GN 538 rate <span class="u">(m³/ha/a)</span></label><HelpTip key="node.gaRateM3HaYear" /></span>
							<select
								id={id('ga-rate')}
								disabled={readonly}
								value={node.gaRateM3HaYear == null ? '' : String(node.gaRateM3HaYear)}
								aria-describedby="{id('ga-rate')}-h"
								onchange={(e) => (node.gaRateM3HaYear = e.currentTarget.value === '' ? null : Number(e.currentTarget.value))}
							>
								<option value="">Not looked up</option>
								{#each GA538_GROUNDWATER_RATES as r (r)}<option value={String(r)}>{r}</option>{/each}
							</select>
							<span class="hint" id="{id('ga-rate')}-h">
								The abstraction rate GN 538 Table 2 (Appendix B) lists for the property’s quaternary catchment. Property area × rate, at most 40 000 m³/a, is its
								general authorisation volume; without both the run shows the 40 000 ceiling.
							</span>
							<FieldHistoryLine field="node:{node.id}:gaRateM3HaYear" {unit} />
						</div>
					{/if}
					{#if g === 'area' && hiLo}
						<p class="hint dam-hint" role="note" data-testid="hilo-hint">{hiLo}</p>
					{/if}
					{#if g === 'area' && node.kind === 'farm'}
						<!-- The unit's own MAP (issue #482): with rain for each unit on, it sets the level of the unit's rain (docs/model.md §2.4h). -->
						<div class="field" data-testid="unit-map">
							<span class="lbl"><label for={id('mapMm')}>MAP <span class="u">(mm)</span></label><HelpTip key="unit-map" /></span>
							<NumberInput
								id={id('mapMm')}
								min={MAP_MM_MIN}
								max={MAP_MM_MAX}
								step={1}
								nullable
								grouped
								placeholder="not set"
								disabled={readonly}
								aria-invalid={(!!mapProblem && !mapOnSource) || undefined}
								aria-describedby="{id('mapMm')}-h{mapProblem && !mapOnSource ? ` ${id('map')}-err` : ''}"
								value={node.mapMm ?? null}
								onchange={(v) => withUnitMap(node, v)}
							/>
							<span class="hint" id="{id('mapMm')}-h">The unit’s own mean annual rain. Used only while Settings → Rain for each unit is on, where it sets the level of the unit’s rain. Empty: none.</span>
							{#if mapProblem && !mapOnSource}<p class="problem" id="{id('map')}-err">{mapProblem}</p>{/if}
							<FieldHistoryLine field="node:{node.id}:mapMm" {unit} />
						</div>
						{#if node.mapMm !== null && node.mapMm !== undefined}
							<div class="field">
								<span class="lbl"><label for={id('mapSource')}>Source of the MAP</label></span>
								<input
									id={id('mapSource')}
									readonly={readonly}
									required
									maxlength={PE_SOURCE_MAX}
									value={node.mapSource ?? ''}
									placeholder="e.g. a 1′ MAP grid averaged over the unit’s parcel"
									aria-invalid={mapOnSource || undefined}
									aria-describedby="{id('mapSource')}-h{mapOnSource ? ` ${id('map')}-err` : ''}"
									oninput={(e) => (node.mapSource = e.currentTarget.value)}
								/>
								<span class="hint" id="{id('mapSource')}-h">Required: the dataset or study, and its years. The run shows it beside the unit’s rain factor.</span>
								{#if mapOnSource}<p class="problem" id="{id('map')}-err">{mapProblem}</p>{/if}
								<FieldHistoryLine field="node:{node.id}:mapSource" {unit} />
							</div>
						{/if}
					{/if}
					{#if g === 'routing'}
						<RiverToDamFields {node} readonly={readonly || onRiverDam(node)} />
					{/if}
					{#if g === 'irrigation'}
						<DevelopmentFields {node} {readonly} part="abstraction" />
						{#if node.kind === 'farm' && (plantedHref || transfersHref)}
							<!-- Where the unit's demand and its transfers are set: Crops and Transfers, not this form. -->
							<p class="hint elsewhere" data-testid="node-elsewhere">
							Set elsewhere:{#if plantedHref}{' '}its crops, <a href={plantedHref} data-testid="node-planted-link">{planting?.planted ? `${fmtNum(planting.totalM2 / 10_000, 2)} ha planted, ${planting.planted} crop${planting.planted === 1 ? '' : 's'}` : 'nothing planted yet'}</a>{/if}{#if plantedHref && transfersHref};{/if}{#if transfersHref}{' '}its transfers, <a href={transfersHref} data-testid="node-transfers-link">{transfersLine ?? 'none yet'}</a>{/if}.
						</p>
						{/if}
					{/if}
					{#if g === 'dam'}
						{#each hints as h (h)}
							<p class="hint dam-hint" role="note">{h}</p>
						{/each}
					{/if}
					{#if g === 'share' && share !== null}
						<div class="field">
							<span class="label">Share in use <HelpTip key="flow-share" label="About the flow share in use" /></span>
							<span class="computed">{fmtPct(share, 2)}</span>
							<span class="hint">With the current flow-share method (<a href="?tab=settings#set-share">Settings &amp; calibration</a>). Saved settings only.</span>
						</div>
					{/if}
				</div>
			{/if}
		</fieldset>
	{/each}

	{#if !readonly}
		<div class="actions">
			{#if onmakeoutlet && node.downstreamNodeId !== null}
				<button type="button" class="btn" onclick={onmakeoutlet} title="This hydrological unit drains nowhere; the current outflow gauge drains into it">
					Make outflow gauge
				</button>
			{/if}
			<span class="spacer"></span>
			{#if onremove}
				<button type="button" class="btn btn-danger" onclick={onremove}>Remove {node.name || 'this hydrological unit'}</button>
			{/if}
		</div>
	{/if}
</div>

<style>
	.ident {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
		gap: 0 1rem;
	}
	.field :global(input),
	.field select {
		width: 100%;
	}
	/* The efficiency from the crops' systems: a value, not a field. */
	.field output.derived {
		display: block;
		padding: 0.3rem 0;
		font-weight: 600;
		font-variant-numeric: tabular-nums;
	}
	/* Each section is a card with its title in a tinted header band, so one
	   section's fields don't run into the next's. The legend floats so it sits
	   inside the card rather than on its border. The card itself stays
	   --surface: read-only inputs are --surface-2 and would vanish on it. */
	fieldset {
		border: 1px solid var(--border);
		border-radius: var(--radius);
		margin: 1rem 0 0;
		padding: 0 1rem 0.75rem;
		min-width: 0;
	}
	legend {
		float: left;
		width: calc(100% + 2rem);
		margin: 0 -1rem 0.75rem;
		padding: 0.55rem 1rem;
		background: var(--surface-2);
		border-bottom: 1px solid var(--border);
		border-radius: var(--radius) var(--radius) 0 0;
		font-weight: 600;
		font-size: 1rem;
	}
	legend + :global(*) {
		clear: both;
	}
	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
		gap: 0.5rem 1.25rem;
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
	/* Read-only values sit under their label rather than at the far right. */
	.detail :global(input:read-only) {
		text-align: left;
	}
	/* A section the sheet's jump row moved to: the focus ring on the whole card. */
	fieldset:focus-visible {
		outline: 2px solid var(--focus);
		outline-offset: 2px;
	}
	.section-note {
		margin: 0 0 0.5rem;
		font-size: 0.85rem;
	}
	.elsewhere {
		grid-column: 1 / -1;
		margin: 0 0 0.5rem;
		font-size: 0.85rem;
	}
	.computed {
		padding: 0.35rem 0;
		font-variant-numeric: tabular-nums;
		font-weight: 600;
	}
	.dam-hint {
		grid-column: 1 / -1;
		margin: 0 0 0.5rem;
		font-size: 0.85rem;
	}
	.ewr-site {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.25rem 0.5rem;
		margin: 0 0 0.5rem;
	}
	.ewr-site .hint,
	.ewr-site .problem {
		flex-basis: 100%;
	}
	.problem {
		margin: 0.25rem 0 0;
		font-size: 0.85rem;
		color: var(--danger);
	}
	.check {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		font-weight: 500;
		font-size: 0.9rem;
	}
	.gauge-note {
		margin: 0 0 0.5rem;
		font-size: 0.85rem;
		color: var(--text-muted);
	}
	.actions {
		margin-top: 0.75rem;
		padding-top: 0.75rem;
		border-top: 1px solid var(--border);
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}
	.spacer {
		flex: 1;
	}
	@media (max-width: 640px) {
		fieldset {
			padding: 0 0.75rem 0.5rem;
		}
		legend {
			width: calc(100% + 1.5rem);
			margin: 0 -0.75rem 0.75rem;
			padding: 0.55rem 0.75rem;
		}
		.actions .btn {
			min-height: 44px;
		}
	}
	@media (max-width: 640px) {
		.field :global(input),
		.field select {
			min-height: 44px;
		}
	}
</style>
