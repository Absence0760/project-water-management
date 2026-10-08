<script lang="ts">
	// The Project page (`?tab=project`, issue #17 option A): what the project
	// is and who can open it. The project's details, its import record, notes
	import HelpTip from '$lib/components/help/HelpTip.svelte';
	// and the model's headline facts on the left; the team, members, farmers
	// and share links on the right. Everything here sat below the
	// Summary's first screen until 2026-09-27 and moved unchanged; the Summary
	// links here, and its old `#…-h` links are sent here (links.ts). A
	// reading page: it scrolls, it isn't fitted to the window.
	import { onDestroy, onMount } from 'svelte';
	import type { SeriesMeta } from '@water-management/engine';
	import { page } from '$app/state';
	import type { Project, RunMeta } from '$lib/api';
	import DownloadMenu from '$lib/components/export/DownloadMenu.svelte';
	import RecentNotes from '$lib/components/notes/RecentNotes.svelte';
	import { fillHeader } from '$lib/components/workspace/headerSlot.svelte';
	import { downloads } from '$lib/export';
	import { fmtNum } from '$lib/format/number';
	import { holdAnchor } from '$lib/help/anchor';
	import type { ModelEditor } from '$lib/model/editor.svelte';
	import type { ProjectDetailsDraft } from './detailsDraft.svelte';
	import AuthorityPanel from './AuthorityPanel.svelte';
	import FarmersPanel from './FarmersPanel.svelte';
	import ImportReportPanel from './ImportReportPanel.svelte';
	import { projectAnchor } from './links';
	import { modelFacts, otherNodesLine } from './modelFacts';
	import LicenceRecordPanel from './LicenceRecordPanel.svelte';
	import MembersPanel from './MembersPanel.svelte';
	import RegistrationChecksPanel from './RegistrationChecksPanel.svelte';
	import { DEFAULT_TIME_ZONE, projectContext } from './project';
	import ShareLinksPanel from './ShareLinksPanel.svelte';
	import TeamPanel from './TeamPanel.svelte';
	import TwoStepPanel from './TwoStepPanel.svelte';

	let {
		project,
		editor,
		details,
		series,
		runs,
		canEdit,
		isOwner,
		currentUserId,
		onProjectChange,
		onLeftProject
	}: {
		project: Project;
		editor: ModelEditor;
		/**
		 * The details form's values (issue #162 item 12): the workspace page holds them and
		 * saves or discards them with its save bar, with the model's edits.
		 */
		details: ProjectDetailsDraft;
		/** The page's input-series list (null if it couldn't be loaded). */
		series: SeriesMeta[] | null;
		/** The page's runs list (null if it couldn't be loaded). */
		runs: RunMeta[] | null;
		canEdit: boolean;
		isOwner: boolean;
		currentUserId: string;
		onProjectChange: (p: Project) => void;
		onLeftProject: () => void;
	} = $props();

	// The time zone dates the project's downloads (issue #45); the WUA name is what
	// the farm pages' contact lines name (095_wua_name), empty for "your WUA".
	const zones = (() => {
		try {
			return Intl.supportedValuesOf('timeZone');
		} catch {
			return [DEFAULT_TIME_ZONE];
		}
	})();
	// The series and runs lists come from the page, which refreshes them after
	// an upload or a run, so the counts are final on the first frame.
	const seriesCount = $derived(series?.length ?? null);
	const runCount = $derived(runs?.length ?? null);

	// Counted as the Network and Dams pages count them (modelFacts.ts, issue #177).
	const stats = $derived(modelFacts(editor.model));

	// Anyone who can open the project can take a copy of it (viewers included).
	const projectDownloads = $derived([
		{
			label: 'Download project (JSON)',
			url: downloads.project(project.id),
			hint: 'Model, settings and input series (runs not included)'
		}
	]);

	// The section header: whose project it is, when it was made, its zone; Download is the page's action.
	const context = $derived(projectContext(project));
	$effect(() => fillHeader({ context: headerContext, actions: headerActions }));

	// A link to one of the panels (`#members-h`, or an old Summary link sent here): the panels
	// fill in as their data arrives, after the browser's own jump, so wait for the heading, then
	// scroll there and hold it while the page settles (as River & reserve does), focusing it.
	let body: HTMLDivElement | undefined = $state();
	let releaseAnchor = () => {};
	let stopWaiting = () => {};
	onMount(() => {
		const hash = page.url.hash.slice(1);
		if (!projectAnchor(hash) || !body) return;
		const land = () => {
			const heading = document.getElementById(hash);
			if (!heading) return false;
			releaseAnchor = holdAnchor(heading);
			if (!heading.hasAttribute('tabindex')) heading.tabIndex = -1;
			heading.focus({ preventScroll: true });
			return true;
		};
		if (land()) return;
		const mo = new MutationObserver(() => land() && mo.disconnect());
		mo.observe(body, { childList: true, subtree: true });
		stopWaiting = () => mo.disconnect();
	});
	onDestroy(() => {
		stopWaiting();
		releaseAnchor();
	});
