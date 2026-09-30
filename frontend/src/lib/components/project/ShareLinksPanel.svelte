<script lang="ts">
	// Read-only share links (WP-2.3 phase 2, docs/ui.md § Share links): the
	// owner makes a link to the published baseline for someone outside the
	// project, copies it once (the token isn't kept, so it can't be shown
	// again), sees when each was last opened, and withdraws one. Owners only:
	// ProjectTab renders this for an owner, and the API answers anyone else 403.
	// The list there is the owner's inventory of every public link in the
	// project (`?scope=all`): the baseline's and each application's, made by
	// its assessors or applicant, each with what it opens, so the owner can
	// withdraw any of them from one place.
	// With `scenario` (WP-3.15, docs/ui.md § Applications) it is one
	// submitted or decided scenario's links instead, in its Share dialog: an
	// assessor lists and withdraws every link to it, its applicant the ones
	// they made (the API's RLS decides which are listed).
	// With `pack` (WP-3.15, 128_pack_share_notes; docs/ui.md § Evidence pack)
	// it is one issued evidence pack's links, on the pack's page: its editors
	// list, make and withdraw them.
	import { confirmDialog } from '$lib/components/common/confirm.svelte';
	import { onMount } from 'svelte';
	import { api, SHARE_LABEL_MAX, type PackStatus, type ScenarioStatus, type ShareLink } from '$lib/api';
	import LoadState from '$lib/components/common/LoadState.svelte';
	import { DEFAULT_EXPIRY_DAYS, EXPIRY_CHOICES, linkRow, revokeQuestion, sortLinks, STATE_WORD } from './shareLinks';

	let {
		projectId,
		scenario,
		pack
	}: { projectId: string; scenario?: { id: string; name: string; status: ScenarioStatus }; pack?: { id: string; name: string; status: PackStatus; version: number } } = $props();
	/** One target's links (a scenario's or a pack's), rather than the owner's inventory. */
	const targeted = $derived(!!scenario || !!pack);
	/**
	 * A link opens a scenario only while it is submitted or decided
	 * (app_share_scenario); one is made to a pack only while it is issued (a
	 * made link keeps working after, showing that it no longer stands).
	 */
	const shareable = $derived(pack ? pack.status === 'issued' : !scenario || scenario.status === 'submitted' || scenario.status === 'decided');
	const listLinks = () =>
		pack ? api.shareLinks.listForPack(projectId, pack.id) : scenario ? api.shareLinks.listForScenario(projectId, scenario.id) : api.shareLinks.listAll(projectId);

	let links = $state<ShareLink[]>([]);
	let loading = $state(true);
	let loadError = $state<string | null>(null);
	let error = $state<string | null>(null);
	let busy = $state<string | null>(null);

	let label = $state('');
	let days = $state<number>(DEFAULT_EXPIRY_DAYS);
	let creating = $state(false);
	/** The link just made: its URL is shown this once. */
	let fresh = $state<{ id: string; label: string; url: string } | null>(null);
	/** Whether a run is published (a link shows nothing until one is); null until known. */
	let published = $state<boolean | null>(null);
	let copied = $state('');
	let urlInput: HTMLInputElement | undefined = $state();

	const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
	const rows = $derived(sortLinks(links).map((l) => linkRow(l)));

	async function load() {
		loading = true;
		loadError = null;
		try {
			if (targeted) {
				links = await listLinks();
				published = true;
			} else {
				const [list, pub] = await Promise.all([listLinks(), api.publication.get(projectId)]);
				links = list;
				published = pub.current !== null;
			}
		} catch (e) {
			loadError = msg(e);
		} finally {
			loading = false;
		}
	}
	onMount(load);

	async function create(e: SubmitEvent) {
		e.preventDefault();
		creating = true;
		error = null;
		copied = '';
		try {
			const { url, ...link } = pack
				? await api.shareLinks.createForPack(projectId, pack.id, label.trim(), days)
				: scenario
					? await api.shareLinks.createForScenario(projectId, scenario.id, label.trim(), days)
					: await api.shareLinks.create(projectId, label.trim(), days);
			links = [link, ...links];
			fresh = { id: link.id, label: link.label, url };
			label = '';
		} catch (err) {
			error = msg(err);
		} finally {
			creating = false;
		}
	}

	async function copy() {
		if (!fresh) return;
		try {
			await navigator.clipboard.writeText(fresh.url);
			copied = 'Link copied.';
		} catch {
			// No clipboard permission: select it so the owner can copy it themselves.
			urlInput?.select();
			copied = 'Couldn’t copy automatically. The link is selected: copy it with your keyboard or menu.';
		}
	}

	async function revoke(id: string, name: string, opens?: string) {
		if (!(await confirmDialog({ title: 'Withdraw this link?', message: revokeQuestion(name, opens), confirmLabel: 'Withdraw link', danger: true }))) return;
		busy = id;
		error = null;
		try {
			await api.shareLinks.revoke(projectId, id);
			if (fresh?.id === id) fresh = null;
			links = await listLinks();
		} catch (err) {
			error = msg(err);
		} finally {
			busy = null;
		}
	}
