<!-- i18n-section: alerts -->
<script lang="ts">
	// Alert emails (WP-2.13, docs/ui.md § Alerts): per catchment and kind,
	// right away, once a day (the 06:00 summary) or off. A farmer sees only
	// their own farms' dam alerts and the WUA's restriction notices. Each
	// choice saves as it is made. Its words come from $lib/i18n (farmers
	// use it); linked from the account page and from every alert email.
	// When SES stopped delivering to the address (a bounce or a complaint),
	// a banner says every alert email is paused and turns them back on.
	// Layout (issue #17): the section header, then one card per catchment,
	// each alert one row (its name beside a three-way switch), so a farmer
	// with thirty farms reads a list, not thirty stacked radio groups.
	import { onMount } from 'svelte';
	import { base } from '$app/paths';
	import { api, type AlertChoice, type AlertMode, type ProjectAlerts } from '$lib/api';
	import { session } from '$lib/auth/session.svelte';
	import { ALERT_MODES, choiceLabel, DAILY_CAP, modeLabel, resumeProblem, suppressedText, thresholdLine } from '$lib/components/alerts/words';
	import SectionHeader from '$lib/components/workspace/SectionHeader.svelte';
	import { t } from '$lib/i18n/locale.svelte';
	import { errorText } from '$lib/i18n/apiError';

	let projects = $state<ProjectAlerts[] | null>(null);
	let loadError = $state<string | null>(null);
	/** Per project: saving, saved, or an error message. */
	let status = $state<Record<string, { saving?: boolean; saved?: boolean; error?: string }>>({});

	const msg = errorText;
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

	let resuming = $state(false);
	let resumed = $state(false);
	let resumeError = $state<string | null>(null);
	async function resumeMail() {
		resuming = true;
		resumeError = null;
		try {
			await api.alerts.resume();
			if (session.user) session.user = { ...session.user, mailSuppressed: null };
			resumed = true;
		} catch (e) {
			resumeError = resumeProblem(e);
		} finally {
			resuming = false;
		}
	}

	// A choice saves as it is made, and the switch stays usable while it
	// does: disabling it would drop the keyboard's focus on every arrow key.
	// Saves for one catchment go to the server one after another, in the
	// order they were made, and the page takes the server's answer once the
	// last of them is back, so a quick run of changes never flickers back.
	const pending: Record<string, number> = {};
	const failed: Record<string, string | undefined> = {};
	const queue: Record<string, Promise<void>> = {};
	function choose(p: ProjectAlerts, items: { kind: AlertChoice['kind'] | 'all'; nodeId?: string | null; mode: AlertMode }[]) {
		const id = p.id;
		if (!pending[id]) failed[id] = undefined;
		pending[id] = (pending[id] ?? 0) + 1;
		status[id] = { saving: true };
		queue[id] = (queue[id] ?? Promise.resolve()).then(async () => {
			let fresh: ProjectAlerts | null = null;
			try {
				fresh = await api.alerts.save(id, items);
			} catch (e) {
				failed[id] = msg(e);
			}
			if (--pending[id]! > 0) return;
			if (fresh) {
				const f = fresh;
				projects = projects!.map((x) => (x.id === id ? f : x));
			}
			status[id] = failed[id] ? { error: failed[id] } : { saved: true };
			// A failed save leaves the switch where the server has it.
			if (failed[id]) await load();
		});
	}
</script>

<svelte:head>
	<title>{t('{page} · Water Management', { page: t('Alert emails') })}</title>
</svelte:head>

