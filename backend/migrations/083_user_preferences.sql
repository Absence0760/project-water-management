-- 083_user_preferences — a person's own display preferences, starting with
-- the workspace sections they hid from their sidebar (issue #17, followups.md
-- § Roles and what each member sees: "Members choose their own tabs";
-- docs/data-model.md § Accounts).
--
-- One jsonb document per account, `{ "hiddenTabs": ["crops", …] }` today;
-- the backend validates its shape (auth/preferences.ts) and this table only
-- keeps it an object of bounded size. Later display choices (the roadmap's
-- WP-1.26 unit preferences) join it as new keys, not new columns.
--
-- Its own table rather than an app_user column: app_user's SELECT policy (068)
-- lets you read the rows of everyone you work with, so a column there would
-- be readable by every co-member at the SQL level. Here the policy is your
-- own row only, for every command. It is presentation only and holds nothing
-- another person needs: no route reads someone else's.
--
-- The row goes with the account (ON DELETE CASCADE); it is in the
-- data-subject export (GET /auth/me/export, `preferences`).

CREATE TABLE user_preferences (
	user_id     uuid PRIMARY KEY REFERENCES app_user (id) ON DELETE CASCADE,
	preferences jsonb NOT NULL DEFAULT '{}'::jsonb
		CHECK (jsonb_typeof(preferences) = 'object' AND pg_column_size(preferences) <= 4096),
	updated_at  timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE user_preferences IS
	'A person''s own display preferences (083): { hiddenTabs } today. Own row only, for every command.';

ALTER TABLE user_preferences ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_preferences_own ON user_preferences FOR ALL
	USING (user_id = app_current_user_id())
	WITH CHECK (user_id = app_current_user_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON user_preferences TO water_app;
