<script lang="ts">
	// The "Require two-step sign-in" switch (204_mfa_opt_in; docs/ui.md,
	// docs/security.md § Two-step sign-in): on the Project page for owners
	// (project/TwoStepPanel.svelte) and in the team settings for admins
	// (teams/TeamSettings.svelte). It saves when switched, as the server's
	// answer decides: turning it on needs this session's own second factor,
	// so a refusal (403 mfa_required / mfa_step_up) also brings up the
	// workspace's two-step prompt (layout/MfaBanner), and the switch goes back.
	import { mfaPrompt } from '$lib/auth/mfaPrompt.svelte';
	import { ALWAYS_TEXT, inheritedText, requirementText, turnOnHint, type TwoStepScope } from './requireTwoStep';

	let {
		scope,
		on,
		canChange,
		save,
		effective = on,
		teamName = null
	}: {
		scope: TwoStepScope;
		/** The setting as saved. */
		on: boolean;
		/** An owner (team admin): the switch; anyone else reads the state. */
		canChange: boolean;
		/** Save the new value; throws on a refusal. */
		save: (next: boolean) => Promise<void>;
		/** A project's: whether it applies, by this setting or its team's. */
		effective?: boolean;
		/** A project's team, for the inherited note (null when not visible). */
		teamName?: string | null;
	} = $props();

	const id = $derived(`require-two-step-${scope}`);
	let saving = $state(false);
	let error = $state<string | null>(null);
	let saved = $state<string | null>(null);
	const inherited = $derived(scope === 'project' ? inheritedText(on, effective, teamName) : null);
	const hint = $derived(canChange ? turnOnHint(on, mfaPrompt.status?.sessionVerified ?? null) : null);

	async function change(e: Event & { currentTarget: HTMLInputElement }) {
		const input = e.currentTarget;
		const next = input.checked;
		saving = true;
		error = null;
		saved = null;
		try {
			await save(next);
			saved = next ? 'Saved. Two-step sign-in is now required.' : 'Saved. Two-step sign-in is no longer required.';
		} catch (err) {
			// The saved value stands: put the switch back.
			input.checked = on;
			error = err instanceof Error ? err.message : String(err);
		} finally {
			saving = false;
		}
	}
</script>

<div class="require-two-step" data-require-two-step={on ? 'on' : 'off'}>
	{#if canChange}
		<div class="row">
			<span class="name" id="{id}-name">Require two-step sign-in</span>
			<label class="switch">
				<input type="checkbox" role="switch" aria-labelledby="{id}-name" aria-describedby="{id}-what" checked={on} disabled={saving} onchange={change} />
				<span class="track" aria-hidden="true"></span>
				<span class="state" aria-hidden="true">{on ? 'On' : 'Off'}</span>
			</label>
		</div>
	{:else}
		<p class="row"><span class="name">Require two-step sign-in</span> <strong>{on ? 'On' : 'Off'}</strong></p>
	{/if}
	<p class="small what" id="{id}-what">{requirementText(scope)}</p>
	{#if inherited}<p class="small" data-testid="two-step-inherited">{inherited}</p>{/if}
	<p class="muted small">{ALWAYS_TEXT}</p>
	{#if hint}<p class="muted small" data-testid="two-step-hint">{hint}</p>{/if}
	{#if !canChange}<p class="muted small">Only owners can change it.</p>{/if}
	{#if error}<div class="alert alert-error" role="alert">{error}</div>{/if}
	<p class="muted small saved" role="status">{saved ?? ''}</p>
</div>

<style>
	.row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem 1rem;
		margin: 0 0 0.4rem;
	}
	.name {
		font-weight: 600;
	}
	.require-two-step p.small {
		margin: 0 0 0.4rem;
	}
	.saved:empty {
		margin: 0;
	}
	/* The switch (the pattern TransfersTab's rules use): the state in words beside the track, both part of its target. */
	.switch {
		position: relative;
		display: inline-flex;
		align-items: center;
		gap: 0.45rem;
		min-height: 28px;
		cursor: pointer;
		user-select: none;
	}
	.switch input {
		position: absolute;
		z-index: 1;
		inset: 0;
		width: 100%;
		height: 100%;
		margin: 0;
		opacity: 0;
		cursor: inherit;
	}
	.switch input:disabled {
		cursor: default;
	}
	.track {
		position: relative;
		flex: none;
		width: 2.1rem;
		height: 1.2rem;
		border-radius: 999px;
		background: var(--surface-sunken);
		border: 1px solid var(--border-input);
		transition: background 0.12s;
	}
	.track::after {
		content: '';
		position: absolute;
		top: 1px;
		left: 1px;
		width: calc(1.2rem - 4px);
		height: calc(1.2rem - 4px);
		border-radius: 50%;
		background: var(--text-muted);
		transition: transform 0.12s;
	}
	.switch input:checked + .track {
		background: var(--accent);
		border-color: var(--accent);
	}
	.switch input:checked + .track::after {
		background: var(--accent-contrast);
		transform: translateX(0.9rem);
	}
	.switch input:focus-visible + .track {
		outline: 2px solid var(--focus);
		outline-offset: 2px;
	}
	.switch input:disabled + .track {
		opacity: 0.7;
	}
	.state {
		min-width: 1.6rem;
		font-size: 0.85rem;
		font-weight: 600;
		color: var(--text-2);
	}
	@media (prefers-reduced-motion: reduce) {
		.track,
		.track::after {
			transition: none;
		}
	}
</style>
