<!--
	Parameters from (issue #659 option 2, "similar units"; docs/model.md §2.10n, docs/ui.md § Settings & calibration):
	inside Calibration → Calibration record's locations, every land unit with the location whose GR4J parameters it
	runs on, and a choice to give it another ticked location's: a unit on another tributary that is like a gauged
	zone takes that gauge's parameters. Bind `assignments` (settings.unitParamsFrom; null = every unit its own zone).
	What each unit runs on and the fit's refusal (a borrowing cycle, a location left with no unit draining through it)
	are the engine's own (calibration/unitParams.ts), live as the choices change; `error` is that refusal. A save isn't
	refused for it (a run doesn't need a fit), Fit automatically is. Folded to its values while every unit takes its
	own zone's. Nothing while no location is ticked: the page says every unit runs on the catchment parameters.
-->
<script lang="ts">
	import type { NetworkNode } from '@water-management/engine';
	import Fold from '#lib/components/common/Fold.svelte';
	import HelpTip from '#lib/components/help/HelpTip.svelte';
	import { unitParamsLine, unitParamsPlanError, unitParamsRows, withUnitParamsFrom, type UnitParamsSettings } from '#lib/calibration/unitParams.js';

	let {
		assignments = $bindable(),
		error = $bindable(null),
		nodes,
		settings,
		readonly
	}: {
		/** settings.unitParamsFrom: land unit node id → the location's node id (a gauge's, or the outlet's). */
		assignments: Record<string, string> | null | undefined;
		/** Why Fit automatically would refuse these choices; null when it would fit. */
		error?: string | null;
		/** The model's nodes as they are now. */
		nodes: readonly NetworkNode[];
		/** The form's settings (the locations ticked, the outlet's tick, the rest rule). */
		settings: UnitParamsSettings;
		readonly: boolean;
	} = $props();

	const uid = $props.id();
	const rows = $derived(unitParamsRows(nodes, settings, assignments));
	const plan = $derived(unitParamsPlanError(nodes, settings, assignments));
	$effect(() => {
		error = plan;
	});
	const set = (unitId: string, target: string) => (assignments = withUnitParamsFrom(assignments, unitId, target || null));
	const anyStale = $derived(rows.some((r) => r.stale));
</script>

<!-- The live region is always in the page, so a refusal is read out as it appears, the first time too. -->
<div role="status" class="plan-status">
	{#if rows.length && plan}<div class="alert alert-warning" data-testid="unit-params-error">{plan}</div>{/if}
</div>
{#if rows.length}
	<fieldset class="plain unit-params" id="fld-unit-params" data-testid="unit-params" aria-describedby="{uid}-h">
		<legend class="label">Parameters from <HelpTip key="calibration-zones" label="About where a unit’s parameters come from" /></legend>
		<p class="hint explain" id="{uid}-h">
			A unit runs on the parameters of the first ticked location downstream. A unit on a river with no gauge of its own can take a similar gauged
			location’s parameters instead; that location’s fit then sets them for both.
		</p>
		<Fold line={unitParamsLine(rows)} change="Choose per unit" atDefaults={!rows.some((r) => r.value !== '') && !plan} {readonly} body="none" testid="unit-params-fold">
			<div class="table-wrap">
				<table class="data compact">
					<caption class="visually-hidden">Each land unit and the calibration location whose parameters it runs on</caption>
					<thead>
						<tr>
							<th scope="col">Hydrological unit</th>
							<th scope="col">Parameters from</th>
						</tr>
					</thead>
					<tbody>
						{#each rows as r (r.unitId)}
							<tr data-testid="unit-params-row" data-node={r.unitId}>
								<th scope="row">{r.name}</th>
								<td>
									<select
										aria-label="Parameters from: {r.name}"
										disabled={readonly}
										value={r.value}
										aria-invalid={r.stale || undefined}
										aria-describedby="{uid}-{r.unitId}-runs{r.stale ? ` ${uid}-stale` : ''}"
										onchange={(e) => set(r.unitId, e.currentTarget.value)}
									>
										{#each r.options as o (o.value)}<option value={o.value}>{o.label}</option>{/each}
									</select>
									<!-- What it runs on now, under its choice (two columns fit a phone). -->
									<span class="runs-on" id="{uid}-{r.unitId}-runs" data-testid="unit-params-runs-on">Runs on: {r.runsOn}</span>
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
			{#if anyStale}
				<p class="hint" id="{uid}-stale">
					A choice that reads “(not a ticked location)” needs changing: until then that unit takes its own zone’s parameters.
				</p>
			{/if}
		</Fold>
	</fieldset>
{/if}

<style>
	.unit-params {
		margin-top: 0.75rem;
	}
	.runs-on {
		display: block;
		margin-top: 0.15rem;
		color: var(--text-2);
		font-size: var(--font-sm);
	}
	select {
		width: 100%;
		max-width: 24rem;
	}
</style>
