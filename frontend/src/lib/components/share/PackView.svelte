<!-- i18n-section: share.pack -->
<script lang="ts">
	// An evidence pack link's page (WP-3.15, the pack half; 128_pack_share_notes;
	// docs/ui.md § Share page): an issued licensing evidence pack, read-only,
	// for someone outside the project. What the verify page shows (its
	// standing, code, hashes and signers), and while it stands the Reserve at
	// each EWR site, the river's rows of its change table and the paired
	// change by month, all from the pack's own frozen report. Once withdrawn
	// or superseded it says so, and why or which version replaced it, and
	// shows no figure. Public comments as on an application's link: a member
	// of the project who is signed in comments while the pack stands (POST
	// …/notes with the pack, `public_participation`); anyone else is offered
	// the sign-in, the token waiting in this tab's sessionStorage. Every word
	// is in ./pack.ts or t() here.
	import { onMount } from 'svelte';
	import { base } from '$app/paths';
	import { api, ApiError } from '$lib/api';
	import type { SharePack } from '$lib/api/types';
	import { fmtStampDay } from '$lib/components/farm/format';
	import { errorText } from '$lib/i18n/apiError';
	import { t } from '$lib/i18n/locale.svelte';
	import { bandLine, monthRows, packSiteRows, packStatusLine, rowChange, rowLabel, rowValue, signerLine, standingNote, successorCode } from './pack';
	import { SHARE_RETURN_KEY, SHARE_RETURN_MS } from './scenario';
	import { shareCaveat } from './share';

	let { view, token }: { view: SharePack; token: string } = $props();

	const v = $derived(view.verify);
	const fig = $derived(view.figures);
	const application = $derived(view.pack.mode === 'application');
	const standing = $derived(standingNote(v));
	const successor = $derived(successorCode(v));
	const sites = $derived(fig ? packSiteRows(fig.river, application) : []);
	const months = $derived(fig?.byMonth ? monthRows(fig.byMonth) : []);
	/** Comments are open only while the pack stands (the server holds the rule: issued, with a live link). */
	const open = $derived(v.status === 'issued');

	/** Comments, oldest first; one posted here is added at the end. */
	let comments = $state<SharePack['comments']>([]);
	$effect(() => {
		comments = [...view.comments];
	});

	let signedIn = $state<boolean | null>(null);
	let draft = $state('');
	let busy = $state(false);
	let error = $state<string | null>(null);
	let posted = $state('');

	onMount(() => {
		api.auth.me().then(
			() => (signedIn = true),
			() => (signedIn = false)
		);
	});

	/** Keep the link for this tab while its reader signs in (never in the address: it would reach the logs). */
	function keepForSignIn() {
		try {
			sessionStorage.setItem(SHARE_RETURN_KEY, JSON.stringify({ t: token, k: 'pack', exp: Date.now() + SHARE_RETURN_MS }));
		} catch {
			// Storage refused (a private window): they open the link again after signing in.
		}
	}

	async function comment(e: SubmitEvent) {
		e.preventDefault();
		const body = draft.replace(/\r\n?/g, '\n').trim();
		if (!body) return;
		busy = true;
		error = null;
		posted = '';
		try {
			const n = await api.notes.create(view.project.id, { body, packId: view.pack.id, visibility: 'public_participation' });
			comments = [...comments, { body: n.body, author: n.author, createdAt: n.createdAt, editedAt: n.editedAt }];
			draft = '';
			posted = t('Your comment is posted.');
		} catch (err) {
			const status = err instanceof ApiError ? err.status : 0;
			// A 404 is the server's "not a member, or not one you can comment on"; everything else by its code.
			error =
				status === 401
					? t('Sign in to comment.')
					: status === 404
						? t('Only members of this project can comment. Ask its owner to invite you.')
						: errorText(err);
			if (status === 401) signedIn = false;
		} finally {
			busy = false;
		}
	}
</script>

<div class="head">
	<h1>{view.pack.title}</h1>
	<p class="sub">{t('Licensing evidence pack, version {version}, shared read-only', { version: view.pack.version })}</p>
	<p class="dates" data-testid="share-pack-status" data-status={v.status}>{packStatusLine(v)}</p>
	<p class="caveat" data-testid="share-caveat">{shareCaveat()}</p>
</div>

