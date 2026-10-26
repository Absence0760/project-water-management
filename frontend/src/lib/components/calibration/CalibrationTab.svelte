<!--
	The Calibration page (`?tab=calibration`, issue #586): fitting the runoff
	parameters and judging the fit, on one page. Its two parts are "Set up the
	fit" (Flow calibration, Calibration record, Fit the parameters, WR2012 check:
	settings/CalibrationSettings.svelte, moved here from Settings in round 3) and
	"How the shown run fits" (Model quality, moved here from Runs & results in
	round 3: CalibrationResults.svelte, a run picker that follows `?run=` and
	Model quality for that run). The settings panels edit the workspace's one
	settings draft, so Model settings' edits and these save together from the one
	save bar, and the header carries the fit's line and its way to Fit the
	parameters (they were Settings'). A side index lists the two parts.
	`?tab=calibration` opened Settings until this page had its own, so an old
	`#set-…` link to a panel still there goes on there (nav/anchorMoves.ts); a
	link to one of these panels (#set-fit, #set-evaporation, #res-hydrograph…)
	lands here.
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
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
	import { isModelQualityAnchor } from '#lib/components/runs/modelQuality.js';
	import CalibrationResults from './CalibrationResults.svelte';
	import { calibrationNavGroups, isCalPart } from './page';
	import { apanFingerprint } from './apanFingerprint';

	let {
		runs,
		role,
		projectId,
		nodes = [],
		series = null,
		projectSettings = null,
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
		projectId: string;
		/** The model's nodes (the editor's), for How the shown run fits' names and order. */
		nodes?: readonly { id: string; name: string }[];
		/** The project's input series: a checks-only gauge links to its record on Data. */
		series?: readonly { id: string; kind: string; siteNodeId?: string | null }[] | null;
		/** The project's settings: a run that kept no snapshot of its own is scored on their calibration window. */
		projectSettings?: { calibrationStart?: string | null; calibrationEnd?: string | null } | null;
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

	const navGroups = calibrationNavGroups();
	/** How the shown run fits' landing (CalibrationResults.svelte): a Model quality anchor waits there for the run. */
	let landResults: ((id: string) => (() => void) | void) | null = null;

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
	// entry so Back skips it (nav/anchorMoves.ts). A link to a Model quality panel (`#res-plausibility`, an old
	// `?tab=runs#res-…` sent on here) lands once the run is shown.
	let body: HTMLDivElement | undefined = $state();
	onMount(() =>
		followAnchors({
			page: 'calibration',
			land: (id) =>
				isCalPart(id) && body ? landOnAnchor(id, body) : isCalibrationAnchor(id) ? landOnAnchor(id) : isModelQualityAnchor(id) ? landResults?.(id) : undefined,
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
			Set up the fit, then read how the shown run fits below. Its edits save with Model settings’ from the one save bar.
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
	/* The parts one above the other: the settings panels' monthly rows need the page's full width. */
	.parts {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 1rem;
		align-items: start;
	}
	/* How the shown run fits takes the page's width: its charts need it. */
	.parts > #cal-fit {
		min-width: 0;
	}
	.part-h {
		margin: 0 0 0.75rem;
	}
</style>
