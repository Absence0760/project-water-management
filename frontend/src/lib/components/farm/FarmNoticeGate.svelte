<!-- i18n-section: farm.ack -->
<script lang="ts">
	// "Before you look at your farm" (issue #47; the CPA s49 research's R2):
	// until the signed-in account has pressed "I understand" on the notice in
	// force (/auth/me `farmNoticeCurrent`, 093), a farm page shows this instead
	// of its figures. WUA staff previewing a farm see the figures as the farmer
	// does, without it: the notice is the farmer's to acknowledge.
	import type { Snippet } from 'svelte';
	import { base } from '$app/paths';
	import { api } from '$lib/api';
	import { session } from '$lib/auth/session.svelte';
	import { errorText } from '$lib/i18n/apiError';
	import { t } from '$lib/i18n/locale.svelte';
	import { farmNoticeButton, farmNoticePoints, farmNoticeTitle } from './farmNotice';

	let { preview = false, children }: { preview?: boolean; children: Snippet } = $props();

	const needed = $derived(!preview && !!session.user && session.user.farmNoticeCurrent !== true);
	let busy = $state(false);
	let error = $state('');

	async function acknowledge() {
		busy = true;
		error = '';
		try {
			session.user = await api.auth.acknowledgeFarmNotice();
		} catch (e) {
			error = errorText(e);
		} finally {
			busy = false;
		}
	}
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
