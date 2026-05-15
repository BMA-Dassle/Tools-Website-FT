# Architecture Decision Records

This directory holds the durable architecture decisions that shape FastTrax
Tools. ADRs are written when a choice constrains future work — anything
load-bearing for the structure of the codebase, deploy model, or vendor
contract.

## When to write an ADR

- A new structural convention (folder layout, naming, module boundaries)
- A vendor / SaaS / library choice that's hard to reverse
- A deploy or infrastructure decision (hosting, CI, monorepo tooling)
- Any decision overriding a previous ADR — supersede it; don't edit the old
  ADR in place

Routine code choices (which date library, which utility helper, etc.) do NOT
need an ADR.

## Format

One file per decision: `NNNN-kebab-case-title.md`. Use the template at
[0000-template.md](0000-template.md). Sections:

- **Status** — Proposed / Accepted / Superseded by NNNN
- **Context** — What's the situation that forced a choice
- **Decision** — What we picked, in one or two sentences
- **Consequences** — What this enables, what it costs, what becomes harder

## Index

| #    | Title                                      | Status   |
| ---- | ------------------------------------------ | -------- |
| 0000 | Template                                   | n/a      |
| 0001 | npm workspaces + Turborepo (replaces pnpm) | Accepted |
