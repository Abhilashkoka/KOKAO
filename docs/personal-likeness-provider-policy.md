# Personal likeness and provider authorization

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

Wan's direct-reference media flow is not Seedance's Asset Library. Permission for Wan must not register an uploaded likeness as a fictional Atlas asset, relax BytePlus requirements, enable an unknown provider, or authorize an undisclosed fallback recipient.

Check authorization before reserving video funding and again before each new provider submission, including retries and resumed jobs. Stored job permission references must remain bound to the grant originally accepted for that job, not silently switch to a later grant.

## Verification boundaries

Local automated tests can verify consent persistence, tenant isolation, revocation, exact-image binding, and dispatch rejection. They cannot establish that a provider will accept a real person's image or that a particular use satisfies every applicable law. Paid/live provider testing requires separate authorization and legitimate test permissions.