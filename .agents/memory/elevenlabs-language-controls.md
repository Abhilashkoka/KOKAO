---
name: ElevenLabs language controls
description: Model-specific rules for explicit language selection in ElevenLabs speech.
---

Do not send `language_code` blindly to ElevenLabs speech models. `eleven_multilingual_v2` does not support that request field and must auto-detect from native-script text; it supports Hindi and Tamil but not Telugu. Guided Story uses `eleven_v3` when explicit English, Hindi, Tamil, or Telugu language control is required.

**Why:** ElevenLabs' current Create Speech documentation explicitly says `language_code` is unsupported for multilingual v2. Treating all multilingual models alike can turn valid localized narration into a paid provider failure.

**How to apply:** Keep model/language capabilities centralized, validate before wallet reservation or provider dispatch, send the field only for a compatible model, and include the frozen locale in durable TTS operation identity even when transport uses auto-detection.