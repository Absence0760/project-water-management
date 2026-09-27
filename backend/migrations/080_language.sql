-- 080_language — the languages a person or an invite can have, as a table
-- (issue #58; docs/data-model.md § Languages).
--
-- invite.locale (034) and app_user.locale (050) each had
-- CHECK (locale IN ('en', 'af')), so a third language meant a migration. Now
-- both reference `language`, and the list lives in one place: the engine's
-- language table (packages/engine/src/languages.ts, LANGUAGES), which
-- backend/scripts/migrate.ts copies in after every migration run (insert
-- only, ON CONFLICT DO NOTHING). Adding a language is then no schema change.
-- The seed below is the list as it stands, so the foreign keys hold even
-- before the first sync.
--
-- Reference data, the same for everyone and holding nothing personal: every
-- signed-in request may read it, and nothing but the schema owner (the
-- migration runner) writes it. A row is never deleted by the app: a language
-- that leaves the list stays here while stored locales may name it.

CREATE TABLE language (
	code text PRIMARY KEY CHECK (code ~ '^[a-z]{2,3}$')
);
COMMENT ON TABLE language IS
	'Languages a person or an invite can have (app_user.locale, invite.locale): BCP 47 primary tags. Synced, insert only, from the engine''s LANGUAGES by scripts/migrate.ts.';

INSERT INTO language (code) VALUES ('en'), ('af');

ALTER TABLE language ENABLE ROW LEVEL SECURITY;
CREATE POLICY language_read ON language FOR SELECT USING (true);
GRANT SELECT ON language TO water_app;

-- The CHECKs become foreign keys. Every stored value is 'en' or 'af' (the
-- CHECKs guaranteed it), so the constraints validate at once.
ALTER TABLE invite DROP CONSTRAINT invite_locale_check;
ALTER TABLE invite ADD CONSTRAINT invite_locale_fkey FOREIGN KEY (locale) REFERENCES language (code);
CREATE INDEX invite_locale_idx ON invite (locale);

ALTER TABLE app_user DROP CONSTRAINT app_user_locale_check;
ALTER TABLE app_user ADD CONSTRAINT app_user_locale_fkey FOREIGN KEY (locale) REFERENCES language (code);
CREATE INDEX app_user_locale_idx ON app_user (locale);
