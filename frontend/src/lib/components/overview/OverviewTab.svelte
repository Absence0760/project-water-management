<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import type { SeriesMeta } from '@water-management/engine';
	import { api, type Project, type RunMeta } from '$lib/api';
	import DownloadMenu from '$lib/components/export/DownloadMenu.svelte';
	import { downloads } from '$lib/export';
	import { fmtNum } from '$lib/format/number';
	import type { ModelEditor } from '$lib/model/editor.svelte';
	import { cached } from './cache';
	import { checklist } from './checklist';
	import MembersPanel from './MembersPanel.svelte';
	import SetupChecklist from './SetupChecklist.svelte';
	import TeamPanel from './TeamPanel.svelte';

	let {
		project,
		editor,
		canEdit,
		isOwner,
		currentUserId,
		onProjectChange,
		onLeftProject
	}: {
		project: Project;
		editor: ModelEditor;
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

	// Start from what we saw last time on this project (see cache.ts) so the
	// first frame already has the final layout; refresh in the background.
	const memo = untrack(() => cached(project.id));
	let series = $state<SeriesMeta[] | null>(memo.series ?? null);
	let runs = $state<RunMeta[] | null>(memo.runs ?? null);
	onMount(async () => {
		const [s, r] = await Promise.allSettled([api.series.list(project.id), api.runs.list(project.id)]);
		if (s.status === 'fulfilled') series = memo.series = s.value;
		if (r.status === 'fulfilled') runs = memo.runs = r.value;
	});
	const seriesCount = $derived(series?.length ?? null);
	const runCount = $derived(runs?.length ?? null);

	// Built from the model as edited (unsaved changes included) so the
	// checklist ticks as soon as the user fills a step in.
	const steps = $derived(
		checklist({ model: editor.model, settings: project.settings, series, runs, updatedAt: project.updatedAt })
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

<dl class="stats">
	<div class="stat"><dt>Farms</dt><dd>{fmtNum(stats.farms)}<small>+ {stats.gauges} gauge{stats.gauges === 1 ? '' : 's'}</small></dd></div>
	<div class="stat"><dt>Catchment area</dt><dd>{fmtNum(stats.areaKm2, 2)}<small>km²</small></dd></div>
	<div class="stat"><dt>Dam capacity ({stats.dams} dam{stats.dams === 1 ? '' : 's'})</dt><dd>{fmtNum(stats.damM3)}<small>m³</small></dd></div>
	<div class="stat"><dt>Irrigated area ({stats.crops} crop{stats.crops === 1 ? '' : 's'})</dt><dd>{fmtNum(stats.irrigatedHa, 1)}<small>ha</small></dd></div>
	<div class="stat"><dt>Active transfers</dt><dd>{fmtNum(stats.transfers)}</dd></div>
	<div class="stat"><dt>Time series</dt><dd>{seriesCount === null ? '–' : fmtNum(seriesCount)}</dd></div>
	<div class="stat"><dt>Model runs</dt><dd>{runCount === null ? '–' : fmtNum(runCount)}</dd></div>
	<div class="stat"><dt>Outflow gauge</dt><dd class="text">{stats.outlet ?? '–'}</dd></div>
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

		<TeamPanel {project} {isOwner} {currentUserId} {onProjectChange} />
	</div>

	<MembersPanel projectId={project.id} team={project.team} {isOwner} {currentUserId} {onLeftProject} />
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
	dd.text {
		font-size: 1rem;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
</style>
