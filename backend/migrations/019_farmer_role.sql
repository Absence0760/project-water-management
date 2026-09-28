-- 019_farmer_role — the `farmer` project role (roadmap WP-2.1, issue #24;
-- docs/data-model.md § Roles and access).
--
-- A farmer sees their own linked farms and nothing about any other farm
-- (020_farm_scope.sql). 'farmer' sorts *below* 'viewer', so every existing
-- policy — all of them `app_has_role(project_id, 'viewer' | 'editor' |
-- 'owner')`, compared with >= — refuses a farmer without touching one of
-- them. That is the fail-closed default: a table nobody wrote a farmer policy
-- for stays invisible to farmers. Team roles never map to 'farmer'
-- (app_project_role, 008), and app_project_role takes the max, so a farmer
-- who is also a team member is simply an editor or viewer.
--
-- Its own file because an enum value added inside a transaction can't be
-- *used* until that transaction commits, and the migration runner wraps each
-- file in one. 020 uses it.

ALTER TYPE project_role ADD VALUE IF NOT EXISTS 'farmer' BEFORE 'viewer';
