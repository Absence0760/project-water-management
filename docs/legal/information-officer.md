# Registering the information officer: pack for the operator

> **Research notes, not legal advice** (2026-09-27). What Jared Howard would
> do to register as the information officer of Water Management with South
> Africa's Information Regulator, and the open question of whether he has to.
> He files it himself; nothing here is filed by the app. Sources are cited
> inline and were checked on the date above; the Regulator's pages move, so
> re-check the portal before filing. Tracked in
> [legal-status.md](../legal-status.md) § Open before the first client goes
> live.

## Short answer

- **As the clients' operator** (everything inside their projects), POPIA
  puts no registration duty on him: the information-officer duty (s55,
  s56) belongs to responsible parties, and for that information the client
  is the responsible party and registers its own information officer.
- **But the privacy notice makes him a responsible party too**, for the
  accounts and the running of the service (privacy notice §1–2, legal-status.md
  "Accounts are ours"). POPIA applies to a responsible party that is not
  domiciled in South Africa if it "makes use of automated or non-automated
  means" in the Republic (s3(1)(b)); the database is in AWS `af-south-1`
  (Cape Town). So, on the notice as drafted, **he is most likely required to
  register**, and the notice already names him as information officer.
- **Recommendation:** register before the first client goes live (it is
  free and online), unless counsel advises restructuring the roles so the
  client is the responsible party for accounts too (question 1 below).

## Who the information officer is

