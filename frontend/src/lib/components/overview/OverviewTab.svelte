<script lang="ts">
	import { untrack } from 'svelte';
	import type { SeriesMeta } from '@water-management/engine';
	import { api, type Project, type Run, type RunMeta } from '$lib/api';
	import DownloadMenu from '$lib/components/export/DownloadMenu.svelte';
	import { detailCache } from '$lib/components/runs/cache';
	import { downloads } from '$lib/export';
	import { fmtNum, localIsoDate } from '$lib/format/number';
	import type { ModelEditor } from '$lib/model/editor.svelte';
	import { attention } from './attention';
	import { checklist } from './checklist';
	import LatestRun from './LatestRun.svelte';
	import { pickRuns } from './latestRun';
	import MembersPanel from './MembersPanel.svelte';
	import NeedsAttention from './NeedsAttention.svelte';
	import SetupChecklist from './SetupChecklist.svelte';
	import TeamPanel from './TeamPanel.svelte';

	let {
		project,
		editor,
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

	// Form fields start from the loaded project and are reset after each save.
	let name = $state(untrack(() => project.name));
	let description = $state(untrack(() => project.description ?? ''));
	let saving = $state(false);
	let error = $state<string | null>(null);
	let savedAt = $state<number | null>(null);

	const detailsDirty = $derived(name.trim() !== project.name || description.trim() !== (project.description ?? ''));

	// The series and runs lists come from the page, which loads them before any
	// tab renders and refreshes them after an upload or a run, so the counts and
	// checklist are final on the first frame and never go stale.
	const seriesCount = $derived(series?.length ?? null);
	const runCount = $derived(runs?.length ?? null);

	// Built from the model as edited (unsaved changes included) so the
	// checklist ticks as soon as the user fills a step in.
	const steps = $derived(
		checklist({ model: editor.model, settings: project.settings, series, runs, updatedAt: project.updatedAt })
	);

	// --- latest run: its headline figures and what needs attention ----------
	// The run list is the page's; the full records (summaries) are fetched here
	// through the Runs tab's cache, so opening that tab next shows the run at once.
	const pick = $derived(pickRuns(runs));
	let latestRun = $state.raw<Run | null>(null);
	let previousRun = $state.raw<Run | null>(null);
	let runLoading = $state(false);
	let runError = $state<string | null>(null);
	let previousError = $state<string | null>(null);
	const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

	async function fetchRun(id: string): Promise<Run> {
		const hit = detailCache.get(id);
		if (hit) return hit.run;
		const d = await api.runs.get(project.id, id);
		detailCache.set(id, d);
		return d.run;
	}

	let loadKey = '';
	async function loadRuns(latestId: string, previousId: string | null) {
		const key = (loadKey = `${latestId}|${previousId ?? ''}`);
		// Cached records paint on the first frame; the rest arrive in parallel.
		latestRun = detailCache.get(latestId)?.run ?? null;
		previousRun = previousId ? (detailCache.get(previousId)?.run ?? null) : null;
		runError = null;
		previousError = null;
		runLoading = !latestRun;
		const prev = previousId && !previousRun ? fetchRun(previousId) : null;
		try {
			const r = await fetchRun(latestId);
			if (loadKey === key) latestRun = r;
		} catch (e) {
			if (loadKey === key) runError = msg(e);
		} finally {
			if (loadKey === key) runLoading = false;
		}
		if (prev) {
			try {
				const p = await prev;
				if (loadKey === key) previousRun = p;
			} catch (e) {
				// Shown under the cards: they stand without the changes.
				if (loadKey === key) previousError = msg(e);
			}
		}
	}
	const retryRuns = () => pick && loadRuns(pick.latest.id, pick.previous?.id ?? null);

	// Reload only when the pair of runs changes (the page refreshes its list
	// after a run or a note edit; the same ids need no refetch).
	$effect(() => {
		const latestId = pick?.latest.id ?? null;
		const previousId = pick?.previous?.id ?? null;
		untrack(() => {
			if (!latestId) {
				loadKey = '';
				latestRun = previousRun = null;
			} else if (`${latestId}|${previousId ?? ''}` !== loadKey) loadRuns(latestId, previousId);
		});
	});

	const today = localIsoDate();
	const attentionItems = $derived(
		attention({
			model: editor.model,
			series,
			latest: pick?.latest ?? null,
			summary: latestRun && latestRun.id === pick?.latest.id ? latestRun.summary : null,
			today
		})
	);

	const stats = $derived.by(() => {
		const m = editor.model;
		const farms = m.nodes.filter((n) => n.kind === 'farm');
		const outlet = m.nodes.find((n) => n.downstreamNodeId === null);
		return {
			farms: farms.length,
			gauges: m.nodes.length - farms.length,
			areaKm2: m.nodes.reduce((s, n) => s + (n.areaKm2 || 0), 0),
			damM3: m.nodes.reduce((s, n) => s + (n.damCapacityM3 || 0), 0),
			dams: m.nodes.filter((n) => n.damCapacityM3 > 0).length,
			crops: m.crops.length,
			irrigatedHa: m.cropAreas.reduce((s, a) => s + (a.areaM2 || 0), 0) / 10_000,
			transfers: m.transfers.filter((t) => t.enabled).length,
			outlet: outlet?.name ?? null
		};
	});

	// Anyone who can open the project can take a copy of it (viewers included).
	const projectDownloads = $derived([
		{
			label: 'Download project (JSON)',
			url: downloads.project(project.id),
			hint: 'Model, settings and input series (runs not included)'
		}
	]);

	async function saveDetails(e: SubmitEvent) {
		e.preventDefault();
		saving = true;
		error = null;
		try {
			const p = await api.projects.update(project.id, { name: name.trim(), description: description.trim() });
			onProjectChange(p);
			name = p.name;
			description = p.description ?? '';
			savedAt = Date.now();
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
		} finally {
			saving = false;
		}
	}
</script>

<SetupChecklist {steps} />

{#if pick}
	<LatestRun
		meta={pick.latest}
		run={latestRun}
		previousMeta={pick.previous}
		previous={previousRun}
		evidence={pick.evidence}
		loading={runLoading}
		error={runError}
		{previousError}
		retry={retryRuns}
	/>
{/if}

<NeedsAttention items={attentionItems} />

<!-- Each fact links to the tab where it is edited or looked at; the link is
     stretched over the whole tile, so the tile is the click target. -->
<dl class="stats">
	<div class="stat"><dt><a href="?tab=network">Farms</a></dt><dd>{fmtNum(stats.farms)}<small>+ {stats.gauges} gauge{stats.gauges === 1 ? '' : 's'}</small></dd></div>
	<div class="stat"><dt><a href="?tab=network">Catchment area</a></dt><dd>{fmtNum(stats.areaKm2, 2)}<small>km²</small></dd></div>
	<div class="stat"><dt><a href="?tab=network">Dam capacity ({stats.dams} dam{stats.dams === 1 ? '' : 's'})</a></dt><dd>{fmtNum(stats.damM3)}<small>m³</small></dd></div>
	<div class="stat"><dt><a href="?tab=crops">Irrigated area ({stats.crops} crop{stats.crops === 1 ? '' : 's'})</a></dt><dd>{fmtNum(stats.irrigatedHa, 1)}<small>ha</small></dd></div>
	<div class="stat"><dt><a href="?tab=transfers">Active transfers</a></dt><dd>{fmtNum(stats.transfers)}</dd></div>
	<div class="stat"><dt><a href="?tab=series">Time series</a></dt><dd>{seriesCount === null ? '–' : fmtNum(seriesCount)}</dd></div>
	<div class="stat"><dt><a href="?tab=runs">Model runs</a></dt><dd>{runCount === null ? '–' : fmtNum(runCount)}</dd></div>
	<div class="stat"><dt><a href="?tab=network">Outflow gauge</a></dt><dd class="text">{stats.outlet ?? '–'}</dd></div>
</dl>

<div class="grid">
	<div class="col">
		<section class="panel" aria-labelledby="details-h">
			<div class="panel-head">
				<h2 id="details-h">Project details</h2>
				<DownloadMenu items={projectDownloads} />
			</div>
			<form onsubmit={saveDetails}>
				{#if error}<div class="alert alert-error" role="alert">{error}</div>{/if}
				<div class="field">
					<label for="pd-name">Name</label>
					<input id="pd-name" required maxlength="200" readonly={!canEdit} bind:value={name} />
				</div>
				<div class="field">
					<label for="pd-desc">Description</label>
					<textarea id="pd-desc" rows="4" readonly={!canEdit} bind:value={description}></textarea>
				</div>
				{#if canEdit}
					<div class="form-row">
						<button class="btn btn-primary" type="submit" disabled={saving || !detailsDirty || !name.trim()}>
							{saving ? 'Saving…' : 'Save details'}
						</button>
						{#if savedAt && !detailsDirty}<span class="muted" role="status">Saved.</span>{/if}
					</div>
				{/if}
			</form>
		</section>
	</div>

	<!-- Who can open the project: the owning team, then the people shared directly. -->
	<div class="col access">
		<TeamPanel {project} {isOwner} {currentUserId} {onProjectChange} />
		<MembersPanel projectId={project.id} team={project.team} {isOwner} {currentUserId} {onLeftProject} />
	</div>
</div>

<style>
	.grid {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(0, 1.4fr);
		gap: 1rem;
		align-items: start;
	}
	/* Eight facts: one row on wide screens, then 4 × 2, then 2 × 4. */
	dl.stats {
		grid-template-columns: repeat(8, minmax(0, 1fr));
	}
	@media (max-width: 1280px) {
		dl.stats {
			grid-template-columns: repeat(4, minmax(0, 1fr));
		}
	}
	@media (max-width: 560px) {
		dl.stats {
			grid-template-columns: repeat(2, minmax(0, 1fr));
			gap: 0.5rem;
		}
	}
	.col {
		display: grid;
		gap: 0;
		min-width: 0;
	}
	@media (max-width: 900px) {
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
