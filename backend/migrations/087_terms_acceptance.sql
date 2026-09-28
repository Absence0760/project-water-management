-- 087_terms_acceptance — which version of the terms of use and privacy
-- notice each account accepted, and when (issue #48, docs/legal-status.md
-- § Open before the first client goes live: "Consent record").
--
-- The sign-up form says "By signing up, you accept the Terms of use and
-- Privacy notice" and sends the version it showed (`acceptTerms`, the
-- engine's LEGAL_VERSION, the date the pages took effect); POST
-- /auth/register refuses any other and stores it here through app_register.
-- Accounts the scripts make (seed:examples, import:project) accepted
-- nothing: both columns stay NULL. /auth/me answers `termsCurrent`, the
-- stored version against the current one, so a later version can ask
-- everyone again (legal-status.md tracks the re-acceptance screen).
--
--   1. Two columns on app_user, both NULL or both set, the version a
--      YYYY-MM-DD date. On app_user rather than a table of their own (083's
--      reason for user_preferences): the SELECT policy (068) lets the people
--      you work with read your row, and an acceptance date says no more than
--      created_at, which they can already read.
--   2. app_user_terms_stamp: the time is the database's, never the caller's.
--      water_app may UPDATE its own row (068), so without this an account
--      could backdate or clear its own record. A change of version stamps
--      now(); anything else keeps the stored time; clearing the version
--      keeps the stored record. The operator (as the schema owner) goes
--      through it too.
--   3. app_register (from its latest definition, 068) takes the accepted
--      version as a fifth argument, defaulting to NULL so the scripts' four-
--      argument calls still work. Dropped and recreated: a new argument is a
--      new signature, and leaving the old one would make a four-argument
--      call ambiguous.
--
-- New columns on an existing table: the table-level grants to water_app
-- (001) and app_user's policies (068) already cover them; no foreign key,
-- so no index. Both are in the data-subject export (auth/export.ts).

ALTER TABLE app_user
	ADD COLUMN terms_version text,
	ADD COLUMN terms_accepted_at timestamptz,
	ADD CONSTRAINT app_user_terms_both CHECK ((terms_version IS NULL) = (terms_accepted_at IS NULL)),
	ADD CONSTRAINT app_user_terms_version_date CHECK (terms_version ~ '^\d{4}-\d{2}-\d{2}$');

COMMENT ON COLUMN app_user.terms_version IS
	'The terms of use and privacy notice this account accepted: their effective date, YYYY-MM-DD (the engine''s LEGAL_VERSION at sign-up). NULL: made by a script, accepted nothing.';
COMMENT ON COLUMN app_user.terms_accepted_at IS
	'When terms_version was accepted: stamped by the database (app_register, app_user_terms_stamp), never the caller.';

CREATE FUNCTION app_user_terms_stamp() RETURNS trigger
	LANGUAGE plpgsql SET search_path = public
	AS $$
	BEGIN
		IF NEW.terms_version IS NULL THEN
			-- A record is never cleared: the version and time stay.
			NEW.terms_version := OLD.terms_version;
			NEW.terms_accepted_at := OLD.terms_accepted_at;
		ELSIF NEW.terms_version IS DISTINCT FROM OLD.terms_version THEN
			NEW.terms_accepted_at := now();
		ELSE
			NEW.terms_accepted_at := OLD.terms_accepted_at;
		END IF;
		RETURN NEW;
	END
	$$;
CREATE TRIGGER app_user_terms_stamp BEFORE UPDATE OF terms_version, terms_accepted_at ON app_user
	FOR EACH ROW EXECUTE FUNCTION app_user_terms_stamp();

DROP FUNCTION app_register(citext, text, text, text);
CREATE FUNCTION app_register(p_email citext, p_display_name text, p_password_hash text, p_locale text, p_terms_version text DEFAULT NULL)
	RETURNS uuid
	LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public
	AS $$
		INSERT INTO app_user (email, display_name, password_hash, locale, terms_version, terms_accepted_at)
		VALUES (p_email, p_display_name, p_password_hash, p_locale, p_terms_version, CASE WHEN p_terms_version IS NULL THEN NULL ELSE now() END)
		ON CONFLICT (email) DO NOTHING RETURNING id
	$$;

REVOKE ALL ON FUNCTION app_register(citext, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_register(citext, text, text, text, text) TO water_app;
