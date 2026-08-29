---
name: Job error identifiers
description: Convention for making generation errors traceable to their saved jobs.
---

Include the relevant job number in user-facing error messages whenever the error is associated with a persisted job.

**Why:** The user needs to identify, discuss, and investigate the exact failed job without searching by message text or timestamps.

**How to apply:** When rendering or creating an error for a known job, include a clear label such as “Job #12345”. Do not invent an identifier for failures that occur before a job exists.