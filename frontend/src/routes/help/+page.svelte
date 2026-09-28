<script lang="ts">
	// The help landing page: the illustrated catchment tour, the setup path
	// through the workspace tabs, and the guides that explain the model. The
	// sidebar (search, every guide, the glossary) is the help layout's.
	import { goto } from '$app/navigation';
	import { base } from '$app/paths';
	import { page } from '$app/state';
	import PictureTour from '$lib/components/help/PictureTour.svelte';
	import { HELP, helpFor } from '$lib/help/content';
	import { GUIDES, SETUP_STEPS, TAB_TITLES, guideFor } from '$lib/help/guides';
	import { TOUR } from '$lib/help/tour';

	const concepts = GUIDES.filter((g) => g.kind === 'concept');
	const start = GUIDES.find((g) => g.kind === 'start')!;

	// The glossary used to live here: /help#<term> links (old help tips,
	// bookmarks) go on to /help/glossary#<term>.
	$effect(() => {
		const id = decodeURIComponent(page.url.hash.slice(1));
		if (id && helpFor(id)) goto(`${base}/help/glossary#${id}`, { replaceState: true });
	});
</script>

<svelte:head><title>Help · Water Management</title></svelte:head>

<header class="hero">
	<p class="eyebrow">Help</p>
	<h1>How the catchment model works</h1>
	<p class="lede">
		Water Management follows a catchment’s water day by day: how much the rain produces, what each hydrological unit can
		irrigate, and whether the river keeps its ecological Reserve. Follow the numbered stops, open one to see that
		part up close, or go on to its guide.
	</p>
</header>

<section aria-labelledby="tour-h" class="block">
	<h2 id="tour-h" class="visually-hidden">Follow the water</h2>
	<PictureTour shot="catchment" stops={TOUR} />
</section>

<section aria-labelledby="setup-h" class="block">
	<div class="block-head">
		<h2 id="setup-h">Set up a catchment</h2>
		<a href="{base}/help/guides/{start.id}">{start.title} →</a>
	</div>
	<p class="muted intro">One step per tab, in the order a project’s <strong>Build the model</strong> section lists them. The project’s Summary keeps a checklist of them.</p>
	<ol class="steps">
		{#each SETUP_STEPS as step, i (step.tab)}
			{@const guide = guideFor(step.guide)}
			<li>
				<span class="n" aria-hidden="true">{i + 1}</span>
				<a href="{base}/help/guides/{step.guide}" aria-describedby="step-{i}">{TAB_TITLES[step.tab]}</a>
				<p id="step-{i}">
					{#if step.optional}<span class="opt">Optional.</span>{/if}
					{step.text}{#if guide}<span class="visually-hidden"> Guide: {guide.title}.</span>{/if}
				</p>
			</li>
		{/each}
	</ol>
</section>

<section aria-labelledby="model-h" class="block">
	<div class="block-head">
		<h2 id="model-h">Understand the model</h2>
		<a href="{base}/help/glossary">Glossary, {HELP.length} terms →</a>
	</div>
	<ul class="concepts">
		{#each concepts as g (g.id)}
			<li>
				<a href="{base}/help/guides/{g.id}">{g.title}</a>
				<p>{g.summary}</p>
			</li>
		{/each}
	</ul>
</section>

<style>
	.hero {
		max-width: 46rem;
	}
	.eyebrow {
		margin: 0;
		color: var(--accent);
		font-size: 0.8rem;
		font-weight: 600;
		letter-spacing: 0.05em;
		text-transform: uppercase;
	}
	h1 {
		margin: 0.2rem 0 0.5rem;
		font-size: clamp(1.5rem, 1.2rem + 1.2vw, 2rem);
	}
	.lede {
		margin: 0;
		color: var(--text-2);
		font-size: 1.02rem;
		line-height: 1.55;
	}
	.block {
		margin-top: 2rem;
	}
	.block + .block {
		padding-top: 1.75rem;
		border-top: 1px solid var(--border);
	}
	.block-head {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		justify-content: space-between;
		gap: 0.25rem 1rem;
	}
	.block-head h2 {
		margin: 0;
		font-size: 1.25rem;
	}
	.block-head a {
		font-size: 0.9rem;
		font-weight: 600;
	}
	.intro {
		margin: 0.35rem 0 1rem;
	}
	/* The setup path: numbered steps joined by a line, like a route. A
	   column on phones (the line runs down), four across on wider screens
	   (the line runs along each row). */
	.steps {
		display: grid;
		gap: 1rem;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.steps li {
		position: relative;
		padding-left: 2.5rem;
	}
	.steps li::before {
		content: '';
		position: absolute;
		top: 1.9rem;
		bottom: -1rem;
		left: 0.8rem;
		width: 2px;
		background: var(--border-strong);
	}
	.steps li:last-child::before {
		display: none;
	}
	@media (min-width: 48rem) {
		.steps {
			grid-template-columns: repeat(4, minmax(0, 1fr));
			gap: 1.5rem 1rem;
		}
		.steps li {
			padding: 2.25rem 0 0;
		}
		.steps li::before {
			top: 0.8rem;
			bottom: auto;
			left: 1.9rem;
			right: -1rem;
			width: auto;
			height: 2px;
		}
		.steps li:nth-child(4n)::before {
			display: none;
		}
	}
	.n {
		position: absolute;
		top: 0;
		left: 0;
		display: grid;
		place-items: center;
		width: 1.65rem;
		height: 1.65rem;
		border-radius: 50%;
		background: var(--accent);
		color: var(--accent-contrast);
		font-size: 0.8rem;
		font-weight: 700;
	}
	.steps a {
		font-weight: 600;
	}
	.opt {
		color: var(--text-muted);
		font-style: italic;
	}
	.steps p {
		margin: 0.25rem 0 0;
		color: var(--text-2);
		font-size: 0.875rem;
		line-height: 1.45;
	}
	/* The model guides: a two-column list, not a wall of cards. */
	.concepts {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(18rem, 1fr));
		gap: 0 2rem;
		margin: 0.75rem 0 0;
		padding: 0;
		list-style: none;
	}
	.concepts li {
		padding: 0.75rem 0;
		border-bottom: 1px solid var(--border);
	}
	.concepts a {
		font-weight: 600;
	}
	.concepts p {
		margin: 0.2rem 0 0;
		color: var(--text-2);
		font-size: 0.9rem;
	}
</style>
