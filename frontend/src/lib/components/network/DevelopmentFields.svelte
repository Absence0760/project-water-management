<script lang="ts">
	// Development over the run (engine ≥ 1.30.0, issue #67, docs/model.md
	// §2.7g), in the one-node form. `part="dam"`: a farm dam's survey date,
	// sediment rate and in-service date, under its survey and releases.
	// `part="abstraction"`: the day a farm or water user starts to abstract.
	// Empty is null: the field is off, as on a model from before 1.30.0. The
	// model check's message (engine developmentProblem) shows under the fields.
	import type { NetworkNode } from '@water-management/engine';
	import NumberInput from '$lib/components/common/NumberInput.svelte';
	import HelpTip from '$lib/components/help/HelpTip.svelte';
	import FieldHistoryLine from '$lib/components/history/FieldHistoryLine.svelte';
	import { developmentIssue } from '$lib/model/validate';
	import { developmentProblemFields, type DevelopmentField } from './problemFields';

	let { node, readonly, part }: { node: NetworkNode; readonly: boolean; part: 'dam' | 'abstraction' } = $props();

	const id = (k: string) => `dev-${k}-${node.id}`;
	const unit = $derived(node.kind === 'farm' ? node.id : null);
	const problem = $derived(developmentIssue(node));
	/** Which of the fields the problem is about, so it shows once, beside them. */
	const problemHere = $derived(problem !== null && (part === 'abstraction' ? /abstraction|gauge/.test(problem) : !/abstraction|gauge/.test(problem)));
	const problemId = $derived(id(`problem-${part}`));
	/** The fields the problem is about point at it and are marked invalid (only where it shows, beside them). */
	const bad = $derived(problemHere ? developmentProblemFields(problem) : []);
	const describe = (f: DevelopmentField) => [`${id(f)}-h`, ...(bad.includes(f) ? [problemId] : [])].join(' ');
	const invalid = (f: DevelopmentField) => (bad.includes(f) ? 'true' : undefined);
	const dateOf = (v: string) => (v === '' ? null : v);
</script>

<div class="dev" data-testid="development-{part}-{node.id}">
	{#if part === 'dam'}
		<h3 class="sub">Capacity over time</h3>
		<div class="grid">
			<div class="field">
				<span class="lbl"><label for={id('survey')}>Survey date</label><HelpTip key="node.damSurveyDate" /></span>
				<input
					id={id('survey')}
					type="date"
					{readonly}
					value={node.damSurveyDate ?? ''}
					aria-describedby={describe('survey')}
					aria-invalid={invalid('survey')}
					onchange={(e) => (node.damSurveyDate = dateOf(e.currentTarget.value))}
				/>
				<span class="hint" id="{id('survey')}-h">The day the capacity above was measured. Empty: not recorded.</span>
				<FieldHistoryLine field="node:{node.id}:damSurveyDate" {unit} />
			</div>
			<div class="field">
				<span class="lbl"><label for={id('sediment')}>Sediment <span class="u">(% of capacity a year)</span></label><HelpTip key="node.damSedimentPctPerYear" /></span>
				<NumberInput
					id={id('sediment')}
					min={0}
					max={20}
					scale={100}
					nullable
					placeholder="none"
					disabled={readonly}
					aria-describedby={describe('sediment')}
					aria-invalid={invalid('sediment')}
					value={node.damSedimentPctPerYear ?? null}
					onchange={(v) => (node.damSedimentPctPerYear = v)}
				/>
				<span class="hint" id="{id('sediment')}-h">Capacity lost to silt each year, 0–20 %. The dam holds more before the survey date and less after it. Empty: none.</span>
				<FieldHistoryLine field="node:{node.id}:damSedimentPctPerYear" {unit} />
			</div>
			<div class="field">
				<span class="lbl"><label for={id('in-service')}>In service from</label><HelpTip key="node.damInServiceFrom" /></span>
				<input
					id={id('in-service')}
					type="date"
					{readonly}
					value={node.damInServiceFrom ?? ''}
					aria-describedby={describe('in-service')}
					aria-invalid={invalid('in-service')}
					onchange={(e) => (node.damInServiceFrom = dateOf(e.currentTarget.value))}
				/>
				<span class="hint" id="{id('in-service')}-h">The first day the dam holds water; before it the unit has no dam. Empty: the whole run.</span>
				<FieldHistoryLine field="node:{node.id}:damInServiceFrom" {unit} />
			</div>
		</div>
	{:else}
		<div class="field">
			<span class="lbl"><label for={id('abstraction')}>Abstraction starts</label><HelpTip key="node.abstractionFrom" /></span>
			<input
				id={id('abstraction')}
				type="date"
				{readonly}
				value={node.abstractionFrom ?? ''}
				aria-describedby={describe('abstraction')}
					aria-invalid={invalid('abstraction')}
				onchange={(e) => (node.abstractionFrom = dateOf(e.currentTarget.value))}
			/>
			<span class="hint" id="{id('abstraction')}-h">
				{node.kind === 'user' ? 'The first day this user takes water; before it its demand is 0.' : 'The first day this unit takes water; before it its crops and demand objects take nothing.'} Empty: the whole run.
			</span>
			<FieldHistoryLine field="node:{node.id}:abstractionFrom" {unit} />
		</div>
	{/if}
	{#if problemHere}<p class="problem" role="alert" id={problemId}>{problem!.charAt(0).toUpperCase() + problem!.slice(1)}</p>{/if}
</div>

<style>
	/* As the one-node form's own fields (NodeDetail.svelte). */
	.sub {
		font-size: 0.85rem;
		font-weight: 600;
		margin: 0.5rem 0 0.25rem;
	}
	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(210px, 1fr));
		gap: 0 1rem;
	}
	.field {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
		margin-bottom: 0.5rem;
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
	.field :global(input) {
		width: 100%;
		font-variant-numeric: tabular-nums;
	}
	.problem {
		margin: 0 0 0.5rem;
		font-size: 0.85rem;
		color: var(--danger);
	}
	@media (max-width: 640px) {
		.field :global(input) {
			min-height: 44px;
		}
	}
</style>
