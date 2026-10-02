-- 168_team_privacy_contact — the organisation's own privacy contact, so a
-- farmer can see who decides about their farm's information (POPIA s18(1)(b);
-- provisional position, pre-counsel research, 2026-10-01: docs/security.md
-- § Personal information, Privacy §2, operator agreement 3A.1(b)).
--
-- For project data the responsible party is the client organisation (the
-- team), not the operator. s18(1)(b) asks that the person be told its name
-- and address. Until now only each client's own notice did that; this puts
-- the contact in the app: on the farm view's menu ("Who decides about your
-- farm's information") and in invitation emails.
--
-- Expand-only:
--
--  1. team.privacy_contact_name, _email, _postal: all NULL (not set), or a
--     name and an email address, the postal address optional. The API trims
--     and validates; the CHECKs bound the text for any other writer. Access
--     is unchanged: team_select (002) lets every team member read it,
--     team_update (002) lets only an admin change it, and water_app's
--     table-level grant on team (002) covers the new columns.
--  2. app_project_privacy_contact(p_project): the contact of the project's
--     team, for anyone with a role on the project, farmers included. A farmer
--     is no team member, so team_select hides the team row from them; this
--     SECURITY DEFINER function returns the four fields only (the team's
--     name and its contact), nothing else about the team, and nothing to a
--     caller with no role on the project (no row, as for a project without a
--     team or a team without a contact). Pinned search_path; execute to
--     water_app only.

ALTER TABLE team
	ADD COLUMN privacy_contact_name text CHECK (privacy_contact_name IS NULL OR char_length(privacy_contact_name) BETWEEN 1 AND 200),
	ADD COLUMN privacy_contact_email text CHECK (privacy_contact_email IS NULL OR (char_length(privacy_contact_email) BETWEEN 3 AND 254 AND privacy_contact_email LIKE '%_@_%')),
	ADD COLUMN privacy_contact_postal text CHECK (privacy_contact_postal IS NULL OR char_length(privacy_contact_postal) BETWEEN 1 AND 500),
	ADD CONSTRAINT team_privacy_contact_complete CHECK (
		(privacy_contact_name IS NULL AND privacy_contact_email IS NULL AND privacy_contact_postal IS NULL)
		OR (privacy_contact_name IS NOT NULL AND privacy_contact_email IS NOT NULL)
	);

COMMENT ON COLUMN team.privacy_contact_name IS
	'Who a person asks about the team''s projects'' personal information (POPIA s18(1)(b)): a name or office, with privacy_contact_email; NULL = not set (168).';
COMMENT ON COLUMN team.privacy_contact_email IS 'The privacy contact''s email address (168).';
COMMENT ON COLUMN team.privacy_contact_postal IS 'The privacy contact''s postal address, optional (168).';

CREATE FUNCTION app_project_privacy_contact(p_project uuid)
	RETURNS TABLE (organisation text, name text, email text, postal text)
	LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
	AS $$
		SELECT t.name, t.privacy_contact_name, t.privacy_contact_email, t.privacy_contact_postal
		FROM project p JOIN team t ON t.id = p.team_id
		WHERE p.id = p_project
			AND t.privacy_contact_name IS NOT NULL
			AND app_project_role(p_project) IS NOT NULL
	$$;
REVOKE ALL ON FUNCTION app_project_privacy_contact(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_project_privacy_contact(uuid) TO water_app;
