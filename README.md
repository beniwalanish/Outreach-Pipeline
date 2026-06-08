# Outreach Pipeline

A fully automated cold-outreach data pipeline, built as a Node.js CLI. Given a
single company domain, it discovers similar companies, finds their decision
makers, enriches verified work emails, and sends personalized outreach — with
strong credit- and send-safety guarantees at every stage.

> Built as an SDE internship assignment for Vocallabs / Subspace.

---

## Overview

The pipeline takes one input (a company domain) and runs it through four
external services. Each stage persists its output to a JSON file, so stages can
be run independently and resumed without repeating (paid) API calls.

```
Input Domain
      │
      ▼
Ocean.io
(Similar Companies)
      │
      ▼
Prospeo Search
(People Discovery)
      │
      ▼
Prospeo Bulk Enrich
(Verified Emails)
      │
      ▼
Filtering & Validation
      │
      ▼
contacts.json
      │
      ▼
Brevo
(DRY_RUN Protected)
```

---

## Features

- **End-to-end automation** — domain in, personalized emails out.
- **Stage isolation** — every stage runs standalone and reads the previous
  stage's saved JSON (`outputs/*.json`), so you never re-spend credits to resume.
- **Credit safety** — finite result caps, hard page ceilings, and right-sized
  requests prevent runaway pagination.
- **Send safety** — `DRY_RUN` defaults to `true`; real sends require an explicit
  opt-in.
- **Deduplication** — companies, people, and outbound emails are all deduped.
- **Resilience** — per-item failures are logged and skipped; the run continues.
- **Retries with backoff** — transient failures (network / 429 / 5xx) are
  retried; client/validation errors fail fast.
- **Structured logging** — timestamped, level-aware logs via Winston.

---

## Tech Stack

| Concern        | Choice                          |
| -------------- | ------------------------------- |
| Runtime        | Node.js 20+ (CommonJS)          |
| HTTP client    | Axios                           |
| Config         | dotenv                          |
| Logging        | Winston                         |
| Email provider | Brevo (transactional API)       |
| Data providers | Ocean.io, Prospeo               |

---

## Architecture

```
src/
├── app.js                     # Orchestrator + CLI (the only place Brevo is wired)
├── config/
│   └── env.js                 # Centralized, validated config (single source of truth)
├── services/
│   ├── ocean.service.js       # Stage 1: similar companies
│   ├── prospeo.service.js     # Stage 2a/2b: people discovery + bulk enrich
│   └── brevo.service.js       # Stage 5: transactional send (isolated)
└── utils/
    ├── logger.js              # Winston logger
    └── emailTemplate.js       # generateColdEmail(contact)
outputs/                       # Per-stage JSON artifacts (created at runtime)
```

Each service exposes pure, testable functions and owns its own retry, rate
limiting, and error mapping. The orchestrator only sequences stages and persists
artifacts.

---

## Environment Variables

Create a `.env` file in the project root:

```dotenv
# Required — API keys
OCEAN_API_KEY=your_ocean_token
PROSPEO_API_KEY=your_prospeo_key
BREVO_API_KEY=your_brevo_key

# Brevo sender (must be a Brevo-verified sender; required only for real sends)
BREVO_SENDER_EMAIL=you@yourdomain.com
BREVO_SENDER_NAME=Outreach Team

# Optional tuning (defaults shown)
MAX_SIMILAR_COMPANIES=5
MAX_PEOPLE_PER_COMPANY=10

# Send safety — must be explicitly "false" to send real emails
DRY_RUN=true
```

`config/env.js` validates required keys at startup and throws a descriptive
error listing any that are missing.

---

## Installation

```bash
git clone <repo-url>
cd outreach-pipeline
npm install
cp .env.example .env   # then fill in your keys
```

Requires Node.js 20 or newer.

---

## Usage

Run the full pipeline for a domain:

```bash
node src/app.js openai.com
```

This produces, in order:

