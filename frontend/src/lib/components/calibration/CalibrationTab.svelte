<!--
	The Calibration page (`?tab=calibration`, issue #586): fitting the runoff
	parameters and judging the fit, on one page. Its two parts are "Set up the
	fit" (Flow calibration, Calibration record, Fit the parameters, WR2012 check:
	settings/CalibrationSettings.svelte, moved here from Settings in round 3) and
	"How the shown run fits" (Model quality, from Runs & results, for the run
	picked there). The settings panels edit the workspace's one settings draft,
	so Model settings' edits and these save together from the one save bar, and
	the header carries the fit's line and its way to Fit the parameters (they
	were Settings'). A side index lists the two parts. `?tab=calibration` opened
	Settings until this page had its own, so an old `#set-…` link to a panel
	still there goes on there (nav/anchorMoves.ts); a link to one of these
	panels (#set-fit, #set-evaporation…) lands here.
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { fitRecordCaveats, fitRecordStatus, type ApanDailyFingerprint, type ProjectSettings, type SeriesMeta, type SeriesOrigin, type SeriesProvenance } from '@water-management/engine';
	import type { Project, Role, RunMeta } from '#lib/api/types.js';
	import type { FitSession } from '#lib/calibration/fitSession.svelte.js';
	import SectionNav from '#lib/components/common/SectionNav.svelte';
	import ExplainSwitch from '#lib/components/common/ExplainSwitch.svelte';
	import { explainSwitch } from '#lib/components/common/explain.svelte.js';
	import CalibrationSettings from '#lib/components/settings/CalibrationSettings.svelte';
	import { fitSummary } from '#lib/components/settings/calibration.js';
	import { isCalibrationAnchor } from '#lib/components/settings/sections.js';
	import type { SettingsDraft } from '#lib/components/settings/settingsDraft.svelte.js';
	import type { ModelEditor } from '#lib/model/editor.svelte.js';
	import { fillHeader } from '#lib/components/workspace/headerSlot.svelte.js';
	import { landOnAnchor } from '#lib/help/anchor.js';
	import { followAnchors } from '#lib/nav/anchorLanding.js';
	import { fmtWhen } from '#lib/format/number.js';
	import { calibrationNavGroups, isCalPart, RESULT_LINKS, runsHref, shownRun } from './page';
	import { apanFingerprint } from './apanFingerprint';

	let {
		runs,
		role,
		project,
		editor,
		draft,
		fit,
		seriesKinds = null,
		gaugeRecords = null,
		chirpsSource,
		observedOrigins,
		apanSeries,
		flowRecordId = null,
		readonly,
		onProjectChange
	}: {
		runs: RunMeta[] | null;
		role: Role | null | undefined;
		project: Project;
		/** The model being edited (the catchment area's default, the gauges, unsaved edits a fit runs on). */
		editor?: ModelEditor;
		/** The workspace's one settings draft (settingsDraft.svelte.ts), Model settings' too: the page's save bar saves it. */
		draft: SettingsDraft;
		/** Fit automatically's session, held by the workspace page so a tab change keeps it (calibration/fitSession.svelte.ts). */
		fit: FitSession;
		/** Kinds of the project's input series, to limit the calibration flow choices. */
		seriesKinds?: string[] | null;
		/** The flow records attached to gauges inside the network, for the calibration site's choices; null = not known. */
		gaugeRecords?: { kind: string; siteNodeId: string }[] | null;
		/** The CHIRPS series' product and version a run would use (issue #40c); undefined when not known. */
		chirpsSource?: SeriesProvenance | null;
		/** Each observed record's source and given unit a run would read, by model-input key; undefined when not known. */
		observedOrigins?: Partial<Record<string, SeriesOrigin | null>>;
		/** The daily A-pan series a run would read (issue #45): null for none, undefined while the list loads. */
		apanSeries?: Pick<SeriesMeta, 'id' | 'updatedAt'> | null;
		/** A flow record the calibration can score against, for the link to where its site is set (the Data tab). */
		flowRecordId?: string | null;
		readonly: boolean;
		/** The server saved an automated fit or a proposal: the project as it now is. */
		onProjectChange: (p: Project) => void;
	} = $props();

	const picked = $derived(page.url.searchParams.get('run'));
	const run = $derived(shownRun(runs, picked, role));
	// The links carry the run only when one was picked: without it Runs & results shows its default, as here.
	const carried = $derived(run && picked === run.id ? run.id : null);
	const navGroups = calibrationNavGroups();

	// The daily A-pan series now, as the fit record fingerprints it (issue #45): fetched and hashed only when the record
	// tracked one, so "forcing changed since fit" can say whether it was replaced; once per version of the series
	// (apanFingerprint.ts), for the header and the fit record alike.
	const s = $derived(draft.s);
	let apanNow = $state<ApanDailyFingerprint | null | undefined>(undefined);
	const apanTracked = $derived(s.fitRecord?.forcing?.apanDaily !== undefined);
	$effect(() => {
		const meta = apanSeries;
		const tracked = apanTracked;
		apanNow = meta === null ? null : undefined;
		if (!meta || !tracked) return;
		let live = true;
		apanFingerprint(project.id, meta).then(
			(f) => {
				if (live) apanNow = f;
			},
			// Unknown, not "changed": the caveat then waits for a value it can compare.
			() => {
				if (live) apanNow = undefined;
			}
		);
		return () => {
			live = false;
		};
	});
	// The header (issue #17): where the parameters came from, and the way to the fit (Settings' until round 3).
	const fitStatus = $derived(s.fitRecord ? fitRecordStatus(s as unknown as ProjectSettings, s.fitRecord, { chirpsSource, apanDaily: apanNow }) : null);
	const summary = $derived(fitSummary(s.fitRecord, !!fitStatus && fitRecordCaveats(fitStatus).length > 0));
	$effect(() => fillHeader({ context: headerContext, actions: headerActions }));

	// A link to one of the parts (`#cal-fit`) or of the settings panels (`#set-fit`, `#set-evaporation`), on load or
	// followed while the page is open: the tab is a lazy chunk, so the browser's own jump found nothing. Land on it
	// and focus its heading (landOnAnchor, as Settings, Runs and Project do; it waits for a lazy panel). An old
	// `?tab=calibration#set-ewr` (when this tab opened Settings) goes on to that panel there instead, replacing this
	// entry so Back skips it (nav/anchorMoves.ts).
	let body: HTMLDivElement | undefined = $state();
	onMount(() =>
		followAnchors({
			page: 'calibration',
			land: (id) => (isCalPart(id) && body ? landOnAnchor(id, body) : isCalibrationAnchor(id) ? landOnAnchor(id) : undefined),
			forward: (to) => void goto(to, { replace: true, reset: false })
		})
	);
</script>

{#snippet headerContext()}<span data-testid="fit-summary">{summary}</span>{/snippet}
{#snippet headerActions()}
	{#if !readonly}<a class="btn" href="#set-fit">Fit the parameters</a>{:else if s.fitRecord}<a class="btn" href="#set-fit">Fit record</a>{/if}
{/snippet}

<!-- The side index from 80rem of page (a 1440 px window), as Project and Data; the bar below that. -->
<SectionNav groups={navGroups} label="Calibration sections" railFrom={80}>
	<div class="cal-page" bind:this={body}>
		<p class="lead" data-testid="calibration-lead">
			Set up the fit below; its edits save with Model settings’ from the one save bar. Until Model quality moves here, read how a run fits on
			<a href={carried ? `?tab=runs&run=${encodeURIComponent(carried)}` : '?tab=runs'}>Runs &amp; results</a>.
		</p>
		<div class="parts">
			<!-- The settings panels that set up a fit (issue #586 round 3). Their wrapper gives them the settings pages'
			     frame (app.css `.settings-form`) and the explanations switch, as on Model settings. A viewer reads them
			     with every field read-only and no fit controls (`readonly`, as on Model settings). -->
			<section class="cal-part" id="cal-setup" aria-labelledby="cal-setup-h">
				<h2 id="cal-setup-h" class="part-h">Set up the fit</h2>
				<div class="settings-form explain-scope" class:explained={explainSwitch.on}>
					<ExplainSwitch />
					<CalibrationSettings
						{project}
						{editor}
						{draft}
						{fit}
						{seriesKinds}
						{gaugeRecords}
						{chirpsSource}
						{observedOrigins}
						apanDaily={apanNow}
						{flowRecordId}
						{readonly}
						{onProjectChange}
					/>
				</div>
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
	/* The parts one above the other: the settings panels' monthly rows need the page's full width. */
	.parts {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 1rem;
		align-items: start;
	}
	.parts > .panel {
		margin-bottom: 0;
	}
	.part-h {
		margin: 0 0 0.75rem;
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
