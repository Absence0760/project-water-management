# Personal-information incident procedure

> **Draft for counsel review** (2026-09-27). The operator's procedure for a
> security compromise of personal information: a farmer who sees the wrong
> farm, a leaked share link or key, a database or account compromise.
> Technical first steps are in [deployment.md § Runbooks](../deployment.md#runbooks)
> (item 4, "A farmer sees the wrong farm", and items 5, 1) and
> [security.md § Incident playbook](../security.md#incident-playbook). This
> file is who decides, how fast, and whom to tell. It backs clause 7 of the
> [operator agreement](./operator-agreement.md).

## Roles

| Who | For what information | Decides |
| --- | --- | --- |
| **Jared Howard** (operator; sole proprietor; the service's information officer) | Accounts and the running of the service (the service is the responsible party: [privacy notice §2](https://[domain]/privacy)) | Everything, including notifying the Regulator and the people affected |
| **The client** (the WUA or consultancy; responsible party) and its information officer | What is in its projects: farm links and figures, members, notes, water-use records | Whether and how to notify the Information Regulator and the people affected (POPIA s22). The operator informs and helps; it does not decide for the client |

If it touches both (for example the database itself was reached), both
tracks run: the operator notifies the Regulator for accounts, and every
affected client for its projects.

## Timeline

"Aware" means there are **reasonable grounds to believe** personal
information was accessed or acquired by someone not entitled to it (s22(1)).
Certainty is not needed, and a forensic investigation is not a reason to
wait.

| When | What |
| --- | --- |
| **At once** | Contain it (below). Start the incident record. |
| **Within 48 hours** of being aware, and sooner where possible | Tell every affected client in writing (email to its contact and its information officer): what is known, per [operator agreement §7.2](./operator-agreement.md#7-security-compromises-s212-and-s22). POPIA s21(2) says *immediately*; 48 hours is the outer bound, not the target. |
| **As soon as reasonably possible** after being aware | Where the operator is the responsible party (accounts): report to the Information Regulator and notify the people affected. Where the client is: help it do both. Section 22(2) allows for the legitimate needs of law enforcement and the steps reasonably needed to find the scope of the compromise and restore the system's integrity; telling data subjects may be delayed only if a public body investigating offences, or the Regulator, decides it would impede a criminal investigation (s22(3)). Any delay and its reason go in the record and in the report. |
| As facts change | Update the client(s) and, where the operator reported it, the Regulator. |
| Within 2 weeks of closing | Write up the cause and the fix; add a test that reproduces the failure (security.md, incident playbook item 2). |

## 1. Contain

- **A farmer sees the wrong farm:** unlink them at once (Overview →
  Farmers), deployment.md § Runbooks item 4. Access ends on their next
  request.
- **A share link or API key leaked:** revoke it (runbook items 5 and 1).
- **Cross-project exposure (an RLS failure):** security.md § Incident
  playbook item 2; take the affected route or the whole service offline if
  it can't be closed at once.
- **Secret, credential or AWS account compromise:** security.md § Incident
  playbook items 1, 3 and 5.

## 2. Find out and record

Keep one incident record (in the operator log, never in this public repo):

- when it started, when it was noticed, by whom, and how;
- what personal information, of whom (which projects, farms, how many
  people), was or may have been seen or taken, and for how long;
- who accessed it, if known;
- the evidence: History (`farmer.linked`, `member.added`, share-link and
  key events), CloudWatch logs (kept 30 days: export what's needed before
  it ages out), CloudTrail for AWS actions;
- what was done, when, and every notification sent (to whom, when, what).

## 3. Tell the Information Regulator (where the operator is the responsible party)

- **How:** the Regulator's eServices portal, **Security Compromises**
  (`https://eservices.inforegulator.org.za/compromises/default.aspx`), from
  the information officer's portal profile. Since 1 April 2025 the portal is
  the required channel; a report by email is treated as non-compliant.
  ([Regulator media statement, April 2025](https://inforegulator.org.za/wp-content/uploads/2025/04/MEDIA-STATEMENT-INVITATION-TO-REPORT-SECURITY-COMPROMISES-THROUGH-THE-eSERVICES-PORTAL-.pdf);
  [step-by-step guide](https://www.inforegulator.org.za/wp-content/uploads/2025/05/stepbystepguide.pdf).)
  The portal needs a registered information officer
  ([information-officer.md](./information-officer.md)).
- **What it asks for** (the section 22 form, now online): Part A, the
  responsible party; Part B, the information officer (if different); Part
  C, the compromise: the date it happened, the date reported, the reason
  for any delay, its type, a description (an annexure may add detail), the
  types of personal information accessed, the number of data subjects, how
  they were notified, the possible consequences, and the measures taken or
  intended. Keep the incident record (§2) in that shape so the report is a
  copy, not a new piece of work.
  ([Regulator's guideline on completing the s22 form](https://inforegulator.org.za/wp-content/uploads/2020/07/Guidelines-on-completing-a-Security-Compromise-Notification-ito-Section-22-POPIA.pdf).)
  There is no size threshold: every compromise is reported
  ([Regulator fact sheet, August 2025](https://inforegulator.org.za/2025/08/19/fact-sheet-handling-of-security-compromises/)).
- The Regulator may direct a public announcement (s22(6)); follow it.

## 4. Tell the people affected (s22(4) and (5))

In writing, by email to their account address (one of the methods in
s22(4); a prominent notice on the site or in the news media are others, and
the Regulator may direct one). Section 22(5) requires enough information for
them to protect themselves. The notice says, in plain words:

1. what happened and when, and what personal information of theirs was
   involved;
2. the possible consequences (s22(5)(a));
3. what the operator (or the client) has done and will do about it
   (s22(5)(b));
4. what they can do to protect themselves, for example: change their
   password, sign out everywhere (Account), watch for phishing that uses the
   information (s22(5)(c));
5. who accessed it, if known (s22(5)(d));
6. whom to contact: `jared@jaredhoward.com` (or the client's information
   officer, for its projects), and that they may complain to the
   Information Regulator (`POPIAComplaints@inforegulator.org.za`).

Farmers' notices go in their language where the app has it (English or
Afrikaans); the English text binds.

For a client's projects the client sends this (it is its decision and its
members); the operator drafts it on request.

## 5. Close

- Fix the cause at the source, with a regression test (CLAUDE.md "fix the
  root cause").
- Update [security.md](../security.md) and, if the incident shows a gap in
  this procedure, this file.
- Tell the client(s), and the Regulator where it was reported, that it is
  closed and what changed.

## Open questions for counsel

- Where the operator is also the information officer for accounts, and a
  compromise touches a client's projects, is one Regulator report (by the
  client) enough, or must the operator report its own part too?
- Is email to the account address enough "written" notice for farmers who
  rarely read email, or should the client also tell them in person?
