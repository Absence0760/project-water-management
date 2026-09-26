<script lang="ts">
	// Summary → "Needs attention" (issue #17 A1): what's worth acting on, as
	// coloured cards (overview/attention.ts). Each card is a title, a one-line
	// detail and its link to the tab that fixes it; the link covers the whole
	// card, and a second link (a farm's planted areas) sits above it. The tone
	// colours the card, but the title always says what's wrong. Not rendered
	// when empty.
	import type { AttentionItem } from './attention';

	let { items }: { items: AttentionItem[] } = $props();
</script>

{#if items.length}
	<section class="panel attention" aria-labelledby="attention-h">
		<div class="panel-head">
			<h2 id="attention-h">Needs attention</h2>
			<span class="muted">{items.length} item{items.length === 1 ? '' : 's'}</span>
		</div>
		<ul>
			{#each items as it (it.id)}
				<li class="card {it.tone}" data-attention={it.id} data-tone={it.tone}>
					<strong class="title">{it.title}</strong>
					<span class="detail" title={it.text}>{it.text}</span>
					<span class="links"
						><a class="main" href={it.href}>{it.action}</a>{#if it.also}<span class="also"
								>{' '}· <a href={it.also.href}>{it.also.action}</a></span
							>{/if}</span
					>
				</li>
			{/each}
		</ul>
	</section>
{/if}

<style>
	.attention {
		margin-bottom: 0;
	}
	.panel-head {
		margin-bottom: 0.6rem;
	}
	.panel-head h2 {
		font-size: 1.05rem;
	}
	ul {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 0.5rem;
	}
	.card {
		position: relative;
		display: grid;
		gap: 0.15rem;
		padding: 0.6rem 0.75rem;
		border-radius: var(--radius);
		border-left: 3px solid var(--border-strong);
		background: var(--surface-2);
		font-size: 0.85rem;
	}
	.card:hover {
		box-shadow: inset 0 0 0 1px var(--border-strong);
	}
	.card:has(a.main:focus-visible) {
		outline: 2px solid var(--focus);
		outline-offset: 2px;
	}
	.card.danger {
		background: var(--danger-soft);
		border-left-color: var(--danger);
	}
	.card.warning {
		background: var(--warning-soft);
		border-left-color: var(--warning);
	}
	.card.danger .title {
		color: var(--danger);
	}
	.card.warning .title {
		color: var(--warning);
	}
	.title {
		font-size: 0.9rem;
	}
	/* One or two lines: a long run warning is read in full on the Runs tab (and in the title tip). */
	.detail {
		color: var(--text-2);
		display: -webkit-box;
		-webkit-box-orient: vertical;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		overflow: hidden;
	}
	/* The links sit in text, so they are underlined (WCAG 1.4.1), never told apart by colour alone. */
	.links a {
		text-decoration: underline;
	}
	.links a.main:focus-visible {
		outline: none;
	}
	/* The main link covers the card, so the card is the click target. */
	.links a.main::after {
		content: '';
		position: absolute;
		inset: 0;
		border-radius: var(--radius);
	}
	.also a {
		position: relative;
		z-index: 1;
	}
</style>
