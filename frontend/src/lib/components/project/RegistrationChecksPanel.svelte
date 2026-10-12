<script lang="ts">
	// The host's checks of members' professional registrations (167_signers;
	// licensing positions item 9, provisional position, pre-counsel research,
	// 2026-10-01; docs/ui.md § Project → Registration checks). Someone at the
	// host organisation looks the signer up on the public SACNASP or ECSA
	// register, and records what they found here: verify then says
	// "checked against the register by <org> on <date>" for that signer's
	// sign-offs, and "self-declared" for anyone else's. The app checks
	// nothing itself, and the operator never does it for the host. While the
	// project requires it (the owner's switch, on by default), issuing a pack
	// waits until each specialist signer has a current check (a year, and the
	// latest check says registered). Editors read the list; owners, and the
	// editors the authority confirmed as acting for it (163, 233), record.
	import DayInput from '$lib/components/common/DayInput.svelte';
	import { onMount, tick } from 'svelte';
	import HelpTip from '$lib/components/help/HelpTip.svelte';
	import { api, type Member, type RegistrationCheck, type RegistrationCheckRequest } from '$lib/api';
	import { REGISTRATION_BODIES, registrationBody as bodyInfo, registrationCategoriesOf, type RegistrationBodyCode } from '@water-management/engine';
	import { fmtDate, localIsoDate, pastDayMoment } from '$lib/format/number';

	let { projectId, isOwner, actsForAuthority = false }: { projectId: string; isOwner: boolean; actsForAuthority?: boolean } = $props();

	let checks = $state.raw<RegistrationCheck[] | null>(null);
	let required = $state(true);
	let members = $state.raw<Member[]>([]);
	let error = $state<string | null>(null);
	let note = $state('');
	let busy = $state(false);
	// Recording a check is rare (once a year a signer), so its form stays closed behind the
	// header's "+ Record a check" until asked for (issue #521 § 13).
	let recording = $state(false);
	let opener: HTMLButtonElement | undefined = $state();
	let firstField: HTMLSelectElement | undefined = $state();
	const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

	// The viewer's own day, never the UTC one (a day behind until 02:00 in South Africa).
	const today = () => localIsoDate();
	let form = $state<RegistrationCheckRequest & { userId: string }>({
		userId: '',
		registrationBody: 'sacnasp',
		registrationCategory: '',
		registrationNo: '',
		registerName: '',
		outcome: 'registered',
		checkedByOrg: '',
		checkedAt: today(),
		note: ''
	});
	const categories = $derived(registrationCategoriesOf(form.registrationBody));
	const register = $derived(bodyInfo(form.registrationBody));
	const name = (userId: string | null) => members.find((m) => m.userId === userId)?.displayName ?? 'A former member';
	const signers = $derived(members.filter((m) => m.role !== 'farmer'));
	/** An owner, or a confirmed delegate of the responsible authority (project.actsForAuthority, 233: a team editor too), records a check. */
	const canRecord = $derived(isOwner || actsForAuthority);

	async function load() {
		error = null;
		try {
			const [r, m] = await Promise.all([api.registrationChecks.list(projectId), api.members.list(projectId)]);
			checks = r.checks;
			required = r.required;
			members = m;
		} catch (e) {
			error = msg(e);
		}
	}
	onMount(load);

	async function openForm() {
		recording = true;
		await tick();
		firstField?.focus();
	}
	async function closeForm() {
		recording = false;
		await tick();
		opener?.focus();
	}

	async function record(e: SubmitEvent) {
		e.preventDefault();
		busy = true;
		error = null;
		note = '';
		try {
			const { userId, ...body } = form;
			const c = await api.registrationChecks.record(projectId, userId, { ...body, checkedAt: pastDayMoment(body.checkedAt), note: body.note?.trim() ?? '' });
			checks = [c, ...(checks ?? [])];
			note = `Recorded the check of ${name(userId)}’s registration.`;
			form = { ...form, registrationNo: '', registerName: '', note: '' };
			await closeForm();
		} catch (err) {
			error = msg(err);
		} finally {
			busy = false;
		}
	}

	async function setRequired(next: boolean) {
		busy = true;
		error = null;
		try {
			required = await api.registrationChecks.setRequired(projectId, next);
			note = next ? 'Issuing a pack now waits for the registration checks.' : 'Issuing a pack no longer waits for a registration check.';
		} catch (err) {
			error = msg(err);
			await load();
		} finally {
			busy = false;
		}
	}
</script>

