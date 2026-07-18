const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

const config = getDefaultConfig(__dirname);

// Expo Go does not include @clerk/expo's "ClerkExpo" native module. The
// package's Android spec files use requireNativeModule(), which throws
// ("Cannot find native module 'ClerkExpo'") instead of returning null like
// the iOS/web variants do. Clerk falls back to pure JS when the module is
// null, so redirect those specs to a null stub. Remove this (and the stub in
// lib/clerkNativeModuleStub.js) if you move to a development build that
// bundles Clerk's native module.
const CLERK_NATIVE_SPECS = /specs\/(NativeClerkModule|NativeClerkGoogleSignIn)$/;

const defaultResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (platform === "android" && CLERK_NATIVE_SPECS.test(moduleName)) {
    return {
      type: "sourceFile",
      filePath: path.resolve(__dirname, "lib/clerkNativeModuleStub.js"),
    };
  }
  if (defaultResolveRequest) {
    return defaultResolveRequest(context, moduleName, platform);
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
