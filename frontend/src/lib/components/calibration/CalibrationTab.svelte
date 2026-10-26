<!--
	The Calibration page (`?tab=calibration`, issue #586): fitting the runoff
	parameters and judging the fit, on one page. Its two parts are "Set up the
	fit" (Flow calibration, Calibration record, Fit the parameters, WR2012 check,
	from Settings & calibration) and "How the shown run fits" (Model quality, moved
	here from Runs & results in Round 3: CalibrationResults.svelte, a run picker
	that follows `?run=` and Model quality for that run). A side index lists the
	two parts. `?tab=calibration` opened Settings
	until this page had its own, so an old `#set-…` link goes on there
	(nav/anchorMoves.ts).
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import type { Role, RunMeta } from '#lib/api/types.js';
	import SectionNav from '#lib/components/common/SectionNav.svelte';
	import { fillHeader } from '#lib/components/workspace/headerSlot.svelte.js';
	import { landOnAnchor } from '#lib/help/anchor.js';
	import { followAnchors } from '#lib/nav/anchorLanding.js';
	import { isModelQualityAnchor } from '#lib/components/runs/modelQuality.js';
	import CalibrationResults from './CalibrationResults.svelte';
	import { calibrationNavGroups, isCalPart, settingsHref, SETUP_LINKS } from './page';

	let {
		runs,
		role,
		projectId,
		nodes = [],
		series = null,
		projectSettings = null
	}: {
		runs: RunMeta[] | null;
		role: Role | null | undefined;
		projectId: string;
		/** The model's nodes (the editor's), for How the shown run fits' names and order. */
		nodes?: readonly { id: string; name: string }[];
		/** The project's input series: a checks-only gauge links to its record on Data. */
		series?: readonly { id: string; kind: string; siteNodeId?: string | null }[] | null;
		/** The project's settings: a run that kept no snapshot of its own is scored on their calibration window. */
		projectSettings?: { calibrationStart?: string | null; calibrationEnd?: string | null } | null;
	} = $props();

	const navGroups = calibrationNavGroups();
	/** How the shown run fits' landing (CalibrationResults.svelte): a Model quality anchor waits there for the run. */
	let landResults: ((id: string) => (() => void) | void) | null = null;

	$effect(() => fillHeader({ context: headerContext }));

	// A link to one of the parts (`#cal-fit`), on load or followed while the page is open: the tab is a lazy
	// chunk, so the browser's own jump found nothing. Land on it and focus its heading (landOnAnchor, as
	// Settings, Runs and Project do). An old `?tab=calibration#set-ewr` (when this tab opened Settings) goes
	// on to that panel there instead, replacing this entry so Back skips it (nav/anchorMoves.ts). A link to a Model
	// quality panel (`#res-plausibility`, an old `?tab=runs#res-…` sent on here) lands once the run is shown.
	let body: HTMLDivElement | undefined = $state();
	onMount(() =>
		followAnchors({
			page: 'calibration',
			land: (id) => (isCalPart(id) && body ? landOnAnchor(id, body) : isModelQualityAnchor(id) ? landResults?.(id) : undefined),
			forward: (to) => void goto(to, { replace: true, reset: false })
		})
	);
</script>

{#snippet headerContext()}<span data-testid="calibration-context">Fit the runoff parameters to observed flow, then judge the fit</span>{/snippet}

<!-- The side index from 80rem of page (a 1440 px window), as Project and Data; the bar below that. -->
<SectionNav groups={navGroups} label="Calibration sections" railFrom={80}>
	<div class="cal-page" bind:this={body}>
		<p class="lead" data-testid="calibration-lead">
			The calibration panels are moving to this page. Until they arrive, set up the fit on
			<a href="?tab=settings">Settings &amp; calibration</a>; how a run fits is below.
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
			<!-- Model quality's panels are panels of their own, so this part is a heading over them, not a panel round them. -->
			<section class="part" id="cal-fit" aria-labelledby="cal-fit-h">
				<h2 id="cal-fit-h" class="part-h">How the shown run fits</h2>
				<CalibrationResults {projectId} {runs} {role} {nodes} {series} {projectSettings} landing={(land) => (landResults = land)} />
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
	/* How the shown run fits takes the page's width: its charts need it. */
	.parts > #cal-fit {
		grid-column: 1 / -1;
		min-width: 0;
	}
	.part-h {
		margin: 0 0 0.75rem;
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
</style>
