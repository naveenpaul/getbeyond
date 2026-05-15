# getbeyond

**Open-source AI GTM teammates for solo founders.** Audit every prompt, every claim, every source — in code and in the app.

> Status: pre-launch. v1 in active development. See `../gtm_teammates_plan.md` for the full plan.

---

## What it is

A platform where solo founders run their GTM with **multiple AI teammates** under one runtime, each owning a workflow, all reading from a shared **Company Brain** (ICP, voice, offer, past wins, current pipeline). The form factor matches the customer: solo founders can't buy five point tools, so we ship the bundle.

**v1 teammates:**

- **Researcher** — "tell me about this company/person" with cited sources
- **SDR Drafter** — outbound emails + LinkedIn DMs (drafts only, never auto-send)
- **Content Drafter** — LinkedIn/Twitter posts in your voice

**v1 data sources:** HubSpot, Salesforce, Apollo, ZoomInfo, CSV upload.
**v1 actions:** send via Gmail/Resend/Smartlead, post to LinkedIn/Twitter, log activity back to HubSpot/Salesforce.

## Why it exists

The AI SDR category is in trust collapse — 50-70% churn, hallucination is the killer. Closed-source tools have no way to prove they're not making things up. We do: every claim a teammate writes has a citation, the runtime drops uncited claims at synthesis time, and the prompts are AGPLv3 — you can read them.

## Quickstart (self-host)

```bash
# Clone
git clone https://github.com/getbeyond/getbeyond.git
cd getbeyond

# Configure
cp .env.example .env
# Edit .env — fill ANTHROPIC_API_KEY, BRAVE_SEARCH_API_KEY, etc.

# Bring up Postgres + MinIO
docker compose up -d

# Install deps and run
pnpm install
pnpm dev
```

Then open `http://localhost:3001` and follow the onboarding.

## One-click deploy to a server

```bash
# Agent-runnable installer (Claude Code, Codex, or any agent that can SSH)
# See deploy/Deployfile.md
```

Under 5 minutes from `ssh root@<ip>` to a working `/login` page, zero manual file editing.

## License

[AGPL-3.0-or-later](./LICENSE) for the platform. MIT for SDKs / clients / Chrome extension.

The trust positioning depends on readers being able to audit the prompts and tool scopes — AGPLv3 is the strongest license that protects against closed-source forks running our prompts in a black box. If you're embedding into a closed-source commercial product and AGPLv3 doesn't fit, talk to us.

## Contributing

The adapter architecture is designed so adding a new contact source or write-back destination is **one file, one registry line, zero changes elsewhere**. If your CRM / outreach tool / data vendor isn't listed, write the adapter and open a PR.

See `docs/CONTRIBUTING.md` (landing in Phase B).

## Project state

The full plan, including architecture decisions, eng review history, and the implementation task list, lives at `../gtm_teammates_plan.md`. Open decisions and deferred work are in `../TODOS.md`.
