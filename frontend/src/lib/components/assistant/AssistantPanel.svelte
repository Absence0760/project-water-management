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
	import Fold from '#lib/components/common/Fold.svelte';
	import { tick } from 'svelte';
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
	// Whose month is spent: the project's, the person's across their projects, or the server's (usage.ts BudgetScope).
	const SPENT_WHOSE = { project: 'This project’s', user: 'Your', total: 'This server’s' } as const;
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

	// The newest words stay in view while they stream, unless the reader scrolled up to read. Whether the reader
	// was at the foot is measured before the DOM grows (`$effect.pre`): measured after, a proposal card (taller
	// than any slack) left the conversation behind. A question just sent always brings the foot into view.
	/** The sheet's body (Dialog.svelte's `.body`) is what scrolls. */
	const scroller = () => log?.closest<HTMLElement>('.body') ?? null;
	const turnSize = () => {
		const t = lastTurn;
		return chat.turns.length + (t?.role === 'assistant' ? t.text.length + t.tools.length + t.proposals.length : 0);
	};
	let follow = true;
	$effect.pre(() => {
		void turnSize();
		const el = scroller();
		if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 48) follow = true;
	});
	$effect(() => {
		void turnSize();
		const el = scroller();
		if (!el || !follow) return;
		el.scrollTop = el.scrollHeight;
		follow = false;
	});

	/** Opening the disclaimer shortens the body: keep the newest words in view rather than the oldest. */
	function keepFoot() {
		const el = scroller();
		if (el) el.scrollTop = el.scrollHeight;
	}
	// Opened again on a conversation, the sheet shows its newest words, once the Dialog's own effect has shown it
	// (a closed <dialog> has no height to scroll).
	$effect(() => {
		if (open) void tick().then(keepFoot);
	});

	async function send(text = draft) {
		const q = text.trim();
		if (!q || chat.busy || blocked) return;
		draft = '';
		follow = true;
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
	<!-- The conversation scrolls in the sheet's body; the question box, the budget and the disclaimer's line are the
	     sheet's pinned foot (its actions), so they stay in view however long the conversation gets. -->
	<div class="convo" data-testid="assistant-panel">
		{#if chat.turns.length === 0}
			<div class="empty">
				<p class="intro">
					Ask about this project’s model and results. The assistant reads the project’s data, the run you have open and
					the help guides. It never changes anything: a recommended settings change is yours to apply and save.
				</p>
				<p class="label" id="assistant-examples">For example</p>
				<ul class="suggestions" aria-labelledby="assistant-examples">
					{#each EXAMPLES as q (q)}
						<li>
							<button type="button" class="btn suggestion" disabled={chat.busy || blocked} onclick={() => send(q)}>
								<span>{q}</span><span class="arrow" aria-hidden="true">→</span>
							</button>
						</li>
					{/each}
				</ul>
			</div>
		{:else}
			<ol class="log" bind:this={log} aria-label="Conversation">
				{#each chat.turns as t, i (i)}
					{#if t.role === 'user'}
						<li class="turn user" data-testid="assistant-question"><span class="visually-hidden">{'You: '}</span>{t.text}</li>
					{:else}
						{@render answer(t, i === chat.turns.length - 1)}
					{/if}
				{/each}
			</ol>
		{/if}
		<p class="visually-hidden" role="status" aria-live="polite">{announce}</p>
	</div>
	{#snippet actions()}
		<div class="foot">
			{#if chat.refusal?.kind === 'rate' && st}
				<p class="note warn" role="alert" data-testid="assistant-rate-limited">
					You have reached the assistant’s limit of {st.rate.messagesPerHour} messages an hour. Try again in about {waitText(chat.refusal.seconds)}.
				</p>
			{:else if chat.spent && st}
				<p class="note warn" role="alert" data-testid="assistant-budget-spent">
					{SPENT_WHOSE[chat.spentScope ?? 'project']} assistant budget for the month is used up. It starts again on {fmtDay(st.budget.resetsAt)}.
				</p>
			{:else if chat.refusal?.kind === 'error'}
				<p class="note err" role="alert">The question wasn’t sent: {chat.refusal.message}</p>
			{/if}

			<form
				class="composer"
				onsubmit={(e) => {
					e.preventDefault();
					void send();
				}}
			>
				<label for="assistant-q" class="visually-hidden">Your question</label>
				<!-- The box takes the focus when the sheet opens: asking is what it is for. -->
				<!-- svelte-ignore a11y_autofocus -->
				<textarea
					id="assistant-q"
					rows="2"
					autofocus
					bind:this={box}
					bind:value={draft}
					{onkeydown}
					disabled={blocked}
					aria-describedby="assistant-q-hint"
					placeholder="Ask about this project…"
				></textarea>
				<div class="composer-row">
					<span id="assistant-q-hint" class="hint">Enter sends, Shift+Enter starts a new line.</span>
					{#if chat.busy}
						<button type="button" class="btn btn-sm" onclick={() => chat.stop()}>Stop</button>
					{:else}
						<button type="submit" class="btn btn-primary btn-sm" disabled={blocked || !draft.trim()}>Send</button>
					{/if}
				</div>
			</form>

			{#if st || chat.turns.length}
				<div class="meta">
					{#if st}
						<span class="budget" data-testid="assistant-budget">
							{fmtPct(left, 0)} of this month’s budget left · starts again {fmtDay(st.budget.resetsAt)}
						</span>
					{/if}
					{#if chat.turns.length}
						<button type="button" class="btn btn-ghost btn-sm" onclick={() => chat.clear()}>New conversation</button>
					{/if}
				</div>
			{/if}

			{#if st}
				<!-- The status's disclaimer, paragraphs a blank line apart and `{site}` this site's address (as the report's,
				     liability/Disclaimer.svelte). Its first paragraph, what the answers are, stays in view; the report's
				     paragraphs under it fold away, one click from the box. -->
				{@const [first = '', ...rest] = st.disclaimer.split(/\n\s*\n/).map((p) => withSite(p, site))}
				{#if rest.length}
					<Fold line={first} change="Read the full disclaimer" problem={false} body="none" class="disclaimer" testid="assistant-disclaimer" ontoggle={keepFoot}>
						<!-- Scrolls in its own box: it takes the focus so the keyboard can scroll it (axe scrollable-region-focusable). -->
						<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
						<div class="disclaimer-text" role="region" aria-label="The full disclaimer" tabindex="0">
							{#each rest as para, i (i)}<p>{para}</p>{/each}
						</div>
					</Fold>
				{:else}
					<p class="hint" data-testid="assistant-disclaimer">{first}</p>
				{/if}
			{/if}
		</div>
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
	/* The body: the empty state or the conversation, both settled at the foot beside the box, as a chat reads
	   (the newest words nearest the question box; no gap between the examples and the box). */
	.convo {
		display: flex;
		flex-direction: column;
		min-height: 100%;
	}
	.empty {
		margin-top: auto;
		padding-block: 1rem 0.25rem;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}
	.intro {
		margin: 0 0 0.5rem;
		color: var(--text-2);
		line-height: 1.5;
	}
	.label {
		margin: 0;
		font-weight: 500;
		font-size: var(--font-sm);
		color: var(--text-muted);
	}
	.suggestions,
	.log,
	.tools,
	.reasons {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.suggestions {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}
	.suggestion {
		width: 100%;
		justify-content: space-between;
		gap: 0.75rem;
		padding: 0.6rem 0.75rem;
		border-color: var(--border);
		border-radius: var(--radius);
		font-weight: 400;
		line-height: 1.4;
		text-align: left;
		white-space: normal;
	}
	.arrow {
		flex: none;
		color: var(--accent);
	}
	.log {
		margin-top: auto;
		display: flex;
		flex-direction: column;
		gap: 1rem;
		padding-block: 0.25rem 0.5rem;
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
		gap: 0.5rem;
	}
	.text {
		white-space: pre-wrap;
		line-height: 1.55;
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

	/* The foot: one block, the box with its hint and Send inside it, then a quiet line of meta. It fills the
	   Dialog's action row (a wrapping flex row). */
	.foot {
		flex: 1 1 100%;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
	}
	.composer {
		display: flex;
		flex-direction: column;
		border: 1px solid var(--border-input);
		border-radius: var(--radius);
		background: var(--surface);
	}
	/* The box draws the focus ring for the field inside it. */
	.composer:focus-within {
		outline: 2px solid var(--focus);
		outline-offset: 1px;
	}
	.composer textarea {
		padding: 0.6rem 0.75rem 0.25rem;
		border: 0;
		background: none;
		resize: vertical;
	}
	.composer textarea:focus-visible {
		outline: none;
	}
	.composer-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
		padding: 0.25rem 0.4rem 0.4rem 0.75rem;
	}
	.hint {
		margin: 0;
		font-size: var(--font-xs);
		color: var(--text-muted);
	}
	.meta {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 0 0.5rem;
		font-size: var(--font-xs);
		color: var(--text-muted);
	}
	.meta button {
		margin-left: auto;
	}
	/* The disclaimer's line: what the answers are, in view; the report's paragraphs fold under it and scroll
	   in their own box, so opening them never pushes the question box off a phone's screen. */
	.foot :global(.disclaimer > summary),
	.disclaimer-text {
		font-size: var(--font-xs);
	}
	.disclaimer-text {
		max-height: 25vh;
		overflow-y: auto;
	}
</style>
