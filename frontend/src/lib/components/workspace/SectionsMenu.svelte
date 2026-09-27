<script lang="ts">
	// "Hidden (n)": the person chooses which workspace sections their sidebar
	// lists (followups.md, "Members choose their own tabs"; docs/ui.md §
	// Sections by role). Within what their role sees (`roleTabs`); the Summary
	// always stays. A hidden section still opens from a link. The choice is
	// the account's (user.preferences.hiddenTabs, PATCH /auth/me), so it
	// follows them to every catchment and device.
	import { api } from '$lib/api';
	import { session } from '$lib/auth/session.svelte';
	import { ALWAYS_SHOWN, hiddenTabs, navSections, TAB_LABELS, withTabHidden, type TabId } from '$lib/workspace/tabs';

	let {
		roleTabs,
		showLabel = false
	}: {
		roleTabs: readonly TabId[];
		/** Show "Choose sections" in words (the phone menu); the sidebar's head has room for the icon only. */
		showLabel?: boolean;
	} = $props();

	const stored = $derived(session.user?.preferences?.hiddenTabs ?? []);
	const hidden = $derived(hiddenTabs(roleTabs, stored));
	const groups = $derived(navSections(roleTabs));

	let open = $state(false);
	let button: HTMLButtonElement | undefined = $state();
	let error = $state<string | null>(null);

	// Saves go one after another, each sending the whole list; the server's
	// answer is taken only from the last, so a slow early save can't undo a
	// later click. The checkboxes stay live meanwhile (ui-playbook § 4).
	let chain = Promise.resolve();
	let seq = 0;
	function save(next: string[]) {
		const user = session.user;
		if (!user) return;
		session.user = { ...user, preferences: { ...user.preferences, hiddenTabs: next } };
		const mine = ++seq;
		chain = chain.then(async () => {
			try {
				const fresh = await api.auth.updateMe({ preferences: { hiddenTabs: next } });
				if (mine === seq) {
					session.user = fresh;
					error = null;
				}
			} catch {
				if (mine === seq) error = 'Not saved. Your choice holds on this page until you reload.';
			}
		});
	}

	function keydown(e: KeyboardEvent) {
		if (e.key !== 'Escape' || !open) return;
		e.preventDefault();
		e.stopPropagation();
		open = false;
		button?.focus();
	}
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="sections-menu" onkeydown={keydown}>
	<button
		type="button"
		class="trigger"
		class:some={hidden.length > 0}
		aria-expanded={open}
		aria-controls="sections-menu-panel"
		title="Choose the sections in your sidebar"
		bind:this={button}
		onclick={() => (open = !open)}
	>
		<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"
			><path d="M2 4h7M13 4h1M2 12h1M7 12h7M11 2.5v3M5 10.5v3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" /></svg
		>
		<span class:visually-hidden={!showLabel}>Choose sections{hidden.length ? ':' : ''}</span>
		{#if hidden.length}Hidden ({hidden.length}){/if}
	</button>
	{#if open}
		<div class="panel" id="sections-menu-panel" role="group" aria-labelledby="sections-menu-title">
			<p class="title" id="sections-menu-title">Sections in your sidebar</p>
			{#each groups as g (g.id)}
				<fieldset>
					<legend>{g.label}</legend>
					{#each g.tabs as id (id)}
						<label class:fixed={id === ALWAYS_SHOWN}>
							<input
								type="checkbox"
								checked={id === ALWAYS_SHOWN || !stored.includes(id)}
								disabled={id === ALWAYS_SHOWN}
								onchange={(e) => save(withTabHidden(stored, id, !e.currentTarget.checked))}
							/>
							{TAB_LABELS[id]}
							{#if id === ALWAYS_SHOWN}<span class="muted">(always)</span>{/if}
						</label>
					{/each}
				</fieldset>
			{/each}
			<p class="muted hint">A hidden section still opens from a link. Your choice applies to every catchment.</p>
			<button type="button" class="btn btn-sm" disabled={stored.length === 0} onclick={() => save([])}>Reset to default</button>
			<p class="error" role="status">{error ?? ''}</p>
		</div>
	{/if}
</div>

<style>
	.sections-menu {
		display: contents;
	}
	.trigger {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		/* 24 px: the AA target size, and no taller than the head line it sits on. */
		min-width: 24px;
		min-height: 24px;
		margin-left: auto;
		padding: 0 0.4rem;
		border: 1px solid transparent;
		border-radius: var(--radius);
		background: none;
		color: var(--text-muted);
		font: inherit;
		font-size: 0.8rem;
		cursor: pointer;
	}
	.trigger:hover,
	.trigger[aria-expanded='true'] {
		border-color: var(--border);
		background: var(--surface-2);
		color: var(--text);
	}
	.trigger.some {
		color: var(--text-2);
	}
	.panel {
		flex-basis: 100%;
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
		margin: 0.35rem 0 0.5rem;
		padding: 0.6rem 0.75rem;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--surface);
		font-size: 0.875rem;
	}
	.title {
		margin: 0;
		font-weight: 600;
	}
	fieldset {
		display: flex;
		flex-direction: column;
		margin: 0;
		padding: 0;
		border: 0;
	}
	legend {
		padding: 0;
		color: var(--text-muted);
		font-size: 0.72rem;
		font-weight: 600;
		letter-spacing: 0.05em;
		text-transform: uppercase;
	}
	label {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		min-height: 26px;
		color: var(--text-2);
		cursor: pointer;
	}
	label.fixed {
		cursor: default;
	}
	.hint,
	.error {
		margin: 0;
		font-size: 0.8rem;
	}
	.error {
		color: var(--danger);
	}
	.error:empty {
		display: none;
	}
</style>
