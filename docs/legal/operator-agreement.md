# Operator agreement (POPIA sections 20 and 21): template

> **TEMPLATE — FOR COUNSEL REVIEW. Not legal advice and not yet agreed
> wording.** Drafted on 2026-09-27 from what the service actually does
> ([security.md](../security.md), [deployment.md](../deployment.md),
> `infra/`). South African counsel should review it before the first client
> signs (docs/legal-status.md § Open before the first client goes live).
> Fill in the `[square brackets]` for each client. Where a clause describes
> the system, it is written from the code and infrastructure as they are; if
> they change, change this template in the same change.

---

**Between**

1. **[Client legal name]**, [registration number], of [address]
   (**"the Client"**), a [water user association / irrigation board /
   consultancy], acting as the **responsible party**; and
2. **Jared Howard**, a sole proprietor trading as Water Management, of
   Virginia, United States of America, `jared@jaredhoward.com`
   (**"the Operator"**).

**Date:** [date]  **Reference:** [client reference]

## 1. What this agreement is for

1.1 The Client uses Water Management (**"the service"**), a web application
for catchment water-balance modelling, to run one or more catchment projects
and to share results with its members (farmers, hydrologists, staff and
others it invites).

1.2 To provide the service, the Operator processes personal information on
the Client's behalf. Under the Protection of Personal Information Act, 2013
(**POPIA**) the Client is the **responsible party** for that information and
the Operator is its **operator** (sections 20 and 21). This agreement is the
written contract section 21(1) requires.