For a private body, the information officer is its **head** (POPIA s1,
through PAIA's definition of "head of a private body"); for a natural
person carrying on a business, that is the person. So for a sole
proprietorship the proprietor is the information officer by operation of
law; no appointment is needed, and he may authorise deputies in writing
([MJ Kotze Inc, "Information officers"](https://mjkinc.co.za/popia/information-officers);
[ClearComply](https://www.clearcomply.co.za/blog/popia-information-officer-registration-south-africa)).

Section 55(2): an information officer takes up their duties only **after the
responsible party has registered them with the Regulator**. The Regulator
treats registration as compulsory; it has made findings against a body for
failing to register ([MJ Kotze Inc](https://mjkinc.co.za/popia/information-officers)).

## How to register (eServices portal)

Since 1 May 2024 every online service of the Regulator is on its **eServices
portal**, <https://eservices.inforegulator.org.za/>. All services there are
**free of charge** ([eServices: services](https://eservices.inforegulator.org.za/services.aspx);
[Lexology on the 2022 launch](https://www.lexology.com/library/detail.aspx?g=a7cabf11-5ea0-49c3-b72f-fd388a7b46ba)).
The older registration site (`registrations.inforegulator.org.za`) and the
emailed PDF form on the Regulator's information-officer page are the
previous routes; use the portal.

1. **Create a profile** on the portal: country, ID (or passport) number,
   title, name, surname, email address, cell phone number and a password.
   Activate it from the emailed link and the one-time PIN
   ([NADA step-by-step guide](https://nada.co.za/a-step-by-step-guide-on-how-to-register-on-the-information-regulators-eservices-portal/);
   [Michalsons FAQ](https://www.michalsons.com/blog/faq-items/how-do-i-register-my-information-officer-with-the-regulator)).
2. **Information Officers → register**
   (`https://eservices.inforegulator.org.za/officers/default.aspx`): add the
   body and its information officer. For a South African company the portal
   pulls the directors from CIPC; a foreign sole proprietor has no CIPC
   number, so expect to enter the body by hand (see question 3).
3. Keep the **registration confirmation / certificate number**. It is
   needed for later updates and is what to quote to clients.
4. **Update it** whenever the details change (a new email, a deputy added,
   a change of trading name).

### Details to have ready

| Field | Value (from the privacy notice and legal-status.md) |
| --- | --- |
| Body name | Jared Howard, trading as Water Management *(confirm the trading name to register)* |
| Type of body | Private body: sole proprietor (natural person carrying on a business) |
| Registration number | None (not a South African company; no CIPC number). US: none for a Virginia sole proprietor unless a trade name (fictitious name) certificate or EIN is used *(confirm what to enter)* |
| Country | United States of America |
| Physical and postal address | [Virginia business address] *(fill in: the privacy notice gives none)* |
| Information officer | Jared Howard |
| ID / passport number | [US passport number] *(he enters it himself: never in this repo)* |
| Email | `jared@jaredhoward.com` |
| Telephone / cell | [number, with +1] |
| Deputy information officer | None today; a South African deputy may be worth considering (question 4) |
| Sector / nature of processing | Online software service: water-balance modelling for water user associations and consultants; account data of their members |

## What registration brings with it

Registered, the information officer is the person who:

- deals with requests from data subjects about account data (the privacy
  notice promises `jared@jaredhoward.com`);
- reports security compromises about account data through the portal
  ([incident-procedure.md](./incident-procedure.md); the portal requires a
  registered officer to file);
- works with the Regulator on any complaint or assessment;
- keeps the service's POPIA compliance framework (the privacy notice,
  security.md § Personal information, the operator agreements) current;
- under PAIA, may also need a **section 51 manual** for the private body.
  The small-private-body exemption from compiling one lapsed on 31 December
  2021, and sources since say almost every private body needs one
  ([ENS](https://www.ensafrica.com/news/detail/4448/certain-private-bodies-are-exempt-from-compil);
  [MJ Kotze Inc, PAIA manual](https://mjkinc.co.za/agreements/paia-manual)).
  Whether PAIA reaches a foreign sole proprietor at all is question 5.

## Questions for South African counsel

1. **Roles.** Is the operator the responsible party for account data (as the
   privacy notice now says), or should each client be the responsible party
   for its members' accounts, leaving the operator purely an operator? The
   second would likely remove the registration duty, but the accounts are
   shared across clients (one person, several WUAs), which is why the notice
   says they are ours.
2. **Territorial reach.** Does storing account data in AWS `af-south-1`
   make the operator a responsible party "making use of means" in South
   Africa under s3(1)(b), so that POPIA, and the s55 registration, apply?
   (Our reading: yes.)
3. **Foreign registrant.** Can a US sole proprietor with no South African ID
   or CIPC number register through the portal, and what goes in the
   registration-number field? If the portal refuses, is the Regulator's
   support desk (iSupport on the portal; `enquiries@inforegulator.org.za`,
   +27 10 023 5200) the route?
4. **Local presence.** Is a South African deputy information officer
   expected or advisable (some commentary says foreign responsible parties
   should register a South Africa-based officer; we found no provision that
   requires it)?
5. **PAIA.** Does the operator, as a foreign natural person, need a PAIA
   section 51 manual and the annual section 32 report?
6. **Timing.** Must registration happen before the first South African user
   signs up, or before the first client goes live? (Our reading: before any
   processing as responsible party, so before the first sign-up in
   production.)

## Sources

- Information Regulator eServices portal: <https://eservices.inforegulator.org.za/>; services list: <https://eservices.inforegulator.org.za/services.aspx>
- Information Regulator, information officers page (older routes, guidance note of 1 April 2021): <https://inforegulator.org.za/information-officers/>
- [Lexology: online registration portal for information officers launched](https://www.lexology.com/library/detail.aspx?g=a7cabf11-5ea0-49c3-b72f-fd388a7b46ba)
- [Michalsons: how do I register on the Information Regulator portal?](https://www.michalsons.com/blog/faq-items/how-do-i-register-my-information-officer-with-the-regulator)
- [NADA: step-by-step guide to the eServices portal](https://nada.co.za/a-step-by-step-guide-on-how-to-register-on-the-information-regulators-eservices-portal/)
- [MJ Kotze Inc: information officers](https://mjkinc.co.za/popia/information-officers); [when POPIA applies](https://mjkinc.co.za/popia/when-popia-applies); [PAIA manual](https://mjkinc.co.za/agreements/paia-manual)
- [ClearComply: information officer registration (2026)](https://www.clearcomply.co.za/blog/popia-information-officer-registration-south-africa)
- [ENS: exemption from compiling a PAIA manual](https://www.ensafrica.com/news/detail/4448/certain-private-bodies-are-exempt-from-compil)
