<script lang="ts">
	// "Hidden (n)", a dialog: the person chooses which workspace sections their sidebar
	// lists (followups.md, "Members choose their own tabs"; docs/ui.md §
	// Sections by role). Within what their role sees (`roleTabs`); the Summary
	// always stays. A hidden section still opens from a link. The choice is
	// the account's (user.preferences.hiddenTabs, PATCH /auth/me), so it
	// follows them to every catchment and device.
	import { api } from '$lib/api';
	import Dialog from '$lib/components/common/Dialog.svelte';
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

	// The dialog handles Escape itself; keep it from reaching the phone's
	// Sections menu around it, which would close too and hide the button
	// focus goes back to.
	function keydown(e: KeyboardEvent) {
		if (e.key === 'Escape' && open) e.stopPropagation();
	}
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="sections-menu" onkeydown={keydown}>
	<button
		type="button"
		class="trigger"
		class:some={hidden.length > 0}
		class:icon-only={!showLabel}
		aria-haspopup="dialog"
		title={hidden.length ? `${hidden.length} hidden. Choose the sections in your sidebar` : 'Choose the sections in your sidebar'}
		bind:this={button}
		onclick={() => (open = true)}
	>
		<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"
			><path d="M2 4h7M13 4h1M2 12h1M7 12h7M11 2.5v3M5 10.5v3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" /></svg
		>
		<span class:visually-hidden={!showLabel}>Choose sections{hidden.length ? ':' : ''}</span>
		<!-- The sidebar's head has room for the icon and a count, not "Hidden (n)": the words wrapped the
		     button onto a line of its own. The accessible name keeps the words either way. -->
		{#if hidden.length && showLabel}Hidden ({hidden.length}){:else if hidden.length}<span class="visually-hidden">Hidden ({hidden.length})</span><span
				class="count"
				aria-hidden="true">{hidden.length}</span
			>{/if}
	</button>
	<Dialog bind:open title="Sections in your sidebar" wide anchor={button}>
		<p class="muted hint">Untick a section to hide it from your sidebar. A hidden section still opens from a link. Your choice applies to every catchment.</p>
		<div class="groups">
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
		</div>
		<p class="error" role="status">{error ?? ''}</p>
		{#snippet actions()}
			<button type="button" class="btn" disabled={stored.length === 0} onclick={() => save([])}>Reset to default</button>
			<button type="button" class="btn btn-primary" onclick={() => (open = false)}>Done</button>
		{/snippet}
	</Dialog>
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
	/* Icon only (the sidebar's head): a 24 px square, so "Catchment", the role
	   and this button stay on one line with a wider system font too (DejaVu
	   Sans, Linux's usual one), and the sidebar's rows still fit 1440×960
	   (app-sidebar.spec.ts). */
	.trigger.icon-only {
		justify-content: center;
		padding: 0;
	}
	/* Some hidden: the count is a small badge on the button's top-right corner, so the button stays the 24 px
	   square and the head's line ("Catchment", the role, this) doesn't wrap; beside the icon it took 41 px and
	   did. The badge stays inside the square's width (the icon moves left to make room): past it, it stuck out
	   of the head and gave the sidebar's slot a sideways scrollbar (app-sidebar.spec.ts). */
	.trigger.icon-only.some {
		position: relative;
		justify-content: flex-start;
	}
	.count {
		position: absolute;
		top: -5px;
		right: 0;
		min-width: 14px;
		padding: 0 3px;
		border-radius: 999px;
		background: var(--accent-soft);
		color: var(--accent);
		font-size: 0.62rem;
		font-weight: 700;
		line-height: 14px;
		text-align: center;
		pointer-events: none;
	}
	.trigger:hover {
		border-color: var(--border);
		background: var(--surface-2);
		color: var(--text);
	}
	.trigger.some {
		color: var(--text-2);
	}
	.groups {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr));
		gap: 1rem 1.5rem;
		margin-top: 1rem;
	}
	fieldset {
		display: flex;
		flex-direction: column;
		margin: 0;
		padding: 0;
		border: 0;
	}
	legend {
		margin-bottom: 0.25rem;
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
		min-height: 32px;
		color: var(--text-2);
		cursor: pointer;
	}
	label.fixed {
		cursor: default;
	}
	.hint {
		margin: 0;
	}
	.error {
		margin: 0.75rem 0 0;
		font-size: 0.875rem;
		color: var(--danger);
	}
	.error:empty {
		display: none;
	}
</style>
