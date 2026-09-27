<script lang="ts">
	// The frame of the legal pages (/privacy, /terms): outside the app shell,
	// like the landing page. A slim header with the way home, a readable
	// column, a contents list, and the footer links. Prerendered (their
	// +page.ts), so they read before any script runs and for anyone, signed in
	// or not. English only: the English text is the binding version
	// (docs/legal-status.md).
	import type { Snippet } from 'svelte';
	import { base } from '$app/paths';
	import BrandMark from '$lib/components/layout/BrandMark.svelte';

	let {
		title,
		description,
		effective,
		sections,
		children
	}: { title: string; description: string; effective: string; sections: { id: string; label: string }[]; children: Snippet } = $props();
</script>

<svelte:head>
	<title>{title} · Water Management</title>
	<meta name="description" content={description} />
</svelte:head>

<div class="legal">
	<header class="top">
		<a class="lockup" href="{base}/" aria-label="Water Management, home">
			<BrandMark size={28} />
			<span>Water Management</span>
		</a>
		<a class="btn" href="{base}/login">Sign in</a>
	</header>

	<main class="doc">
		<h1>{title}</h1>
		<p class="effective">{effective}</p>
		<nav class="toc" aria-label="Contents">
			<ol>
				{#each sections as s (s.id)}<li><a href="#{s.id}">{s.label}</a></li>{/each}
			</ol>
		</nav>
		{@render children()}
	</main>

	<footer class="foot">
		<nav aria-label="Legal">
			<a href="{base}/">Home</a>
			<a href="{base}/privacy">Privacy notice</a>
			<a href="{base}/terms">Terms of use</a>
			<a href="mailto:jared@jaredhoward.com">Contact</a>
		</nav>
	</footer>
</div>

<style>
	:global(html:has(.legal)) {
		background: var(--bg);
	}
	.legal {
		min-height: 100vh;
		background: var(--bg);
		color: var(--text);
	}
	.top {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		max-width: 52rem;
		margin-inline: auto;
		padding: 1rem var(--gutter);
	}
	.lockup {
		display: inline-flex;
		align-items: center;
		gap: 0.55rem;
		color: var(--text);
		font-family: var(--font-display);
		font-weight: 600;
		font-size: 1.05rem;
		text-decoration: none;
	}
	.doc {
		display: block;
		max-width: 52rem;
		margin-inline: auto;
		padding: 1.5rem var(--gutter) 3rem;
		line-height: 1.65;
	}
	h1 {
		margin: 0 0 0.25rem;
		font-family: var(--font-display);
		font-size: clamp(1.9rem, 4vw, 2.5rem);
		letter-spacing: -0.015em;
	}
	.effective {
		margin: 0 0 1.5rem;
		color: var(--text-muted);
	}
	.toc {
		margin: 0 0 2rem;
		padding: 1rem 1.25rem;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--surface);
	}
	/* The labels carry their section numbers. */
	.toc ol {
		margin: 0;
		padding-left: 0;
		list-style: none;
		columns: 2 16rem;
	}
	/* 24 px targets (WCAG 2.5.8): the list is dense. */
	.toc a {
		display: inline-block;
		min-height: 24px;
		padding-block: 0.1rem;
	}
	.doc :global(h2) {
		margin: 2.25rem 0 0.5rem;
		font-family: var(--font-display);
		font-size: 1.3rem;
		scroll-margin-top: 1rem;
	}
	.doc :global(h3) {
		margin: 1.25rem 0 0.25rem;
		font-size: 1.02rem;
	}
	.doc :global(p),
	.doc :global(li) {
		max-width: 68ch;
	}
	.doc :global(table) {
		width: 100%;
		margin: 0.75rem 0 1rem;
		border-collapse: collapse;
		font-size: 0.92rem;
	}
	.doc :global(th),
	.doc :global(td) {
		padding: 0.5rem 0.6rem;
		border: 1px solid var(--border);
		text-align: left;
		vertical-align: top;
	}
	.doc :global(th) {
		background: var(--surface-2);
	}
	.doc :global(.table-wrap) {
		overflow-x: auto;
	}
	.doc :global(.caps) {
		font-size: 0.92rem;
	}
	.foot {
		border-top: 1px solid var(--border);
		padding: 1.5rem var(--gutter) 2.5rem;
	}
	.foot nav {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem 1.5rem;
		max-width: 52rem;
		margin-inline: auto;
	}
</style>