1.3 **What is not covered.** The Operator is the responsible party, not the
Client's operator, for the account information a person gives when they sign
up (name, email address, password, language and display choices) and for
running the service itself (security logs, sign-in protection). That is
governed by the service's [Privacy notice](https://[domain]/privacy) and
[Terms of use](https://[domain]/terms). Everything a person or the Client puts
**into the Client's projects** is covered here.

## 2. Subject matter, duration, nature and purpose

2.1 **Subject matter.** Hosting, storing, computing on and displaying the
personal information in the Client's projects, sending the emails the Client
switches on, and producing the reports and exports the Client's users ask
for.

2.2 **Duration.** From the date above until the Client stops using the
service and clause 10 (return and deletion) has been completed.

2.3 **Categories of data subjects.** Members of the Client's projects and
teams (staff, consultants, farmers, applicants and viewers it invites);
people the Client invites who have not yet signed up; registered water users
named in water-use records the Client imports (for example WARMS extracts).

2.4 **Categories of personal information.**
- Names and email addresses of invited people, and their role in a project.
- The link between a farmer and the farms they are associated with, and the
  modelled water figures for those farms (personal once a farm is linked to a
  named person).
- Registered water-use records: holder names, registration numbers,
  registered volumes.
- Notes, sign-offs (a typed name and professional registration), and the
  project's audit log (who did what, and when).
- Alert choices and the record of alert emails sent.

2.5 **Special personal information and children.** The service is not
designed to hold special personal information (POPIA section 26) or
information about children. The Client will not put any into the service.

2.6 **Purpose.** Only to provide the service to the Client as described in
the Terms of use, and for no other purpose. The Operator does not sell,
share for advertising, or use the Client's information to train models.

## 3. Processing only on documented instructions (s20(a))

3.1 The Operator processes the Client's personal information only with the
Client's knowledge or authorisation. The Client's instructions are: this
agreement; the Terms of use; and the choices the Client and its users make in
the service (whom to invite, what to import, what to publish, which emails to
switch on). Any further instruction must be in writing (email is enough)
from [Client contact name / role].

3.2 If the Operator believes an instruction breaks POPIA or another law, it
will say so promptly and may decline to follow it until it is confirmed or
changed in writing.

3.3 If a law requires the Operator to process the information otherwise (for
example a court order), it will tell the Client first unless the law forbids
that.

## 3A. The Client's duties

3A.1 The Client confirms that, for the personal information it puts into the
service, (a) it has a lawful basis under section 11; (b) it will make its
members and invitees aware of the matters in section 18, including its own
name and address as responsible party, before or as soon as reasonably
practicable after their information is entered; and (c) it has considered
whether matching registered water-use records (such as WARMS registration
numbers) to farms or people needs prior authorisation under sections 57
and 58, and has obtained it where needed; and (d) it obtained any registered
water-use extract lawfully and will give the Operator, on request, the terms
under which it was released, which prevail over the service's defaults.

3A.2 The Client tells the Operator in writing if it is a governmental body
whose records are public records under the National Archives and Records
Service of South Africa Act 43 of 1996 (or a provincial archives law). For
such a Client, clause 8.4 is varied: a deleted person's name stays in the
Client's project history, and clause 10.2 deletion happens only after the
Client confirms it holds its records or has a disposal authority.

## 4. Confidentiality (s20(b))

4.1 The Operator treats the Client's personal information as confidential
and does not disclose it except as this agreement allows, or as the law
requires.

4.2 The Operator is a sole proprietor and is today the only person with
administrative access to the production systems. If anyone else is given
access (an employee or contractor), the Operator will bind them to
confidentiality in writing first and tell the Client.

## 5. Security measures (s19 and s21(2))

The Operator maintains appropriate, reasonable technical and organisational
measures to prevent loss of, damage to, unauthorised destruction of, and
unlawful access to or processing of the information. As built today
([security.md](../security.md)):

5.1 **Access between customers.** Every project-scoped database query runs
under PostgreSQL row-level security as a restricted role, inside a
transaction bound to the signed-in person; the application never connects
as the database owner. A person sees only the projects and farms they have
been given. A farmer sees only their own farms' figures. Automated tests
check that people cannot see what they were not given.

5.2 **Accounts.** Passwords are stored only as bcrypt hashes. Sessions are
signed, HttpOnly, Secure, SameSite cookies, and can be revoked on every
device. Sign-in attempts are rate-limited and locked out after repeated
failures; sign-up is throttled. Email addresses are confirmed before an
account can sign in.

5.3 **In transit.** HTTPS (TLS) only, with HSTS; TLS required between the
application and the database, and to receiving mail servers.

5.4 **At rest and hosting.** Amazon Web Services, region `af-south-1`
(Cape Town, South Africa). The database runs in private subnets with no
public endpoint, is encrypted at rest, and has deletion protection. Report
PDFs are kept in a private, encrypted S3 bucket. Secrets are held in AWS
Secrets Manager or encrypted with AWS KMS, never in source code.

5.5 **Perimeter.** A web application firewall with per-address rate limits
in front of the application; strict browser security headers (Content
Security Policy with no third-party scripts, fonts or analytics).

5.6 **Change control.** Deployments go through a reviewed pipeline that
uses short-lived credentials (no long-lived cloud keys) and needs a manual
approval before anything reaches production.

5.7 **Logs.** Application and database logs are kept for 30 days in AWS
CloudWatch (af-south-1). Logs are written to avoid personal information (for
example, integrity alarms carry identifiers only, never farm names or
values).

5.8 **Backups.** Automated database backups with point-in-time recovery,
kept for between 7 and 35 days (today: [7] days). A deleted record stays in
backups until they age out.

5.9 **Alarms.** Budget, error, throttle and integrity alarms notify the
Operator.

5.10 The Operator may change these measures, but not so that the overall
level of protection goes down. It will keep [security.md] current and give
the Client the current description on request.

## 6. Sub-processors

6.1 The Client authorises the Operator to use these sub-processors:

| Sub-processor | What it does | Where the Client's information is |
| --- | --- | --- |
| **Amazon Web Services, Inc.** | Hosting: AWS Lambda (application, background jobs, report rendering, data-feed fetching), Amazon RDS for PostgreSQL (database and backups), Amazon S3 (site files, report PDFs), Amazon SES (email), Amazon SQS and EventBridge (job queues and schedules), Amazon CloudWatch (logs, metrics, alarms), AWS Secrets Manager and KMS (secrets), Amazon ECR (application images, no personal information), Amazon VPC | Stored in `af-south-1` (Cape Town) |
| Amazon Web Services, Inc. | Amazon CloudFront (content delivery), AWS WAF (firewall) and AWS Certificate Manager (TLS certificates) | In transit only: requests pass through CloudFront edge locations worldwide; the firewall's configuration and rate counters sit in `us-east-1` and see each request's IP address and path. Nothing is stored there by the service. |
| Migadu (Switzerland), the Operator's mailbox provider for `@jaredhoward.com` (per the estate's DNS records) | Receives email the Client or data subjects send to `jared@jaredhoward.com` (support, requests) | Switzerland *(the Operator's personal site also names Gmail for its email: confirm whether mail is forwarded there, and list Google too if so)* |

6.2 The data-feed sources the service reads from (CHIRPS rainfall, the
Department of Water and Sanitation's hydrology data) receive no personal
information.

6.3 The Operator binds each sub-processor to data-protection terms at least
as protective as this agreement (for AWS, its Data Processing Addendum,
which is part of the AWS Customer Agreement). The Operator remains
responsible to the Client for its sub-processors.

6.4 **Changes.** The Operator will give the Client at least [30] days'
written notice before adding or replacing a sub-processor that will receive
the Client's personal information. The Client may object on reasonable data-
protection grounds; if the parties can't resolve it, the Client may end this
agreement and clause 10 applies.

## 7. Security compromises (s21(2) and s22)

7.1 Where the Operator has reasonable grounds to believe that the Client's
personal information has been accessed or acquired by an unauthorised person,
it will notify the Client **immediately, and in any case within 48 hours**
of becoming aware of it, even before the facts are all known.

7.2 The notice will give what is known at the time, and be updated as more
is learned: what happened and when; what information and which people are,
or may be, affected; the likely consequences; what the Operator has done and
will do to contain it; and, if known, who accessed the information.

7.3 The Client, as responsible party, decides whether and how to notify the
Information Regulator and the data subjects (section 22). The Operator will
help: it will supply the facts the Regulator's security-compromise report
asks for, and draft the notice to data subjects if asked. The Operator will
not notify data subjects or the Regulator about the Client's information on
the Client's behalf unless the Client asks it to in writing, or the law
requires it.

7.4 The Operator's internal procedure is
[incident-procedure.md](./incident-procedure.md).

## 8. Helping with data subjects' requests

8.1 The service gives each person a self-service download of their data
(Account → Your data → Download my data). For other requests (correction,
deletion, objection, or an access request the person can't serve
themselves), the Operator will help the Client respond within the time POPIA
and PAIA allow.

8.2 If a data subject contacts the Operator directly about the Client's
information, the Operator will pass the request to the Client within [5]
business days and will not answer it itself except to say it has been
passed on.

8.3 The Operator will also give reasonable help with the Client's own POPIA
duties that concern the service (for example a prior-authorisation
application or a question from the Information Regulator).

8.4 Standing instruction on deleting an account. When a person asks for
their account to be deleted, the Client instructs the Operator, as a
standing instruction under clause 3 for every such request, to delete it as
the privacy notice (§7) describes, without asking the Client each time:
what the person made for a project (the project, its runs, scenarios,
licence applications, imports and the like) is kept as the project's record
with the person's name removed, and is never reassigned to anyone else; an
unfinished calculation and a draft application of theirs are deleted; a
sign-off's typed name and registration, and the names printed in an issued
evidence pack, are kept until the closing date of the licence record they
support (three years after the licence expires, or three years after the
application is refused or withdrawn, reviewed every five years while no
outcome is recorded), and then deleted on the Client's written confirmation.
The Operator tells the Client of each deletion that touches the Client's
projects within [5] business days. The Client may vary this instruction in
writing for its own projects (for example under clause 3 where it must keep
a name by law).

## 9. Records, information and audits

9.1 The service keeps an audit log for each project, which the Client's
owners can see (History).

9.2 On request, and at most once a year unless there has been a security
compromise, the Operator will answer the Client's reasonable written
security questionnaire and give it the information it needs to show that
this agreement is kept.

9.3 An on-site or technical audit by the Client or an independent auditor it
appoints is possible on [30] days' notice, at the Client's cost, subject to
confidentiality and without access to other customers' information or to
the sub-processors' facilities (for AWS, its published audit reports stand
in for an audit).

## 10. End of the agreement: return and deletion

10.1 When the agreement ends, the Client may export its projects (model,
series, runs, reports) and its users may download their own data. The
Operator will, on request within [30] days of the end date, help with an
export of anything the Client can't take itself.

10.2 Within [60] days of the end date the Operator will delete the Client's
projects and the personal information in them from the live service, and
confirm it in writing. Copies in backups are deleted as the backups age out
(at most 35 days). Accounts belong to their holders (clause 1.3): a person
who is only in the Client's projects keeps their account unless they ask for
it to be deleted.

10.3 The Operator may keep information longer only where a law requires it,
and then only for that purpose, still protected under this agreement.

## 11. Cross-border transfers (s72)

11.1 The Client's information is stored in South Africa (`af-south-1`). The
Operator is in the United States and administers the service from there, so
the Operator's access is a transfer of personal information outside South
Africa under section 72.

11.2 The parties agree that this agreement is a binding agreement providing
an adequate level of protection under section 72(1)(a): the Operator will
apply the conditions for lawful processing in POPIA to the information,
and will not transfer it onward to another country except under this
agreement (clause 6) or with the Client's written consent.

11.3 The Operator will not move the stored information out of South Africa
without the Client's prior written consent.

## 12. Liability

12.1 Each party is responsible for its own compliance with POPIA.

12.2 The Operator's liability under this agreement is limited as in the
Terms of use (the greater of the fees paid in the 12 months before the claim
or US $100), **except** that [the cap does not apply to loss caused by the
Operator's breach of clauses 4, 5 or 7, or by its wilful misconduct or gross
negligence] *(for counsel: whether to carve out, and whether a separate data-
protection cap is appropriate)*.

12.3 Nothing in this agreement limits a data subject's rights under POPIA,
or either party's liability where the law does not allow it to be limited.

12.4 **Farm figures shown to the Client's members.** Where the Client
publishes farm figures to its members (the farm view, share links, alert
emails), the Client presents them as model estimates, not measurements,
and keeps the service's notices on them in place (the estimate line and
the "Before you look at your farm" acknowledgement). The Client is
responsible for its own notices to its members, including as their
supplier where the Consumer Protection Act 68 of 2008 treats its supply of
the farm view to them as a transaction (section 5(6)(a)).

