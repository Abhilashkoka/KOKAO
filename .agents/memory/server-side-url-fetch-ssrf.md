---
name: Server-side URL fetch SSRF guard
description: Any endpoint that fetches a user-supplied URL server-side must be SSRF-hardened; the non-obvious gap is IPv6.
---

# Server-side URL fetch must be SSRF-hardened

Any feature that takes a user-supplied URL and fetches it from the server (e.g. "summarize this article URL") is an SSRF sink. A plain `fetch(userUrl)` lets a tenant reach internal services, cloud metadata (`169.254.169.254`), and loopback.

**Rule:** before fetching, resolve the host and block private/loopback/link-local/CGNAT/multicast/reserved IPs; block `localhost`/`.local`/`.internal`; follow redirects manually and re-validate the host on every hop; stream + cap the response body; allowlist content-type; clear the timeout in `finally`. Fail closed on any parse/resolve error.

**Why:** the architect review flagged this as a blocking issue twice. The first naive denylist passed an obvious case but had a real bypass.

**The non-obvious bypass — IPv6-mapped IPv4.** A substring check like `ip.startsWith("::ffff:")` only catches the *dotted-quad* mapped form (`::ffff:127.0.0.1`). It misses the equivalent hex/expanded forms that resolve to the same address: `::ffff:7f00:1`, `0:0:0:0:0:ffff:7f00:1`. Those bypass naive checks and can still reach loopback/private targets. The fix is to canonicalize IPv6 to a 16-byte array, detect IPv4-mapped (`::ffff:0:0/96`) and IPv4-compatible (`::/96`) ranges, and delegate the embedded IPv4 to the IPv4 range checks — don't pattern-match on the string. Also strip `[...]` brackets from IPv6 URL hostnames (`new URL(...).hostname` keeps them) before `net.isIP`.

**How to apply:** see `assertPublicHost` / `ipv6ToBytes` / `safeFetch` in `artifacts/api-server/src/routes/ai.ts` for a working reference. Residual DNS-rebinding TOCTOU (validate-then-fetch resolves twice) is accepted there given the short timeout + small body cap; tighten with IP-pinned connect or an egress proxy if the threat model demands it.
