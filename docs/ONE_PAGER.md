# EaseTax: core idea and data model

**Live:** https://easetax.onrender.com · Source: https://github.com/adityashah1603/EaseTax

## Core idea
The workpaper's job is to **prove the return is right**. Every number on the return should answer four questions in three clicks or fewer:

1. Where did it come from?
2. What was done to it?
3. Who checked it?
4. What is still open?

The app does not ask anyone to trust the tax engine or the extraction pipeline. Our own checks re-derive the numbers from the printed pages, the client's words and third-party records. Whatever disagrees becomes a work-queue item with a severity, a suggested fix and a link to its source.

## Data model: three layers
| Layer | What it is | Rule |
|---|---|---|
| **1. Baseline** | The packet exactly as delivered: documents and pages, extracted values, return versions v1–v3, prior year, related returns and firm standards | Read-only and hashed at start-up. Never modified |
| **2. Event log** | Every human action as an event: who, role, when, reason and payload (adjustments, corrections, verifications, issue closures, sign-offs, notes, questions, filing steps, undo) | Append-only SQLite. Undo is a compensating event |
| **3. Projections** | `WorkState`, rebuilt by replaying events over the baseline, plus a **provenance graph** with typed node ids (`line:v3:F2441.1b` → `ev:ev-1045` → `doc:D62#page1`) and the **issue list** (engine diagnostics plus 38 independent checks) | Derived, so it can always be rebuilt and replayed |

The original value is always the baseline, and a change is an event on top of it. That gives us history, undo, compare-versions and "what changed since I last looked" for free.

## Decisions that follow from it
- **The server enforces roles.** It checks every request against the acting user, and nobody signs off on their own work.
- **Sensitive data is masked when sent.** SSNs and account numbers are masked in every response. Unmasking needs a reason and is logged.
- **Sign-offs track content.** A sign-off covers a hash of the content in its scope, so any change reopens it.
- **Second confirmation for closing errors.** Closing an error needs a reason and a second person to confirm.
- **Filing freezes the return.** The filed return becomes a hashed snapshot, and later changes go through an amendment.

**Trade-off:** the free demo host (Render, SQLite in `/tmp`) wipes saved work whenever it redeploys or sleeps. On a real deployment the same event log would sit on a persistent disk or Postgres.
