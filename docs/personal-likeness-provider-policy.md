# Personal likeness and provider authorization

## Two layers

The attestation and the recipients are separate records, because they answer
separate questions and change on different schedules.

1. **Subject attestation** (`character_likeness_consent_grants`) — who is
   depicted, whose authority the submitter holds, and which of the three uses
   they authorize. Provider-independent: swapping Replicate for OpenRouter does
   not change who is in the photograph, so it must not invalidate a statement
   about them. Bound to the exact source bytes.
2. **Recipient disclosure ledger** (`character_likeness_recipient_disclosures`)
   — append-only, one row per (grant, provider, model, operation) the user has
   been shown and accepted. This is what keeps a provider-independent
   attestation an *informed* one, and it makes a newly configured provider cost
   one acknowledgement instead of a re-signature. Each recipient can be
   withdrawn on its own, without destroying an attestation that remains true.

The previous design welded the two together: the policy version hashed the
selected image-processor scope, so an admin changing the global image provider
marked every attestation in the system stale. `LIKENESS_CONSENT_POLICY_VERSION`
is now the version of the statement text and nothing else.

Provider-independent is not use-independent. Wardrobe editing, video depiction
and scripted speech stay separate permissions: permission to depict someone is
not permission to put words in their mouth.

## Subject classes

- `uploaded_self` and `uploaded_authorized_person` — a real, identifiable
  person. Hard gate: no recipient receives these bytes without a current,
  unrevoked grant and an acknowledged disclosure.
- `generated_fictional` — a photorealistic AI face depicting nobody real. There
  is no subject to attest for and the server creates generated cast with no user
  in the loop, so these are covered by a workspace-level standing declaration
  (`tenant_likeness_standing_declarations`) rather than a per-character
  signature. That declaration is also the evidence for the reverse argument when
  a provider's classifier flags an AI face as a possible real human.

  Recorded but not blocking by default, so deploying this does not brick
  existing workspaces mid-generation. Set
  `LIKENESS_STANDING_DECLARATION_ENFORCED=true` to make it a hard gate once
  workspaces have been prompted; the status is reported either way.

## Provider eligibility is declared, not discovered

`artifacts/api-server/src/lib/likenessProviderPolicy.ts` holds one reviewed
declaration per catalogued provider and surface. Two independent axes, because
several providers' input classifiers reject a generated face precisely because
they cannot tell it from a real one:

- `realLikeness` — a real, identifiable person.
- `generatedPhotorealistic` — an AI face depicting nobody real.

`undeclared` fails closed. `likenessProviderPolicy.test.ts` asserts
exhaustiveness against both provider registries, so adding a provider fails the
suite until somebody decides what it may receive.

Routing is checked **before** the attestation and before any funding is
reserved. A provider that will certainly refuse the image produces a fast,
explained failure instead of a paid rejection, and the user is never asked to
sign for a submission that could not have succeeded.

Operation-level refusals are subject-aware: Atlas Cloud's Asset Library is the
working home for generated fictional characters and must never receive a real
person, which is one declaration rather than two code paths.

## Policy basis

Reviewed against Atlas Cloud's public documentation on 2026-09-17:

- [Atlas legal terms](https://www.atlascloud.ai/privacy) require image rights/licenses and written consent for identifiable people. They also prohibit unlawful and unauthorized uses and misleading or abusive contributions.
- [Atlas acceptable use](https://www.atlascloud.ai/acceptable-use) sets additional content and service-use restrictions.
- [Wan 3.0 reference-to-video](https://www.atlascloud.ai/models/alibaba/wan-3.0/reference-to-video) documents reference media inputs. It does not document a likeness-consent token or a liveness-verification endpoint.
- [Wan 3.0 image-to-video](https://www.atlascloud.ai/models/alibaba/wan-3.0/image-to-video) is a different request contract. Supporting its input format does not automatically authorize every use of a personal image.

These sources do not certify KOKAO's legal compliance or guarantee that any particular submission will pass provider moderation. Recheck the applicable terms and model contract before enabling additional providers or model families.

## Separate claims

1. **Origin:** where the image came from. A personal face remains photo-derived when AI changes its outfit or body.
2. **Permission:** what the submitting user has expressly authorized, for which source image, processors, and uses.
3. **Provider verification:** any identity or rights-verification process performed by that particular provider.

An authorization declaration is not proof of identity. BytePlus verification is not an Atlas/Wan authorization token. Never describe a KOKAO consent record as provider-verified.

## Authorization requirements

- Limit this personal-character workflow to adults.
- For one's own likeness, collect express electronic permission and a declaration of image rights.
- For another person's likeness, require an explicit declaration that the user holds written permission covering the requested use. This records the user's declaration; it does not independently verify that agreement.
- Disclose recipients and separate wardrobe/image processing from video generation and scripted speech.
- Preserve the exact statement, version, source binding, scopes, actor, and grant time.
- Require new authorization when the source identity or authorized recipients change.
- Keep cloned-voice authorization separate; permission to depict someone speaking does not authorize cloning a voice.
- Withdrawal stops future submissions. It cannot recall an upstream request already sent or guarantee deletion of outputs already downloaded or published.

## Provider boundaries

Asset-library registration is a likeness submission like any other: the bytes
leave the process and the provider retains them under an id. It used to be the
one lane decided purely on whether a BytePlus identity row said "verified" —
the provider's check, not KOKAO's, leaving nothing behind if the provider ever
asked. Provider verification and KOKAO's rights record remain separate claims,
and having the first no longer stands in for the second.

Wan's direct-reference media flow is not Seedance's Asset Library. Permission for Wan must not register an uploaded likeness as a fictional Atlas asset, relax BytePlus requirements, enable an unknown provider, or authorize an undisclosed fallback recipient.

Check authorization before reserving video funding and again before each new provider submission, including retries and resumed jobs. Stored job permission references must remain bound to the grant originally accepted for that job, not silently switch to a later grant.

## Verification boundaries

Local automated tests can verify consent persistence, tenant isolation, revocation, exact-image binding, and dispatch rejection. They cannot establish that a provider will accept a real person's image or that a particular use satisfies every applicable law. Paid/live provider testing requires separate authorization and legitimate test permissions.