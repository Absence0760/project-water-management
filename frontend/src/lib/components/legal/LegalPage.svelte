<script lang="ts">
	// The frame of the legal pages (/privacy, /terms) and the methods page
	// (/methods, the engine audit's public summary): outside the app shell,
	// like the landing page. A slim header whose logo is the way home (no
	// second button: issue #162), then the Help shell's layout at its width
	// (1480 px): from 900 px the contents list is a column on the left that
	// stays in view while reading, the text beside it. The extra width goes to
	// the contents, not to longer lines: paragraphs keep a ~68ch measure; only
	// tables use the column's width. Below 900 px the contents sit above the
	// text, folded on a phone (thirteen entries took the whole first screen).
	// The footer's links line up with the text column. Pure CSS, no script:
	// prerendered (their +page.ts), so they read before any script runs and
	// for anyone, signed in or not. English only: the English text is the
	// binding version (docs/legal-status.md).
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
	</header>

	<main class="doc">
		<div class="head">
			<h1>{title}</h1>
			<p class="effective">{effective}</p>
		</div>
		<!-- A disclosure on a phone; above 600 px the list shows and the toggle
		     doesn't, where the browser can style the details' content (the
		     @supports below); elsewhere it stays a working disclosure. From
		     900 px it is the sticky column beside the text. -->
		<nav class="toc" aria-label="Contents">
			<details>
				<summary>Contents <span class="count">({sections.length} sections)</span></summary>
				<ol>
					{#each sections as s (s.id)}<li><a href="#{s.id}">{s.label}</a></li>{/each}
				</ol>
			</details>
		</nav>
		<div class="body">
			{@render children()}
		</div>
	</main>

	<footer class="foot">
		<nav aria-label="Site">
			<a href="{base}/">Home</a>
			<a href="{base}/privacy">Privacy notice</a>
			<a href="{base}/terms">Terms of use</a>
			<a href="{base}/methods">How the model is checked</a>
			<!-- The address is written once, in the terms' contact section. -->
			<a href="{base}/terms#contact">Contact</a>
		</nav>
	</footer>
</div>

<style>
	:global(html:has(.legal)) {
		background: var(--bg);
	}
	/* The Help shell's width and contents column (help/+layout.svelte). The
	   header, the text and the footer share one frame, so the logo, the
	   contents and the footer's links start on one line, and the footer's
	   links line up with the text column above them. */
	.legal {
		--frame: 1480px;
		--toc-w: 14rem;
		--toc-gap: 3rem;
		min-height: 100vh;
		background: var(--bg);
		color: var(--text);
	}
	.top,
	.doc,
	.foot nav {
		max-width: var(--frame);
		margin-inline: auto;
		padding-inline: var(--gutter);
	}
	.top {
		display: flex;
		align-items: center;
		gap: 1rem;
		padding-block: 1rem;
	}
	.lockup {
		display: inline-flex;
		align-items: center;
		gap: 0.55rem;
		min-height: var(--tap);
		color: var(--text);
		font-family: var(--font-display);
		font-weight: 600;
		font-size: 1.05rem;
		text-decoration: none;
	}
	.doc {
		display: block;
		padding-block: 1.5rem 3rem;
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
	.toc summary {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		min-height: var(--tap);
		margin: -0.5rem 0;
		font-weight: 600;
		cursor: pointer;
	}
	.toc summary .count {
		font-weight: 400;
		color: var(--text-muted);
	}
	.toc details[open] summary {
		margin-bottom: 0.25rem;
	}
	@media (min-width: 601px) {
		@supports selector(::details-content) {
			.toc summary {
				display: none;
			}
			.toc details::details-content {
				content-visibility: visible;
			}
		}
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
	/* Wide: the contents column on the left, in view while reading (like the
	   Help menu); it scrolls on its own only when taller than the window. The
	   title and the text share the column beside it. */
	@media (min-width: 900px) {
		.doc {
			display: grid;
			grid-template-columns: var(--toc-w) minmax(0, 1fr);
			column-gap: var(--toc-gap);
			align-items: start;
		}
		.head,
		.body {
			grid-column: 2;
		}
		.toc {
			grid-column: 1;
			grid-row: 1 / span 2;
			position: sticky;
			top: 1.25rem;
			max-height: calc(100vh - 2.5rem);
			overflow-y: auto;
			overscroll-behavior: contain;
			scrollbar-width: thin;
			margin: 0;
			padding: 0.25rem 0 0.25rem 0.9rem;
			border: none;
			border-left: 1px solid var(--border);
			border-radius: 0;
			background: none;
			line-height: 1.4;
		}
		.toc ol {
			columns: auto;
		}
		.toc li + li {
			margin-top: 0.3rem;
		}
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
	/* The contents' items aren't lines of text: no measure there. */
	.doc .toc li {
		max-width: none;
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
	.foot {
		border-top: 1px solid var(--border);
		padding-block: 1.5rem 2.5rem;
	}
	.foot nav {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem 1.5rem;
	}
	/* 24 px targets (WCAG 2.5.8). */
	.foot a {
		display: inline-block;
		min-height: 24px;
		padding-block: 0.1rem;
	}
	@media (min-width: 900px) {
		.foot nav {
			padding-left: calc(var(--gutter) + var(--toc-w) + var(--toc-gap));
		}
	}
</style>
