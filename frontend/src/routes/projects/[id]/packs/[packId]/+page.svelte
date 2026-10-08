<script lang="ts">
	// An evidence pack's own page (WP-3.14, issue #71; docs/ui.md § Evidence
	// pack, docs/evidence-pack.md): /projects/:id/packs/:packId. It renders the
	// evidence report from the pack's frozen manifest (its `report`), with the
	// same layout as the report route's evidence mode (EvidenceReport, one
	// layout, design/evidence-report.md §10): every section stamped with the
	// pack's status ("Issued · version n · date", "Draft pack · not issued",
	// superseded, withdrawn) and, once issued, the manifest SHA-256, the short
	// code and the verify link in every section and in the footer
	// (data-report-footer, which a server render prints on every page). The
	// status board above it carries the editor's moves (PackActions); signing
	// is in Appendix B.2, against the pack statement. data-report-ready
	// follows the catchment report's contract, so e2e and a server render wait
	// on it. Printing is A4 and light, as the report route's.
	//
	// The server PDF prints this page in a pack render session
	// (backend/src/reports/scope.ts), which may read only GET …/packs/:packId
	// and its /signoffs: so a render session never asks for the project (it
	// only decides whether the editor's moves show), and a project that
	// can't be read leaves the pack readable, without the moves. A "can't
	// show this" is a main > [role="alert"]; a quiet reload's inline alert
	// (only after a change on this page, which a render never makes) keeps
	// the loaded pack and data-report-ready. Once issued, the bar (never
	// printed) says where the server PDF is (detail.pdf): its download when
	// ready, "printing" while it renders, and why it failed, with an
	// editor's "Try again" (POST …/pdf). The bar also lists the errata found
	// since the manifest was frozen (detail.errataFoundSince, 132): never
	// printed, since the pack prints only what its manifest recorded.
	//
	// The bar also says what the server's re-run of the pack from its stored
	// reproduction bundle found (detail.reproduction, 154_pack_reproduce):
	// reproduced, not reproduced (with the failed checks), another engine, or
	// still re-running. It is the app's own claim: never printed, never on
	// verify. An editor may ask for it again (POST …/reproduce) when the last
	// re-run gave up, or when the outcome is an older engine's than the
	// server's: the new outcome is recorded beside the old.
	//
	// Sharing and comments (WP-3.15, 128_pack_share_notes): an editor makes a
	// read-only share link to an issued pack here (Share link…, the same
	// ShareLinksPanel as an application's) and withdraws any of them, a
	// withdrawn or superseded pack's too; whoever reads the pack keeps team
	// notes on it and sees its public comments (Notes). Neither shows to a
	// render session, which reads no project.
	import { untrack } from 'svelte';
	import { base } from '$app/paths';
	import { page } from '$app/state';
	import { REPORT_FOOTER } from '@water-management/engine';
	import { api, ApiError, hasRole, type PackDetail, type PackSignoffList, type Project } from '$lib/api';
	import { session } from '$lib/auth/session.svelte';
	import ChunkFailed from '$lib/components/common/ChunkFailed.svelte';
	import Dialog from '$lib/components/common/Dialog.svelte';
	import Lazy from '$lib/components/common/Lazy.svelte';
	import { loadOnce } from '$lib/components/common/lazy';
	import NotesDrawer from '$lib/components/notes/NotesDrawer.svelte';
	import { packAudiences } from '$lib/components/notes/notes';
	import ShareLinksPanel from '$lib/components/project/ShareLinksPanel.svelte';
	import PackSendDialog from '$lib/components/packs/PackSendDialog.svelte';
	import PackActions from '$lib/components/packs/PackActions.svelte';
	import PackBadge from '$lib/components/packs/PackBadge.svelte';
	import HelpTip from '$lib/components/help/HelpTip.svelte';
	import { errataFoundSinceNote, latestOnly, reproductionNote, manifestFileName, manifestFileText, packStamp, packVerifyLine, packVerifyRef } from '$lib/components/packs/pack';
	import { forceLightForPrint, restoreThemeAfterPrint } from '$lib/components/report/printTheme';

	const loadReport = () => import('$lib/components/report/evidence/EvidenceReport.svelte');

	const projectId = $derived(page.params.id ?? '');
	const packId = $derived(page.params.packId ?? '');

	let project = $state.raw<Project | null>(null);
	let detail = $state.raw<PackDetail | null>(null);
	let signoffs = $state.raw<PackSignoffList | null>(null);
	let status = $state<'loading' | 'loaded' | 'not-found' | 'forbidden' | 'error' | 'chunk-failed'>('loading');
	let error = $state('');

	/** A quiet reload's failure (after a sign-off, issue or withdrawal): shown above the pack, which stays as it was. */
	let reloadError = $state<string | null>(null);
	// Only the latest load's answer is applied: moving to another pack (a newer version) while one loads can't show the old one.
	const latest = latestOnly();

	/**
	 * Load the pack. `quiet` (a reload after a change on this page) keeps the
	 * loaded view whatever happens, and says inline if the reload failed, so
	 * the pack never disappears behind an error it was already showing.
	 */
	async function load(id: string, pid: string, quiet = false) {
		const current = latest.begin();
		if (!quiet) status = 'loading';
		reloadError = null;
		try {
			// The project only gives the caller's role (the editor's moves); a render session doesn't read it.
			const role = session.user?.renderSession ? Promise.resolve(null) : api.projects.get(id).catch(() => null);
			const [p, d, so] = await Promise.all([role, api.packs.get(id, pid), api.packs.signoffs(id, pid)]);
			if (!current()) return;
			try {
				await loadOnce(loadReport);
			} catch {
				if (current()) status = 'chunk-failed';
				return;
			}
			if (!current()) return;
			project = p;
			detail = d;
			signoffs = so;
			status = 'loaded';
		} catch (e) {
			if (!current()) return;
			if (quiet && status === 'loaded') {
				reloadError = e instanceof Error ? e.message : String(e);
				return;
			}
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

	/** After a sign-off: the pack (its checklist and count) and its sign-offs, read again. */
	const reload = () => load(projectId, packId, true);

	const pack = $derived(detail?.pack ?? null);
	/** Where the server-rendered PDF is (119_pack_render): ready, rendering, failed or none. */
	const pdf = $derived(detail?.pdf ?? null);
	/** What the server's re-run from the stored bundle found (154_pack_reproduce); null when there is nothing to say. */
	const reproduction = $derived(detail?.reproduction ? { state: detail.reproduction, note: reproductionNote(detail.reproduction) } : null);

	let renderingAgain = $state(false);
	let renderError = $state<string | null>(null);
	/** An editor asks again for a PDF whose render gave up (POST …/pdf), then reads the pack again. */
	async function renderAgain() {
		if (!pack) return;
		renderingAgain = true;
		renderError = null;
		try {
			await api.packs.renderPdf(projectId, pack.id);
			await reload();
		} catch (e) {
			renderError = e instanceof Error ? e.message : String(e);
		} finally {
			renderingAgain = false;
		}
	}
	let rerunning = $state(false);
	let rerunError = $state<string | null>(null);
	/** An editor asks the server to re-run the pack again (POST …/reproduce), then reads the pack again. */
	async function rerunAgain() {
		if (!pack) return;
		rerunning = true;
		rerunError = null;
		try {
			await api.packs.reproduce(projectId, pack.id);
			await reload();
		} catch (e) {
			rerunError = e instanceof Error ? e.message : String(e);
		} finally {
			rerunning = false;
		}
	}
	const report = $derived(detail?.manifest.report ?? null);
	const canEdit = $derived(hasRole(project?.role, 'editor'));
	/** Share links to it (an editor, once it was issued) and its notes (whoever reads it); never in a render session, which reads no project. */
	const canShare = $derived(canEdit && !!pack && pack.status !== 'draft');
	let shareOpen = $state(false);
	/** Send the issued pack to the members acting for the responsible authority (licensing build item 13). */
	let sendOpen = $state(false);
	const ready = $derived(status === 'loaded');
	const stamp = $derived(pack ? packStamp(pack) : '');
	const verify = $derived(pack ? packVerifyRef(pack, page.url.origin, base) : null);
	// The frozen project name, as the manifest recorded it.
	const footer = $derived(
		detail && pack ? [stamp, verify ? packVerifyLine(verify) : null, REPORT_FOOTER(detail.manifest.project.name, pack.title, 'Appendix B.3')].filter(Boolean).join(' · ') : undefined
	);
	const back = $derived(
		pack?.scenarioId ? `${base}/projects/${encodeURIComponent(projectId)}?tab=scenarios&scenario=${encodeURIComponent(pack.scenarioId)}` : `${base}/projects/${encodeURIComponent(projectId)}?tab=runs&run=${encodeURIComponent(pack?.baselineRunId ?? '')}`
	);

	let manifestUrl = $state<string | null>(null);
	/** The bundle's download (the API redirects to a signed GET); an issued pack has one. */
	const bundleUrl = $derived(pack?.bundleSha256 ? api.packs.bundleUrl(projectId, pack.id) : null);
	$effect(() => {
		if (!detail) return;
		const url = URL.createObjectURL(new Blob([manifestFileText(detail.manifest)], { type: 'application/json' }));
		manifestUrl = url;
		return () => URL.revokeObjectURL(url);
	});

	// Printing is A4, in the light theme, without the app's header (see the styles).
	$effect(() => {
		const pageRule = document.createElement('style');
		pageRule.textContent = '@page { size: A4; margin: 14mm 12mm 18mm; }';
		document.head.append(pageRule);
		const before = () => forceLightForPrint();
		const after = () => restoreThemeAfterPrint();
		addEventListener('beforeprint', before);
		addEventListener('afterprint', after);
		return () => {
			pageRule.remove();
			removeEventListener('beforeprint', before);
			removeEventListener('afterprint', after);
			restoreThemeAfterPrint();
		};
	});
</script>

<svelte:head><title>{pack ? `Evidence pack v${pack.version} · ${pack.title} · ` : ''}Water Management</title></svelte:head>

<main class="page report pack-page" data-report-ready={ready || undefined} data-report-footer={footer} aria-busy={status === 'loading'}>
	{#if status === 'not-found'}
		<div class="alert alert-error" role="alert">This evidence pack doesn’t exist, or you don’t have access to it. <a href="{base}/">Back to projects</a></div>
	{:else if status === 'forbidden'}
		<div class="alert alert-error" role="alert">An evidence pack needs the viewer role or above on this project.</div>
	{:else if status === 'error'}
		<div class="alert alert-error" role="alert">
			The evidence pack could not be loaded: {error}
			<button type="button" class="btn btn-sm" onclick={() => load(projectId, packId)}>Try again</button>
		</div>
	{:else if status === 'chunk-failed'}
		<ChunkFailed what="The evidence pack" />
	{:else if status === 'loading'}
		<p class="muted" role="status">Loading the evidence pack…</p>
	{/if}

	{#if status === 'loaded' && detail && pack && report}
		{#if reloadError}
			<div class="alert alert-error no-print" role="alert" data-testid="pack-reload-error">
				The pack changed, but reading it again failed ({reloadError}), so what shows below may be out of date.
				<button type="button" class="btn btn-sm" onclick={reload}>Try again</button>
			</div>
		{/if}
		<div class="bar no-print">
			<a href={back}>← Back</a>
			<PackBadge status={pack.status} version={pack.version} />
			{#if pdf?.status === 'ready'}
				<a class="btn btn-primary" href={api.packs.pdfUrl(projectId, pack.id)} data-testid="pack-pdf-download">Download PDF</a>
				<button type="button" class="btn" onclick={() => window.print()}>Print this page</button>
			{:else}
				<button type="button" class="btn btn-primary" onclick={() => window.print()}>Download PDF</button>
			{/if}
			{#if manifestUrl}<a class="btn" href={manifestUrl} download={manifestFileName(pack.shortCode)} data-testid="pack-manifest-download">Download manifest</a>{/if}
			{#if bundleUrl}<a class="btn" href={bundleUrl} data-testid="pack-bundle-download">Download reproduction bundle</a>{/if}
			{#if verify}<a class="btn" href="{base}/verify/{encodeURIComponent(pack.shortCode)}">Verify page</a>{/if}
			{#if canShare}<span class="with-tip"><button type="button" class="btn" onclick={() => (shareOpen = true)} data-testid="pack-share-open">Share link…</button><HelpTip key="pack-share-link" label="About sharing a pack by link" /></span>{/if}
			{#if canEdit && pack.status === 'issued'}<span class="with-tip"><button type="button" class="btn" onclick={() => (sendOpen = true)} data-testid="pack-send-open">Send to the authority…</button><HelpTip key="send-to-authority" label="About sending a pack to the authority" /></span>{/if}
			{#if project}<NotesDrawer {projectId} target={{ kind: 'pack', packId: pack.id, name: `evidence pack v${pack.version}`, audiences: packAudiences(pack.status === 'issued') }} />{/if}
			<p class="muted small">
				Version {pack.version}{pack.supersedesId ? ' (replaces an earlier version)' : ''} · code <span class="mono" data-testid="pack-code">{pack.shortCode}</span> · manifest SHA-256
				<span class="mono hash">{pack.manifestSha256}</span>. <HelpTip key="manifest-hash" label="About the manifest and its SHA-256" />
				{#if pack.pdfSha256}PDF SHA-256 <span class="mono hash">{pack.pdfSha256}</span>{pack.pdfPages ? ` (${pack.pdfPages} pages)` : ''}.{:else}No server PDF recorded yet: Download PDF prints this page in the browser.{/if}
				<HelpTip key="pack-pdf" label="About the evidence pack’s PDF" />
				{#if pack.bundleSha256}Reproduction bundle SHA-256 <span class="mono hash" data-testid="pack-bundle-sha">{pack.bundleSha256}</span> (re-run it with
					<span class="mono">pnpm reproduce:pack</span>). <HelpTip key="reproduction-bundle" label="About the reproduction bundle" />{/if}
			</p>
			{#if detail.errataFoundSince.length}
				{@const since = errataFoundSinceNote(pack)}
				<div class="alert alert-warning errata-alert" role="note" data-testid="pack-errata-since">
					<strong>{since.heading}:</strong> <HelpTip key="errata-since" label="About errata found since" />
					<ul class="errata-since">{#each detail.errataFoundSince as e (e.id)}<li><strong>{e.id}</strong> {e.summary}</li>{/each}</ul>
					<p class="small">{since.note}</p>
				</div>
			{/if}
			{#if pdf?.status === 'rendering'}
				<p class="muted small" role="status" data-testid="pack-pdf-state" data-state="rendering">
					The server is printing this pack’s PDF, whose SHA-256 the verify page will show.
					<button type="button" class="btn btn-sm" onclick={reload}>Check again</button>
				</p>
			{:else if pdf?.status === 'failed'}
				<div class="alert alert-error" role="alert" data-testid="pack-pdf-state" data-state="failed">
					The server couldn’t print this pack’s PDF{pdf.error ? `: ${pdf.error}` : '.'}
					{#if canEdit}<button type="button" class="btn btn-sm" onclick={renderAgain} disabled={renderingAgain}>Try again</button>{/if}
					{#if renderError}<span data-testid="pack-pdf-retry-error">({renderError})</span>{/if}
				</div>
			{/if}
			{#if reproduction?.note}
				{@const r = reproduction.note}
				<div
					class="reproduction small"
					class:alert={r.tone !== 'quiet'}
					class:alert-info={r.tone === 'good'}
					class:alert-error={r.tone === 'bad'}
					class:alert-warning={r.tone === 'warn'}
					class:muted={r.tone === 'quiet'}
					role={r.tone === 'bad' ? 'alert' : 'status'}
					data-testid="pack-reproduction"
					data-state={reproduction.state.status}
				>
					{r.text}
					{#if reproduction.state.status === 'checking'}<button type="button" class="btn btn-sm" onclick={reload}>Check again</button>{/if}
					{#if canEdit && r.rerun}<button type="button" class="btn btn-sm" onclick={rerunAgain} disabled={rerunning} data-testid="pack-reproduce-again">{r.rerun}</button>{/if}
					{#if rerunError}<span data-testid="pack-reproduce-error">({rerunError})</span>{/if}
					{#if r.failed.length}
						<ul class="failed-checks">{#each r.failed as c (c.id)}<li><span class="mono">{c.id}</span>: {c.detail}</li>{/each}</ul>
					{/if}
				</div>
			{/if}
		</div>
		{#if canShare}
			<Dialog bind:open={shareOpen} title="Share evidence pack v{pack.version} read-only" side>
				{#if shareOpen}<ShareLinksPanel {projectId} pack={{ id: pack.id, name: `evidence pack version ${pack.version}`, status: pack.status, version: pack.version }} />{/if}
				{#snippet actions()}
					<button type="button" class="btn" onclick={() => (shareOpen = false)}>Close</button>
				{/snippet}
			</Dialog>
		{/if}
		{#if canEdit && pack.status === 'issued'}
			<PackSendDialog bind:open={sendOpen} {projectId} packId={pack.id} version={pack.version} authority={project?.settings.responsibleAuthority?.name ?? null} />
		{/if}
		<PackActions {projectId} {pack} issue={detail.issue} manifestMatches={detail.manifestMatches} {canEdit} onchange={reload} />
		<Lazy load={loadReport}>
			{#snippet children(EvidenceReportView)}
				<EvidenceReportView {report} {projectId} {stamp} {verify} frozen {signoffs} signoffTarget={{ kind: 'pack', id: pack!.id }} onsignoffchange={reload} />
			{/snippet}
		</Lazy>
	{/if}
</main>

<style>
	.pack-page {
		max-width: 1000px;
	}
	.bar {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem 1rem;
		margin-bottom: 1rem;
	}
	.bar p {
		margin: 0;
		flex-basis: 100%;
		overflow-wrap: anywhere;
	}
	.with-tip {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
	}
	.errata-alert {
		flex-basis: 100%;
		margin: 0;
	}
	.reproduction {
		flex-basis: 100%;
		margin: 0;
		overflow-wrap: anywhere;
	}
	.failed-checks {
		margin: 0.35rem 0 0;
		padding-left: 1.2rem;
	}
	.errata-since {
		margin: 0.35rem 0;
		padding-left: 1.2rem;
	}
	.mono {
		font-family: var(--font-mono);
	}
	.hash {
		font-size: 0.78rem;
	}
	@media print {
		:global(body:has(main.pack-page) .verify-banner),
		.no-print,
		.pack-page :global(.no-print) {
			display: none !important;
		}
		:global(html:has(main.pack-page)),
		:global(body:has(main.pack-page)) {
			background: #fff;
		}
		.pack-page {
			max-width: none;
			padding: 0;
			font-size: 9.5pt;
			print-color-adjust: exact;
			-webkit-print-color-adjust: exact;
		}
		.pack-page :global(table.data) {
			font-size: 7.5pt;
		}
		.pack-page :global(.table-wrap) {
			overflow: visible;
			max-height: none;
			border: 0;
		}
		.pack-page :global(h2),
		.pack-page :global(h3) {
			break-after: avoid;
		}
		.pack-page :global(tr),
		.pack-page :global(figure) {
			break-inside: avoid;
		}
	}
</style>
