<!--
	The Calibration page (`?tab=calibration`, issue #586): fitting the runoff
	parameters and judging the fit, on one page. Its two parts are "Set up the
	fit" (Flow calibration, Calibration record, Fit the parameters, WR2012 check,
	from Settings & calibration) and "How the shown run fits" (Model quality, from
	Runs & results, for the run picked there). Until Round 3 moves those panels
	in, each part links to them where they are, named by their headings, each
	link landing on its heading; the links to Runs & results keep the run picked
	(`run=`). A side index lists the two parts. `?tab=calibration` opened Settings
	until this page had its own, so an old `#set-…` link goes on there
	(calibrationForward).
-->
<script lang="ts">
	import { onDestroy, onMount, untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import type { Role, RunMeta } from '#lib/api/types.js';
	import SectionNav from '#lib/components/common/SectionNav.svelte';
	import { fillHeader } from '#lib/components/workspace/headerSlot.svelte.js';
	import { hashId, landOnAnchor } from '#lib/help/anchor.js';
	import { fmtWhen } from '#lib/format/number.js';
	import { calibrationForward, calibrationNavGroups, isCalPart, RESULT_LINKS, runsHref, settingsHref, SETUP_LINKS, shownRun } from './page';

	let { runs, role }: { runs: RunMeta[] | null; role: Role | null | undefined } = $props();

	const picked = $derived(page.url.searchParams.get('run'));
	const run = $derived(shownRun(runs, picked, role));
	// The links carry the run only when one was picked: without it Runs & results shows its default, as here.
	const carried = $derived(run && picked === run.id ? run.id : null);
	const navGroups = calibrationNavGroups();

	$effect(() => fillHeader({ context: headerContext }));

	// An old `?tab=calibration#set-ewr` (when this tab opened Settings) goes on to that panel there,
	// replacing this entry so Back skips it; Settings lands on the panel. On load, and for such a link
	// followed while the page is open.
	$effect(() => {
		const to = calibrationForward(page.url);
		if (to) untrack(() => void goto(to, { replace: true, reset: false }));
	});

	// A link to one of the parts (`#cal-fit`): the tab is a lazy chunk, so the browser's own jump found
	// nothing. Land on it and focus its heading (landOnAnchor, as Settings, Runs and Project do).
	let body: HTMLDivElement | undefined = $state();
	let stopLanding = () => {};
	onMount(() => {
		const hash = hashId(page.url.hash);
		if (isCalPart(hash) && body) stopLanding = landOnAnchor(hash, body);
	});
	onDestroy(() => stopLanding());
</script>

{#snippet headerContext()}<span data-testid="calibration-context">Fit the runoff parameters to observed flow, then judge the fit</span>{/snippet}

<!-- The side index from 80rem of page (a 1440 px window), as Project and Data; the bar below that. -->
<SectionNav groups={navGroups} label="Calibration sections" railFrom={80}>
	<div class="cal-page" bind:this={body}>
		<p class="lead" data-testid="calibration-lead">
			The calibration panels are moving to this page. Until they arrive, set up the fit on
			<a href="?tab=settings">Settings &amp; calibration</a> and read how a run fits on
			<a href={carried ? `?tab=runs&run=${encodeURIComponent(carried)}` : '?tab=runs'}>Runs &amp; results</a>.
		</p>
		<div class="parts">
			<section class="panel" id="cal-setup" aria-labelledby="cal-setup-h">
				<div class="panel-head"><h2 id="cal-setup-h">Set up the fit</h2></div>
				<p class="where">On Settings &amp; calibration:</p>
				<ul class="links">
					{#each SETUP_LINKS as l (l.id)}
						<li><a href={settingsHref(l.id)}>{l.label}</a><span class="hint">{l.hint}</span></li>
					{/each}
				</ul>
			</section>
			<section class="panel" id="cal-fit" aria-labelledby="cal-fit-h">
				<div class="panel-head"><h2 id="cal-fit-h">How the shown run fits</h2></div>
				{#if runs && !run}
					<p class="where" data-testid="calibration-no-run">
						No run yet. Once the model has run, its fit is on <a href="?tab=runs">Runs &amp; results</a>, under Model quality.
					</p>
				{:else}
					<p class="where" data-testid="calibration-run">
						On Runs &amp; results, under Model quality{#if run}, for <strong>{run.label || 'Untitled run'}</strong> (ran {fmtWhen(run.createdAt)}){/if}:
					</p>
					<ul class="links">
						{#each RESULT_LINKS as l (l.id)}
							<li><a href={runsHref(l.id, carried)}>{l.label}</a><span class="hint">{l.hint}</span></li>
						{/each}
					</ul>
					<p class="muted more">The rest of Model quality follows them there, for the runs that have it: the runoff model, rain for each unit, the WR2012 check and the plausibility checks.</p>
				{/if}
			</section>
		</div>
	</div>
</SectionNav>

<style>
	/* The parts answer to the page's width, not the window's (the sidebar and the side index take some). */
	.cal-page {
		container: cal-page / inline-size;
	}
	.lead {
		margin: 0 0 1rem;
		max-width: 75ch;
	}
	.parts {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 1rem;
		align-items: start;
	}
	.parts > .panel {
		margin-bottom: 0;
	}
	@container cal-page (max-width: 760px) {
		.parts {
			grid-template-columns: minmax(0, 1fr);
		}
	}
	.where {
		margin: 0 0 0.5rem;
	}
	.links {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 0.15rem;
	}
	.links li {
		display: flex;
		flex-direction: column;
		padding: 0.35rem 0;
		border-top: 1px solid var(--border);
	}
	.links li:first-child {
		border-top: 0;
	}
	/* A link the size of a target (WCAG 2.5.8), its line of what it holds under it. */
	.links a {
		font-weight: 600;
		min-height: 24px;
		display: inline-flex;
		align-items: center;
		align-self: flex-start;
	}
	.hint {
		color: var(--text-muted);
		font-size: 0.875rem;
	}
	.more {
		margin: 0.75rem 0 0;
		font-size: 0.875rem;
	}
</style>
