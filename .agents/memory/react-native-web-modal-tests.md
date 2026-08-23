---
name: React Native Web modal tests
description: How to verify that an animated React Native Web modal closed under jsdom.
---

React Native Web modals with fade or slide exit animations can keep their children mounted in jsdom after `visible` becomes false. Verify closure by walking from modal content to an ancestor whose computed `pointer-events` is `none`, rather than expecting text queries to return null.

**Why:** jsdom does not emit the animation-end event that React Native Web uses to unmount the exiting modal layer, so presence-only assertions report a false failure even though the modal is closed and non-interactive.

**How to apply:** In jsdom component tests for animated React Native Web modals, use `window.getComputedStyle` on content ancestors and assert the shared non-interactive exit state. Do not depend on generated class names or fade-specific opacity because slide exits differ.