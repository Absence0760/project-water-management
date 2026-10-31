<script lang="ts">
	// The Restriction log's decisions, newest first (docs/ui.md § Restriction log): each one's day and time, what it
	// was, the level, the notice in every language it was written in, the season and units, the next date, the staff
	// note, who made it and the run it rested on. The page (RestrictionLogTab.svelte) loads and pages them.
	import type { RestrictionDecision } from '#lib/api/types.js';
	import { fmtDate } from '#lib/format/number.js';
	import { decisionBy, decisionFacts, decisionNotices, decisionTitle, inForceId, levelText, levelTone, runHref, shortId } from './log';

	let { items }: { items: readonly RestrictionDecision[] } = $props();

	const inForce = $derived(inForceId(items));
</script>

<ol class="decisions" aria-label="Restriction decisions, newest first" data-testid="restriction-log-list">
	{#each items as d (d.id)}
		{@const notices = decisionNotices(d)}
		{@const href = runHref(d)}
		{@const facts = decisionFacts(d)}
		<li class="decision" data-testid="restriction-decision" data-kind={d.kind}>
			<div class="when">
				<time datetime={d.at}>{fmtDate(d.at, true)}</time>
			</div>
			<div class="body">
				<div class="head">
					<h3 id="rl-{d.id}">{decisionTitle(d)}</h3>
					<span class="pill tone-{levelTone(d.restriction)}" data-testid="restriction-level">{levelText(d.restriction)}</span>
					{#if d.id === inForce}<span class="pill tone-current" data-testid="restriction-in-force">In force</span>{/if}
				</div>
				<p class="by">
					By {decisionBy(d)} ·
					{#if href}
						<a {href}>Open the run<span class="visually-hidden"> of {fmtDate(d.at, true)}</span></a>
					{:else if d.runId}
						<span class="muted" title={d.runId}>run {shortId(d.runId)} no longer kept</span>
					{:else}
						<span class="muted">run not recorded</span>
					{/if}
				</p>
				{#if notices === null}
					<p class="muted small">Recorded before notices were kept in the log: the level only.</p>
				{:else if notices.length}
					<dl class="notices">
						{#each notices as n (n.code)}
							<dt>Notice ({n.name})</dt>
							<dd lang={n.code}>{n.text}</dd>
						{/each}
					</dl>
				{:else}
					<p class="muted small">No notice text.</p>
				{/if}
				{#if facts.length || d.note}
					<ul class="facts">
						{#each facts as f (f)}<li>{f}</li>{/each}
						{#if d.note}<li class="note"><span class="label">Staff note (farmers don’t see it):</span> {d.note}</li>{/if}
					</ul>
				{/if}
			</div>
		</li>
	{/each}
</ol>

<style>
	.decisions {
		list-style: none;
		margin: 0;
		padding: 0;
		container: decisions / inline-size;
	}
	.decision {
		display: grid;
		grid-template-columns: 11rem minmax(0, 1fr);
		gap: 0.25rem 1rem;
		padding: 0.85rem 0;
		border-top: 1px solid var(--border);
	}
	.decision:first-child {
		border-top: 0;
		padding-top: 0.25rem;
	}
	.when {
		color: var(--text-2);
		font-variant-numeric: tabular-nums;
		font-size: var(--font-sm);
		padding-top: 0.15rem;
	}
	.body {
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
	}
	.head {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.35rem 0.6rem;
	}
	h3 {
		margin: 0;
		font-size: 1rem;
	}
	.by {
		margin: 0;
		color: var(--text-2);
		font-size: var(--font-sm);
		overflow-wrap: anywhere;
	}
	.notices {
		margin: 0;
		display: grid;
		grid-template-columns: max-content minmax(0, 1fr);
		gap: 0.2rem 0.75rem;
		max-width: 75ch;
	}
	.notices dt {
		color: var(--text-2);
		font-size: var(--font-sm);
	}
	.notices dd {
		margin: 0;
		white-space: pre-line;
		overflow-wrap: anywhere;
	}
	.facts {
		margin: 0;
		padding: 0;
		list-style: none;
		font-size: var(--font-sm);
		color: var(--text-2);
		max-width: 75ch;
	}
	.facts .note {
		overflow-wrap: anywhere;
		white-space: pre-line;
	}
	.facts .label {
		font-weight: 600;
	}
	.muted {
		color: var(--text-2);
	}
	.small {
		margin: 0;
		font-size: var(--font-sm);
	}
	/* The level in words; the colour repeats it. */
	.pill {
		display: inline-block;
		padding: 0.05rem 0.5rem;
		border-radius: var(--radius);
		border: 1px solid var(--border);
		font-size: var(--font-sm);
		font-weight: 600;
		line-height: 1.4;
		background: var(--surface-2);
		color: var(--text-2);
		white-space: nowrap;
	}
	.tone-advisory {
		background: var(--warning-soft);
		border-color: color-mix(in srgb, var(--warning) 40%, transparent);
		color: var(--warning);
	}
	.tone-restricted {
		background: var(--danger-soft);
		border-color: color-mix(in srgb, var(--danger) 40%, transparent);
		color: var(--danger);
	}
	.tone-current {
		background: var(--accent-soft);
		border-color: color-mix(in srgb, var(--accent) 45%, transparent);
		color: var(--text);
	}
	/* A phone: the day above the decision, the notice's language above its words. */
	@container decisions (max-width: 36rem) {
		.decision {
			grid-template-columns: minmax(0, 1fr);
		}
		.notices {
			grid-template-columns: minmax(0, 1fr);
		}
		.notices dd + dt {
			margin-top: 0.3rem;
		}
	}
</style>
