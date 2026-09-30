<script lang="ts">
	// An applicant's view of an evidence pack of their own application
	// (WP-3.15; 131_applicant_packs; docs/ui.md § Evidence pack → The
	// applicant's pack view): /projects/:id/scenarios/:sid/packs/:packId.
	// Issuing stays with the editors, so this page only reads, and links.
	// An applicant reads no pack row (the manifest names every farm): this is
	// the D2 projection the API builds, GET …/scenarios/:sid/packs/:packId.
	// Its standing, code, hashes and signers (verify's fields); the river's
	// rows and sites a pack link shows; their own units by name; every other
	// farm or water user only as "Farm n" with its change in whole points.
	// The PDF, manifest and reproduction bundle aren't offered: each is the
	// assessors' copy, which names every unit. The application's owner makes
	// read-only share links to it while it is issued (the same ShareLinksPanel
	// as an editor's) and withdraws the ones they made, whatever its standing.
	// Part of the workspace, so English (docs/ui.md § Language).
	import { untrack } from 'svelte';
	import { base } from '$app/paths';
	import { page } from '$app/state';
	import { api, ApiError, type ApplicantPack } from '$lib/api';
	import Dialog from '$lib/components/common/Dialog.svelte';
	import PackBadge from '$lib/components/packs/PackBadge.svelte';
	import { latestOnly } from '$lib/components/packs/pack';
	import { applicantPackHref, bandText, otherUnitLines, othersSummary, ownUnitLines, rowChange, rowLabel, rowValue, siteLines, standingLine } from '$lib/components/packs/applicantPack';
	import ShareLinksPanel from '$lib/components/project/ShareLinksPanel.svelte';
	import { fmtDate } from '$lib/format/number';

	const projectId = $derived(page.params.id ?? '');
	const scenarioId = $derived(page.params.sid ?? '');
	const packId = $derived(page.params.packId ?? '');

	let view = $state.raw<ApplicantPack | null>(null);
	let status = $state<'loading' | 'loaded' | 'not-found' | 'forbidden' | 'error'>('loading');
	let error = $state('');
	const latest = latestOnly();

	async function load(id: string, sid: string, pid: string) {
		const current = latest.begin();
		status = 'loading';
		try {
			const v = await api.scenarios.pack(id, sid, pid);
			if (!current()) return;
			view = v;
			status = 'loaded';
		} catch (e) {
			if (!current()) return;
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
		const sid = scenarioId;
		const pid = packId;
		untrack(() => load(id, sid, pid));
	});

	const pack = $derived(view?.pack ?? null);
	const fig = $derived(view?.figures ?? null);
	const application = $derived(pack?.mode === 'application');
	const sites = $derived(fig ? siteLines(fig.river, application) : []);
	const own = $derived(view?.units ? ownUnitLines(view.units.own) : []);
	const others = $derived(view?.units ? otherUnitLines(view.units.others) : []);
	const back = $derived(`${base}/projects/${encodeURIComponent(projectId)}?tab=scenarios&scenario=${encodeURIComponent(scenarioId)}`);
	let shareOpen = $state(false);
</script>

<svelte:head><title>{pack ? `Evidence pack v${pack.version} · ${pack.title} · ` : ''}Water Management</title></svelte:head>