</script>

{#snippet headerContext()}<span data-testid="project-context">{context}</span>{/snippet}
{#snippet headerActions()}<DownloadMenu items={projectDownloads} />{/snippet}

<div class="project-page" bind:this={body}>
	<div class="grid">
		<div class="col">
			<section class="panel" aria-labelledby="details-h">
				<div class="panel-head">
					<h2 id="details-h">Project details</h2>
				</div>
				<!-- Saved or discarded with the bar at the page's foot, like the model's edits (issue #162 item 12). -->
				<form onsubmit={(e) => e.preventDefault()}>
					<div class="field">
						<label for="pd-name">Name</label>
						<input id="pd-name" required maxlength="200" readonly={!canEdit} bind:value={details.name} />
					</div>
					<div class="field">
						<label for="pd-desc">Description</label>
						<textarea id="pd-desc" rows="4" readonly={!canEdit} bind:value={details.description}></textarea>
					</div>
					<div class="field">
						<span class="label"><label for="pd-tz">Time zone</label> <HelpTip key="project-time-zone" /></span>
						<input id="pd-tz" required maxlength="64" autocomplete="off" list="pd-tz-list" readonly={!canEdit} bind:value={details.timeZone} aria-describedby="pd-tz-h" />
						<datalist id="pd-tz-list">{#each zones as z (z)}<option value={z}></option>{/each}</datalist>
						<span class="hint" id="pd-tz-h">An IANA name, like Africa/Johannesburg. Downloads are dated by the day here.</span>
					</div>
					<div class="field">
						<label for="pd-wua">WUA name</label>
						<input id="pd-wua" maxlength="200" autocomplete="off" readonly={!canEdit} bind:value={details.wuaName} placeholder="Vaalbank WUA" aria-describedby="pd-wua-h" />
						<span class="hint" id="pd-wua-h">The farmer view's pages tell farmers to contact the WUA by this name. Left empty, they say “your WUA”.</span>
					</div>
					{#if canEdit}
						<p class="muted save-hint" data-testid="details-save-hint">
							{details.dirty ? 'Unsaved: Save changes at the foot of the page saves these with any model edits.' : 'Changes here are saved with Save changes at the foot of the page, as model edits are.'}
						</p>
					{/if}
				</form>
			</section>
			<!-- An imported project's record of what the importer flagged; nothing for any other. -->
			<ImportReportPanel projectId={project.id} />
			<!-- The newest notes on anything in the project, and the project's own notes (WP-2.7). -->
			<RecentNotes projectId={project.id} />
			<!-- The model's headline facts, at the column's foot (issue #176): each repeats the context line of the
			     tab it links to, so they are reference, not the page's first row. -->
			<section class="panel" aria-labelledby="model-h">
				<div class="panel-head">
					<h2 id="model-h">The model</h2>
				</div>
				<!-- Each fact links to the tab where it is edited or looked at; the link is
				     stretched over the whole tile, so the tile is the click target. -->
				<dl class="stats">
					<div class="stat"><dt><a href="?tab=network">Hydrological units</a></dt><dd>{fmtNum(stats.farms)}<small>{otherNodesLine(stats)}</small></dd></div>
					<div class="stat"><dt><a href="?tab=network">Catchment area</a></dt><dd>{fmtNum(stats.areaKm2, 2)}<small>km²</small></dd></div>
					<div class="stat"><dt><a href="?tab=network">Dam capacity ({stats.dams} dam{stats.dams === 1 ? '' : 's'})</a></dt><dd>{fmtNum(stats.damM3)}<small>m³</small></dd></div>
					<div class="stat"><dt><a href="?tab=crops">Irrigated area ({stats.crops} crop{stats.crops === 1 ? '' : 's'})</a></dt><dd>{fmtNum(stats.irrigatedHa, 1)}<small>ha</small></dd></div>
					<div class="stat"><dt><a href="?tab=transfers">Active transfers</a></dt><dd>{fmtNum(stats.transfers)}</dd></div>
					<div class="stat"><dt><a href="?tab=series">Time series</a></dt><dd>{seriesCount === null ? '–' : fmtNum(seriesCount)}</dd></div>
					<div class="stat"><dt><a href="?tab=runs">Model runs</a></dt><dd>{runCount === null ? '–' : fmtNum(runCount)}</dd></div>
					<div class="stat"><dt><a href="?tab=network">Outflow gauge</a></dt><dd class="text">{stats.outlet ?? '–'}</dd></div>
				</dl>
			</section>
		</div>

		<!-- Who can open the project: the owning team, the people shared directly, then the farmers (their own farms only). -->
		<div class="col access">
			<TeamPanel {project} {isOwner} {currentUserId} {onProjectChange} />
			<MembersPanel projectId={project.id} team={project.team} {isOwner} {currentUserId} {onLeftProject} />
			<!-- The host's checks of signers' registrations (167_signers): editors read them, owners record them. -->
			{#if canEdit}<RegistrationChecksPanel projectId={project.id} {isOwner} />{/if}
			<!-- Who decides the project's licence applications (163_licensing_authority). -->
			<AuthorityPanel {project} {canEdit} {onProjectChange} />
			<FarmersPanel projectId={project.id} {isOwner} farms={editor.model.nodes.filter((n) => n.kind === 'farm').map((n) => ({ id: n.id, name: n.name }))} />
			<!-- Read-only links to the published baseline for people outside the project (WP-2.3 phase 2): owners only. -->
			{#if isOwner}<ShareLinksPanel projectId={project.id} />{/if}
			<!-- Whether its owners' actions need two-step sign-in (204_mfa_opt_in): owners only. -->
			{#if isOwner}<TwoStepPanel {project} {onProjectChange} />{/if}
			<!-- How long the licence record (and the names it keeps) is kept (161): editors read it, owners record the outcome. -->
			{#if canEdit}<LicenceRecordPanel projectId={project.id} {isOwner} />{/if}
		</div>
	</div>
</div>

<style>
	.save-hint {
		margin: 0;
		font-size: 0.85rem;
	}
	/* The columns answer to the page's width, not the viewport's (the sidebar takes 240 px). */
	.project-page {
		container: project-page / inline-size;
	}
	.grid {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(0, 1.4fr);
		gap: 1rem;
		align-items: start;
	}
	/* Eight facts: 2 × 4 in the left column and on a phone, 4 × 2 across a one-column page. */
	dl.stats {
		grid-template-columns: repeat(2, minmax(0, 1fr));
		margin: 0;
	}
	@container project-page (min-width: 521px) and (max-width: 760px) {
		dl.stats {
			grid-template-columns: repeat(4, minmax(0, 1fr));
		}
	}
	@container project-page (max-width: 520px) {
		dl.stats {
			grid-template-columns: repeat(2, minmax(0, 1fr));
			gap: 0.5rem;
		}
	}
	.col {
		display: grid;
		/* One track no wider than the column: an implicit (auto) track grows to its widest panel's min-content,
		   and in a wide font (DejaVu Sans) that pushed every panel 6 px past a phone's edge. */
		grid-template-columns: minmax(0, 1fr);
		gap: 0;
		min-width: 0;
	}
	@container project-page (max-width: 760px) {
		.grid {
			grid-template-columns: minmax(0, 1fr);
		}
	}
	textarea,
	input {
		width: 100%;
	}
	/* The description grows with its text (up to a cap) instead of hiding it
	   behind an inner scrollbar, which on a phone showed only a few lines.
	   Browsers without field-sizing keep the fixed four rows. */
	textarea {
		field-sizing: content;
		min-height: 6.5rem;
		max-height: 24rem;
	}
	/* A phone has no cap: its narrow field wraps every line, so 12 short lines
	   took 24 in a wide font (DejaVu Sans) and ran past 24rem into the inner
	   scrollbar this avoids. The page scrolls instead (project-page.spec.ts). */
	@container project-page (max-width: 520px) {
		textarea {
			max-height: none;
		}
	}
	.stat {
		position: relative;
	}
	.stat:hover {
		border-color: var(--accent);
	}
	.stat:has(a:focus-visible) {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}
	.stat dt a {
		color: inherit;
		text-decoration: underline;
		text-decoration-color: var(--border-strong);
		text-underline-offset: 3px;
	}
	.stat dt a:focus-visible {
		outline: none;
	}
	.stat dt a::after {
		content: '';
		position: absolute;
		inset: 0;
		border-radius: var(--radius);
	}
	dd.text {
		font-size: 1rem;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
</style>
