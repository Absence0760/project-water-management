<script lang="ts">
	// "Ask the assessors why" (164_applicant_visibility, docs/ui.md
	// § Applications): for an application's parties, each problem line a rule
	// hidden from them broke, with a button that sends the line, the changes it
	// names and the rule's kind to the assessors (never anything hidden: the
	// app has nothing hidden to send back), and every question asked with its
	// answer. The assessors read the rule in its real words and decide what
	// their answer says; the draft itself stays the applicant's.
	import { untrack } from 'svelte';
	import { api, type ApplicationQuestion, type MaskedRuleRef } from '$lib/api';
	import { fmtDate } from '$lib/format/number';
	import { askables, opsText, rulesText } from './questions';

	let {
		projectId,
		scenarioId,
		problems,
		maskedRules,
		canAsk
	}: {
		projectId: string;
		scenarioId: string;
		problems: string[];
		maskedRules: MaskedRuleRef[] | undefined;
		/** One of the application's parties: its applicant or someone they shared it with. */
		canAsk: boolean;
	} = $props();

	let questions = $state.raw<ApplicationQuestion[]>([]);
	let error = $state<string | null>(null);
	let busy = $state<number | null>(null);
	let note = $state('');
	const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

	async function load() {
		try {
			questions = await api.scenarios.questions(projectId, scenarioId);
			error = null;
		} catch (e) {
			error = msg(e);
		}
	}
	$effect(() => {
		void scenarioId;
		untrack(load);
	});

	const items = $derived(askables(problems, maskedRules, questions));
	/** Questions about lines the check no longer shows (the changes moved on). */
	const earlier = $derived(questions.filter((q) => !items.some((i) => i.asked?.id === q.id)));

	async function ask(problem: number, line: string) {
		busy = problem;
		error = null;
		try {
			const q = await api.scenarios.ask(projectId, scenarioId, problem, line);
			questions = [q, ...questions];
			note = 'Sent to the assessors.';
		} catch (e) {
			error = msg(e);
		} finally {
			busy = null;
		}
	}
</script>

{#if items.length || questions.length}
	<section class="ask panel" aria-labelledby="ask-h" data-testid="ask-assessors">
		<h3 id="ask-h">Rules you can’t see</h3>
		{#if items.length}
			<p class="hint">
				These changes break a rule that depends on other water users’ figures, which aren’t shown to you. The assessors can see them: ask them why, and
				they decide what their answer can say. They see your question, the changes it names and this application’s name, not the rest of your draft.
			</p>
			<ul class="items">
				{#each items as it (it.problem)}
					<li>
						<p class="line">{it.line}</p>
						<p class="small muted">{opsText(it.ops)}: {rulesText(it.rules)}</p>
						{#if it.asked}
							{#if it.asked.answer}
								<p class="answer"><strong>The assessors’ answer</strong> ({fmtDate(it.asked.answeredAt ?? it.asked.askedAt)}): {it.asked.answer}</p>
							{:else}
								<p class="small" data-testid="asked">Asked {fmtDate(it.asked.askedAt)}; waiting for the assessors’ answer.</p>
							{/if}
						{/if}
						{#if canAsk && (!it.asked || it.asked.answer)}
							<button type="button" class="btn btn-sm" disabled={busy !== null} onclick={() => ask(it.problem, it.line)}>
								{it.asked ? 'Ask again' : 'Ask the assessors why'}
							</button>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}
		{#if earlier.length}
			<details>
				<summary>Earlier questions ({earlier.length})</summary>
				<ul class="items">
					{#each earlier as q (q.id)}
						<li>
							<p class="line">{q.problem}</p>
							<p class="small muted">Asked {fmtDate(q.askedAt)} about {opsText(q.opIndexes)}: {rulesText(q.rules)}</p>
							{#if q.answer}<p class="answer"><strong>Answer</strong>: {q.answer}</p>{:else}<p class="small">No answer yet.</p>{/if}
						</li>
					{/each}
				</ul>
			</details>
		{/if}
		{#if error}<p class="alert alert-warning" role="alert">{error}</p>{/if}
		<p class="visually-hidden" role="status">{note}</p>
	</section>
{/if}

<style>
	.ask {
		margin: 0;
	}
	.items {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 0.75rem;
	}
	.items li {
		border-top: 1px solid var(--border);
		padding-top: 0.5rem;
	}
	.line {
		margin: 0;
		overflow-wrap: anywhere;
	}
	.answer {
		margin: 0.25rem 0;
		white-space: pre-line;
	}
	p.small {
		margin: 0.25rem 0;
	}
</style>
