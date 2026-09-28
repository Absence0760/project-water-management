<!-- i18n-section: farm.ack -->
<script lang="ts">
	// "Before you look at your farm" (issue #47; the CPA s49 research's R2):
	// until the signed-in account has pressed "I understand" on the notice in
	// force (/auth/me `farmNoticeCurrent`, 093), a farm page shows this instead
	// of its figures. WUA staff previewing a farm see the figures as the farmer
	// does, without it: the notice is the farmer's to acknowledge.
	// Pressed without a signal, the press is kept on the phone (noticeAck.ts)
	// and the figures show; it is sent when the signal is back, and a refusal
	// (the notice changed meanwhile) brings the notice back.
	import { untrack, type Snippet } from 'svelte';
	import { FARMER_NOTICE_VERSION } from '@water-management/engine/legal';
	import { base } from '$app/paths';
	import { api } from '$lib/api';
	import { session } from '$lib/auth/session.svelte';
	import { errorText } from '$lib/i18n/apiError';
	import { t } from '$lib/i18n/locale.svelte';
	import { farmNoticeButton, farmNoticePoints, farmNoticeTitle } from './farmNotice';
	import { classify } from './load';
	import { clearPendingAck, flushOutcome, hasPendingAck, savePendingAck } from './noticeAck';

	let { preview = false, children }: { preview?: boolean; children: Snippet } = $props();

	// Bumped when this phone's kept press changes, so `pending` reads storage again.
	let kept = $state(0);
	const userId = $derived(session.user?.id ?? null);
	const pending = $derived.by(() => {
		void kept;
		return !!userId && hasPendingAck(userId, FARMER_NOTICE_VERSION);
	});
	const needed = $derived(!preview && !!session.user && session.user.farmNoticeCurrent !== true && !pending);
	let busy = $state(false);
	let error = $state('');

	async function acknowledge() {
		busy = true;
		error = '';
		try {
			session.user = await api.auth.acknowledgeFarmNotice();
		} catch (e) {
			// No signal: keep the press on the phone and show the figures; it goes when the signal is back.
			if (classify(e) === 'offline' && userId && savePendingAck(userId, FARMER_NOTICE_VERSION)) kept++;
			else error = errorText(e);
		} finally {
			busy = false;
		}
	}

	let flushing = false;
	/** Send a kept press. The server stamps its own time; a refusal drops the press and the notice shows again. */
	async function flush() {
		if (flushing || !pending || session.user?.farmNoticeCurrent === true) {
			if (pending && session.user?.farmNoticeCurrent === true) {
				clearPendingAck();
				kept++;
			}
			return;
		}
		flushing = true;
		let failure: unknown | null = null;
		try {
			session.user = await api.auth.acknowledgeFarmNotice();
		} catch (e) {
			failure = e;
		} finally {
			flushing = false;
		}
		if (flushOutcome(failure) !== 'keep') {
			clearPendingAck();
			kept++;
		}
	}

	$effect(() => {
		if (!pending) return;
		// Only `pending` drives this: flush's own reads of the session mustn't re-run it.
		untrack(() => void flush());
		const online = () => void flush();
		window.addEventListener('online', online);
		return () => window.removeEventListener('online', online);
	});
</script>

{#if needed}
	<section class="card ack" aria-labelledby="ack-h">
		<h1 id="ack-h">{farmNoticeTitle()}</h1>
		<ul>
			{#each farmNoticePoints() as point, i (i)}
				<li>
					{#each point.split(/(\{terms\})/) as part, j (j)}{#if part === '{terms}'}<a href="{base}/terms#liability">{t('Terms of use')}</a>{:else}{part}{/if}{/each}
				</li>
			{/each}
		</ul>
		{#if error}<p class="error" role="alert">{error}</p>{/if}
		<button class="btn btn-primary" type="button" onclick={acknowledge} disabled={busy}>{farmNoticeButton()}</button>
	</section>
{:else}
	{@render children()}
{/if}

<style>
	.ack ul {
		margin: 0;
		padding-left: 20px;
		display: flex;
		flex-direction: column;
		gap: 10px;
		font-size: 16px;
		line-height: 1.45;
	}
	.ack button {
		align-self: flex-start;
		min-height: var(--tap);
	}
	.error {
		color: var(--danger);
	}
</style>