## 13. General

13.1 **Order of precedence.** For the Client's personal information, this
agreement wins over the Terms of use where they conflict.

13.2 **Changes.** Only in writing signed (or confirmed by email) by both
parties.

13.3 **Governing law.** This agreement is governed by the law of the
Republic of South Africa, and the South African courts have jurisdiction over
disputes under it. POPIA applies to the processing in any case.

13.4 **Notices.** To the Operator at `jared@jaredhoward.com`; to the Client
at [email]. A security-compromise notice (clause 7) also goes to [the
Client's information officer, name and email].

---

Signed for the Client: ____________________ Name / role: ____________ Date: ________

Signed by the Operator: ____________________ Jared Howard Date: ________

---

## Notes for counsel (not part of the agreement)

- **Roles split.** The draft treats accounts as the Operator's own (it is the
  responsible party) and project contents as the Client's. Confirm this split
  works under POPIA, and that the privacy notice (§2) and this agreement say
  the same thing.
- **48 hours.** Section 21(2) says "immediately". 48 hours is an outer bound
  the Operator can meet as a sole proprietor; confirm it is acceptable
  alongside the statutory word.
- **Section 72.** Is a binding agreement (72(1)(a)) the right basis for the
  Operator's own access from the US, or should the Client also rely on
  72(1)(b)/(d) (necessary for the contract)?
