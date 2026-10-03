<script lang="ts">
	// The workspace's one sticky footer for unsaved edits: the model's (the
	// Network, Crops and Transfers tabs, the farm drawer, a grid) and the page's
	// other drafts (`drafts`: the project details, issue #162 item 12, and the
	// Settings & calibration form; see pageDraft.ts for adding one). Unsaved
	// indicator naming what changed, the problems that block the save as links
	// to where they are fixed, the optional reason for a model or settings
	// change (kept with it in the History tab), Preview of the model and
	// settings edits against the last run (issue #284), Save / Discard for
	// everything unsaved. Discard asks first, naming what goes.
	// Once a save or a discard takes the bar away, a live region outside it
	// says so and the focus moves to the page's title (it was on a button that
	// is gone).
	import { tick } from 'svelte';
	import { confirmDialog } from '$lib/components/common/confirm.svelte';
	import { useInvalidFields } from '$lib/components/common/invalidFields.svelte';
	import { focusPageStart } from '$lib/a11y/focusPage';
	import type { ModelEditor } from '$lib/model/editor.svelte';
	import { issueHref } from '$lib/model/validate';
	import { listAnd } from '$lib/nav/unsaved';
	import { AREA_WORDS, changedAreas } from './changedAreas';
	import type { PageDraft, ProblemLink } from './pageDraft';
	import ProblemLinks from './ProblemLinks.svelte';

	let {
		editor,
		drafts = [],
		onsave,
		readonly,
		height = $bindable(0),
		reason = $bindable(''),
		onpreview = null
	}: {
		editor: ModelEditor;
		/** The page's other unsaved forms (the project details), saved and discarded with the model's edits. */
		drafts?: readonly PageDraft[];
		/** Save everything unsaved (the page's saveAll); the bar waits for it to say "Changes saved". */
		onsave: () => unknown;
		readonly: boolean;
		/** Rendered height (0 when hidden), so the page can keep content clear of it. */
		height?: number;
		/** The optional "why" sent with a model or settings save (at most 500 characters). */
		reason?: string;
		/** Preview what the unsaved model and settings edits do to the last run (issue #284); null hides the button. */
		onpreview?: (() => void) | null;
	} = $props();
	// The nearest owner's registry of invalid fields (the workspace page, or a scenario's override mode).
	const invalidFields = useInvalidFields();

	const dirtyDrafts = $derived(drafts.filter((d) => d.dirty));
	// Number fields holding text they can't take (common/invalidFields): unsaved work too, and they block the save.
	const invalid = $derived(invalidFields.fields);
	const dirty = $derived(editor.dirty || dirtyDrafts.length > 0 || invalid.length > 0);
	const saving = $derived(editor.saving || drafts.some((d) => d.saving));
	const saveError = $derived(editor.saveError ?? drafts.find((d) => d.saveError)?.saveError ?? null);
	const shown = $derived(!readonly && (dirty || !!saveError));
	let measured = $state(0);
	$effect(() => {
		height = shown ? measured : 0;
	});

	/** The model's areas with unsaved edits (network, crops, transfers). */
	const areas = $derived(editor.dirty ? changedAreas(editor.savedModel(), editor.model) : []);
	const problems = $derived<ProblemLink[]>([
		...(editor.dirty ? editor.issues.map((i) => ({ message: i.message, href: issueHref(i) })) : []),
		...dirtyDrafts.flatMap((d) => d.problems),
		...invalid.map((f) => ({ message: f.label ? `${f.label}: ${f.message}` : f.message, href: `#${f.id}` }))
	]);
	const blocking = $derived(problems.length);
	/** What the unsaved edits are to, as the line says it. */
	const what = $derived(listAnd([...(editor.dirty ? ['the model'] : []), ...dirtyDrafts.map((d) => d.what)]) || 'numbers that need fixing');
	/** The same, naming the model's areas: the Discard question's words. */
	const lost = $derived(
		listAnd([
			...(editor.dirty ? (areas.length ? areas.map((a) => AREA_WORDS[a]) : ['the model']) : []),
			...dirtyDrafts.map((d) => d.what),
			...(invalid.length ? [invalid.length === 1 ? 'the number that needs fixing' : 'the numbers that need fixing'] : [])
		])
	);
	/** Whether a reason field shows: a model or settings change keeps one. */
	const takesReason = $derived(editor.dirty || dirtyDrafts.some((d) => d.takesReason));
	// Preview shows the model's edits and a previewable draft's (the settings), each once nothing blocks it;
	// one with problems is left out and the dialog says so.
	const previewDrafts = $derived(dirtyDrafts.filter((d) => d.previewable));
	const canPreview = $derived(!!onpreview && (editor.dirty || previewDrafts.length > 0));
	const previewReady = $derived((editor.dirty && editor.issues.length === 0) || previewDrafts.some((d) => d.problems.length === 0));
	// Named for what is unsaved: the model, else the first draft, else only numbers that need fixing (on any page).
	const region = $derived(editor.dirty ? 'Unsaved model changes' : dirtyDrafts.length ? dirtyDrafts[0]!.region : 'Unsaved changes');

	let bar: HTMLDivElement | undefined = $state();
	let announcement = $state('');
	/** Say what happened; when the bar is gone with the focus in it, focus the page's title. */
	async function settled(message: string, hadFocus: boolean) {
		announcement = '';
		await tick();
		announcement = message;
		if (hadFocus && !shown) await focusPageStart();
	}
	const focusInBar = () => !!bar && bar.contains(document.activeElement);

	async function save() {
		const hadFocus = focusInBar();
		await onsave();
		if (dirty || saveError) return;
		invalidFields.reset();
		await settled('Changes saved.', hadFocus);
	}

	async function discard() {
		const hadFocus = focusInBar();
		const ok = await confirmDialog({
			title: 'Discard your unsaved changes?',
			message: `Your unsaved changes to ${lost} will be lost. This can’t be undone.`,
			confirmLabel: 'Discard changes',
			danger: true
		});
		if (!ok) return;
		editor.revert();
		for (const d of drafts) d.revert();
		invalidFields.reset();
		reason = '';
		await settled('Changes discarded.', hadFocus);
	}
