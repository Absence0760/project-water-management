<script lang="ts">
	// A unit's demand objects (engine ≥ 1.7.0, issue #54 item 2b, docs/model.md
	// §2.7f): a town, households, livestock or any demand that isn't a crop,
	// supplied from the unit's own dam, river pump and boreholes with its crops.
	// Each is a monthly m³/day or a count × litres per unit per day (grossed up
	// for losses, × a monthly profile), with a return share, a priority against
	// the crops, a destination and an on/off schedule by date
	// (DemandScheduleFields, engine ≥ 1.17.0). A domestic or municipal one has
	// a basic-needs floor of 25 l a person a day that a restriction never cuts
	// through (engine ≥ 1.38.0, issue #123): its people are a per-unit count, or
	// entered here. The objects are the editor's own, so edits land in the model directly.
	import {
		BASIC_NEEDS_CATEGORIES,
		DEMAND_NORMS,
		DEMAND_OBJECT_CATEGORIES,
		DEMAND_OBJECT_CATEGORY_LABEL,
		objectMonthlyM3Day,
		type DemandObject,
		type DemandObjectCategory,
		type DemandObjectDestination,
		type DemandObjectPriority,
		type NetworkNode
	} from '@water-management/engine';
	import NumberInput from '$lib/components/common/NumberInput.svelte';
	import DemandScheduleFields from './DemandScheduleFields.svelte';
	import HelpTip from '$lib/components/help/HelpTip.svelte';
	import { fmtNum } from '$lib/format/number';
	import MonthFields from './MonthFields.svelte';
	import { monthsOf } from './monthFields';
	import { floorLine, peopleHint } from './demandObjectFloor';

	let {
		node,
		objects,
		readonly,
		onadd,
		onremove
	}: {
		node: NetworkNode;
		/** This unit's demand objects (live editor objects). */
		objects: DemandObject[];
		readonly: boolean;
		onadd?: (category: DemandObjectCategory) => void;
		onremove?: (id: string) => void;
	} = $props();

	const PRIORITY_LABEL: Record<DemandObjectPriority, string> = {
		first: 'First: before the hydrological unit’s crops',
		shared: 'Shared: pro rata with the crops',
		last: 'Last: after the crops'
	};
	const DESTINATION_LABEL: Record<DemandObjectDestination, string> = {
		internal: 'Used in the catchment',
		external: 'Piped out of the catchment (nothing returns)'
	};
	/** What a per-unit object counts, by category. */
	const unitWord = (c: DemandObjectCategory) => (c === 'livestock' ? 'head' : c === 'domestic' || c === 'municipal' ? 'people' : 'units');
	const label = $derived(node.name || 'this hydrological unit');
	let newCategory = $state<DemandObjectCategory>('municipal');

	/** Its mean abstraction demand over the year, m³/day (the engine's own sizing). */
	const meanOf = (o: DemandObject) => objectMonthlyM3Day(o, []).reduce((s, v) => s + v, 0) / 12;

	function setSizing(o: DemandObject, sizing: DemandObject['sizing']) {
		o.sizing = sizing;
		if (sizing === 'monthly') o.monthlyM3Day ??= monthsOf(0);
		else {
			o.count ??= 0;
			o.litresPerUnitDay ??= o.category === 'livestock' ? DEMAND_NORMS.litresPerCattleDay : DEMAND_NORMS.litresPerPersonDay;
		}
	}
	function setDestination(o: DemandObject, d: DemandObjectDestination) {
		o.destination = d;
		// Nothing returns from water piped out (the save refuses a return share there).
		if (d === 'external') o.returnPct = 0;
	}
</script>

