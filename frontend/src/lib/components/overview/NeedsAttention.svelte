<script lang="ts">
	// Overview → "Needs attention": what's worth acting on, each with a link to
	// the tab that fixes it (overview/attention.ts). Not rendered when empty.
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
				<li data-attention={it.id}>
					<span class="mark" aria-hidden="true">!</span>
					<span>{it.text} <a href={it.href}>{it.action}</a>{#if it.also}<span class="also"> · <a href={it.also.href}>{it.also.action}</a></span>{/if}</span>
				</li>
			{/each}
		</ul>
	</section>
{/if}

<style>
	.attention {
		margin-bottom: 1rem;
	}
	ul {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 0.45rem;
	}
	li {
		display: flex;
		align-items: baseline;
		gap: 0.5rem;
		font-size: 0.9rem;
	}
	/* The action link sits in running text, so it is underlined like links in
	   paragraphs (app.css), not told apart by colour alone (WCAG 1.4.1). */
	li a {
		text-decoration: underline;
	}
	/* A shape as well as a colour: the text says what's wrong either way. */
	.mark {
		flex: none;
		display: inline-grid;
		place-items: center;
		width: 1.1rem;
		height: 1.1rem;
		border-radius: 50%;
		font-size: 0.72rem;
		font-weight: 700;
		color: var(--warning);
		border: 1.5px solid var(--warning);
		transform: translateY(-0.05rem);
	}
</style>
