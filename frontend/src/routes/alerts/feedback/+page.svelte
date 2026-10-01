<!-- i18n-section: feedback -->
<script lang="ts">
	// The page an alert email's "Was this useful? Yes · No" links open
	// (147_alert_feedback, docs/ui.md § Alerts). Works signed in or out: the
	// token in the URL's fragment (never sent to a server log) is the
	// credential, and it only ever answers its own email. Opening the link
	// records nothing: the answer the link chose is preselected, and only
	// Send stores it, so a mail scanner that opens links answers nothing.
	// No tracking of any kind (Privacy §3). Its words come from $lib/i18n.
	import { onMount } from 'svelte';
	import { replaceState } from '$app/navigation';
	import { base } from '$app/paths';
	import { page } from '$app/state';
	import { api, ApiError, type FeedbackAnswered } from '$lib/api';
	import { FEEDBACK_COMMENT_MAX, feedbackThanks, fragmentAnswer, fragmentToken } from '$lib/components/alerts/words';
	import AuthCard, { focusAuthTitle } from '$lib/components/layout/AuthCard.svelte';
	import { t } from '$lib/i18n/locale.svelte';
	import { errorText } from '$lib/i18n/apiError';

	let token = $state<string | null>(null);
	let useful = $state<boolean | null>(null);
	let comment = $state('');
	let status = $state<'loading' | 'ask' | 'working' | 'done' | 'dead' | 'incomplete'>('loading');
	let done = $state<FeedbackAnswered | null>(null);
	/** A failure that isn't the link's (no signal, a server problem): the form stays, to try again. */
	let failure = $state<string | null>(null);
	/** Send pressed with no answer chosen. */
	let unanswered = $state(false);
	const tooLong = $derived(comment.trim().length > FEEDBACK_COMMENT_MAX);

	onMount(() => {
		token = fragmentToken(page.url.hash);
		useful = fragmentAnswer(page.url.hash);
		// Out of the address bar and the history once read.
		if (page.url.hash) replaceState(`${base}/alerts/feedback`, {});
		status = token ? 'ask' : 'incomplete';
	});

	async function send(e: SubmitEvent) {
		e.preventDefault();
		if (!token) return;
		if (useful === null) {
			unanswered = true;
			return;
		}
		if (tooLong) return;
		status = 'working';
		failure = null;
		try {
			done = await api.alerts.feedback(token, useful, comment.trim() || null);
			status = 'done';
			void focusAuthTitle();
		} catch (err) {
			// Only the server's "this link is no good" (404) means the link is dead.
			if (err instanceof ApiError && err.status === 404) {
				status = 'dead';
				void focusAuthTitle();
			} else {
				failure = errorText(err);
				status = 'ask';
			}
		}
	}
</script>

<svelte:head>
	<title>{t('{page} · Water Management', { page: t('Was this alert useful?') })}</title>
	<meta name="referrer" content="no-referrer" />
</svelte:head>

<AuthCard title={t('Was this alert useful?')} footer={status === 'done' || status === 'dead' ? undefined : manageLink}>
	<div data-ready={status === 'loading' ? undefined : 'true'} data-state={status}>
		{#if status === 'ask' || status === 'working'}
			<form onsubmit={send} novalidate>
				<fieldset class="answer" aria-describedby={unanswered && useful === null ? 'feedback-pick' : undefined}>
					<legend>{t('Your answer')}</legend>
					<label class="choice"><input type="radio" name="useful" value="yes" checked={useful === true} onchange={() => (useful = true)} /> {t('Yes, it was useful')}</label>
					<label class="choice"><input type="radio" name="useful" value="no" checked={useful === false} onchange={() => (useful = false)} /> {t('No, it wasn’t useful')}</label>
					{#if unanswered && useful === null}<p class="error" id="feedback-pick" role="alert">{t('Choose Yes or No.')}</p>{/if}
				</fieldset>
				<div class="field">
					<label for="feedback-comment">{t('Anything to add? (optional)')}</label>
					<textarea
						id="feedback-comment"
						rows="3"
						bind:value={comment}
						aria-describedby="feedback-hint{tooLong ? ' feedback-long' : ''}"
						aria-invalid={tooLong ? 'true' : undefined}
					></textarea>
					<span class="hint" id="feedback-hint">{t('Your WUA reads your answer and comment without your name. Nothing is kept until you press Send.')}</span>
					{#if tooLong}<span class="error" id="feedback-long">{t('Keep it to {max} characters.', { max: FEEDBACK_COMMENT_MAX })}</span>{/if}
				</div>
				{#if failure}<div class="alert alert-error" role="alert">{failure}</div>{/if}
				<button type="submit" class="btn btn-primary" disabled={status === 'working'}>
					{status === 'working' ? t('One moment…') : t('Send')}
				</button>
			</form>
		{:else if status === 'done' && done}
			<div class="alert alert-info" role="status">{feedbackThanks(done)}</div>
			<a class="btn btn-primary" href="{base}/account/alerts">{t('Manage alerts')}</a>
		{:else if status === 'dead'}
			<div class="alert alert-error" role="alert">{t('This link doesn’t work any more: it lasts 30 days, and only while you are a member of the catchment.')}</div>
			<a class="btn btn-primary" href="{base}/account/alerts">{t('Manage alerts')}</a>
		{:else if status === 'incomplete'}
			<div class="alert alert-error" role="alert">{t('This link is incomplete. Open it again from the email, or copy the whole link.')}</div>
		{/if}
	</div>
</AuthCard>

{#snippet manageLink()}
	<a href="{base}/account/alerts">{t('Manage alerts')}</a>
{/snippet}

<style>
	.answer {
		border: 0;
		margin: 0 0 0.75rem;
		padding: 0;
		display: grid;
		gap: 0.25rem;
	}
	.answer legend {
		font-weight: 600;
		margin-bottom: 0.25rem;
	}
	.choice {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		min-height: var(--tap);
	}
	.choice input {
		width: 1.15rem;
		height: 1.15rem;
	}
	textarea {
		width: 100%;
		font: inherit;
	}
	.error {
		color: var(--danger);
		margin: 0;
	}
</style>
