<script lang="ts">
	// A unit's demand objects (engine ≥ 1.7.0, issue #54 item 2b, docs/model.md
	// §2.7f): a town, households, livestock or any demand that isn't a crop,
	// supplied from the unit's own dam, river pump and boreholes with its crops.
	// Each is a monthly m³/day or a count × litres per unit per day (grossed up
	// for losses, × a monthly profile), with a return share, a priority against
	// the crops (with two or more objects, the unit's numbered supply order,
	// engine ≥ 1.64.0, issue #343, demandObjectOrder.ts), a destination and an
	// on/off schedule by date
	// (DemandScheduleFields, engine ≥ 1.17.0). A domestic or municipal one has
	// a basic-needs floor of 25 l a person a day that a restriction never cuts
	// through (engine ≥ 1.44.0, issue #123): its people are a per-unit count, or
	// entered here. Where its number comes from is a source by rule (engine ≥
	// 1.56.0, issue #54 Q11), which sets how the demand is given
	// (demandObjectSource.ts), with the note for the detail. Its water comes
	// from the dam side under the unit's supply rule, or from a river
	// abstraction of its own with its own pump and pool (WaterSourceFields,
	// engine ≥ 1.65.0, issue #344). The objects are the editor's own, so edits
	// land in the model directly.
	import { tick } from 'svelte';
	import {
		BASIC_NEEDS_CATEGORIES,
		DEMAND_OBJECT_CATEGORIES,
		DEMAND_OBJECT_CATEGORY_LABEL,
		DEMAND_OBJECT_SOURCES,
		SUPPLY_RULE_LABEL,
		objectMonthlyM3Day,
		supplyOrder,
		type DemandObject,
		type DemandObjectCategory,
		type DemandObjectDestination,
		type DemandObjectPriority,
		type DemandObjectSource,
		type NetworkNode
	} from '@water-management/engine';
	import NumberInput from '$lib/components/common/NumberInput.svelte';
	import { confirmDialog } from '$lib/components/common/confirm.svelte';
	import { hasDam } from './fields';
	import { demandObjectQuestion, focusAfter, itemName } from './removeQuestions';
	import DemandScheduleFields from './DemandScheduleFields.svelte';
	import WaterSourceFields from './WaterSourceFields.svelte';
	import HelpTip from '$lib/components/help/HelpTip.svelte';
	import { fmtNum } from '$lib/format/number';
	import MonthFields from './MonthFields.svelte';
	import { floorLine, peopleHint } from './demandObjectFloor';
	import { setSizing, setSource, sizingFixedBy, SOURCE_OPTION_LABEL } from './demandObjectSource';
	import { orderRows, positionChoices, PRIORITY_OPTION_LABEL, setPriority, setSupplyPosition, showsSupplyOrder, supplyOrderText } from './demandObjectOrder';

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

	const DESTINATION_LABEL: Record<DemandObjectDestination, string> = {
		internal: 'Used in the catchment',
		external: 'Piped out of the catchment (nothing returns)'
	};
	/** What a per-unit object counts, by category. */
	const unitWord = (c: DemandObjectCategory) => (c === 'livestock' ? 'head' : c === 'domestic' || c === 'municipal' ? 'people' : 'units');
	const label = $derived(node.name || 'this hydrological unit');
	let newCategory = $state<DemandObjectCategory>('municipal');

	/** The unit's numbered supply order (two or more objects): each object's position and the crops'. */
	const ordered = $derived(showsSupplyOrder(objects));
	/** How many places the order has now (the crops' among them). */
	const levels = $derived.by(() => {
		const { positions, crops } = supplyOrder(objects);
		return Math.max(crops, ...positions);
	});

	/** Its mean abstraction demand over the year, m³/day (the engine's own sizing). */
	const meanOf = (o: DemandObject) => objectMonthlyM3Day(o, []).reduce((s, v) => s + v, 0) / 12;

	/** "Town A", or "demand 2" while it has no name: in its month fields' names and its water source's. */
	const whoOf = (o: DemandObject, i: number) => o.name.trim() || `demand ${i + 1}`;
	let addBtn: HTMLButtonElement | undefined = $state();

	/** Asks first when the object holds a demand, a schedule or a note, then puts the focus on the next one (or the add row). */
	async function remove(o: DemandObject, i: number) {
		const q = demandObjectQuestion(o, i);
		if (q && !(await confirmDialog(q))) return;
		const at = focusAfter(i, objects.length);
		const nextId = at === null ? null : objects.filter((x) => x.id !== o.id)[at]?.id;
		onremove?.(o.id);
		await tick();
		(nextId ? document.getElementById(`do-name-${nextId}`) : addBtn)?.focus();
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
		its dam, river pump and boreholes with the crops, or from a river abstraction of its own. <HelpTip key="demandObject.category" />
	</p>
	{#if objects.length === 0}
		<p class="muted small">No demand objects on {label}.</p>
	{:else}
		{#if ordered}
			<fieldset class="order" data-testid="supply-order-{node.id}">
				<legend><span class="lbl">Supply order on a short day<HelpTip key="demandObject.priority" /></span></legend>
				<p class="muted small">
					1 is supplied first; demands at one number share pro rata. Pick “between” to put one in a place of its own. The order holds among the demands on one water source: the
					unit’s own supply ({hasDam(node) ? 'its dam, river pump and boreholes' : 'its river pump and boreholes'}) serves its demands first, and the river abstractions
					share what passes it, each in this order.
				</p>
				<ol class="order-list">
					{#each orderRows(objects) as row (row.which)}
						{@const id = row.which === 'crops' ? `do-order-crops-${node.id}` : `do-order-${objects[row.which]!.id}`}
						<li>
							<label for={id}>{row.which === 'crops' ? 'The crops' : objects[row.which]!.name || 'Unnamed demand'}</label>
							<select
								{id}
								disabled={readonly}
								value={String(row.position)}
								aria-describedby="supply-order-text-{node.id}"
								onchange={(e) => {
									setSupplyPosition(objects, row.which, Number(e.currentTarget.value));
									// Show what was kept, even when the choice changed nothing.
									e.currentTarget.value = String(orderRows(objects).find((r) => r.which === row.which)!.position);
								}}
							>
								{#each positionChoices(levels) as c (c.value)}<option value={String(c.value)}>{c.label}</option>{/each}
							</select>
						</li>
					{/each}
				</ol>
				<p class="muted small" id="supply-order-text-{node.id}" data-testid="supply-order-text-{node.id}" aria-live="polite">Order: {supplyOrderText(objects)}.</p>
			</fieldset>
		{/if}
		<ul class="list">
			{#each objects as o, i (o.id)}
				<li data-testid="demand-object-{o.id}">
					<fieldset class="obj">
					<legend>Demand object {i + 1}{o.name.trim() ? `: ${o.name.trim()}` : ''}</legend>
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
							<span class="lbl"><label for="do-src-{o.id}">Source of the number</label><HelpTip key="demandObject.source" /></span>
							<select
								id="do-src-{o.id}"
								disabled={readonly}
								value={o.source ?? ''}
								onchange={(e) => setSource(o, (e.currentTarget.value || null) as DemandObjectSource | null)}
							>
								<option value="">Not recorded</option>
								{#each DEMAND_OBJECT_SOURCES as src (src)}<option value={src}>{SOURCE_OPTION_LABEL[src]}</option>{/each}
							</select>
						</div>
						<div class="field">
							<label for="do-size-{o.id}">Demand given as</label>
							<select
								id="do-size-{o.id}"
								disabled={readonly || sizingFixedBy(o) !== null}
								value={o.sizing}
								aria-describedby={sizingFixedBy(o) ? `do-size-hint-${o.id}` : undefined}
								onchange={(e) => setSizing(o, e.currentTarget.value as DemandObject['sizing'])}
							>
								<option value="monthly">m³/day by month</option>
								<option value="perUnit">{unitWord(o.category)} × litres a day</option>
							</select>
							{#if sizingFixedBy(o)}<span class="muted small" id="do-size-hint-{o.id}">Set by the source.</span>{/if}
						</div>
						{#if !ordered}
							<div class="field">
								<span class="lbl"><label for="do-pri-{o.id}">Priority</label><HelpTip key="demandObject.priority" /></span>
								<select id="do-pri-{o.id}" disabled={readonly} value={o.priority} onchange={(e) => setPriority(o, e.currentTarget.value as DemandObjectPriority)}>
									{#each Object.entries(PRIORITY_OPTION_LABEL) as [p, text] (p)}<option value={p}>{text}</option>{/each}
								</select>
							</div>
						{/if}
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
								<span class="lbl"><label for="do-loss-{o.id}">Distribution losses <span class="u">(%)</span></label><HelpTip key="demand-object" label="About demand objects: sizing and losses" /></span>
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
						<WaterSourceFields
							idBase="ws-{o.id}"
							who={whoOf(o, i)}
							helpKey="demandObject.waterSource"
							rule={SUPPLY_RULE_LABEL[node.supplyRule ?? 'damFirst']}
							source={o.waterSource}
							pump={o.riverPumpM3Day}
							pool={o.riverPoolM3}
							{readonly}
							onsource={(v) => (o.waterSource = v)}
							onpump={(v) => (o.riverPumpM3Day = v)}
							onpool={(v) => (o.riverPoolM3 = v)}
						/>
						<div class="field check">
							<label><input type="checkbox" disabled={readonly} bind:checked={o.enabled} aria-describedby="do-on-hint-{o.id}" /> Modelled</label>
							<span class="muted small" id="do-on-hint-{o.id}">Untick to keep it on record without running it.</span>
						</div>
					</div>
					{#if o.sizing === 'monthly'}
						<MonthFields
							values={o.monthlyM3Day}
							label={(m) => `Demand of ${whoOf(o, i)} in ${m}, m³/day`}
							caption="Demand, m³/day, per month"
							fillLabel="Use October’s demand for every month"
							{readonly}
							onchange={(next) => (o.monthlyM3Day = next)}
						/>
					{:else}
						<MonthFields
							values={o.monthlyFactor}
							label={(m) => `Profile of ${whoOf(o, i)} in ${m}`}
							caption="Monthly profile (× the daily use; blank = 1)"
							blank={1}
							grouped={false}
							{readonly}
							onchange={(next) => (o.monthlyFactor = next)}
						/>
					{/if}
					<DemandScheduleFields object={o} {readonly} />
					<div class="field">
						<label for="do-note-{o.id}">Source details</label>
						<input id="do-note-{o.id}" maxlength="1000" placeholder="e.g. which meter and years, which strategy, which norm" readonly={readonly} bind:value={o.note} />
					</div>
					<p class="muted small" data-testid="demand-object-mean-{o.id}">
						{fmtNum(meanOf(o), 0)} m³/day on average{o.enabled ? '' : ' (not modelled)'}.
					</p>
					{#if floorLine(o)}
						<p class="muted small" data-testid="demand-object-floor-{o.id}">{floorLine(o)}</p>
					{/if}
					{#if !readonly}
						<div class="row-actions">
							{#if onremove}<button type="button" class="btn btn-sm" onclick={() => remove(o, i)}>Remove {itemName(o.name, 'demand object', i)}</button>{/if}
						</div>
					{/if}
					</fieldset>
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
			<button type="button" class="btn" onclick={() => onadd(newCategory)} bind:this={addBtn}>+ Add demand</button>
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
		padding: 0.5rem 0 0;
	}
	/* Each object a small card titled by its name, so its fields read as its own. */
	.obj {
		border: 1px solid var(--border);
		border-radius: var(--radius);
		margin: 0;
		padding: 0 0.75rem 0.5rem;
		min-width: 0;
	}
	.obj > legend {
		float: left;
		width: calc(100% + 1.5rem);
		margin: 0 -0.75rem 0.5rem;
		padding: 0.35rem 0.75rem;
		background: var(--surface-2);
		border-bottom: 1px solid var(--border);
		border-radius: var(--radius) var(--radius) 0 0;
		font-weight: 600;
		font-size: 0.9rem;
		overflow-wrap: anywhere;
	}
	.obj > legend + * {
		clear: both;
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
	.order {
		border: 1px solid var(--border);
		border-radius: 6px;
		padding: 0.5rem 0.75rem;
		margin: 0 0 0.75rem;
	}
	.order legend {
		font-weight: 500;
		font-size: 0.85rem;
		color: var(--text-2);
	}
	.order-list {
		list-style: none;
		padding: 0;
		margin: 0.25rem 0;
		display: grid;
		gap: 0.25rem;
	}
	.order-list li {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(8rem, 12rem);
		gap: 0.5rem;
		align-items: center;
	}
	.order-list label {
		overflow-wrap: anywhere;
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
		.order-list select,
		.btn {
			min-height: 44px;
		}
	}
</style>
