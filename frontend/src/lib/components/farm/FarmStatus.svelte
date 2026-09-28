<!-- i18n-section: farm -->
<script lang="ts">
	// The farm pages' non-figure states (design §6.5, boards 6 and 7): no
	// publication yet, access removed, and the error with Try again (the
	// contact line after a second failure). No raw error text (CLAUDE.md rule 6).
	import { base } from '$app/paths';
	import { t } from '$lib/i18n/locale.svelte';
	import { contactText, stateText, stillFailing } from './cards';

	let {
		kind,
		farmName = null,
		projectName = null,
		wuaName = null,
		offline = false,
		attempts = 1,
		retry
	}: {
		kind: 'no-publication' | 'removed' | 'error';
		farmName?: string | null;
		projectName?: string | null;
		/** The WUA the contact lines name (project.wuaName); null says "your WUA". */
		wuaName?: string | null;
		offline?: boolean;
		attempts?: number;
		retry?: () => void;
	} = $props();
</script>

{#if kind === 'error'}
	<div class="error" role="alert">
		<h1>{stateText('errorTitle')}</h1>
		<p>{stateText('errorText')}</p>
		{#if retry}<button type="button" class="btn btn-primary" onclick={retry}>{t('Try again')}</button>{/if}
		{#if attempts > 1}<p>{stillFailing(offline, wuaName)}</p>{/if}
	</div>
{:else if kind === 'removed'}
	<h1>{farmName ?? t('Your hydrological unit')}</h1>
	<p role="alert">{contactText('removed', wuaName)}</p>
	<a class="link" href="{base}/farm">{t('Your hydrological units')}</a>
{:else}
	<div>
		<h1>{farmName ?? t('Your hydrological unit')}</h1>
		{#if projectName}<p class="sub">{projectName}</p>{/if}
	</div>
	<section class="card empty" aria-labelledby="empty-h">
		<svg width="36" height="36" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M12 3 C12 3 6 10 6 14 a6 6 0 0 0 12 0 C18 10 12 3 12 3 Z" /></svg>
		<h2 id="empty-h">{stateText('noPublication')}</h2>
		<p>{stateText('noPublicationText')}</p>
	</section>
	<p class="sub">{contactText('contact', wuaName)}</p>
{/if}

<style>
	.error {
		display: flex;
		flex-direction: column;
		gap: 12px;
		align-items: flex-start;
	}
	.error .btn {
		min-height: var(--tap);
		padding: 0 20px;
		font-size: 16px;
	}
	.empty {
		align-items: center;
		text-align: center;
		border-style: dashed;
		border-color: var(--border-strong);
		padding: 24px 16px;
		color: var(--text-2);
	}
	.empty h2 {
		color: var(--text);
	}
</style>
