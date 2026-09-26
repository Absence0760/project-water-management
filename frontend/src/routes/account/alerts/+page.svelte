<script lang="ts">
	// Alert emails (WP-2.13, docs/ui.md § Alerts): per catchment and kind,
	// right away, once a day (the 06:00 summary) or off. A farmer sees only
	// their own farms' dam alerts and the WUA's restriction notices. Each
	// choice saves as it is made. Its words come from $lib/i18n (farmers
	// use it); linked from the account page and from every alert email.
	import { onMount } from 'svelte';
	import { base } from '$app/paths';
	import { api, type AlertChoice, type AlertMode, type ProjectAlerts } from '$lib/api';
	import { ALERT_MODES, choiceLabel, DAILY_CAP, modeLabel } from '$lib/components/alerts/alerts';
	import { t } from '$lib/i18n/locale.svelte';

	let projects = $state<ProjectAlerts[] | null>(null);
	let loadError = $state<string | null>(null);
	/** Per project: saving, saved, or an error message. */
	let status = $state<Record<string, { saving?: boolean; saved?: boolean; error?: string }>>({});

	const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
	const slot = (p: ProjectAlerts, c: AlertChoice) => `alert-${p.id}-${c.kind}-${c.nodeId ?? 'all'}`;

	async function load() {
		loadError = null;
		try {
			projects = await api.alerts.mine();
		} catch (e) {
			loadError = msg(e);
		}
	}
	onMount(load);

	async function choose(p: ProjectAlerts, items: { kind: AlertChoice['kind'] | 'all'; nodeId?: string | null; mode: AlertMode }[]) {
		status[p.id] = { saving: true };
		try {
			const fresh = await api.alerts.save(p.id, items);
			projects = projects!.map((x) => (x.id === p.id ? fresh : x));
			status[p.id] = { saved: true };
		} catch (e) {
			status[p.id] = { error: msg(e) };
		}
	}
</script>

<svelte:head>
	<title>{t('common.pageTitle', { page: t('alerts.title') })}</title>
</svelte:head>

<main class="page alerts-page" data-ready={projects !== null || loadError !== null ? 'true' : undefined}>
	<p class="crumbs"><a href="{base}/account">{t('alerts.back')}</a></p>
	<h1>{t('alerts.title')}</h1>
	<p class="intro">{t('alerts.intro')}</p>
	<p class="muted intro">{t('alerts.cap', { cap: DAILY_CAP })}</p>

	{#if loadError}
		<div class="alert alert-error" role="alert">{loadError} <button type="button" class="btn btn-sm" onclick={load}>{t('common.tryAgain')}</button></div>
	{:else if projects === null}
		<p class="muted" role="status">…</p>
	{:else if !projects.length}
		<p>{t('alerts.none')}</p>
	{:else}
		{#each projects as p (p.id)}
			{@const s = status[p.id] ?? {}}
			<section class="panel" aria-labelledby="p-{p.id}">
				<h2 id="p-{p.id}">{p.name}</h2>
				{#if p.muted}
					<div class="alert alert-info">
						{t('alerts.muted')}
						<button type="button" class="btn btn-sm" onclick={() => choose(p, [{ kind: 'all', mode: 'immediate' }])}>{t('alerts.unmute')}</button>
					</div>
				{/if}
				{#each p.choices as c (slot(p, c))}
					<fieldset class="choice" data-choice="{c.kind}{c.nodeId ? `/${c.nodeId}` : ''}" disabled={s.saving}>
						<legend>{choiceLabel(c)}</legend>
						<div class="modes">
							{#each ALERT_MODES as m (m)}
								<label class="radio">
									<input
										type="radio"
										name={slot(p, c)}
										value={m}
										checked={c.mode === m}
										onchange={() => choose(p, [{ kind: c.kind, nodeId: c.nodeId, mode: m }])}
									/>
									{modeLabel(m)}
								</label>
							{/each}
						</div>
						{#if !c.ruleOn}<p class="hint">{t('alerts.notOn')}</p>{/if}
					</fieldset>
				{/each}
				<p class="status" role="status" aria-live="polite">{s.saving ? t('alerts.saving') : s.saved ? t('alerts.saved') : ''}</p>
				{#if s.error}<div class="alert alert-error" role="alert">{s.error}</div>{/if}
			</section>
		{/each}
	{/if}
</main>

<style>
	.alerts-page {
		max-width: 40rem;
	}
	.crumbs {
		margin: 0 0 0.5rem;
		font-size: 0.9rem;
	}
	h1 {
		margin: 0 0 0.75rem;
	}
	.intro {
		margin: 0 0 0.75rem;
		max-width: 60ch;
	}
	.panel {
		padding: 1rem 1.1rem 0.5rem;
		margin-bottom: 1rem;
	}
	h2 {
		margin: 0 0 0.75rem;
		font-size: 1.1rem;
		overflow-wrap: anywhere;
	}
	.choice {
		border: 0;
		margin: 0 0 0.9rem;
		padding: 0;
	}
	.choice legend {
		font-weight: 500;
		padding: 0;
		margin-bottom: 0.25rem;
		overflow-wrap: anywhere;
	}
	.modes {
		display: flex;
		flex-wrap: wrap;
		gap: 0 1.25rem;
	}
	/* 44 px rows: comfortable tap targets on a phone (WCAG 2.5.8 asks 24). */
	.radio {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		min-height: 2.75rem;
	}
	.hint {
		margin: 0;
		font-size: 0.85rem;
		color: var(--text-2);
	}
	.status {
		margin: 0 0 0.5rem;
		font-size: 0.9rem;
		color: var(--text-2);
	}
</style>
