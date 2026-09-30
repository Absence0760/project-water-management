<!--
	The applicant's statement on a scenario (docs/ui.md § Scenarios, "Applicant's
	statement"): the answers to the evidence report's Appendix C prompts
	(engine APPLICANT_PROMPTS: purpose and need, mitigation, monitoring;
	129_scenario_statement). Appendix C prints each verbatim, or "Not given".
	Whoever may change the scenario writes them (an editor on a team scenario,
	only its applicant on an application), on the description's terms: a
	submission doesn't freeze them, an issued evidence pack freezes what it
	printed. Everyone who reads the scenario reads them.
-->
<script lang="ts">
	import { APPLICANT_PROMPT_MAX, APPLICANT_PROMPTS, NO_PROMPTS, type ApplicantPrompts } from '@water-management/engine';
	import { guardUnsaved } from '$lib/nav/unsaved';
	import { leavesScenario } from './leaves';
	import { answeredCount, statementPatch, storedAnswers } from './statement';

	let {
		scenarioName,
		answers,
		canChange,
		saving,
		onsave
	}: {
		scenarioName: string;
		answers: ApplicantPrompts;
		/** The caller may change the scenario (an editor on a team scenario, its applicant on an application). */
		canChange: boolean;
		/** A save of the scenario is in flight. */
		saving: boolean;
		/** PATCH the changed answers; true when saved. */
		onsave: (patch: Partial<ApplicantPrompts>) => Promise<boolean>;
	} = $props();

	const uid = $props.id();
	let editing = $state(false);
	let draft = $state<ApplicantPrompts>({ ...NO_PROMPTS });
	const stored = $derived(storedAnswers(answers));
	const changes = $derived(statementPatch(draft, stored));
	const dirty = $derived(editing && Object.keys(changes).length > 0);
	const answered = $derived(answeredCount(stored));

	function start() {
		draft = { ...stored };
		editing = true;
	}
	/** The parent keys this component on the scenario id, so a different scenario starts closed. */
	guardUnsaved({
		dirty: () => dirty,
		what: () => `the statement for “${scenarioName}” not yet saved`,
		leaves: leavesScenario
	});
	async function save(e: SubmitEvent) {
		e.preventDefault();
		if (!dirty) {
			editing = false;
			return;
		}
		if (await onsave(changes)) editing = false;
	}
</script>

<section class="statement" aria-labelledby="{uid}-h" data-testid="scenario-statement">
	<div class="statement-head">
		<h3 id="{uid}-h">Applicant’s statement</h3>
		<span class="muted small" data-testid="statement-count">{answered} of {APPLICANT_PROMPTS.length} answered</span>
		{#if canChange && !editing}
			<button type="button" class="btn btn-sm" disabled={saving} onclick={start}>{answered ? 'Edit statement' : 'Answer the prompts'}</button>
		{/if}
	</div>
	<p class="hint">
		Appendix C of the evidence report prints these answers as written, beside the description and the run’s notes, and “Not given” for any
		prompt left blank.
	</p>
	{#if editing}
		<form onsubmit={save}>
			{#each APPLICANT_PROMPTS as p (p.id)}
				<div class="field">
					<label for="{uid}-{p.id}">{p.heading}</label>
					<p id="{uid}-{p.id}-q" class="hint q">{p.question}</p>
					<textarea id="{uid}-{p.id}" rows="3" maxlength={APPLICANT_PROMPT_MAX} aria-describedby="{uid}-{p.id}-q" bind:value={draft[p.id]}></textarea>
				</div>
			{/each}
			<div class="toolbar">
				<button type="submit" class="btn btn-primary btn-sm" disabled={saving}>{saving ? 'Saving…' : 'Save statement'}</button>
				<button type="button" class="btn btn-sm" disabled={saving} onclick={() => (editing = false)}>Cancel</button>
			</div>
		</form>
	{:else}
		<dl class="answers">
			{#each APPLICANT_PROMPTS as p (p.id)}
				<div data-testid="statement-{p.id}">
					<dt>{p.heading}</dt>
					{#if stored[p.id].trim()}<dd class="text">{stored[p.id]}</dd>{:else}<dd class="na">Not given</dd>{/if}
				</div>
			{/each}
		</dl>
	{/if}
</section>

<style>
	.statement {
		margin: 1rem 0;
	}
	.statement-head {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 0.25rem 0.75rem;
		margin: 0.5rem 0 0.25rem;
	}
	h3 {
		margin: 0;
		font-size: 1rem;
	}
	.small {
		font-size: 0.82rem;
	}
	.hint {
		font-size: 0.82rem;
		color: var(--text-muted);
		margin: 0.25rem 0 0.5rem;
		max-width: 80ch;
	}
	.q {
		margin: 0 0 0.3rem;
	}
	.field {
		margin-bottom: 0.75rem;
	}
	.field label {
		font-weight: 600;
	}
	textarea {
		width: 100%;
		max-width: 80ch;
		font: inherit;
	}
	.toolbar {
		display: flex;
		gap: 0.5rem;
	}
	.answers {
		display: grid;
		gap: 0.5rem;
		margin: 0;
		max-width: 80ch;
	}
	.answers dt {
		font-weight: 600;
	}
	.answers dd {
		margin: 0.1rem 0 0;
	}
	.text {
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
	.na {
		color: var(--text-muted);
		font-style: italic;
	}
</style>
