<script lang="ts">
	// "Was this useful?" answers on the catchment's alert emails
	// (151_alert_feedback; editors, inside the rule editor): yes and no
	// counted per kind over the last year, and the newest comments, never who
	// gave them. Answers come only from people who chose to answer: there is
	// no open or click tracking, so this says nothing about who read a mail.
	import { onMount } from 'svelte';
	import { api, type AlertFeedbackSummary } from '$lib/api';
	import { fmtDay } from '$lib/format/number';
	import { feedbackKindName, feedbackRows, feedbackShare } from './alerts';

	let { projectId }: { projectId: string } = $props();

	let summary = $state<AlertFeedbackSummary | null>(null);
	let error = $state<string | null>(null);
	const rows = $derived(summary ? feedbackRows(summary) : []);

	onMount(async () => {
		try {
			summary = await api.alerts.feedbackSummary(projectId);
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		}
	});
</script>

<section class="feedback" aria-labelledby="alert-feedback-h" data-ready={summary || error ? 'true' : undefined}>
	<h3 id="alert-feedback-h">Was it useful?</h3>
	<p class="muted">
		What people answered to “Was this alert useful?” in their alert emails over the last year, without their names. Only people who chose to answer
		are counted: nothing records whether an email was opened.
	</p>
	{#if error}
		<div class="alert alert-error" role="alert">Couldn’t load the answers: {error}</div>
	{:else if !summary}
		<p class="muted" role="status">Loading…</p>
	{:else if !rows.length}
		<p class="muted">No answers yet.</p>
	{:else}
		<ul class="kinds">
			{#each rows as r (r.kind)}
				<li data-feedback-kind={r.kind}><strong>{feedbackKindName(r.kind)}:</strong> {feedbackShare(r)}</li>
			{/each}
		</ul>
		{#if summary.comments.length}
			<h4>Comments</h4>
			<ul class="comments">
				{#each summary.comments as c, i (i)}
					<li>
						<span class="meta">{feedbackKindName(c.kind)}, {c.useful ? 'useful' : 'not useful'}, {fmtDay(c.answeredAt.slice(0, 10))}</span>
						<blockquote>{c.comment}</blockquote>
					</li>
				{/each}
			</ul>
		{/if}
	{/if}
</section>

<style>
	.feedback {
		margin-top: 0.75rem;
		border-top: 1px solid var(--border);
		padding-top: 0.75rem;
	}
	h3 {
		font-size: 1rem;
		margin: 0 0 0.35rem;
	}
	h4 {
		font-size: 0.95rem;
		margin: 0.75rem 0 0.35rem;
	}
	ul {
		margin: 0;
		padding-left: 1.2rem;
		display: grid;
		gap: 0.35rem;
		font-size: 0.9rem;
	}
	.comments {
		list-style: none;
		padding-left: 0;
	}
	.meta {
		color: var(--text-muted);
		font-size: 0.85rem;
	}
	blockquote {
		margin: 0.15rem 0 0;
		padding-left: 0.6rem;
		border-left: 3px solid var(--border);
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
</style>
