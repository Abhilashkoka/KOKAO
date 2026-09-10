---
name: Unified credit rollout
description: Safety and accounting rules for replacing separate quotas with one credit balance.
---

The unified-credit system must start in shadow mode. Meter provider calls where spend occurs, including retries and paid failures, and reconcile those totals against provider invoices before enabling enforcement.

**Why:** Route-level quota reservations miss provider work performed deep inside generation pipelines. Charging from an unreconciled rate card can undercharge customers, lose money, or debit inconsistently.

**How to apply:** Keep purchased credits non-expiring and granted credits expiring, spend granted credits first, snapshot rate-card debits with stable operation keys, and only switch to enforce after every material provider path is metered and invoice totals reconcile.