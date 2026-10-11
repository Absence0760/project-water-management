<script lang="ts">
	// File formats (issue #477; docs/ui.md § Expected format): every file and
	// paste box's Expected format in one place, open, each with its example
	// files, grouped by the page its box is on. The words are the same
	// objects the note beside each box shows ($lib/help/fileFormats.ts), and
	// each note links here (`/help/formats#<id>`).
	import { base } from '$app/paths';
	import FormatBody from '$lib/components/common/FormatBody.svelte';
	import HelpCrumbs from '$lib/components/help/HelpCrumbs.svelte';
	import { FORMAT_GROUPS } from '$lib/help/fileFormats';
</script>

<svelte:head><title>File formats · Help · Water Management</title></svelte:head>

<HelpCrumbs trail={[{ label: 'Help', href: `${base}/help` }, { label: 'Reference' }, { label: 'File formats' }]} />
<header class="head">
	<h1>File formats</h1>
	<p class="lede">
		What each upload and paste box reads: the file types, the columns and units, and an example file to download and start
		from. The same note sits beside each box as <em>Expected format</em>. The example files hold invented names and values.
	</p>
</header>

<nav aria-labelledby="formats-contents-h" class="contents">
	<h2 id="formats-contents-h" class="visually-hidden">Contents</h2>
	<ul>
		{#each FORMAT_GROUPS as g (g.id)}
			<li>
				<span class="g">{g.title}</span>
				<ul>
					{#each g.formats as f (f.id)}<li><a href="#{f.id}">{f.title}</a></li>{/each}
				</ul>
			</li>
		{/each}
	</ul>
</nav>

{#each FORMAT_GROUPS as g (g.id)}
	<section aria-labelledby="formats-{g.id}" class="group">
		<h2 id="formats-{g.id}">{g.title}</h2>
		{#each g.formats as f (f.id)}
			<article id={f.id} class="format" aria-labelledby="{f.id}-h" data-testid="file-format">
				<h3 id="{f.id}-h">{f.title}</h3>
				<p class="where">Where: {f.where}</p>
				<FormatBody format={f} />
			</article>
		{/each}
	</section>
{/each}

<style>
	.head {
		max-width: 46rem;
		margin-bottom: 1.25rem;
	}
	/* The size of every help page's title (guides, search). */
	h1 {
		margin: 0 0 0.4rem;
		font-size: clamp(1.5rem, 1.2rem + 1.2vw, 2rem);
	}
	.lede {
		margin: 0;
		color: var(--text-2);
	}
	.contents {
		max-width: 46rem;
		margin-bottom: 1.5rem;
		font-size: 0.9rem;
	}
	.contents ul {
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.contents > ul {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(16rem, 1fr));
		gap: 0.75rem 2rem;
	}
	.g {
		font-weight: 600;
	}
	/* 24 px targets (WCAG 2.2 SC 2.5.8). */
	.contents a {
		display: inline-block;
		min-height: 24px;
		padding: 0.1rem 0;
	}
	.group {
		max-width: 46rem;
		margin-bottom: 2rem;
	}
	.group h2 {
		font-size: 1.2rem;
		margin: 0 0 0.75rem;
		padding-bottom: 0.25rem;
		border-bottom: 1px solid var(--border);
	}
	.format {
		margin-bottom: 1.5rem;
		font-size: 0.9rem;
		scroll-margin-top: 1rem;
	}
	.format h3 {
		font-size: 1rem;
		margin: 0 0 0.15rem;
	}
	.where {
		margin: 0 0 0.4rem;
		color: var(--text-muted);
		font-size: 0.85rem;
	}
</style>