- **Liability carve-outs** (clause 12.2) are deliberately left open.
  **Governing law** (13.3) is South African law (the operator's decision,
  2026-09-28, matching Terms §15 for South African users).
- **Clause 3A** (the Client's own s18 notice, its lawful basis, and the
  s57–58 question for WARMS matching) is from pre-counsel research
  (2026-09-28); confirm the s57 reading before the first signature.
- **Mailbox provider** (clause 6.1): confirm the provider and its data-
  protection terms before the first signature.
- **Clause 8.4 and the National Archives Act.** The standing instruction
  removes a deleted person's name from the evidence they made (POPIA s16
  rules out reassigning it; s14(1)(b) and s14(6)(b) support keeping a
  sign-off's typed name for a bounded period). Where the responsible party
  is DWS or a CMA, its records may be public records under the National
  Archives and Records Service of South Africa Act 43 of 1996, which may
  require the name to be kept. Clause 3A.2 is the carve-out (built: the
  operator-set `team.public_records`, migration 161, keeps the name in that
  team's project history). Confirm whether a WUA is a "governmental body"
  for the Act, and whether the Operator deleting its own copy is a
  "disposal". Clause 3A.1(d) and the WARMS reference the app now requires
  rest on finding no published DWS terms for WARMS extracts; provisional
  positions (pre-counsel research, 2026-10-01).
