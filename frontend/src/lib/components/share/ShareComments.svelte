<!-- i18n-section: share.comments -->
<script lang="ts">
	// The public comments on an application's or an evidence pack's link
	// (WP-3.15; 166_public_participation; licensing positions item 7,
	// provisional position, pre-counsel research, 2026-10-01; docs/ui.md
	// § Share page). Anyone signed in comments through the link itself (POST
	// /share/comment), with no role in the project: a "link participant" reads
	// only what the link shows. Signed out, they are offered the sign-in, the
	// token waiting in this tab's sessionStorage. Every comment box says that
	// a comment here is not a written objection (only a timeous written
	// objection keeps the right to appeal, NWA s148(1)(f)), names the notice's
	// address and closing date when the applicant gave them, and says who
	// receives the comment (POPIA s18) and, if ticked, the commenter's name and
	// email for the applicant's register (GN R267 reg 18).
	import { onMount } from 'svelte';
	import { base } from '$app/paths';
	import { api, ApiError } from '$lib/api';
	import type { SharedComment, ShareObjection } from '$lib/api/types';
	import { fmtStampDay } from '$lib/components/farm/format';
	import { errorText } from '$lib/i18n/apiError';
	import { t } from '$lib/i18n/locale.svelte';
	import { SHARE_RETURN_KEY, SHARE_RETURN_MS } from './scenario';

	let {
		token,
		kind,
		initial,
		objection,
		open = true,
		closed = ''
	}: {
		token: string;
		kind: 'scenario' | 'pack';
		/** The comments the page loaded with, oldest first. */
		initial: SharedComment[];
		objection: ShareObjection | null;
		/** Comments are taken (the server holds the rule too). */
		open?: boolean;
		/** Why not, when closed. */
		closed?: string;
	} = $props();

	const id = (s: string) => `share-${kind}-${s}`;

	/** Comments, oldest first; one posted here is added at the end. */
	let comments = $state<SharedComment[]>([]);
	$effect(() => {
		comments = [...initial];
	});

	let signedIn = $state<boolean | null>(null);
	let draft = $state('');
	let register = $state(false);
	let busy = $state(false);
	let error = $state<string | null>(null);
	let posted = $state('');

	onMount(() => {
		api.auth.me().then(
			() => (signedIn = true),
			() => (signedIn = false)
		);
	});

	/** A notice's date, 'YYYY-MM-DD', as the page writes dates (midday UTC, so no time zone moves it a day). */
	const noticeDate = (d: string) => fmtStampDay(`${d}T12:00:00Z`);

	/** Keep the link for this tab while its reader signs in (never in the address: it would reach the logs). */
	function keepForSignIn() {
		try {
			sessionStorage.setItem(SHARE_RETURN_KEY, JSON.stringify({ t: token, k: kind, exp: Date.now() + SHARE_RETURN_MS }));
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
			const n = await api.share.comment(token, body, register);
			comments = [...comments, n];
			draft = '';
			register = false;
			posted = t('Your comment is posted.');
		} catch (err) {
			const status = err instanceof ApiError ? err.status : 0;
			// A 404 is the server's "this link is dead, or no longer takes comments"; everything else by its code.
			error = status === 401 ? t('Sign in to comment.') : status === 404 ? t('This link no longer takes comments.') : errorText(err);
			if (status === 401) signedIn = false;
		} finally {
			busy = false;
		}
	}
</script>

<section class="card" aria-labelledby={id('comments-h')} data-testid="share-comments">
	<h2 id={id('comments-h')}>{t('Public comments')}</h2>
	<div class="objection" data-testid="share-objection">
		<p>
			<strong>{t('A comment here is not a written objection.')}</strong>
			{t('To object, and to keep the right to appeal (National Water Act s148(1)(f)), write to the address in the application’s notice before its closing date.')}
		</p>
		{#if objection?.address}
			<p class="notice-line">{t('Written objections go to:')} <span class="address">{objection.address}</span></p>
		{/if}
		{#if objection?.closingDate}
			<p class="notice-line">{t('Closing date for objections: {date}', { date: noticeDate(objection.closingDate) })}</p>
		{/if}
	</div>
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
		<p class="fine">{closed}</p>
	{:else if signedIn}
		<form class="comment" onsubmit={comment}>
			<label for={id('comment')}>{t('Add a comment')}</label>
			<textarea id={id('comment')} rows="3" maxlength="4000" bind:value={draft} aria-describedby={id('comment-help')}></textarea>
			<p id={id('comment-help')} class="fine">
				{t('Shown with your name to everyone this page is shared with. Plain text.')}
				{t('The applicant, the responsible authority that decides the application, and the public participation report the applicant gives it (GN R267 reg 19) receive your comment and your name.')}
			</p>
			<label class="check">
				<input type="checkbox" bind:checked={register} aria-describedby={id('register-help')} data-testid="share-register-consent" />
				{t('Give my name and email to the applicant for the register of interested and affected parties (GN R267 reg 18)')}
			</label>
			<p id={id('register-help')} class="fine">
				{t('The applicant keeps that register while the application is considered and for two years after a licence is granted. Without the tick, the applicant gets your name and comment, not your email.')}
			</p>
			<button type="submit" class="btn btn-primary" disabled={busy || !draft.trim()}>{busy ? t('Posting…') : t('Post comment')}</button>
		</form>
	{:else if signedIn === false}
		<p><a href="{base}/login?next={encodeURIComponent(`${base}/share`)}" onclick={keepForSignIn} data-testid="share-sign-in">{t('Sign in to comment')}</a></p>
		<p class="fine">{t('Commenting needs an account, so every comment has a name. You don’t need to be a member of the project: the account reads only what this link shows.')}</p>
	{/if}
	{#if error}<p class="alert alert-error" role="alert">{error}</p>{/if}
	<p class="visually-hidden" role="status">{posted}</p>
</section>

<style>
	.comments {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 10px;
	}
	.comments li {
		border-left: 3px solid var(--border-strong);
		padding-left: 10px;
	}
	.body,
	.address {
		white-space: pre-line;
		overflow-wrap: anywhere;
	}
	.objection {
		border-left: 4px solid var(--warning, var(--border-strong));
		padding: 4px 0 4px 10px;
		margin-bottom: 12px;
	}
	.objection p {
		margin: 0 0 4px;
	}
	.comment {
		display: grid;
		gap: 6px;
		margin-top: 12px;
	}
	.comment > label {
		font-weight: 500;
	}
	.check {
		display: flex;
		gap: 8px;
		align-items: flex-start;
	}
	.check input {
		margin-top: 4px;
		min-width: 20px;
		min-height: 20px;
	}
	textarea {
		width: 100%;
		font: inherit;
	}
	.comment button {
		justify-self: start;
		min-height: 44px;
	}
</style>
