<script lang="ts">
	// One node's fields as a labelled form with help text — the small-screen
	// (and "focus on one node") alternative to the wide network table.
	import { BOREHOLE_RULES, GA538_GROUNDWATER_RATES, IRRIGATION_SYSTEMS, type Borehole, type DemandObject, type DemandObjectCategory, type BoreholeRule, type LandCoverPatch, type NetworkNode, type NodeKind } from '@water-management/engine';
	import NumberInput from '$lib/components/common/NumberInput.svelte';
	import HelpTip from '$lib/components/help/HelpTip.svelte';
	import { fmtPct } from '$lib/format/number';
	import { damHints, GROUPS, hasDam, hasDamDevelopment, isPct, NODE_FIELDS, setNodeField, systemOf, type NodeField } from './fields';
	import DamStorageFields from './DamStorageFields.svelte';
	import DevelopmentFields from './DevelopmentFields.svelte';
	import UserFields from './UserFields.svelte';
	import LandCoverFields from './LandCoverFields.svelte';
	import BoreholeFields from './BoreholeFields.svelte';
	import DemandObjectFields from './DemandObjectFields.svelte';
	import SupplyFields from './SupplyFields.svelte';
	import RiverToDamFields from './RiverToDamFields.svelte';
	import FieldHistoryLine from '$lib/components/history/FieldHistoryLine.svelte';
	import { hasSupplySettings } from './supply';
	import { ewrSiteIssue } from '$lib/model/validate';

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
		mapHref = null
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
	} = $props();

	const groups = $derived.by(() => {
		const out = new Map<NodeField['group'], NodeField[]>();
		for (const f of NODE_FIELDS) {
			if (f.farmOnly && node.kind !== 'farm') continue;
			if (f.notGauge && node.kind === 'gauge') continue;
			// An other water user has no land, dam or routing of its own (WP-1.33), but may have boreholes (WP-1.34).
			if (node.kind === 'user' && f.group !== 'groundwater') continue;
			if (!out.has(f.group)) out.set(f.group, []);
			out.get(f.group)!.push(f);
		}
		return [...out];
	});
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
	/** River to dam set by month (engine ≥ 1.32.0): the one value is then inert. */
	const byMonth = $derived(node.divertMonthlyM3Day != null);
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
					: 'The node directly downstream. Its outflow joins that node’s upstream inflow.'}
			</span>
			<FieldHistoryLine field="node:{node.id}:downstreamNodeId" {unit} />
		</div>
	</div>

	{#if farmersNote}<p class="hint gauge-note" role="note">{farmersNote}</p>{/if}
	{#if mapHref}<p class="hint gauge-note"><a href={mapHref} data-testid="node-detail-map">Show on map</a>: the features linked to this node on the catchment map.</p>{/if}
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

	{#each groups as [g, fields] (g)}
		<fieldset>
			<legend>{GROUPS[g]}</legend>
			<div class="grid">
				{#each fields as f (f.key)}
					<div class="field">
						<span class="lbl"><label for={id(f.key)}>{f.label} <span class="u">({f.unit})</span></label><HelpTip key={`node.${f.key}`} /></span>
						<NumberInput
							id={id(f.key)}
							min={0}
							max={isPct(f) ? 100 : undefined}
							scale={isPct(f) ? 100 : 1}
							nullable={f.nullable}
							grouped={!isPct(f)}
							placeholder={f.nullable ? 'not set' : undefined}
							disabled={readonly || (f.key === 'divertCapacityM3Day' && byMonth)}
							aria-describedby="{id(f.key)}-h"
							value={node[f.key] ?? null}
							onchange={(v) => setNodeField(node, f.key, v)}
						/>
						<span class="hint" id="{id(f.key)}-h">{f.key === 'divertCapacityM3Day' && byMonth ? 'Not used: River to dam is set by month below.' : f.help}</span>
						<FieldHistoryLine field="node:{node.id}:{f.key}" {unit} />
					</div>
				{/each}
				{#if g === 'irrigation'}
					<div class="field">
						<span class="lbl"><label for={id('system')}>Irrigation system</label><HelpTip key="node.irrigationEfficiency" /></span>
						<select
							id={id('system')}
							disabled={readonly}
							value={systemOf(node.irrigationEfficiency) ?? ''}
							aria-describedby="{id('system')}-h"
							onchange={(e) => {
								const s = IRRIGATION_SYSTEMS.find((x) => x.id === e.currentTarget.value);
								if (s) node.irrigationEfficiency = s.efficiency;
							}}
						>
							<option value="">Other (efficiency as entered)</option>
							{#each IRRIGATION_SYSTEMS as s (s.id)}
								<option value={s.id}>{s.label}: {Math.round(s.efficiency * 100)} % (indicative)</option>
							{/each}
						</select>
						<span class="hint" id="{id('system')}-h">Sets an indicative efficiency for the system; a scheme's own measurement is better.</span>
					</div>
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
				{#if g === 'routing'}
					<RiverToDamFields {node} {readonly} />
				{/if}
				{#if g === 'irrigation'}
					<DevelopmentFields {node} {readonly} part="abstraction" />
				{/if}
				{#if g === 'dam'}
					{#each hints as h (h)}
						<p class="hint dam-hint" role="note">{h}</p>
					{/each}
				{/if}
				{#if g === 'share' && share !== null}
					<div class="field">
						<span class="label">Share in use</span>
						<span class="computed">{fmtPct(share, 2)}</span>
						<span class="hint">With the current flow-share method. Saved settings only.</span>
					</div>
				{/if}
			</div>
		</fieldset>
	{/each}

	<!-- A farm's; a farm turned into a gauge or user keeps its settings, shown so they can be reset (WP-3.8). -->
	<!-- A unit's; one left on a node turned into a gauge or user is shown so it can be removed (the save refuses it). -->
	{#if node.kind === 'farm' || demandObjects.length}
		<fieldset>
			<legend>Demand objects</legend>
			<DemandObjectFields {node} objects={demandObjects} {readonly} onadd={onadddemand} onremove={onremovedemand} />
		</fieldset>
	{/if}

	{#if node.kind === 'farm' || hasSupplySettings(node)}
		<fieldset>
			<legend>Supply</legend>
			<SupplyFields {node} {readonly} />
		</fieldset>
	{/if}

	<!-- A dam's development fields (engine ≥ 1.30.0) also show on a node without a dam that still carries them, so they can be cleared. -->
	{#if hasDam(node) || hasDamDevelopment(node)}
		<fieldset>
			<legend>Dam survey and releases</legend>
			{#if hasDam(node)}<DamStorageFields {node} {readonly} />{/if}
			<DevelopmentFields {node} {readonly} part="dam" />
		</fieldset>
	{/if}

	{#if node.kind !== 'gauge'}
		<fieldset>
			<legend>Individual boreholes</legend>
			<BoreholeFields {node} {boreholes} {readonly} onadd={onaddborehole} onremove={onremoveborehole} />
		</fieldset>
	{/if}

	{#if node.kind === 'farm'}
		<fieldset>
			<legend>Land cover</legend>
			<LandCoverFields {node} patches={landCover} {readonly} onadd={onaddcover} onremove={onremovecover} />
		</fieldset>
	{/if}

	{#if !readonly}
		<div class="actions">
			{#if onmakeoutlet && node.downstreamNodeId !== null}
				<button type="button" class="btn" onclick={onmakeoutlet} title="This node drains nowhere; the current outflow gauge drains into it">
					Make outflow gauge
				</button>
			{/if}
			<span class="spacer"></span>
			{#if onremove}
				<button type="button" class="btn btn-danger" onclick={onremove}>Remove {node.name || 'this node'}</button>
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
