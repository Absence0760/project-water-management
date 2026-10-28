<!--
	The project's assistant (issue #610; docs/ui.md § Assistant): a side sheet
	opened from the section header's Assistant button. A question goes to the
	server with the conversation so far; the answer streams in, with a line for
	each tool the assistant reads the project with ("Reading the run summary").
	A recommended settings change is a card with the engine's diff lines and a
	reason for each setting, and, for an editor, Apply: that puts the change in
	the settings form, unsaved, and opens Model settings with the save reason
	filled in (the page's onapply). The assistant never saves anything.
	The conversation lives in the page (chat.svelte.ts), so closing the sheet
	keeps it.
-->
<script lang="ts">
	import Dialog from '#lib/components/common/Dialog.svelte';
	import type { SettingsProposal } from '#lib/api/types.js';
	import { fmtDay, fmtPct } from '#lib/format/number.js';
	import { basePath } from '#lib/nav/base.js';
	import { withSite } from '@water-management/engine';
	import { waitText, type AssistantChat, type AssistantTurn } from './chat.svelte';

	let {
		open = $bindable(false),
		chat,
		/** The run the conversation is about (the page's selected run), or the project's latest. */
		runId = null,
		/** Apply: put the proposal in the settings form and open Model settings (the page does it). */
		onapply
	}: {
		open?: boolean;
		chat: AssistantChat;
		runId?: string | null;
		onapply?: (proposal: SettingsProposal) => void;
	} = $props();

	/** This site's address, for the disclaimer's `{site}` (the Terms link), as liability/Disclaimer.svelte. */
	const site = typeof location === 'undefined' ? basePath() : `${location.origin}${basePath()}`;

	const EXAMPLES = ['Why does the simulated flow at the outlet not respond to rainfall?', 'Which settings would you change to improve the fit at the outlet?'];

	let draft = $state('');
	let box: HTMLTextAreaElement | undefined = $state();
	let log: HTMLOListElement | undefined = $state();

	const st = $derived(chat.status?.available ? chat.status : null);
	const left = $derived(st ? chat.tokensLeft! / Math.max(1, st.budget.tokensPerMonth) : null);
	const limited = $derived(chat.refusal?.kind === 'rate');
	const blocked = $derived(chat.spent || limited);
	const lastTurn = $derived(chat.turns.at(-1));
	/** What the screen reader hears once a turn ends (the streaming text itself isn't read out word by word). */
	const announce = $derived.by(() => {
		if (chat.busy) return 'The assistant is answering…';
		const t = lastTurn;
		if (t?.role !== 'assistant') return '';
		if (t.stopped) return 'Stopped.';
		if (t.error) return `The answer didn’t finish: ${t.error}`;
		return t.proposals.length ? 'The assistant answered with a recommended change.' : 'The assistant answered.';
	});

	// The newest words stay in view while they stream, unless the reader scrolled up to read.
	$effect(() => {
		const t = lastTurn;
		void (t?.role === 'assistant' ? t.text.length + t.tools.length + t.proposals.length : 0);
		const el = log?.parentElement;
		if (!el) return;
		if (el.scrollHeight - el.scrollTop - el.clientHeight < 120) el.scrollTop = el.scrollHeight;
	});

	async function send(text = draft) {
		const q = text.trim();
		if (!q || chat.busy || blocked) return;
		draft = '';
		const taken = await chat.ask(q, runId);
		// Not taken (the hourly limit, the budget, an error): the question goes back in the box.
		if (!taken && !draft) draft = q;
		box?.focus();
	}
	function onkeydown(e: KeyboardEvent) {
		// Enter sends; Shift+Enter is a new line.
		if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
		e.preventDefault();
		void send();
	}
	function apply(p: { proposal: SettingsProposal; applied: boolean }) {
		p.applied = true;
		onapply?.(p.proposal);
	}
	const toolState = { start: 'running', done: 'done', error: 'failed' } as const;
</script>

<Dialog bind:open title="Assistant" side>
	<div class="assistant" data-testid="assistant-panel">
		<p class="muted intro">
			Ask about this project’s model and results. The assistant reads the project’s data, the run you have open and
			the help guides. It never changes anything: a recommended settings change is yours to apply and save.
		</p>

		{#if chat.turns.length === 0}
			<div class="examples">
				<p class="label">For example</p>
				<ul>
					{#each EXAMPLES as q (q)}
						<li><button type="button" class="btn btn-sm example" disabled={chat.busy || blocked} onclick={() => send(q)}>{q}</button></li>
					{/each}
				</ul>
			</div>
		{/if}

		<div class="log-scroll">
			<ol class="log" bind:this={log} aria-label="Conversation">
				{#each chat.turns as t, i (i)}
					{#if t.role === 'user'}
						<li class="turn user" data-testid="assistant-question"><span class="visually-hidden">{'You: '}</span>{t.text}</li>
					{:else}
						{@render answer(t, i === chat.turns.length - 1)}
					{/if}
				{/each}
			</ol>
		</div>
		<p class="visually-hidden" role="status" aria-live="polite">{announce}</p>

		{#if chat.refusal?.kind === 'rate' && st}
			<p class="note warn" role="alert" data-testid="assistant-rate-limited">
				You have reached the assistant’s limit of {st.rate.messagesPerHour} messages an hour. Try again in about {waitText(chat.refusal.seconds)}.
			</p>
		{:else if chat.spent && st}
			<p class="note warn" role="alert" data-testid="assistant-budget-spent">
				This project’s assistant budget for the month is used up. It starts again on {fmtDay(st.budget.resetsAt)}.
			</p>
		{:else if chat.refusal?.kind === 'error'}
			<p class="note err" role="alert">The question wasn’t sent: {chat.refusal.message}</p>
		{/if}

		<form
			class="ask"
			onsubmit={(e) => {
				e.preventDefault();
				void send();
			}}
		>
			<label for="assistant-q" class="label">Your question</label>
			<textarea
				id="assistant-q"
				rows="3"
				bind:this={box}
				bind:value={draft}
				{onkeydown}
				disabled={blocked}
				aria-describedby="assistant-q-hint"
				placeholder="Ask about this project…"
			></textarea>
			<div class="ask-row">
				<span id="assistant-q-hint" class="muted hint">Enter sends, Shift+Enter starts a new line.</span>
				{#if chat.busy}
					<button type="button" class="btn" onclick={() => chat.stop()}>Stop</button>
				{:else}
					<button type="submit" class="btn btn-primary" disabled={blocked || !draft.trim()}>Send</button>
				{/if}
			</div>
		</form>

		{#if st}
			<p class="muted budget" data-testid="assistant-budget">
				{fmtPct(left, 0)} of this month’s budget left · starts again {fmtDay(st.budget.resetsAt)}
			</p>
			<!-- The status's disclaimer: paragraphs a blank line apart, `{site}` this site's address (as the report's, liability/Disclaimer.svelte). -->
			<div class="muted disclaimer" data-testid="assistant-disclaimer">
				{#each st.disclaimer.split(/\n\s*\n/) as para, i (i)}<p>{withSite(para, site)}</p>{/each}
			</div>
		{/if}
	</div>
	{#snippet actions()}
		{#if chat.turns.length}
			<button type="button" class="btn btn-ghost" onclick={() => chat.clear()}>New conversation</button>
		{/if}
		<button type="button" class="btn" onclick={() => (open = false)}>Close</button>
	{/snippet}
</Dialog>

{#snippet answer(t: AssistantTurn, last: boolean)}
	<li class="turn bot" data-testid="assistant-answer" data-done={t.done || undefined}>
		<span class="visually-hidden">{'Assistant: '}</span>
		{#if t.tools.length}
			<ul class="tools" aria-label="What the assistant read">
				{#each t.tools as tool, k (k)}
					<li class="tool {tool.status}" data-testid="assistant-tool" data-tool={tool.name} data-status={tool.status}>
						<span class="dot" aria-hidden="true"></span>{tool.label}<span class="visually-hidden">{` (${toolState[tool.status]})`}</span>
					</li>
				{/each}
			</ul>
		{/if}
		{#if t.text}
			<div class="text" data-testid="assistant-text">{t.text}</div>
		{:else if last && chat.busy}
			<p class="muted thinking">Thinking…</p>
		{/if}
		{#each t.proposals as p, k (k)}
			{@render proposal(p)}
		{/each}
		{#if t.stopped}<p class="muted small">Stopped.</p>{/if}
		{#if t.error}<p class="note err small">{t.error}</p>{/if}
	</li>
{/snippet}

{#snippet proposal(p: { proposal: SettingsProposal; applied: boolean })}
	{@const reasons = Object.values(p.proposal.reasons).filter((r) => r.trim())}
	<section class="proposal" data-testid="assistant-proposal" aria-label="Recommended change">
		<h3>Recommended change</h3>
		<p class="summary">{p.proposal.summary}</p>
		{#if p.proposal.diff.length}
			<table class="data compact">
				<caption class="visually-hidden">The settings it would change</caption>
				<thead><tr><th scope="col">Setting</th><th scope="col">Now</th><th scope="col">Suggested</th></tr></thead>
				<tbody>
					{#each p.proposal.diff as d, k (k)}
						<tr data-testid="assistant-diff-line"><th scope="row">{d.label}</th><td>{d.before}</td><td>{d.after}</td></tr>
					{/each}
				</tbody>
			</table>
		{/if}
		{#if reasons.length}
			<p class="label">Why</p>
			<ul class="reasons">
				{#each reasons as r, k (k)}<li>{r}</li>{/each}
			</ul>
		{/if}
		{#if p.applied}
			<p class="note ok" role="status">Put in the settings form, not saved. Check it on Model settings, then Save.</p>
		{:else if chat.canApply}
			<button type="button" class="btn btn-primary btn-sm" onclick={() => apply(p)}>Apply to the settings form</button>
		{:else}
			<p class="muted small">An editor can apply this change.</p>
		{/if}
	</section>
{/snippet}

<style>
	.assistant {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		min-height: 100%;
	}
	.intro {
		margin: 0;
		font-size: var(--font-sm);
	}
	.label {
		margin: 0 0 0.25rem;
		font-weight: 500;
		font-size: 0.85rem;
		color: var(--text-2);
	}
	.examples ul,
	.log,
	.tools,
	.reasons {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.examples ul {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
	}
	.example {
		text-align: left;
		white-space: normal;
		height: auto;
	}
	.log-scroll {
		flex: 1;
		overflow-y: auto;
		min-height: 0;
	}
	.log {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}
	.turn {
		max-width: 100%;
		overflow-wrap: anywhere;
	}
	.user {
		align-self: flex-end;
		max-width: 85%;
		padding: 0.5rem 0.75rem;
		border-radius: var(--radius);
		background: var(--accent-soft);
		color: var(--text);
		white-space: pre-wrap;
	}
	.bot {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
	}
	.text {
		white-space: pre-wrap;
		line-height: 1.5;
	}
	.tools {
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
		font-size: var(--font-sm);
		color: var(--text-muted);
	}
	.tool {
		display: flex;
		align-items: center;
		gap: 0.4rem;
	}
	.dot {
		flex: none;
		width: 0.5rem;
		height: 0.5rem;
		border-radius: 50%;
		border: 1.5px solid currentColor;
	}
	.tool.done .dot {
		background: var(--success);
		border-color: var(--success);
	}
	.tool.error .dot {
		background: var(--danger);
		border-color: var(--danger);
	}
	.thinking,
	.small {
		margin: 0;
		font-size: var(--font-sm);
	}
	.proposal {
		padding: 0.75rem;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--surface-2);
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		align-items: flex-start;
	}
	.proposal h3 {
		margin: 0;
		font-size: 0.95rem;
	}
	.proposal .summary {
		margin: 0;
	}
	.proposal table {
		width: 100%;
	}
	.reasons {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		font-size: var(--font-sm);
	}
	.reasons li {
		padding-left: 0.75rem;
		border-left: 2px solid var(--border-strong);
	}
	.note {
		margin: 0;
		padding: 0.4rem 0.6rem;
		border-radius: var(--radius-sm);
		font-size: var(--font-sm);
	}
	.note.warn {
		background: var(--warning-soft);
		color: var(--text);
	}
	.note.err {
		background: var(--danger-soft);
		color: var(--text);
	}
	.note.ok {
		background: var(--success-soft);
		color: var(--text);
	}
	.ask {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}
	.ask textarea {
		width: 100%;
	}
	.ask-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
	}
	.hint {
		font-size: var(--font-xs);
	}
	.budget,
	.disclaimer {
		margin: 0;
		font-size: var(--font-xs);
	}
	.disclaimer p {
		margin: 0 0 0.4rem;
	}
</style>