</script>

<!-- Outside the bar, so it is still there to speak once a save or discard takes the bar away. -->
<p class="visually-hidden" aria-live="polite" data-testid="savebar-announcement">{announcement}</p>
{#if shown}
	<div class="savebar" role="region" aria-label={region} bind:offsetHeight={measured} bind:this={bar}>
		<div class="inner">
			<span class="dot" aria-hidden="true"></span>
			<span class="status" aria-live="polite">
				{#if saving}
					Saving…
				{:else if saveError}
					<span class="err">Save failed: {saveError}</span>
				{:else if blocking}
					Unsaved changes · <span class="err">{blocking} problem{blocking === 1 ? '' : 's'} to fix before saving</span>
				{:else}
					Unsaved changes to {what}{#if editor.dirty && !dirtyDrafts.length && areas.length}{' '}<span class="muted where">({listAnd(areas)})</span>{/if}
				{/if}
			</span>
			<div class="spacer"></div>
			<!-- The reason goes with the model's and the settings' save (the History tab keeps it). -->
			{#if takesReason}
				<label class="reason">
					<span class="visually-hidden">Reason for this change (optional)</span>
					<input type="text" maxlength="500" placeholder="Reason for this change (optional)" bind:value={reason} disabled={saving} />
				</label>
			{/if}
			<!-- One box that never splits on a phone: Discard is never left on a row apart from Save. -->
			<div class="acts">
				<!-- The model's and the settings' edits, each once it has no problems the engine would refuse. -->
				{#if canPreview}
					<button type="button" class="btn" onclick={onpreview} disabled={saving || !previewReady} aria-describedby={!previewReady && blocking ? 'savebar-problems' : undefined}>Preview</button>
				{/if}
				<button type="button" class="btn" onclick={discard} disabled={saving || !dirty}>Discard</button>
				<button type="button" class="btn btn-primary" onclick={save} disabled={saving || blocking > 0 || !dirty} aria-describedby={blocking ? 'savebar-problems' : undefined}>Save changes</button>
			</div>
		</div>
		{#if blocking && !saving}
			<div class="inner problems-row"><ProblemLinks {problems} id="savebar-problems" /></div>
		{/if}
	</div>
{/if}

<style>
	.savebar {
		position: fixed;
		/* Beside the app sidebar, not over its foot (the account menu); 0 on a phone (AppShell's --sidebar-w). */
		left: var(--sidebar-w, 0px);
		right: 0;
		bottom: 0;
		z-index: 30;
		background: var(--surface);
		border-top: 1px solid var(--border-strong);
		box-shadow: 0 -2px 8px rgb(0 0 0 / 0.08);
	}
	.inner {
		max-width: 1480px;
		margin: 0 auto;
		padding: 0.6rem var(--gutter);
		display: flex;
		align-items: center;
		gap: 0.6rem;
		flex-wrap: wrap;
	}
	.dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--warning);
	}
	.status {
		font-weight: 500;
	}
	.err {
		color: var(--danger);
	}
	.spacer {
		flex: 1;
	}
	.where {
		font-weight: 400;
	}
	.problems-row {
		padding-top: 0;
	}
	.reason {
		flex: 0 1 22rem;
		min-width: 12rem;
	}
	.reason input {
		width: 100%;
	}
	.acts {
		display: flex;
		gap: 0.6rem;
		flex-wrap: nowrap;
		margin-left: auto;
	}
	@media (max-width: 640px) {
		.btn {
			min-height: 44px;
		}
		.where {
			display: none;
		}
		.reason {
			flex-basis: 100%;
		}
		.reason input {
			min-height: 44px;
		}
	}
</style>
