// Stub for @clerk/expo's native module specs when running in Expo Go.
// Expo Go does not bundle Clerk's "ClerkExpo" native module, and the Android
// spec files call requireNativeModule() (which throws) instead of
// requireOptionalNativeModule(). @clerk/expo handles a null module fine and
// falls back to its pure-JS implementation, so we resolve those specs to null.
// If you switch to a custom development build that includes Clerk's native
// module, remove this stub and the matching resolver in metro.config.js.
module.exports = null;