{#if standing}
	<section class="card standing" aria-labelledby="standing-h" data-testid="share-pack-standing">
		<h2 id="standing-h">{v.status === 'withdrawn' ? t('This pack was withdrawn') : t('This pack was replaced')}</h2>
		<p role="status">{standing}</p>
		{#if v.status === 'withdrawn' && v.withdrawnReason}
			<p>{t('The reason given:')}</p>
			<p class="desc" data-testid="share-pack-reason">{v.withdrawnReason}</p>
		{/if}
		{#if successor}
			<p>{t('The version that replaced it has the code {code}.', { code: successor })} <a href="{base}/verify/{encodeURIComponent(successor)}">{t('Check it on the verify page')}</a></p>
		{/if}
	</section>
{/if}

<div class="cols">
	<div class="col">
		{#if fig}
			<section class="card" aria-labelledby="pk-ewr-h" data-testid="share-pack-ewr">
				<h2 id="pk-ewr-h">{t('The river’s ecological reserve')}</h2>
				<p class="sub">
					{application
						? t('Months the Reserve is met at each EWR site: the baseline beside this application, as the pack records them.')
						: t('Months the Reserve is met at each EWR site, as the pack records them.')}
				</p>
				<ul class="ewr">
					{#each sites as r, i (i)}
						<li class="ewr-site {r.trend}">
							<p class="place">{r.place}</p>
							<dl>
								<dt>{t('Baseline')}</dt>
								<dd>{r.base}</dd>
								{#if r.withApp !== null}
									<dt>{t('With this application')}</dt>
									<dd>{r.withApp}</dd>
								{/if}
							</dl>
							{#if r.change}<p class="change">{r.change}</p>{/if}
						</li>
					{:else}
						<li class="fine">{t('No EWR site has a Reserve rule table in this catchment.')}</li>
					{/each}
				</ul>
			</section>

			<section class="card" aria-labelledby="pk-rows-h" data-testid="share-pack-rows">
				<h2 id="pk-rows-h">{t('The river in figures')}</h2>
				<div class="table-scroll">
					<table class="numbers">
						<thead>
							<tr>
								<th scope="col"><span class="visually-hidden">{t('Figure')}</span></th>
								<th scope="col">{t('Baseline')}</th>
								{#if application}<th scope="col">{t('With this application')}</th><th scope="col">{t('Change')}</th>{/if}
							</tr>
						</thead>
						<tbody>
							{#each fig.rows as r, i (i)}
								<tr>
									<th scope="row">
										{rowLabel(r)}
										{#if r.notAssessed}<span class="fine block">{t('Not assessed')}</span>{/if}
										{#if application && bandLine(r.id, r.change?.band ?? null)}<span class="fine block">{bandLine(r.id, r.change?.band ?? null)}</span>{/if}
									</th>
									<td>{rowValue(r.id, r.baseline)}</td>
									{#if application}<td>{rowValue(r.id, r.application)}</td><td>{rowChange(r.id, r.change?.run ?? null)}</td>{/if}
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
				{#if !fig.volumes}
					<p class="fine">{t('Flow volumes aren’t shown for this catchment: with so few hydrological units, or with a change to the shared baseline, they could reveal a hydrological unit’s water use.')}</p>
				{/if}
			</section>

			{#if application && months.length}
				<section class="card" aria-labelledby="pk-month-h">
					<h2 id="pk-month-h">{t('Days below the EWR by month')}</h2>
					<p class="sub">{t('The change this application makes to the days below the EWR at the outlet, each calendar month.')}</p>
					<div class="table-scroll">
						<table class="numbers">
							<thead>
								<tr><th scope="col">{t('Month')}</th><th scope="col">{t('Change')}</th></tr>
							</thead>
							<tbody>
								{#each months as m (m.month)}
									<tr><th scope="row">{m.month}{#if m.range}<span class="fine block">{m.range}</span>{/if}</th><td>{m.change}</td></tr>
								{/each}
							</tbody>
						</table>
					</div>
				</section>
			{/if}
		{/if}

		<section class="card" aria-labelledby="pk-check-h" data-testid="share-pack-check">
			<h2 id="pk-check-h">{t('Check this pack')}</h2>
			<p>{t('Its code is {code}. Anyone holding a copy of the pack can check it against this app on the verify page.', { code: view.pack.shortCode })}</p>
			<p><a href="{base}/verify/{encodeURIComponent(view.pack.shortCode)}" data-testid="share-pack-verify">{t('Open the verify page')}</a></p>
			<dl class="hashes">
				<dt>{t('Manifest SHA-256')}</dt>
				<dd class="mono">{v.manifestSha256}</dd>
				{#if v.pdfSha256}<dt>{t('PDF SHA-256')}</dt><dd class="mono">{v.pdfSha256}</dd>{/if}
				{#if v.bundleSha256}<dt>{t('Reproduction bundle SHA-256')}</dt><dd class="mono">{v.bundleSha256}</dd>{/if}
			</dl>
			{#if v.signers.length}
				<p>{t('Signed by:')}</p>
				<ul class="signers">
					{#each v.signers as s, i (i)}<li>{signerLine(s)}</li>{/each}
				</ul>
			{/if}
		</section>
	</div>

	<div class="col">
		<section class="card" aria-labelledby="pk-comments-h" data-testid="share-comments">
			<h2 id="pk-comments-h">{t('Public comments')}</h2>
			{#if comments.length}
				<ul class="comments">
					{#each comments as c, i (i)}
						<li>
							<p class="body">{c.body}</p>
							<p class="fine">
								{c.author ?? t('a former member')} · <time datetime={c.createdAt}>{fmtStampDay(c.createdAt)}</time>{#if c.editedAt}
									· {t('edited')}{/if}
							</p>
						</li>
					{/each}
				</ul>
			{:else}
				<p class="fine">{t('No comments yet.')}</p>
			{/if}
			{#if !open}
				<p class="fine">{t('Commenting is closed: this pack no longer stands.')}</p>
			{:else if signedIn}
				<form class="comment" onsubmit={comment}>
					<label for="share-pack-comment">{t('Add a comment')}</label>
					<textarea id="share-pack-comment" rows="3" maxlength="4000" bind:value={draft} aria-describedby="share-pack-comment-help"></textarea>
					<p id="share-pack-comment-help" class="fine">{t('Shown with your name to everyone this pack is shared with. Plain text; every edit is kept.')}</p>
					<button type="submit" class="btn btn-primary" disabled={busy || !draft.trim()}>{busy ? t('Posting…') : t('Post comment')}</button>
				</form>
			{:else if signedIn === false}
				<p><a href="{base}/login?next={encodeURIComponent(`${base}/share`)}" onclick={keepForSignIn} data-testid="share-sign-in">{t('Sign in to comment')}</a></p>
				<p class="fine">{t('Commenting needs an account in this project, so every comment has a name.')}</p>
			{/if}
			{#if error}<p class="alert alert-error" role="alert">{error}</p>{/if}
			<p class="visually-hidden" role="status">{posted}</p>
		</section>

		<section class="card" aria-labelledby="about-pk-h">
			<h2 id="about-pk-h">{t('About this page')}</h2>
			<p>{t('A licensing evidence pack: the model results an applicant attaches to a water-use licence application, signed by a registered professional and fixed once issued. This page shows part of it, read-only, and names no hydrological unit.')}</p>
			<p class="fine">{t('This link works until it expires or is withdrawn. If the pack is withdrawn or replaced, the link says so instead of showing its figures.')}</p>
			<p class="fine">{t('It is not a water-use authorisation, licence, allocation or restriction under the National Water Act: only the responsible authority and the Water User Association’s own notices decide those. Don’t rely on it alone for a decision.')}</p>
			<p class="fine legal-links"><a href="{base}/terms">{t('Terms of use')}</a> · <a href="{base}/privacy">{t('Privacy notice')}</a></p>
		</section>
	</div>
</div>

<style>
	.cols,
	.col {
		display: flex;
		flex-direction: column;
		gap: 12px;
		min-width: 0;
	}
	@container share (min-width: 860px) {
		.cols {
			display: grid;
			grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
			align-items: start;
		}
	}
	.standing {
		border-left: 4px solid var(--danger);
	}
	.ewr,
	.comments,
	.signers {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 10px;
	}
	.ewr-site {
		border-left: 4px solid var(--border-strong);
		padding: 4px 0 4px 10px;
	}
	.ewr-site.worse {
		border-left-color: var(--danger);
	}
	.ewr-site.better {
		border-left-color: var(--success);
	}
	.place {
		font-weight: 600;
		margin: 0;
	}
	dl {
		display: grid;
		grid-template-columns: auto 1fr;
		gap: 2px 10px;
		margin: 4px 0;
	}
	dt {
		color: var(--text-2);
	}
	dd {
		margin: 0;
		min-width: 0;
	}
	.change {
		margin: 0;
		font-weight: 500;
	}
	.worse .change {
		color: var(--danger);
	}
	.hashes {
		grid-template-columns: 1fr;
	}
	.mono {
		font-family: var(--font-mono);
		font-size: 13px;
		overflow-wrap: anywhere;
	}
	.block {
		display: block;
	}
	.desc,
	.body {
		white-space: pre-line;
		overflow-wrap: anywhere;
	}
	.comments li {
		border-left: 3px solid var(--border-strong);
		padding-left: 10px;
	}
	.comment {
		display: grid;
		gap: 6px;
		margin-top: 12px;
	}
	.comment label {
		font-weight: 500;
	}
	textarea {
		width: 100%;
		font: inherit;
	}
	.comment button {
		justify-self: start;
		min-height: 44px;
	}
	.table-scroll {
		overflow-x: auto;
	}
</style>
