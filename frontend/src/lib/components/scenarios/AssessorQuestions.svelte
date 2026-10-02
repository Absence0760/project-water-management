<script lang="ts">
	// The assessors' side of "Ask the assessors why" (164_applicant_visibility,
	// docs/ui.md § Applications): applicants' questions about rules hidden from
	// them, unanswered first, each with the application's name, the changes
	// it named, the line as the applicant read it and the rule in its own
	// words. An editor answers once; what the answer discloses of other water
	// users' figures is the authority's call (provisional position, pre-counsel
	// research, 2026-10-01). The question may be about a draft, which stays
	// the applicant's: the question carries what the assessors need.
	import { untrack } from 'svelte';
	import { api, type AssessorQuestion } from '$lib/api';
	import { fmtDate } from '$lib/format/number';
	import { opsText, rulesText } from './questions';

	let { projectId }: { projectId: string } = $props();

	let questions = $state.raw<AssessorQuestion[] | null>(null);
	let error = $state<string | null>(null);
	let drafts = $state<Record<string, string>>({});
	let busy = $state<string | null>(null);
	const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

	async function load() {
		try {
			questions = await api.scenarios.assessorQuestions(projectId);
			error = null;
		} catch (e) {
			error = msg(e);
		}
	}
	$effect(() => {
		void projectId;
		untrack(load);
	});

	const open = $derived((questions ?? []).filter((q) => !q.answer).length);

	async function answer(q: AssessorQuestion) {
		const text = (drafts[q.id] ?? '').trim();
		if (!text) return;
		busy = q.id;
		error = null;
		try {
			const done = await api.scenarios.answerQuestion(projectId, q.id, text);
			questions = (questions ?? []).map((x) => (x.id === q.id ? done : x));
		} catch (e) {
			error = msg(e);
		} finally {
			busy = null;
		}
	}
</script>

{#if questions?.length || error}
	<section class="panel questions" aria-labelledby="questions-h" data-testid="assessor-questions">
		<div class="panel-head">
			<h2 id="questions-h">Applicants’ questions</h2>
			<span class="muted small">{open ? `${open} waiting for an answer` : 'All answered'}</span>
		</div>
		<p class="hint">
			An applicant asks why a change breaks a rule that depends on figures they can’t see. You read the rule in its own words; your answer goes to the
			application’s applicant and the people they shared it with, so say only what they may know of other water users.
		</p>
		{#if error}<p class="alert alert-warning" role="alert">{error}</p>{/if}
		<ul class="items">
			{#each questions ?? [] as q (q.id)}
				<li data-answered={q.answer ? 'true' : 'false'}>
					<p class="small muted">“{q.scenarioName}”, asked {fmtDate(q.askedAt, true)} about {opsText(q.opIndexes)}: {rulesText(q.rules)}</p>
					<p class="line"><span class="who">The applicant read:</span> {q.problem}</p>
					<p class="line"><span class="who">In its own words:</span> {q.assessorText}</p>
					{#if q.answer}
						<p class="answer"><strong>Answered</strong> {fmtDate(q.answeredAt, true)}: {q.answer}</p>
					{:else}
						<label class="field">
							<span>Your answer</span>
							<textarea rows="3" maxlength="4000" bind:value={drafts[q.id]} disabled={busy !== null}></textarea>
						</label>
						<button type="button" class="btn btn-sm" disabled={busy !== null || !(drafts[q.id] ?? '').trim()} onclick={() => answer(q)}>Send the answer</button>
					{/if}
				</li>
			{/each}
		</ul>
	</section>
{/if}

<style>
	.questions {
		margin: 1rem 0 0;
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
	.line,
	.answer {
		margin: 0.25rem 0;
		overflow-wrap: anywhere;
		white-space: pre-line;
	}
	.who {
		font-weight: 600;
	}
	textarea {
		width: 100%;
	}
</style>