</script>

<section class:panel={!targeted} aria-labelledby={targeted ? undefined : 'share-h'} data-testid={pack ? 'pack-share' : scenario ? 'scenario-share' : undefined}>
	{#if pack}
		<p class="muted small intro" id="share-what">
			A read-only link to {pack.name} for someone outside the project (an NGO, a catchment forum), signed out. They see what the verify
			page shows (its status, hashes and signers) and, while it stays issued, the river’s ecological reserve at each EWR site, the
			days below the EWR and, when the catchment has at least five hydrological units, its volumes. Never a hydrological unit’s name
			or figures, registered volumes, other applications or the applicant’s statement. If the pack is later withdrawn or replaced, the
			link says so instead of showing its figures. While a link is live, members can comment for public participation.
		</p>
		{#if !shareable}
			<p class="alert alert-info" data-testid="pack-share-closed">Only an issued pack can be shared: a draft is still changing, and a superseded or withdrawn pack no longer stands.</p>
		{/if}
	{:else if scenario}
		<p class="muted small intro" id="share-what">
			A read-only link to “{scenario.name}” for someone outside the project (an NGO, a catchment forum), signed out. They see its
			changes, the river’s ecological reserve at each EWR site against the baseline, the catchment’s totals when it has at least five
			hydrological units, and the comments posted for public participation. Never another unit’s name or figures, who is in the
			project, or registered volumes. While a link is live, members can comment for public participation.
		</p>
		{#if !shareable}
			<p class="alert alert-info" data-testid="scenario-share-draft">Only a submitted or decided application can be shared: submit it first.</p>
		{/if}
	{:else}
		<div class="panel-head">
			<h2 id="share-h">Share links</h2>
		</div>
		<p class="muted small intro">
			A read-only link to the published baseline for someone outside the project: the catchment’s reserve status and the WUA’s notice,
			signed out. It never shows a hydrological unit’s name or figures, or the modeller’s note.
		</p>
		<p class="muted small intro" data-testid="share-inventory-note">
			The list is every public link in this project: the baseline links made here, and the links to applications that their assessors
			or applicants make from an application’s Share dialog. You can withdraw any of them.
		</p>
	{/if}
	{#if published === false}
		<p class="muted small">Nothing is published yet: a link opens only once a run is published (Runs tab).</p>
	{/if}
	{#if error}<div class="alert alert-error" role="alert">{error}</div>{/if}

	{#if shareable}
	<form class="add" aria-label="Make a share link" onsubmit={create}>
		<div class="field">
			<label for="share-label">Who it’s for</label>
			<input id="share-label" required maxlength={SHARE_LABEL_MAX} placeholder="Catchment forum, March meeting" bind:value={label} />
		</div>
		<div class="field">
			<label for="share-days">Works for</label>
			<select id="share-days" bind:value={days}>
				{#each EXPIRY_CHOICES as c (c.days)}<option value={c.days}>{c.label}</option>{/each}
			</select>
		</div>
		<div>
			<button class="btn btn-primary" type="submit" disabled={creating || !label.trim()}>{creating ? 'Making…' : 'Make link'}</button>
		</div>
	</form>
	{/if}

	{#if fresh}
		<div class="fresh" role="group" aria-labelledby="fresh-h">
			<p id="fresh-h" class="fresh-h">Link for “{fresh.label}”</p>
			<p class="muted small">Copy it now: it won’t be shown again. Anyone with it can open the page until it expires or you withdraw it.</p>
			<div class="copy-row">
				<label for="share-url" class="visually-hidden">The new link</label>
				<input id="share-url" readonly value={fresh.url} bind:this={urlInput} onfocus={(e) => e.currentTarget.select()} />
				<button type="button" class="btn" onclick={copy}>Copy</button>
			</div>
			<p class="copied" role="status" aria-live="polite">{copied}</p>
		</div>
	{/if}

	<LoadState {loading} error={loadError} retry={load} empty={links.length === 0} emptyText="No share links yet.">
		<div class="table-wrap">
			<table class="data">
				<thead>
					<tr>
						<th scope="col">Link</th>
						<th scope="col">Made</th>
						<th scope="col">Ends</th>
						<th scope="col">Last opened</th>
						<th scope="col"><span class="visually-hidden">Actions</span></th>
					</tr>
				</thead>
				<tbody>
					{#each rows as r (r.id)}
						<tr class:dead={r.state !== 'live'}>
							<th scope="row">
								{r.label}
								{#if !targeted}<span class="opens">{r.opens}</span>{/if}
								<span class="state {r.state}">{STATE_WORD[r.state]}</span>
								{#if (!targeted || pack) && r.state === 'live' && r.opensNothing}<span class="nothing">{r.opensNothing}</span>{/if}
							</th>
							<td>{r.created}</td>
							<td>{r.ends}</td>
							<td>{r.lastUsed}</td>
							<td class="act">
								{#if r.canRevoke}
									<button type="button" class="btn btn-sm btn-danger" disabled={busy === r.id} onclick={() => revoke(r.id, r.label, targeted ? undefined : r.opens)} aria-label="Withdraw {r.label}">Withdraw</button>
								{/if}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	</LoadState>
</section>

<style>
	.intro {
		margin: -0.25rem 0 0.75rem;
	}
	.add {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-end;
		gap: 0.5rem 0.75rem;
		margin-bottom: 0.75rem;
	}
	.add .field {
		margin-bottom: 0;
	}
	.add .field:first-child {
		flex: 1 1 16rem;
	}
	.add input {
		width: 100%;
	}
	.fresh {
		margin-bottom: 0.75rem;
		padding: 0.75rem;
		border: 1px solid var(--accent);
		border-radius: var(--radius);
		background: var(--accent-soft);
	}
	.fresh-h {
		margin: 0 0 0.25rem;
		font-weight: 600;
		overflow-wrap: anywhere;
	}
	.fresh .small {
		margin: 0 0 0.5rem;
	}
	.copy-row {
		display: flex;
		gap: 0.5rem;
	}
	.copy-row input {
		flex: 1 1 auto;
		min-width: 0;
		font-family: var(--font-mono, monospace);
		font-size: 0.8rem;
	}
	.copied {
		margin: 0.35rem 0 0;
		font-size: 0.85rem;
		color: var(--text-2);
	}
	.copied:empty {
		margin: 0;
	}
	.state {
		display: block;
		font-weight: 400;
		font-size: 0.8rem;
		color: var(--text-muted);
	}
	.state.live {
		color: var(--success);
	}
	.opens {
		display: block;
		font-weight: 400;
		font-size: 0.85rem;
		color: var(--text-2);
		overflow-wrap: anywhere;
	}
	.nothing {
		display: block;
		font-weight: 400;
		font-size: 0.8rem;
		color: var(--warning);
	}
	tr.dead th,
	tr.dead td {
		color: var(--text-muted);
	}
	.act {
		text-align: right;
		white-space: nowrap;
	}
</style>