<main class="page alerts-page" data-ready={projects !== null || loadError !== null ? 'true' : undefined}>
	<SectionHeader title={t('Alert emails')}>
		{#snippet context()}
			<span>{t('Choose which alerts you get by email for each catchment, and how often. Alerts come from the catchment model: estimates, not instructions.')}</span>
		{/snippet}
		{#snippet actions()}
			<a class="btn" href="{base}/account">{t('Back to your account')}</a>
		{/snippet}
		{#snippet notices()}
			<p class="notice">{t('At most {cap} alert emails a day come right away. Any more wait for the next morning’s summary (06:00).', { cap: DAILY_CAP })}</p>
			{#if session.user?.mailSuppressed}
				<div class="alert alert-warning suppressed" data-mail-suppressed={session.user.mailSuppressed.reason}>
					<p>{suppressedText(session.user.mailSuppressed, session.user.email)}</p>
					<p>{t('Once {email} can receive email again, turn alert emails back on. Your choices are kept.', { email: session.user.email })}</p>
					{#if resumeError}<p class="resume-error" role="alert">{resumeError}</p>{/if}
					<button type="button" class="btn btn-sm" onclick={resumeMail} disabled={resuming}>
						{resuming ? t('Turning them back on…') : t('Turn alert emails back on')}
					</button>
				</div>
			{/if}
			<p class="status" role="status" aria-live="polite">{resumed ? t('Alert emails are back on.') : ''}</p>
		{/snippet}
	</SectionHeader>

	{#if loadError}
		<div class="alert alert-error" role="alert">{loadError} <button type="button" class="btn btn-sm" onclick={load}>{t('Try again')}</button></div>
	{:else if projects === null}
		<p class="muted" role="status">…</p>
	{:else if !projects.length}
		<p class="panel empty">{t('None of your catchments can send you alerts yet.')}</p>
	{:else}
		<div class="cards">
			{#each projects as p (p.id)}
				{@const s = status[p.id] ?? {}}
				{@const offRule = p.choices.some((c) => !c.ruleOn)}
				<section class="panel card" aria-labelledby="p-{p.id}" aria-busy={s.saving ? 'true' : undefined}>
					<div class="card-head">
						<h2 id="p-{p.id}">{p.name}</h2>
						<p class="status" role="status" aria-live="polite">{s.saving ? t('Saving…') : s.saved ? t('Saved.') : ''}</p>
					</div>
					{#if p.muted}
						<div class="alert alert-info muted-note">
							{t('All alert emails for this catchment are off.')}
							<button type="button" class="btn btn-sm" onclick={() => choose(p, [{ kind: 'all', mode: 'immediate' }])}>{t('Turn alert emails back on')}</button>
						</div>
					{/if}
					{#if s.error}<div class="alert alert-error" role="alert">{s.error}</div>{/if}
					<div class="rows">
						{#each p.choices as c (slot(p, c))}
							{@const level = thresholdLine(c)}
							<fieldset
								class="choice"
								data-choice="{c.kind}{c.nodeId ? `/${c.nodeId}` : ''}"
								data-rule-on={c.ruleOn ? 'true' : 'false'}
								aria-describedby={c.ruleOn ? (level ? `level-${slot(p, c)}` : undefined) : `off-${p.id}`}
							>
								<legend>{choiceLabel(c)}{#if !c.ruleOn}<span class="mark" aria-hidden="true">*</span>{/if}</legend>
								<div class="modes">
									{#each ALERT_MODES as m (m)}
										<label class="seg">
											<input
												type="radio"
												name={slot(p, c)}
												value={m}
												checked={c.mode === m}
												onchange={() => choose(p, [{ kind: c.kind, nodeId: c.nodeId, mode: m }])}
											/>
											<svg class="tick" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 6.5 L5 9 L9.5 3.5" /></svg>
											<span>{modeLabel(m)}</span>
										</label>
									{/each}
								</div>
								<!-- The level a farm's dam alert warns below: the WUA's rule (issue #51). -->
								{#if level}<p class="level" id="level-{slot(p, c)}" data-threshold={c.threshold}>{level}</p>{/if}
							</fieldset>
						{/each}
					</div>
					{#if offRule}
						<p class="key" id="off-{p.id}"><span aria-hidden="true">*</span> {t('Not switched on for this catchment yet: you get nothing until the WUA turns it on.')}</p>
					{/if}
				</section>
			{/each}
		</div>
	{/if}
</main>

<style>
	/* The account page's frame (capped at 92rem from the sidebar's edge), a
	   reading page: it scrolls when a farmer has many farms, and its bottom
	   gutter is small so a page that fits doesn't scroll for nothing. */
	.alerts-page {
		max-width: 92rem;
		padding-bottom: 1.5rem;
	}
	.notice {
		margin: 0;
		font-size: 0.85rem;
		color: var(--text-2);
	}
	.suppressed {
		margin: 0;
	}
	.suppressed p {
		margin: 0 0 0.5rem;
		overflow-wrap: anywhere;
	}
	.resume-error {
		font-weight: 600;
	}
	.status {
		margin: 0;
		font-size: 0.9rem;
		color: var(--text-2);
	}
	.status:empty {
		display: none;
	}
	.empty {
		max-width: 75ch;
	}
	/* One card per catchment; as many across as fit the page's own width
	   (34rem each at the 14 px root: two at 1440 and 1280, one on a phone).
	   auto-fit, so a single catchment takes the whole width and lays its
	   rows out in two columns rather than leaving half the page empty. */
	.cards {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(min(100%, 34rem), 1fr));
		gap: 1rem;
		align-items: start;
	}
	.card {
		margin: 0;
		padding: 0.85rem 1.1rem 0.75rem;
		min-width: 0;
		container: alert-card / inline-size;
	}
	.card-head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		flex-wrap: wrap;
		gap: 0.25rem 1rem;
		margin-bottom: 0.35rem;
	}
	h2 {
		margin: 0;
		font-size: 1.1rem;
		overflow-wrap: anywhere;
		min-width: 0;
	}
	.muted-note {
		margin: 0.35rem 0 0.5rem;
	}
	.rows {
		display: grid;
		column-gap: 2rem;
	}
	/* Two columns of rows once a card is wide enough for two (a lone catchment). */
	@container alert-card (min-width: 66rem) {
		.rows {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
	}
	/* One row per alert: its name, then the switch. The legend floats so it
	   takes part in the row's layout (a floated legend is an ordinary box). */
	.choice {
		border: 0;
		border-top: 1px solid var(--border);
		margin: 0;
		padding: 0.45rem 0;
		min-width: 0;
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 0.35rem 1rem;
	}
	.choice legend {
		float: left;
		padding: 0;
		font-weight: 500;
		flex: 1 1 12rem;
		min-width: 0;
		overflow-wrap: anywhere;
	}
	.level {
		flex: 1 1 100%;
		margin: 0;
		font-size: 0.85rem;
		color: var(--text-2);
		overflow-wrap: anywhere;
	}
	.mark {
		margin-left: 0.2rem;
		color: var(--text-2);
		font-weight: 600;
	}
	/* The three choices joined into one switch, like the account page's
	   language switch; the picked one is tinted, bold and ticked, so it
	   doesn't rest on colour alone. 32 px with a mouse (WCAG 2.5.8 asks 24;
	   2rem would be 28 px at the 14 px root), 44 px on touch and phones. */
	.modes {
		display: inline-flex;
		flex: 0 1 auto;
		max-width: 100%;
	}
	.seg {
		position: relative;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 0.3rem;
		min-height: 32px;
		padding: 0.15rem 0.7rem;
		font-size: 0.9rem;
		line-height: 1.2;
		text-align: center;
		color: var(--text);
		background: var(--surface);
		border: 1px solid var(--border-strong);
		cursor: pointer;
	}
	.seg + .seg {
		margin-left: -1px;
	}
	.seg:first-child {
		border-radius: var(--radius-sm) 0 0 var(--radius-sm);
	}
	.seg:last-child {
		border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
	}
	/* The radio covers its segment, border and all: it takes the click, the
	   focus and the keyboard (arrow keys move within the group), unseen. */
	.seg input {
		position: absolute;
		inset: -1px;
		width: calc(100% + 2px);
		height: calc(100% + 2px);
		margin: 0;
		opacity: 0;
		cursor: inherit;
	}
	.seg:hover:not(:has(input:checked)) {
		background: var(--surface-2);
	}
	.seg:has(input:checked) {
		z-index: 1;
		background: var(--accent-soft);
		border-color: var(--accent);
		color: var(--accent);
		font-weight: 600;
	}
	.seg:has(input:focus-visible) {
		z-index: 2;
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}
	.tick {
		display: none;
		flex: none;
	}
	.seg:has(input:checked) .tick {
		display: block;
	}
	@media (pointer: coarse), (max-width: 640px) {
		.seg {
			min-height: var(--tap);
		}
	}
	/* A narrow card: the switch takes the row's whole width under the name,
	   its three parts sharing it (a long Afrikaans label wraps inside its part). */
	@container alert-card (max-width: 30rem) {
		.modes {
			display: flex;
			width: 100%;
		}
		.seg {
			flex: 1 1 0;
			min-width: 0;
			padding: 0.15rem 0.4rem;
		}
	}
	.key {
		margin: 0.35rem 0 0;
		padding-top: 0.45rem;
		border-top: 1px solid var(--border);
		font-size: 0.85rem;
		color: var(--text-2);
	}
</style>