<div class="objects" data-testid="demand-objects-{node.id}">
	<p class="hint">
		Demands on {label} that aren’t crops: a town, households, livestock or water piped elsewhere. Each adds to the hydrological unit’s demand and is supplied from
		its dam, river pump and boreholes with the crops. <HelpTip key="demandObject.category" />
	</p>
	{#if objects.length === 0}
		<p class="muted small">No demand objects on {label}.</p>
	{:else}
		<ul class="list">
			{#each objects as o, i (o.id)}
				<li data-testid="demand-object-{o.id}">
					<div class="grid">
						<div class="field">
							<label for="do-name-{o.id}">Name</label>
							<input id="do-name-{o.id}" maxlength="200" readonly={readonly} bind:value={o.name} />
						</div>
						<div class="field">
							<label for="do-cat-{o.id}">Category</label>
							<select id="do-cat-{o.id}" disabled={readonly} value={o.category} onchange={(e) => (o.category = e.currentTarget.value as DemandObjectCategory)}>
								{#each DEMAND_OBJECT_CATEGORIES as c (c)}<option value={c}>{DEMAND_OBJECT_CATEGORY_LABEL[c]}</option>{/each}
							</select>
						</div>
						<div class="field">
							<label for="do-size-{o.id}">Demand given as</label>
							<select id="do-size-{o.id}" disabled={readonly} value={o.sizing} onchange={(e) => setSizing(o, e.currentTarget.value as DemandObject['sizing'])}>
								<option value="monthly">m³/day by month</option>
								<option value="perUnit">{unitWord(o.category)} × litres a day</option>
							</select>
						</div>
						<div class="field">
							<span class="lbl"><label for="do-pri-{o.id}">Priority</label><HelpTip key="demandObject.priority" /></span>
							<select id="do-pri-{o.id}" disabled={readonly} value={o.priority} onchange={(e) => (o.priority = e.currentTarget.value as DemandObjectPriority)}>
								{#each Object.entries(PRIORITY_LABEL) as [p, text] (p)}<option value={p}>{text}</option>{/each}
							</select>
						</div>
						<div class="field">
							<label for="do-dest-{o.id}">Destination</label>
							<select id="do-dest-{o.id}" disabled={readonly} value={o.destination} onchange={(e) => setDestination(o, e.currentTarget.value as DemandObjectDestination)}>
								{#each Object.entries(DESTINATION_LABEL) as [d, text] (d)}<option value={d}>{text}</option>{/each}
							</select>
						</div>
						<div class="field">
							<span class="lbl"><label for="do-ret-{o.id}">Share returned <span class="u">(%)</span></label><HelpTip key="demandObject.returnPct" /></span>
							<NumberInput id="do-ret-{o.id}" min={0} max={100} scale={100} disabled={readonly || o.destination === 'external'} value={o.returnPct} onchange={(v) => (o.returnPct = v ?? 0)} />
						</div>
						{#if o.sizing === 'perUnit'}
							<div class="field">
								<label for="do-count-{o.id}">Number of {unitWord(o.category)}</label>
								<NumberInput id="do-count-{o.id}" min={0} grouped disabled={readonly} value={o.count ?? 0} onchange={(v) => (o.count = v ?? 0)} />
							</div>
							<div class="field">
								<label for="do-lpd-{o.id}">Litres per {o.category === 'livestock' ? 'head' : o.category === 'domestic' || o.category === 'municipal' ? 'person' : 'unit'} a day</label>
								<NumberInput id="do-lpd-{o.id}" min={0} grouped disabled={readonly} value={o.litresPerUnitDay ?? 0} onchange={(v) => (o.litresPerUnitDay = v ?? 0)} />
							</div>
							<div class="field">
								<label for="do-loss-{o.id}">Distribution losses <span class="u">(%)</span></label>
								<NumberInput id="do-loss-{o.id}" min={0} max={99} scale={100} disabled={readonly} value={o.lossPct} onchange={(v) => (o.lossPct = v ?? 0)} />
							</div>
						{/if}
						{#if BASIC_NEEDS_CATEGORIES.includes(o.category)}
							<div class="field">
								<span class="lbl"><label for="do-pop-{o.id}">People served</label><HelpTip key="demandObject.population" /></span>
								<NumberInput
									id="do-pop-{o.id}"
									min={0}
									grouped
									nullable
									disabled={readonly}
									placeholder={o.sizing === 'perUnit' ? fmtNum(o.count ?? 0, 0) : 'none'}
									value={o.population ?? null}
									aria-describedby="do-pop-hint-{o.id}"
									onchange={(v) => (o.population = v)}
								/>
								<span class="muted small" id="do-pop-hint-{o.id}">{peopleHint(o)}</span>
							</div>
						{/if}
						<div class="field check">
							<label><input type="checkbox" disabled={readonly} bind:checked={o.enabled} /> Modelled</label>
						</div>
					</div>
					{#if o.sizing === 'monthly'}
						<MonthFields
							values={o.monthlyM3Day}
							label={(m) => `Demand of ${o.name} in ${m}, m³/day`}
							caption="Demand, m³/day, per month"
							fillLabel="Use October’s demand for every month"
							{readonly}
							onchange={(next) => (o.monthlyM3Day = next)}
						/>
					{:else}
						<MonthFields
							values={o.monthlyFactor}
							label={(m) => `Profile of ${o.name} in ${m}`}
							caption="Monthly profile (× the daily use; blank = 1)"
							blank={1}
							grouped={false}
							{readonly}
							onchange={(next) => (o.monthlyFactor = next)}
						/>
					{/if}
					<DemandScheduleFields object={o} {readonly} />
					<div class="field">
						<label for="do-note-{o.id}">Where the number comes from</label>
						<input id="do-note-{o.id}" maxlength="1000" placeholder="e.g. meter records, a reconciliation strategy, a per-person norm" readonly={readonly} bind:value={o.note} />
					</div>
					<p class="muted small" data-testid="demand-object-mean-{o.id}">
						{fmtNum(meanOf(o), 0)} m³/day on average{o.enabled ? '' : ' (not modelled)'}.
					</p>
					{#if floorLine(o)}
						<p class="muted small" data-testid="demand-object-floor-{o.id}">{floorLine(o)}</p>
					{/if}
					{#if !readonly}
						<div class="row-actions">
							{#if onremove}<button type="button" class="btn btn-sm" onclick={() => onremove(o.id)}>Remove demand object {i + 1}</button>{/if}
						</div>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}
	{#if !readonly && onadd && node.kind === 'farm'}
		<div class="add">
			<label for="do-new-{node.id}" class="visually-hidden">Category of the new demand object</label>
			<select id="do-new-{node.id}" bind:value={newCategory}>
				{#each DEMAND_OBJECT_CATEGORIES as c (c)}<option value={c}>{DEMAND_OBJECT_CATEGORY_LABEL[c]}</option>{/each}
			</select>
			<button type="button" class="btn" onclick={() => onadd(newCategory)}>+ Add demand</button>
		</div>
	{/if}
</div>

<style>
	.list {
		list-style: none;
		padding: 0;
		margin: 0 0 0.5rem;
	}
	.list li {
		border-top: 1px solid var(--border);
		padding: 0.5rem 0;
	}
	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
		gap: 0 1rem;
		align-items: end;
	}
	.field :global(input:not([type='checkbox'])),
	.field select {
		width: 100%;
	}
	.lbl {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
	}
	.field label {
		font-weight: 500;
		font-size: 0.85rem;
		color: var(--text-2);
	}
	.row-actions,
	.add {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		align-items: center;
	}
	@media (max-width: 640px) {
		.field :global(input),
		.field select,
		.add select,
		.btn {
			min-height: 44px;
		}
	}
</style>