<section class="panel" aria-labelledby="regcheck-h-t" data-testid="registration-checks">
	<div class="panel-head">
		<h2 id="regcheck-h"><span id="regcheck-h-t">Registration checks</span> <HelpTip key="registration-check" label="About registration checks" /></h2>
		{#if canRecord && !recording}
			<button type="button" class="btn btn-sm" bind:this={opener} onclick={openForm}>+ Record a check</button>
		{/if}
	</div>
	<p class="muted small">
		Before a signer’s evidence pack is issued, someone at your organisation looks their registration up on the public register and records it here. The
		verify page then says “checked against the register” for their sign-offs; everyone else’s registration reads “self-declared”. This app checks nothing
		itself.
	</p>
	{#if isOwner}
		<label class="check">
			<input type="checkbox" checked={required} disabled={busy} onchange={(e) => setRequired(e.currentTarget.checked)} data-testid="registration-check-required" />
			Issuing an evidence pack waits until each specialist signer has a check from the last year
		</label>
	{:else}
		<p class="small">{required ? 'Issuing an evidence pack waits until each specialist signer has a check from the last year.' : 'Issuing an evidence pack doesn’t wait for a check.'}</p>
	{/if}

	{#if error}
		<div class="alert alert-error" role="alert">
			{error}
			<!-- The list never loaded: a way to ask again, not only a reload. -->
			{#if checks === null}<button type="button" class="btn btn-sm" onclick={load}>Try again</button>{/if}
		</div>
	{/if}
	{#if checks === null && !error}
		<p class="muted" role="status">Loading…</p>
	{:else if checks?.length}
		<div class="table-wrap">
			<table class="data">
				<thead>
					<tr><th scope="col">Member</th><th scope="col">Registration</th><th scope="col">Found</th><th scope="col">Checked</th></tr>
				</thead>
				<tbody>
					{#each checks as c (c.id)}
						<tr>
							<th scope="row">{name(c.userId)}</th>
							<td>{c.registrationBody.toUpperCase()} {c.registrationNo} <span class="muted small">({c.registerName})</span></td>
							<td>{c.outcome === 'registered' ? 'On the register' : 'Not on the register'}</td>
							<td>{fmtDate(c.checkedAt)} by {c.checkedByOrg}<span class="muted small">{c.recordedBy ? `, recorded by ${c.recordedBy}` : ''}</span></td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{:else if checks}
		<p class="muted">No check recorded yet.</p>
	{/if}

	{#if canRecord && recording}
		<form class="record" onsubmit={record} aria-labelledby="regcheck-new-h">
			<h3 id="regcheck-new-h">Record a check</h3>
			<div class="grid">
				<div class="field">
					<label for="rc-who">Member</label>
					<select id="rc-who" bind:value={form.userId} required bind:this={firstField}>
						<option value="" disabled>Choose…</option>
						{#each signers as m (m.userId)}<option value={m.userId}>{m.displayName}</option>{/each}
					</select>
				</div>
				<div class="field">
					<label for="rc-body">Register</label>
					<select
						id="rc-body"
						value={form.registrationBody}
						onchange={(e) => (form = { ...form, registrationBody: e.currentTarget.value as RegistrationBodyCode, registrationCategory: '' })}
					>
						{#each REGISTRATION_BODIES as b (b.code)}<option value={b.code}>{b.label}</option>{/each}
					</select>
				</div>
				<div class="field">
					<label for="rc-cat">Category</label>
					<select id="rc-cat" bind:value={form.registrationCategory} required>
						<option value="" disabled>Choose…</option>
						{#each categories as c (c.code)}<option value={c.code}>{c.label}</option>{/each}
					</select>
				</div>
				<div class="field">
					<label for="rc-no">Registration number</label>
					<input id="rc-no" bind:value={form.registrationNo} maxlength="50" required />
				</div>
				<div class="field">
					<label for="rc-name">Name on the register</label>
					<input id="rc-name" bind:value={form.registerName} maxlength="200" required />
				</div>
				<div class="field">
					<label for="rc-outcome">Found</label>
					<select id="rc-outcome" bind:value={form.outcome}>
						<option value="registered">On the register</option>
						<option value="not_registered">Not on the register</option>
					</select>
				</div>
				<div class="field">
					<label for="rc-org">Checked by (organisation)</label>
					<input id="rc-org" bind:value={form.checkedByOrg} maxlength="200" required />
				</div>
				<div class="field">
					<label for="rc-date">Checked on</label>
					<DayInput id="rc-date" bind:value={form.checkedAt} max={today()} required />
				</div>
			</div>
			<div class="field">
				<label for="rc-note">Note (optional)</label>
				<input id="rc-note" bind:value={form.note} maxlength="1000" />
			</div>
			{#if register}
				<p class="muted small">Look it up at {register.registerName}: <a href={register.registerUrl} rel="noopener noreferrer" target="_blank">{register.registerUrl}</a></p>
			{/if}
			<div class="action-row">
				<button type="submit" class="btn btn-primary" disabled={busy}>{busy ? 'Recording…' : 'Record the check'}</button>
				<button type="button" class="btn" disabled={busy} onclick={closeForm}>Cancel</button>
			</div>
		</form>
	{/if}
	<p class="visually-hidden" role="status">{note}</p>
</section>

<style>
	.check {
		margin: 0.5rem 0;
	}
	.record {
		margin-top: 1rem;
	}
	h3 {
		font-size: 0.95rem;
		margin: 0 0 0.5rem;
	}
	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(min(100%, 180px), 1fr));
		gap: 0.5rem 0.75rem;
	}
	.grid select,
	.grid input,
	.field input {
		width: 100%;
	}
</style>
