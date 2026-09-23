// Wire shapes from docs/api.md that aren't in @water-management/engine.
import type { ProjectSettings, RunSummary } from '@water-management/engine';

export type Role = 'viewer' | 'editor' | 'owner';
export const ROLES: readonly Role[] = ['viewer', 'editor', 'owner'];

export interface User {
	id: string;
	email: string;
	displayName: string;
	/** False until the address is confirmed via the emailed link (VerifyEmailBanner). */
	emailVerified?: boolean;
}

/**
 * The team a project belongs to. `name` is null when you reach the project by
 * direct sharing but aren't in its team (team names are private to members).
 */
export interface ProjectTeam {
	id: string;
	name: string | null;
}

export interface ProjectSummary {
	id: string;
	name: string;
	description: string | null;
	role: Role;
	/** null = a personal project (owned by its direct members only). */
	team: ProjectTeam | null;
	createdAt: string;
	updatedAt: string;
}

export interface Project extends ProjectSummary {
	settings: ProjectSettings;
}

export interface Member {
	userId: string;
	email: string;
	displayName: string;
	role: Role;
}

/** Team roles: admins are owners of every team project, members are editors. */
export type TeamRole = 'member' | 'admin';
export const TEAM_ROLES: readonly TeamRole[] = ['member', 'admin'];

export interface Team {
	id: string;
	name: string;
	/** Your role in the team. */
	role: TeamRole;
	createdAt: string;
	memberCount: number;
	projectCount: number;
}

export interface TeamMember {
	userId: string;
	email: string;
	displayName: string;
	role: TeamRole;
}

export interface RunMeta {
	id: string;
	label: string | null;
	engineVersion: string;
	startDate: string;
	endDate: string;
	createdAt: string;
	createdBy: string | null;
}

export interface Run extends RunMeta {
	summary: RunSummary;
}

/** One output series available for a run (values fetched separately). */
export interface RunSeriesRef {
	nodeId: string | null;
	key: string;
	label: string;
	unit: string;
}

const RANK: Record<Role, number> = { viewer: 0, editor: 1, owner: 2 };

/** True when `role` is at least `min`. */
export function hasRole(role: Role | undefined | null, min: Role): boolean {
	return role != null && RANK[role] >= RANK[min];
}
