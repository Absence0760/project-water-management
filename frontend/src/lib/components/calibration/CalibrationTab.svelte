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
	parameters (they were Settings'), once: no panel repeats them (C19). The
	parts are the page's h2s, their panels h3s under them. A side index lists
	the panels under the two parts, the second part's for the run shown.
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
	import type { RunSummary } from '@water-management/engine';
	import { calibrationNavGroups, isCalPart, isCalSubsection, type CalShown } from './page';
	import { apanFingerprint, et0Fingerprint } from './apanFingerprint';
	import { gr4jChanges, statusLine, type CalState } from './status';
	import { hasRole } from '#lib/api/index.js';

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
		et0Series,
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
		/** The daily reference ET series a run would read (issue #604 R5-E): null for none, undefined while the list loads. */
		et0Series?: Pick<SeriesMeta, 'id' | 'updatedAt'> | null;
		/** A flow record the calibration can score against, for the link to where its site is set (the Data tab). */
		flowRecordId?: string | null;
		readonly: boolean;
		/** The server saved an automated fit or a proposal: the project as it now is. */
		onProjectChange: (p: Project) => void;
	} = $props();

	// The side index: the settings panels, then the shown run's Model quality panels and sub-headings (none until a run shows).
	let shown = $state.raw<{ summary: RunSummary; subs: CalShown } | null>(null);
	const navGroups = $derived(calibrationNavGroups(shown?.summary ?? null, shown?.subs ?? {}));
	/** An observed or logger flow record a run can be scored against (null while the series list loads), for the empty state. */
	const hasRecord = $derived(series ? series.some((x) => x.kind === 'flow_observed_m3s' || x.kind === 'flow_logger_m3s') : null);
	// The page's first line (status.ts): how the shown run fits, or why there's nothing to read yet, on the first
	// screen; the panels are long, so the scores were ~3,800 px down at 1440 × 960 (issue #586 R4-A).
	let calState = $state.raw<CalState>({ kind: 'loading' });
	let runGr4j = $state.raw<Record<string, number | null | undefined> | null>(null);
	/** The form's GR4J parameters that differ from the shown run's: said on the first line and over the run's results. */
	const changed = $derived(gr4jChanges(runGr4j, draft.s.gr4j));
	const status = $derived(statusLine(calState, hasRecord, hasRole(role, 'editor'), changed));
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
	// The daily reference ET series now (issue #604 R5-E), the same way and through the same per-version cache.
	let et0Now = $state<ApanDailyFingerprint | null | undefined>(undefined);
	// Through the fit's last scored day (the record's `through`): a feed's later days never reached the fit.
	// A fit recorded with no series: any series now is one added since, so the whole of it stands for it.
	const et0Then = $derived(s.fitRecord?.forcing?.et0Daily);
	$effect(() => {
		const meta = et0Series;
		const then = et0Then;
		et0Now = meta === null ? null : undefined;
		if (!meta || then === undefined) return;
		let live = true;
		(then ? et0Fingerprint(project.id, meta, then.through) : apanFingerprint(project.id, meta)).then(
			(f) => {
				if (live) et0Now = f;
			},
			() => {
				if (live) et0Now = undefined;
			}
		);
		return () => {
			live = false;
		};
	});
	// The header (issue #17): where the parameters came from, and the way to the fit (Settings' until round 3).
	const fitStatus = $derived(s.fitRecord ? fitRecordStatus(s as unknown as ProjectSettings, s.fitRecord, { chirpsSource, apanDaily: apanNow, ...(et0Now !== undefined ? { et0Daily: et0Now } : {}) }) : null);
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
				isCalPart(id) && body ? landOnAnchor(id, body) : isCalibrationAnchor(id) ? landOnAnchor(id) : isModelQualityAnchor(id) || isCalSubsection(id) ? landResults?.(id) : undefined,
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
		<!-- The page's answer on its first screen: one slim line under the header (ui-playbook.md § 2), linking on to the
		     scores, or to what to do first. role="status": it changes as a run loads or another is picked. -->
		<p class="cal-status" class:warn={status.tone === 'warn'} class:busy={status.busy} role="status" data-testid="calibration-status">
			<strong>{status.lead}</strong>{#if status.text}{' '}{status.text}{/if}{#if status.link}{' '}<a href={status.link.href}>{status.link.label}</a>{#if status.link.label === 'add one on Data'}.{/if}{/if}
		</p>
		<div class="parts">
			<!-- The settings panels that set up a fit (issue #586 round 3). Their wrapper gives them the settings pages'
			     frame (app.css `.settings-form`) and the explanations switch, as on Model settings. A viewer reads them
			     with every field read-only and no fit controls (`readonly`, as on Model settings). -->
			<section class="part" id="cal-setup" aria-labelledby="cal-setup-h">
				<h2 id="cal-setup-h" class="part-h">Set up the fit</h2>
				<div class="settings-form explain-scope" class:explained={explainSwitch.on}>
					<!-- What the page's old lead said that a reader needs here: these edits are Model settings' draft too. -->
					<div class="setup-line">
						{#if !readonly}<p class="muted small" data-testid="calibration-setup-note">Changes here are saved with Model settings’ changes, from the bar that shows at the foot of the window.</p>{/if}
						<ExplainSwitch />
					</div>
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
						et0Daily={et0Now}
						{flowRecordId}
						{readonly}
						{onProjectChange}
					/>
				</div>
			</section>
			<!-- Model quality's panels are panels of their own, so this part is a heading over them, not a panel round them. -->
			<section class="part" id="cal-fit" aria-labelledby="cal-fit-h">
				<h2 id="cal-fit-h" class="part-h">How the shown run fits</h2>
				<CalibrationResults
					{projectId}
					{runs}
					{role}
					{nodes}
					{series}
					{projectSettings}
					{hasRecord}
					{changed}
					landing={(land) => (landResults = land)}
					onshown={(v) => (shown = v)}
					onstate={(v, g) => {
						calState = v;
						runGr4j = g;
					}}
				/>
			</section>
		</div>
	</div>
</SectionNav>

<style>
	/* The parts answer to the page's width, not the window's (the sidebar and the side index take some). */
	.cal-page {
		container: cal-page / inline-size;
	}
	/* The parts one above the other: the settings panels' monthly rows and the charts need the page's full width. */
	.parts {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 2rem;
		align-items: start;
	}
	.part {
		min-width: 0;
	}
	/* One slim line, as the workspace's notices: a rule on its left, toned like the NSE tile when the fit is no better
	   than the mean flow (the words say so too). */
	.cal-status {
		margin: 0 0 1rem;
		padding: 0.35rem 0.75rem;
		border-left: 3px solid var(--border-strong);
		background: var(--surface);
		border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
		max-width: 100%;
	}
	.cal-status.warn {
		border-left-color: var(--warning);
	}
	.cal-status.busy {
		color: var(--text-muted);
	}
	.cal-status.busy strong {
		font-weight: 400;
	}
	/* A part's heading over its panels' (h3, 1.1rem): a size up, so the two parts read as the page's two halves. */
	.part-h {
		margin: 0 0 0.75rem;
		font-size: 1.3rem;
	}
	/* The save note and the explanations switch share a line, the switch at its end; under each other when narrow. */
	.setup-line {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 0.25rem 1rem;
		margin: 0 0 0.75rem;
	}
	.setup-line p {
		margin: 0;
	}
	.setup-line :global(.explain-switch.check) {
		margin: 0;
	}
</style>