<main class="page applicant-pack" aria-busy={status === 'loading'} data-testid="applicant-pack">
	<p><a href={back}>← Back to the application</a></p>
	{#if status === 'not-found'}
		<div class="alert alert-error" role="alert">This evidence pack doesn’t exist, isn’t issued yet, or isn’t one of your application’s.</div>
	{:else if status === 'forbidden'}
		<div class="alert alert-error" role="alert">An application’s evidence packs are for its applicant and the people they share it with.</div>
	{:else if status === 'error'}
		<div class="alert alert-error" role="alert">
			The evidence pack could not be loaded: {error}
			<button type="button" class="btn btn-sm" onclick={() => load(projectId, scenarioId, packId)}>Try again</button>
		</div>
	{:else if status === 'loading'}
		<p class="muted" role="status">Loading the evidence pack…</p>
	{/if}

	{#if status === 'loaded' && view && pack}
		<header class="head">
			<h1>Evidence pack v{pack.version} · {pack.title}</h1>
			<div class="bar">
				<PackBadge status={pack.status} version={pack.version} />
				{#if pack.isOwner}
					<button type="button" class="btn" onclick={() => (shareOpen = true)} data-testid="applicant-pack-share-open">Share link…</button>
				{/if}
				<a class="btn" href="{base}/verify/{encodeURIComponent(pack.shortCode)}">Verify page</a>
			</div>
			<p data-testid="applicant-pack-standing" data-status={pack.status}>{standingLine(pack)}</p>
			{#if pack.supersededById}
				<p><a href={applicantPackHref(base, projectId, scenarioId, pack.supersededById)} data-testid="applicant-pack-successor">Open the version that replaced it</a></p>
			{/if}
			<p class="note" data-testid="applicant-pack-note">
				Your copy of the pack. It shows your own hydrological units by name and every other farm or water user only by a number, as
				the rest of your application does; the assessors’ copy, its PDF and its reproduction bundle name them. Issuing a pack, and
				withdrawing or replacing one, is for the assessors.
			</p>
		</header>

		{#if pack.isOwner}
			<Dialog bind:open={shareOpen} title="Share evidence pack v{pack.version} read-only" side>
				{#if shareOpen}<ShareLinksPanel {projectId} pack={{ id: pack.id, name: `evidence pack version ${pack.version}`, status: pack.status, version: pack.version }} />{/if}
				{#snippet actions()}
					<button type="button" class="btn" onclick={() => (shareOpen = false)}>Close</button>
				{/snippet}
			</Dialog>
		{/if}

		{#if fig}
			<section class="panel" aria-labelledby="ap-ewr-h" data-testid="applicant-pack-ewr">
				<h2 id="ap-ewr-h">The river’s ecological reserve</h2>
				<ul class="sites">
					{#each sites as s, i (i)}
						<li>
							<strong>{s.place}</strong>: baseline {s.base}{#if s.withApp !== null}; with the application {s.withApp}{/if}.
							{#if s.change}<span class="muted">{s.change}.</span>{/if}
						</li>
					{:else}
						<li class="muted">No EWR site has a Reserve rule table in this catchment.</li>
					{/each}
				</ul>
			</section>

			<section class="panel" aria-labelledby="ap-rows-h" data-testid="applicant-pack-rows">
				<h2 id="ap-rows-h">The river in figures</h2>
				<div class="table-wrap">
					<table class="data">
						<thead>
							<tr>
								<th scope="col">Measure</th>
								<th scope="col" class="num">Baseline</th>
								{#if application}<th scope="col" class="num">With the application</th><th scope="col" class="num">Change</th>{/if}
							</tr>
						</thead>
						<tbody>
							{#each fig.rows as r, i (i)}
								{@const band = application ? bandText(r.change?.band ?? null, (v) => rowChange(r.id, v)) : null}
								<tr>
									<th scope="row">{rowLabel(r)}{#if r.notAssessed}<span class="muted block">Not assessed</span>{/if}{#if band}<span class="muted block">{band}</span>{/if}</th>
									<td class="num">{rowValue(r.id, r.baseline)}</td>
									{#if application}<td class="num">{rowValue(r.id, r.application)}</td><td class="num">{rowChange(r.id, r.change?.run ?? null)}</td>{/if}
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
				{#if !fig.volumes}
					<p class="muted small" data-testid="applicant-pack-volumes-withheld">
						Flow volumes aren’t shown: with fewer than five farm holders in the catchment, or with a change to the shared baseline, they could reveal another unit’s water use.
					</p>
				{/if}
			</section>
		{/if}

		<section class="panel" aria-labelledby="ap-units-h" data-testid="applicant-pack-units">
			<h2 id="ap-units-h">Hydrological units</h2>
			{#if !view.units}
				<p data-testid="applicant-pack-units-withheld">
					Not shown: this pack’s report changed an assumption of the shared baseline, and every unit’s figure moves with it, so it could reveal another unit’s values.
				</p>
			{:else}
				<h3>Yours</h3>
				{#if own.length}
					<div class="table-wrap">
						<table class="data" data-testid="applicant-pack-own">
							<thead>
								<tr>
									<th scope="col">Unit</th>
									<th scope="col" class="num">Demand supplied, baseline</th>
									<th scope="col" class="num">With the application</th>
									<th scope="col" class="num">Change</th>
								</tr>
							</thead>
							<tbody>
								{#each own as u, i (i)}
									<tr>
										<th scope="row">{u.name}<span class="muted block">{u.kind}</span></th>
										<td class="num">{u.base}</td>
										<td class="num">{u.withApp}</td>
										<td class="num">{u.change}{#if u.band}<span class="muted block">{u.band}</span>{/if}</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
				{:else}
					<p class="muted">None: the application names no hydrological unit linked to its applicant.</p>
				{/if}
				<h3>Everyone else</h3>
				<p data-testid="applicant-pack-others-summary">{othersSummary(view.units.others)}</p>
				{#if others.length}
					<div class="table-wrap">
						<table class="data" data-testid="applicant-pack-others">
							<thead>
								<tr><th scope="col">Unit</th><th scope="col" class="num">Change in demand supplied</th></tr>
							</thead>
							<tbody>
								{#each others as o (o.name)}
									<tr><th scope="row">{o.name}</th><td class="num">{o.change}</td></tr>
								{/each}
							</tbody>
						</table>
					</div>
					<p class="muted small">Numbered by the pack, the same in every version of it; a number says nothing about a unit’s name or where it is.</p>
				{/if}
			{/if}
		</section>

		<section class="panel" aria-labelledby="ap-check-h" data-testid="applicant-pack-check">
			<h2 id="ap-check-h">Check this pack</h2>
			<p>Code <span class="mono" data-testid="applicant-pack-code">{pack.shortCode}</span>, issued {fmtDate(view.verify.issuedAt)}. Anyone holding a copy checks it on the verify page.</p>
			<dl class="hashes">
				<dt>Manifest SHA-256</dt>
				<dd class="mono">{view.verify.manifestSha256}</dd>
				{#if view.verify.pdfSha256}<dt>PDF SHA-256</dt><dd class="mono">{view.verify.pdfSha256}</dd>{/if}
				{#if view.verify.bundleSha256}<dt>Reproduction bundle SHA-256</dt><dd class="mono">{view.verify.bundleSha256}</dd>{/if}
			</dl>
			{#if view.verify.signers.length}
				<p>Signed by:</p>
				<ul>
					{#each view.verify.signers as s, i (i)}<li>{s.fullName}, {s.registrationBody.toUpperCase()} {s.registrationNo}</li>{/each}
				</ul>
			{/if}
		</section>
	{/if}
</main>

<style>
	.applicant-pack {
		max-width: 1000px;
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}
	h1 {
		margin: 0 0 0.5rem;
		font-size: 1.4rem;
		overflow-wrap: anywhere;
	}
	h2 {
		margin: 0 0 0.5rem;
		font-size: 1.1rem;
	}
	h3 {
		margin: 0.75rem 0 0.25rem;
		font-size: 1rem;
	}
	.bar {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem 1rem;
	}
	.note {
		color: var(--text-2);
		max-width: 70ch;
	}
	.sites {
		margin: 0;
		padding-left: 1.2rem;
		display: grid;
		gap: 0.3rem;
	}
	.block {
		display: block;
		font-weight: normal;
	}
	.small {
		font-size: 0.85rem;
	}
	.mono {
		font-family: var(--font-mono);
		font-size: 0.8rem;
		overflow-wrap: anywhere;
	}
	.hashes {
		margin: 0.5rem 0;
	}
	.hashes dd {
		margin: 0 0 0.3rem;
	}
</style>