```
outputs/ocean.json      # similar company domains
outputs/people.json     # discovered people (normalized)
outputs/enriched.json   # bulk-enriched people
outputs/contacts.json   # final verified contacts
outputs/send-report.json# send results (after --stage send)
```

### Stage Commands

Run any stage in isolation. Stages after the first read the previous stage's
saved output (override with `--input <file>`):

```bash
node src/app.js openai.com --stage ocean    # Stage 1: similar companies
node src/app.js --stage search               # Stage 2a: people  (reuses ocean.json)
node src/app.js --stage enrich               # Stage 2b: bulk enrich (reuses people.json)
node src/app.js --stage filter               # Stage 3: filter+map (no API)
node src/app.js --stage send                 # Stage 5: send (DRY_RUN gated)
```

Flags:

| Flag             | Description                                        |
| ---------------- | -------------------------------------------------- |
| `--stage <name>` | `ocean` \| `search` \| `enrich` \| `filter` \| `send` \| `all` |
| `--max-similar N`| Override `MAX_SIMILAR_COMPANIES`                   |
| `--max-people M` | Override `MAX_PEOPLE_PER_COMPANY`                  |
| `--input <file>` | Feed a stage from a specific JSON file             |
| `--dry-run`      | Skip network stages (file-based stages still run)  |

### Final Output Shape

`outputs/contacts.json`:

```json
[
  {
    "companyDomain": "anthropic.com",
    "companyName": "Anthropic",
    "fullName": "Jane Doe",
    "title": "CEO",
    "email": "jane@anthropic.com",
    "linkedinUrl": "https://www.linkedin.com/in/janedoe"
  }
]
```

---

## DRY_RUN Safety

Sending email is guarded by `DRY_RUN`, which **defaults to `true`**.

- `DRY_RUN=true` (default) — the send stage logs the full email payload and
  writes a report, but makes **no** calls to Brevo.
- `DRY_RUN=false` — real emails are sent. This is the only configuration that
  contacts Brevo, and it additionally requires `BREVO_SENDER_EMAIL` to be set
  (or the send fails fast).

```bash
# Safe preview (no emails sent)
node src/app.js --stage send

# Real send (explicit opt-in)
DRY_RUN=false node src/app.js --stage send
```

Recommended: do a `DRY_RUN=true` pass and a single real send to your own
address before sending to real contacts.

---

## Error Handling

- **Fail fast vs. retry** — validation/auth/credit errors
  (`4xx`, e.g. `NO_MATCH`, `INVALID_DATAPOINTS`, `INSUFFICIENT_CREDITS`,
  `INVALID_API_KEY`) are surfaced immediately; only transient errors are retried.
- **Per-item resilience** — a failing company, person, batch, or contact is
  logged and skipped; the overall run continues.
- **Graceful empties** — empty results short-circuit the pipeline and still
  write a (possibly empty) `contacts.json`.
- **Clear errors** — each service maps provider responses to descriptive errors
  carrying the HTTP status and provider error code.

---

## Rate Limiting

- **Prospeo** — a shared limiter enforces both **1 request/second** and
  **20 requests/minute** across all Prospeo calls, with automatic waiting.
- **Ocean.io** — pagination is throttled (250 ms between pages) and bounded by a
  hard page ceiling and a finite result cap to protect credits.
- **Retries** — exponential backoff (`500ms → 1s → 2s`, max 3 attempts) on
  `429` and `5xx`.

---

## Future Improvements

- Live verification of a populated Prospeo `matched[]` enrichment (no
  enrichable contact existed in the test sample; schema is docs-confirmed).
- Persisted send history to suppress re-contacting across runs.
- Per-recipient template variants and A/B subject lines.
- Configurable filtering (seniority, department, country) at the search stage.
- Automated tests (unit + contract tests against recorded provider responses).
- Optional concurrency for enrichment within rate-limit budgets.

---

## Notes

This project intentionally favors **maintainability and safety** over raw speed:
modular services, a single config source, conservative credit/send defaults, and
independently resumable stages.
