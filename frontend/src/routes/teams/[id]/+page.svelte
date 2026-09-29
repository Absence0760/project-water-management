<script lang="ts">
	// A team's page (docs/ui.md § Teams): outcomes first. A header (the name, a
	// one-line summary, and the actions: Portfolio, Team settings, Add member,
	// New project), then the team's projects with their EWR traffic lights as
	// the main column (from the portfolio, GET /teams/:id/portfolio) and the
	// members beside them. The name, the thresholds and leave/delete sit in the
	// settings sheet (`?settings=1`, lib/components/teams/TeamSettings.svelte),
	// out of the reading path.
	import { untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import { base } from '$app/paths';
	import { page } from '$app/state';
	import {
		api,
		ApiError,
		hasTeamRole,
		roleLabel,
		roleTitle,
		TEAM_ROLES,
		type Invite,
		type Portfolio,
		type PortfolioProject,
		type Team,
		type TeamMember,
		type TeamRole
	} from '$lib/api';
	import { emailAuthApi } from '$lib/api/emailAuth';
	import { session } from '$lib/auth/session.svelte';
	import PendingInvites from '$lib/components/auth-extras/PendingInvites.svelte';
	import { upsertInvite } from '$lib/components/auth-extras/invites';
	import Dialog from '$lib/components/common/Dialog.svelte';
	import LoadState from '$lib/components/common/LoadState.svelte';
	import EmailText from '$lib/components/common/EmailText.svelte';
	import StatusBar from '$lib/components/portfolio/StatusBar.svelte';
	import StatusPill from '$lib/components/portfolio/StatusPill.svelte';
	import {
		ageText,
		alertsText,
		curtailmentHref,
		damText,
		DEFAULT_SORT,
		ewrWindowLabel,
		farmsShortLabel,
		farmsShortText,
		farmsShortTotalText,
		farmsUnknownText,
		portfolioTotals,
		sortPortfolio,
		sourceText,
		statusSummary,
		thresholdsRule
	} from '$lib/components/portfolio/portfolio';
	import TeamSettings from '$lib/components/teams/TeamSettings.svelte';
	import { withParam, withoutParam } from '$lib/workspace/overlays';
	import { STALE_DAYS } from '$lib/format/age';
	import { fmtDate, fmtDay } from '$lib/format/number';

	const teamId = $derived(page.params.id ?? '');
	const me = $derived(session.user?.id ?? '');

	let team = $state<Team | null>(null);
	let members = $state<TeamMember[]>([]);
	let loading = $state(true);
	let loadError = $state<string | null>(null);
	let notFound = $state(false);
	let error = $state<string | null>(null);
	let busy = $state<string | null>(null);

	// The team's projects with their traffic lights: the portfolio's rows, worst first.
	let portfolio = $state<Portfolio | null>(null);
	let portfolioError = $state<string | null>(null);
	const rows = $derived(portfolio ? sortPortfolio(portfolio.projects, DEFAULT_SORT) : []);
	const totals = $derived(portfolio ? portfolioTotals(portfolio.projects) : null);

	let email = $state('');
	let role = $state<TeamRole>('member');
	let adding = $state(false);
	let addError = $state<string | null>(null);
	let added = $state<string | null>(null);
	let emailInput: HTMLInputElement | undefined = $state();

	const invitesApi = emailAuthApi(api).teamInvites;
	let invites = $state<Invite[]>([]);

	function addToMembers(m: TeamMember) {
		const known = members.some((x) => x.userId === m.userId);
		members = [...members.filter((x) => x.userId !== m.userId), m];
		if (team && !known) team.memberCount += 1;
	}

	let deleteOpen = $state(false);
	let deleting = $state(false);

	const isAdmin = $derived(team?.role === 'admin');
	// Viewers read the team's projects but can't add one to the team.
	const canAddProjects = $derived(hasTeamRole(team?.role, 'member'));
	const adminCount = $derived(members.filter((m) => m.role === 'admin').length);
	const soleAdmin = (m: TeamMember) => m.role === 'admin' && adminCount <= 1;

	// --- the settings sheet: open while the URL says `settings` (Back closes it) ---
	const settingsParam = $derived(page.url.searchParams.has('settings'));
	let settingsOpen = $state(false);
	$effect(() => {
		settingsOpen = settingsParam;
	});
	$effect(() => {
		// Closed (Done, Esc, the ✕): drop `settings` in place.
		if (!settingsOpen && untrack(() => settingsParam)) void goto(withoutParam(page.url, 'settings'), { replaceState: true, noScroll: true, keepFocus: true });
	});
	const settingsHref = $derived(withParam(page.url, 'settings', '1'));

	const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

	async function loadPortfolio() {
		portfolioError = null;
		try {
			portfolio = await api.teams.portfolio(teamId);
		} catch (e) {
			portfolioError = msg(e);
		}
	}

	async function load() {
		loading = true;
		loadError = null;
		notFound = false;
		try {
			const [detail] = await Promise.all([api.teams.get(teamId), loadPortfolio()]);
			team = detail.team;
			members = detail.members;
		} catch (e) {
			if (e instanceof ApiError && e.status === 404) notFound = true;
			else loadError = msg(e);
		} finally {
			loading = false;
		}
	}
	$effect(() => {
		void teamId;
		untrack(load);
	});

	async function add(e: SubmitEvent) {
		e.preventDefault();
		adding = true;
		addError = null;
		added = null;
		try {
			const r = await api.teams.addMember(teamId, email.trim(), role);
			if (r.invited) {
				invites = upsertInvite(invites, r.invite);
				added = `Invitation sent to ${r.invite.email}. They’ll join as ${roleLabel(r.invite.role)} once they confirm this email address (signing up first if they’re new).`;
			} else {
				addToMembers(r.member);
				invites = invites.filter((x) => x.email.toLowerCase() !== r.member.email.toLowerCase());
				added = `${r.member.displayName} added as ${roleLabel(r.member.role)}.`;
			}
			email = '';
			role = 'member';
		} catch (err) {
			addError = msg(err);
		} finally {
			adding = false;
		}
	}

	function focusAddMember() {
		emailInput?.scrollIntoView({ block: 'center' });
		emailInput?.focus();
	}

	async function setRole(m: TeamMember, next: TeamRole) {
		busy = m.userId;
		error = null;
		try {
			const updated = await api.teams.setRole(teamId, m.userId, next);
			members = members.map((x) => (x.userId === m.userId ? updated : x));
			// Demoting yourself takes away admin rights on this page.
			if (m.userId === me && team) team.role = updated.role;
		} catch (err) {
			error = msg(err);
			await load(); // put the select back to the server's value
		} finally {
			busy = null;
		}
	}

	async function remove(m: TeamMember) {
		const self = m.userId === me;
		if (soleAdmin(m)) {
			error = self
				? 'You are the only owner. Make someone else an owner before you leave, or delete the team.'
				: 'A team must keep at least one owner.';
			return;
		}
		const q = self
			? `Leave ${team?.name}? You lose access to its projects unless they're also shared with you directly.`
			: `Remove ${m.displayName} (${m.email}) from the team? They lose access to its projects unless shared directly.`;
		if (!confirm(q)) return;
		busy = m.userId;
		error = null;
		try {
			await api.teams.removeMember(teamId, m.userId);
			if (self) return void (await goto(`${base}/teams`));
			members = members.filter((x) => x.userId !== m.userId);
			if (team) team.memberCount -= 1;
		} catch (err) {
			error = msg(err);
		} finally {
			busy = null;
		}
	}

	/** From the settings sheet: close it, then ask in the confirm dialog (never two modals stacked). */
	function askDelete() {
		settingsOpen = false;
		deleteOpen = true;
	}

	async function deleteTeam() {
		if (!team) return;
		deleting = true;
		error = null;
		try {
			await api.teams.remove(team.id);
			deleteOpen = false;
			await goto(`${base}/teams`);
		} catch (err) {
			deleteOpen = false;
			error = msg(err);
		} finally {
			deleting = false;
		}
	}

	const self = $derived(members.find((m) => m.userId === me));
	const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;
	// Viewers can't run or publish; "publish a run" is advice for the project's editors.
	const canPublish = (p: PortfolioProject) => p.role === 'editor' || p.role === 'owner';
</script>

<svelte:head><title>{team ? `${team.name} · ` : ''}Teams · Water Management</title></svelte:head>

{#snippet projectRow(p: PortfolioProject)}
	{@const age = ageText(p)}
	{@const short = farmsShortText(p)}
	<li class="prow">
		<div class="p-name">
			<a class="name" href="{base}/projects/{p.id}">{p.name}</a>
			<span class="sub">
				{sourceText(p)}{#if p.source === null && canPublish(p)}{' '}· run the model to see figures{/if}
			</span>
		</div>
		<div class="p-ewr">
			<StatusPill {p} />
			{#if age}<span class="sub">Figures {age}</span>{/if}
			{#if p.stale}<span class="badge badge-warn flag">Stale: over {STALE_DAYS} days old</span>{/if}
		</div>
		<dl class="p-facts">
			<div>
				<dt>Hydrological units short</dt>
				<dd>
					{#if short}
						{#if p.farmsShort7 && p.sourceRunId}<a href={curtailmentHref(p, base)}>{short}</a>{:else}{short}{/if}
					{:else}<span class="muted">{farmsUnknownText(p)}</span>{/if}
				</dd>
			</div>
			<div>
				<dt>Lowest dam</dt>
				<dd class:muted={!p.damsKnown || !p.lowestDamPct}>{damText(p)}</dd>
			</div>
			<div>
				<dt>Alerts</dt>
				<dd>{#if p.alertsFiring > 0}<span class="badge badge-warn">{alertsText(p)}</span>{:else}<span class="muted">{alertsText(p)}</span>{/if}</dd>
			</div>
		</dl>
	</li>
{/snippet}

<main class="page">
	<LoadState {loading} error={loadError} retry={load}>
		{#if notFound || !team}
			<div class="alert alert-error" role="alert">
				This team doesn't exist or you're not a member. <a href="{base}/teams">Back to teams</a>
			</div>
		{:else}
			<nav class="crumbs" aria-label="Breadcrumb"><a href="{base}/teams">Teams</a> <span aria-hidden="true">/</span></nav>
			<header class="page-head">
				<div class="title">
					<div class="head">
						<h1>{team.name}</h1>
						<span class="badge" class:badge-owner={isAdmin}>{roleLabel(team.role)}</span>
					</div>
					<p class="muted facts">
						{plural(team.projectCount, 'project')}{#if totals && totals.catchments}{' '}({statusSummary(totals.counts)}){/if} ·
						{plural(team.memberCount, 'member')} · created {fmtDay(fmtDate(team.createdAt))}
					</p>
				</div>
				<div class="head-actions">
					<a class="btn" href="{base}/teams/{team.id}/portfolio">Portfolio</a>
					<a class="btn" href={settingsHref} data-sveltekit-noscroll>Team settings</a>
					{#if isAdmin}<button type="button" class="btn" onclick={focusAddMember}>Add member</button>{/if}
					{#if canAddProjects}<a class="btn btn-primary" href="{base}/?owner=team:{team.id}&new=1">New project</a>{/if}
				</div>
			</header>

			{#if error && !settingsOpen}<div class="alert alert-error" role="alert">{error}</div>{/if}

			<div class="team-body">
				<div class="cols">
					<section class="panel projects" aria-labelledby="tp-h">
						<div class="panel-head">
							<h2 id="tp-h">Projects</h2>
							<span class="muted small">EWR over the last 30 days of each project's figures, worst first</span>
						</div>
						{#if portfolioError}
							<div class="alert alert-error" role="alert">
								The projects couldn't be loaded: {portfolioError}
								<button type="button" class="btn btn-sm" onclick={loadPortfolio}>Try again</button>
							</div>
						{:else if totals && rows.length}
							<dl class="kpis">
								<div class="kpi">
									<dt>{ewrWindowLabel(rows)}</dt>
									<dd><StatusBar counts={totals.counts} /></dd>
								</div>
								<div class="kpi">
									<dt>{farmsShortLabel(rows)}</dt>
									<dd>{farmsShortTotalText(totals) ?? 'Unknown until a run is published'}</dd>
								</div>
								<div class="kpi">
									<dt>Alerts firing</dt>
									<dd>{totals.alertsFiring}</dd>
								</div>
								<div class="kpi">
									<dt>Last run</dt>
									<dd>{totals.lastRunAt ? fmtDay(fmtDate(totals.lastRunAt)) : 'None yet'}</dd>
								</div>
							</dl>
							<ul class="plist" aria-label="Projects of {team.name}">
								{#each rows as p (p.id)}{@render projectRow(p)}{/each}
							</ul>
							<p class="rule muted small">
								Traffic lights: {thresholdsRule(team.portfolioThresholds)}.
								<a href={settingsHref} data-sveltekit-noscroll>{isAdmin ? 'Change them' : 'Which apply'}</a> in the team settings.
							</p>
						{:else if totals}
							<p class="muted">
								{canAddProjects
									? 'No projects yet. Create one here, or move an existing project into the team from its Project page.'
									: 'No projects yet.'}
							</p>
						{:else}
							<p class="muted">Loading…</p>
						{/if}
					</section>

					<section class="panel members" aria-labelledby="members-h">
						<div class="panel-head">
							<h2 id="members-h">Members</h2>
							{#if !isAdmin}<span class="muted small">Only owners can manage members.</span>{/if}
						</div>
						<div class="table-wrap">
							<table class="data">
								<thead>
									<tr>
										<th scope="col">Name</th>
										<th scope="col">Role</th>
										<th scope="col"><span class="visually-hidden">Actions</span></th>
									</tr>
								</thead>
								<tbody>
									{#each members as m (m.userId)}
										<tr>
											<th scope="row">
												{m.displayName}{#if m.userId === me}&nbsp;<span class="muted">(you)</span>{/if}
												<span class="sub-email"><EmailText email={m.email} /></span>
											</th>
											<td>
												{#if isAdmin}
													<select
														aria-label="Team role for {m.displayName}"
														value={m.role}
														disabled={busy === m.userId}
														onchange={(e) => setRole(m, e.currentTarget.value as TeamRole)}
													>
														{#each TEAM_ROLES as r (r)}
															<option value={r} disabled={r !== 'admin' && soleAdmin(m)}>{roleLabel(r)}</option>
														{/each}
													</select>
												{:else}
													<span class="badge" class:badge-owner={m.role === 'admin'}>{roleLabel(m.role)}</span>
												{/if}
											</td>
											<td class="act">
												{#if isAdmin && m.userId !== me}
													<button
														type="button"
														class="btn btn-sm btn-danger"
														disabled={busy === m.userId}
														onclick={() => remove(m)}
														aria-label="Remove {m.displayName}"
													>
														Remove
													</button>
												{/if}
											</td>
										</tr>
									{/each}
								</tbody>
							</table>
						</div>

						{#if isAdmin}
							<form class="add" onsubmit={add}>
								{#if addError}<div class="alert alert-error" role="alert">{addError}</div>{/if}
								<div class="field">
									<label for="tm-email">Add member by email</label>
									<input id="tm-email" type="email" required placeholder="colleague@example.com" bind:value={email} bind:this={emailInput} />
								</div>
								<div class="add-row">
									<div class="field">
										<label for="tm-role">Role</label>
										<select id="tm-role" bind:value={role}>
											{#each TEAM_ROLES as r (r)}<option value={r}>{roleLabel(r)}</option>{/each}
										</select>
									</div>
									<button class="btn btn-primary" type="submit" disabled={adding || !email.trim()}>
										{adding ? 'Adding…' : 'Add'}
									</button>
								</div>
							</form>
							<p class="added" role="status" aria-live="polite">{added ?? ''}</p>
							{#key teamId}
								<PendingInvites
									bind:invites
									idPrefix="team"
									load={() => invitesApi.list(teamId)}
									resend={async (inv) => {
										const r = await invitesApi.add(teamId, inv.email, inv.role as TeamRole);
										if (r.invited) return r.invite;
										addToMembers(r.member);
										return null;
									}}
									revoke={(inv) => invitesApi.revoke(teamId, inv.id)}
								/>
							{/key}
						{/if}
						<dl class="roles">
							<div><dt>{roleTitle('viewer')}</dt><dd>Reads every team project and its runs, but can't change or run anything.</dd></div>
							<div><dt>{roleTitle('member')}</dt><dd>Edits every team project: model, data and runs.</dd></div>
							<div><dt>{roleTitle('admin')}</dt><dd>Owns every team project (delete, share, move) and manages this team.</dd></div>
						</dl>
						<p class="muted small">Anyone without an account gets an email invitation to sign up.</p>
					</section>
				</div>
			</div>

			<TeamSettings
				bind:open={settingsOpen}
				bind:team
				error={settingsOpen ? error : null}
				canLeave={!!self}
				leaving={!!self && busy === self.userId}
				onleave={() => self && remove(self)}
				ondelete={askDelete}
			/>
		{/if}
	</LoadState>
</main>

<Dialog bind:open={deleteOpen} title="Delete team?">
	<p>
		Delete <strong>{team?.name}</strong>? Its {team?.projectCount ?? 0} project{team?.projectCount === 1 ? '' : 's'}
		stay, but members who only had access through the team lose it. This can't be undone.
	</p>
	{#snippet actions()}
		<button type="button" class="btn" onclick={() => (deleteOpen = false)}>Cancel</button>
		<button type="button" class="btn btn-primary danger-btn" disabled={deleting} onclick={deleteTeam}>
			{deleting ? 'Deleting…' : 'Delete team'}
		</button>
	{/snippet}
</Dialog>

<style>
	.crumbs {
		color: var(--text-muted);
		margin-bottom: 0.25rem;
	}
	.page-head {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 0.75rem 1.5rem;
		flex-wrap: wrap;
		margin-bottom: 1.1rem;
	}
	.title {
		min-width: 0;
	}
	.head {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		flex-wrap: wrap;
	}
	.head h1 {
		margin: 0;
		overflow-wrap: anywhere;
	}
	.facts {
		margin: 0.25rem 0 0;
	}
	.head-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}
	/* The columns answer to the page's own width (the sidebar takes 240 px), not the window's. */
	.team-body {
		container: team-page / inline-size;
	}
	.cols {
		display: grid;
		gap: 1rem;
		align-items: start;
	}
	@container team-page (min-width: 56rem) {
		.cols {
			grid-template-columns: minmax(0, 1fr) minmax(20rem, 24rem);
		}
	}
	.cols > .panel {
		margin: 0;
		min-width: 0;
	}
	.projects {
		container: team-projects / inline-size;
	}
	.small {
		font-size: 0.85rem;
	}
	.sub {
		display: block;
		margin-top: 0.15rem;
		font-size: 0.8rem;
		font-weight: 400;
		color: var(--text-muted);
	}
	.flag {
		display: inline-block;
		margin-top: 0.25rem;
		text-transform: none;
	}
	/* The numbers across the top of the projects. */
	.kpis {
		margin: 0 0 0.75rem;
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(8.5rem, 1fr));
		gap: 0.6rem;
	}
	.kpi {
		min-width: 0;
		background: var(--surface-2);
		border-radius: var(--radius);
		padding: 0.55rem 0.75rem;
	}
	.kpi dt {
		font-size: 0.78rem;
		color: var(--text-muted);
		margin-bottom: 0.2rem;
	}
	.kpi dd {
		margin: 0;
		font-weight: 600;
		font-variant-numeric: tabular-nums;
	}
	.plist {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	/* One project: stacked on a narrow column; name | status over the facts on a
	   middling one; name | status | facts across a wide one. */
	.prow {
		display: grid;
		gap: 0.5rem;
		padding: 0.75rem 0;
		border-top: 1px solid var(--border);
	}
	@container team-projects (min-width: 30rem) {
		.prow {
			grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
			gap: 0.5rem 1rem;
		}
		.p-facts {
			grid-column: 1 / -1;
		}
	}
	@container team-projects (min-width: 46rem) {
		.p-facts {
			grid-column: auto;
		}
		.prow {
			grid-template-columns: minmax(0, 1.1fr) minmax(0, 1.2fr) minmax(0, 1.9fr);
			gap: 1rem;
			align-items: start;
		}
	}
	.name {
		font-weight: 600;
		overflow-wrap: anywhere;
	}
	.p-facts {
		margin: 0;
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 0.5rem;
		font-size: 0.85rem;
	}
	@container team-projects (max-width: 26rem) {
		.p-facts {
			grid-template-columns: minmax(0, 1fr);
			gap: 0.25rem;
		}
		.p-facts div {
			display: flex;
			gap: 0.5rem;
		}
		.p-facts dt {
			flex: none;
			width: 6rem;
		}
	}
	.p-facts dt {
		font-size: 0.75rem;
		color: var(--text-muted);
	}
	.p-facts dd {
		margin: 0;
	}
	.rule {
		margin: 0.5rem 0 0;
		padding-top: 0.6rem;
		border-top: 1px solid var(--border);
	}
	/* Members: a narrow column, so the email sits under the name. */
	.members .table-wrap {
		max-height: none;
	}
	.sub-email {
		display: block;
		font-weight: 400;
		font-size: 0.8rem;
		color: var(--text-muted);
		overflow-wrap: anywhere;
	}
	.act {
		text-align: right;
		width: 1%;
		white-space: nowrap;
	}
	select {
		text-transform: capitalize;
		min-width: 6.5rem;
	}
	.add {
		margin-top: 1rem;
	}
	.add .field {
		margin-bottom: 0.5rem;
	}
	.add-row {
		display: flex;
		align-items: flex-end;
		gap: 0.75rem;
	}
	.add-row .field {
		margin-bottom: 0;
		flex: 1;
	}
	.add-row select {
		width: 100%;
	}
	.added {
		margin: 0.5rem 0 0;
		font-size: 0.85rem;
		color: var(--text-2);
	}
	.added:empty {
		margin: 0;
	}
	.roles {
		margin: 1rem 0 0.5rem;
		display: grid;
		gap: 0.35rem;
		font-size: 0.85rem;
	}
	.roles div {
		display: flex;
		gap: 0.5rem;
	}
	.roles dt {
		flex: none;
		width: 4.5rem;
		font-weight: 600;
	}
	.roles dd {
		margin: 0;
		color: var(--text-2);
	}
	.danger-btn {
		background: var(--danger);
		border-color: var(--danger);
		color: #fff;
	}
	.danger-btn:hover:not(:disabled) {
		background: color-mix(in srgb, var(--danger) 85%, #000);
		border-color: color-mix(in srgb, var(--danger) 85%, #000);
	}
	@media (prefers-color-scheme: dark) {
		.danger-btn {
			color: #1a0a08;
		}
	}
	@media (max-width: 560px) {
		.head-actions {
			width: 100%;
		}
		.head-actions > * {
			flex: 1 1 auto;
			justify-content: center;
		}
	}
</style>
