<script lang="ts">
	// An evidence pack's page (issue #71, WP-3.14; docs/evidence-pack.md):
	// /projects/:id/packs/:packId. The frozen evidence report from the pack's
	// manifest, stamped with its status and version, its hash, short code and
	// verify link, and its sign-offs.
	//
	// MINIMAL on purpose: the server-rendered PDF (backend/src/jobs/handlers/
	// pack-render.ts) prints this route, so it had to exist for the PDF's
	// render and e2e. The full pack view (lifecycle actions, the issue
	// checklist, the PDF's download and state) is built on feat/71-pack-ui and
	// replaces this file, keeping the contract below.
	//
	// The contract with the renderer (backend/src/reports/render.ts,
	// reports/scope.ts): the page reads only GET …/packs/:packId and
	// GET …/packs/:packId/signoffs (a pack render session may make no other
	// read: not the project, not a run), then sets main[data-report-ready]
	// once everything is drawn, and main[data-report-footer] to the PDF's
	// running footer. A "can't show this" is a main > [role="alert"].
	import { untrack } from 'svelte';
	import { base } from '$app/paths';
	import { page } from '$app/state';
	import { REPORT_FOOTER, type PackManifest } from '@water-management/engine';
	import { api, ApiError, type PackMeta, type SignoffList } from '$lib/api';
	import ChunkFailed from '$lib/components/common/ChunkFailed.svelte';
	import Lazy from '$lib/components/common/Lazy.svelte';
	import { loadOnce } from '$lib/components/common/lazy';
	import { DRAFT_STAMP } from '$lib/components/report/evidence/sections';

	const projectId = $derived(page.params.id ?? '');
	const packId = $derived(page.params.packId ?? '');

	const loadReport = () => import('$lib/components/report/evidence/EvidenceReport.svelte');

	let pack = $state.raw<PackMeta | null>(null);
	let manifest = $state.raw<PackManifest | null>(null);
	let signoffs = $state.raw<SignoffList | null>(null);
	let status = $state<'loading' | 'loaded' | 'not-found' | 'forbidden' | 'error' | 'chunk-failed'>('loading');
	let error = $state('');

	async function load(id: string, pid: string) {
		status = 'loading';
		try {
			const [view, so] = await Promise.all([api.packs.get(id, pid), api.packs.signoffs(id, pid)]);
			pack = view.pack;
			manifest = view.manifest;
			signoffs = so;
			try {
				await loadOnce(loadReport);
			} catch {
				status = 'chunk-failed';
				return;
			}
			status = 'loaded';
		} catch (e) {
			if (e instanceof ApiError && e.status === 404) status = 'not-found';
			else if (e instanceof ApiError && e.status === 403) status = 'forbidden';
			else {
				error = e instanceof Error ? e.message : String(e);
				status = 'error';
			}
		}
	}
	$effect(() => {
		const id = projectId;
		const pid = packId;
		untrack(() => load(id, pid));
	});

	/** The stamp on every page: a draft's, or the pack's status and version. */
	const stamp = $derived.by(() => {
		if (!pack) return DRAFT_STAMP;
		if (pack.status === 'draft') return DRAFT_STAMP;
		const word = { issued: 'Issued', superseded: 'Superseded', withdrawn: 'Withdrawn' }[pack.status];
		return `${word} · evidence pack version ${pack.version} · ${pack.shortCode}`;
	});
	const verify = $derived(
		pack && pack.status !== 'draft'
			? `Evidence pack ${pack.shortCode}, version ${pack.version}. Manifest SHA-256 ${pack.manifestSha256}. Check it at ${typeof window === 'undefined' ? '' : window.location.origin}${base}${pack.verifyPath}.`
			: null
	);
	const ready = $derived(status === 'loaded');
	const footer = $derived(manifest && pack ? `${stamp} · ${REPORT_FOOTER(manifest.project.name, manifest.report.identity.title, 'Appendix B.3')}` : undefined);
</script>

<svelte:head><title>{manifest ? `Evidence pack · ${manifest.project.name} · ` : ''}Water Management</title></svelte:head>

<main class="page report pack-page" data-report-ready={ready || undefined} data-report-footer={footer} aria-busy={status === 'loading'}>
	{#if status === 'not-found'}
		<div class="alert alert-error" role="alert">This evidence pack doesn't exist, or you don't have access to it. <a href="{base}/">Back to projects</a></div>
	{:else if status === 'forbidden'}
		<div class="alert alert-error" role="alert">An evidence pack needs the viewer role or above on this project.</div>
	{:else if status === 'error'}
		<div class="alert alert-error" role="alert">
			The evidence pack could not be loaded: {error}
			<button type="button" class="btn btn-sm" onclick={() => load(projectId, packId)}>Try again</button>
		</div>
	{:else if status === 'chunk-failed'}
		<ChunkFailed what="The evidence pack" />
	{/if}

	{#if status === 'loaded' && manifest && pack}
		<p class="stamp" data-testid="pack-stamp">{stamp}</p>
		<Lazy load={loadReport}>
			{#snippet children(EvidenceReportView)}
				<EvidenceReportView report={manifest!.report} {projectId} {stamp} {verify} {signoffs} />
			{/snippet}
		</Lazy>
	{/if}
</main>

<style>
	.pack-page {
		max-width: 1000px;
	}
	.stamp {
		font-weight: 600;
	}
</style>
