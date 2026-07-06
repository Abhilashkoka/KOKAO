---
name: Credential encryption key selection
description: How social-credential at-rest encryption picks and migrates keys, and why decrypt is dual-read.
---

# Credential encryption key selection (secretCrypto)

At-rest secrets (social credentials, app keys) are AES-256-GCM encrypted. Key
selection is asymmetric on purpose:

- **Encrypt** with `CREDENTIALS_ENCRYPTION_KEY` when set, otherwise `SESSION_SECRET`.
- **Decrypt** is DUAL-READ: try the dedicated key first, then fall back to
  `SESSION_SECRET`.

**Why:** the audit wanted a dedicated credential key decoupled from the
session/OAuth-state secret (so rotating `SESSION_SECRET` can't brick stored
creds). A naive single-key switch would fail to decrypt everything already stored
under `SESSION_SECRET` the moment the dedicated key is enabled — a tenant-wide
credential outage. Dual-read decrypt avoids that: old payloads stay readable via
the fallback and get re-encrypted under the dedicated key on their next write.

**How to apply:** never make decrypt single-key. If you add a new key source or
rotate keys, add it to the candidate list (highest priority first) so both old
and new payloads decrypt during the migration window. Payloads are wire-versioned
`v1:iv:tag:ciphertext` (base64, no `:` collision); legacy unprefixed payloads
still parse. Fail closed when no key material exists.
