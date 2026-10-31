<!--
	The areal rainfall correction's "from a MAP" helper (docs/model.md §2.4g, docs/ui.md § Calibration settings):
	reads the rain the correction scales as a run would (arealForcing.ts: the project's model input with the form's
	unsaved settings, prepared by the engine), divides an entered catchment MAP by its mean annual rain over its
	complete water years (engine arealFactorFromMap), and shows the factor, the years and the source note before
	anything changes. Use fills the factor in every month, Independent MAP and the note (arealFromMap.ts); it stores
	nothing itself, and the save bar saves it with the rest. Editors only: ArealRainBody leaves it out read-only.
-->
<script lang="ts">
	import type { ProjectModel, ProjectSettings } from '@water-management/engine';
	import Fold from '#lib/components/common/Fold.svelte';
	import NumberInput from '#lib/components/common/NumberInput.svelte';
	import { arealMapBlocker, proposeArealFromMap, waterYearsSpan, withArealMapProposal, type ArealForcing } from './arealFromMap';
	import type { ArealForcingRead } from './arealForcing';
	import type { EditableArealRain } from './arealRain';

	let {
		projectId,
		settings,
		model,
		current,
		onapply
	}: {
		projectId: string;
		/** The form's settings now, unsaved edits included: the forcing is read as a run with them would read it. */
		settings: () => ProjectSettings;
		/** The model being edited, when it has unsaved edits. */
		model?: () => ProjectModel | undefined;
		/** The correction as the form holds it. */
		current: EditableArealRain;
		onapply: (next: EditableArealRain) => void;
	} = $props();

	const uid = $props.id();
	let mapMm = $state<number | null>(null);
	let reference = $state('');
	let forcing = $state<ArealForcing | null>(null);
	let problem = $state<string | null>(null);
	let reading = $state(false);

	const proposal = $derived(forcing ? proposeArealFromMap(mapMm, reference, forcing) : null);
	const blocker = $derived(arealMapBlocker(proposal, reference));

	async function read() {
		if (reading) return;
		reading = true;
		problem = null;
		try {
			const { readArealForcing } = await import('./arealForcing');
			const r: ArealForcingRead = await readArealForcing(projectId, settings(), model?.());
			if (r.ok) forcing = { startDate: r.startDate, rainMm: r.rainMm };
			else {
				forcing = null;
				problem = r.problem;
			}
		} catch (e) {
			forcing = null;
			problem = `The rain couldn’t be read: ${e instanceof Error ? e.message : String(e)}`;
		} finally {
			reading = false;
		}
	}

	function apply() {
		if (proposal?.ok && !blocker) onapply(withArealMapProposal(current, proposal));
	}
</script>

<Fold name="Work it out from a MAP:" line="the catchment’s MAP ÷ the rain GR4J runs on" change="Open" body="none" testid="areal-map-helper">
	<div class="body">
		<p class="hint explain">
			Reads the rain a run with these settings would give GR4J before the correction (catchment rain, else corrected CHIRPS), and divides an
			independent MAP by its mean over the complete water years. Nothing changes until you press Use.
		</p>
		<div class="row">
			<div class="field">
				<label for="{uid}-map">Catchment MAP <span class="u">(mm)</span></label>
				<NumberInput id="{uid}-map" nullable min={1} max={5000} step={1} bind:value={mapMm} aria-describedby="{uid}-map-h" />
				<span class="hint explain" id="{uid}-map-h">WR2012 quaternary MAP, or an isohyetal or gridded MAP averaged over the catchment.</span>
			</div>
			<div class="field grow">
				<label for="{uid}-ref">Where the MAP comes from</label>
				<input
					id="{uid}-ref"
					maxlength="300"
					required
					placeholder="e.g. WR2012, quaternary G10A"
					value={reference}
					aria-describedby="{uid}-ref-h"
					oninput={(e) => (reference = e.currentTarget.value)}
				/>
				<span class="hint" id="{uid}-ref-h">Required: it goes into the source note.</span>
			</div>
		</div>
		<div class="row">
			<button type="button" class="btn btn-sm" aria-disabled={reading} onclick={read} data-testid="areal-map-read">
				{reading ? 'Reading the rain…' : forcing ? 'Read the rain again' : 'Read the rain'}
			</button>
			{#if problem}<span class="err" role="alert" data-testid="areal-map-problem">{problem}</span>{/if}
		</div>
		{#if forcing && proposal}
			<div class="result" role="status" data-testid="areal-map-result">
				{#if proposal.ok}
					<p>
						The rain averages <strong>{Math.round(proposal.meanAnnualMm)} mm</strong> a year over {waterYearsSpan(proposal.waterYears)}:
						{mapMm} ÷ {Math.round(proposal.meanAnnualMm)} = <strong data-testid="areal-map-factor">× {proposal.factor.toFixed(3)}</strong> in every month.
					</p>
					{#if proposal.outsideBand}
						<p class="warn" data-testid="areal-map-band">Outside 0.5–2: every run will warn. Check the MAP and the rain’s units before using it.</p>
					{/if}
					<p class="note"><span class="label">Source note:</span> <span data-testid="areal-map-note">{proposal.note}</span></p>
				{:else}
					<p class="err">{proposal.problem}</p>
				{/if}
			</div>
		{/if}
		<div class="row">
			<button type="button" class="btn btn-sm" disabled={!!blocker} onclick={apply} aria-describedby="{uid}-block" data-testid="areal-map-apply">
				{proposal?.ok ? `Use × ${proposal.factor.toFixed(3)}` : 'Use the factor'}
			</button>
			<span class="hint" id="{uid}-block">{blocker ? `${blocker}.` : 'Replaces the 12 factors and the source; you can still edit them.'}</span>
		</div>
	</div>
</Fold>

<style>
	.body {
		display: grid;
		gap: 0.5rem;
	}
	.hint {
		font-size: var(--font-sm);
		color: var(--text-muted);
		max-width: 75ch;
	}
	.u {
		font-weight: 400;
		color: var(--text-muted);
		font-size: var(--font-sm);
	}
	.row {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-end;
		gap: 0.5rem 1rem;
	}
	.field {
		margin: 0;
		display: grid;
		gap: 0.2rem;
		max-width: 24ch;
	}
	.field.grow {
		max-width: 60ch;
		flex: 1 1 18rem;
	}
	.grow input {
		width: 100%;
	}
	label {
		font-weight: 500;
		font-size: 0.85rem;
		color: var(--text-2);
	}
	.result p {
		margin: 0 0 0.25rem;
		max-width: 75ch;
	}
	.note {
		font-size: var(--font-sm);
		color: var(--text-2);
		overflow-wrap: anywhere;
	}
	.note .label {
		font-weight: 600;
	}
	.warn {
		color: var(--warning);
	}
	.err {
		color: var(--danger);
		font-size: var(--font-sm);
	}
</style>
