-- 044_contributor_role — the `contributor` project role: a licence applicant
-- or their consultant (roadmap WP-3.3, docs/data-model.md § Roles and access,
-- § Applicants).
--
-- The effective order becomes farmer < contributor < viewer < editor < owner.
-- 'contributor' sorts *below* 'viewer', for the reason 019 put 'farmer'
-- there: every existing policy is `app_has_role(project_id, 'viewer' |
-- 'editor' | 'owner')`, compared with >=, so each refuses a contributor
-- without being touched. A contributor ranked above viewer would read every
-- run, the live model and every model_run.inputs (all farms' parameters).
-- 045_contributor_scope adds what a contributor may read and write, as extra
-- permissive policies only. Team roles never map to 'contributor'
-- (app_project_role, 026), and app_project_role takes the max, so a team
-- member who is also a contributor is simply an editor or viewer.
--
-- Its own file because an enum value added inside a transaction can't be
-- *used* until that transaction commits, and the migration runner wraps each
-- file in one. 045 uses it.

ALTER TYPE project_role ADD VALUE IF NOT EXISTS 'contributor' BEFORE 'viewer';
