// Wire shapes from docs/api.md that aren't in @water-management/engine.
import type { ProjectSettings, RunSummary } from '@water-management/engine';

export type Role = 'viewer' | 'editor' | 'owner';
export const ROLES: readonly Role[] = ['viewer', 'editor', 'owner'];

export interface User {
	id: string;
	email: string;
	displayName: string;
}

export interface ProjectSummary {
	id: string;
	name: string;
	description: string | null;
	role: Role;
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
