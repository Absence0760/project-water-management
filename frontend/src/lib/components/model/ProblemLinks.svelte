<script lang="ts">
	// The problems that block a save, each a link to where it is fixed (the
	// save bar, the save row of a sheet or grid): the first few, then a button
	// for the rest. `id` lets the disabled Save point at the list
	// (aria-describedby), so a screen reader hears why it can't save.
	import type { ProblemLink } from './pageDraft';

	let { problems, id, max = 3 }: { problems: readonly ProblemLink[]; id: string; max?: number } = $props();

	let all = $state(false);
	/**
	 * A link to something on this page (`#id`): an invalid number takes the focus itself; a group (a
	 * Settings panel, `#set-rain`) is scrolled to and its heading takes it, not just scrolled to.
	 */
	function follow(e: MouseEvent, href: string) {
		if (!href.startsWith('#')) return;
		const el = document.getElementById(href.slice(1));
		if (!el) return;
		e.preventDefault();
		const field = el.matches('input, select, textarea, button, [tabindex]');
		const target = field ? el : (el.querySelector<HTMLElement>('h2, h3') ?? el);
		if (!field && !target.hasAttribute('tabindex')) target.tabIndex = -1;
		(field ? el : target).scrollIntoView({ block: field ? 'center' : 'start' });
		target.focus({ preventScroll: true });
	}
	const shown = $derived(all ? problems : problems.slice(0, max));
</script>

{#if problems.length}
	<div class="problems" {id}>
		<span class="lead">Fix before saving:</span>
		<ul>
			{#each shown as p, i (i)}<li><a href={p.href} data-sveltekit-noscroll onclick={(e) => follow(e, p.href)}>{p.message}</a></li>{/each}
			{#if problems.length > max}
				<li><button type="button" class="more" aria-expanded={all} onclick={() => (all = !all)}>{all ? 'Show fewer' : `and ${problems.length - max} more`}</button></li>
			{/if}
		</ul>
	</div>
{/if}

<style>
	.problems {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 0.15rem 0.5rem;
		font-size: 0.85rem;
		max-height: 30vh;
		overflow-y: auto;
	}
	.lead {
		color: var(--danger);
		font-weight: 600;
	}
	ul {
		display: flex;
		flex-wrap: wrap;
		gap: 0.15rem 1rem;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	li {
		min-height: 24px;
		display: flex;
		align-items: center;
	}
	a {
		text-decoration: underline;
	}
	.more {
		min-height: 24px;
		padding: 0 0.25rem;
		border: 0;
		background: none;
		color: var(--accent);
		text-decoration: underline;
		cursor: pointer;
		font: inherit;
	}
</style>
