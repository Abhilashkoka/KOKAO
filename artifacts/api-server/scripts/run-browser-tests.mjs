import { build } from "esbuild";
import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createRequire, isBuiltin } from "node:module";
import path from "node:path";

// Put the bundle next to test-database.ts so its import.meta.url stays correct.
const output = fileURLToPath(new URL(`../src/.browser-test-${randomUUID()}.mjs`, import.meta.url));
let child;
try {
  await build({
    entryPoints: [fileURLToPath(new URL("./browser-test-runtime.ts", import.meta.url))],
    outfile: output, bundle: true, platform: "node", format: "esm",
    packages: "external", logLevel: "warning",
    // Workspace libraries are TS source and must be included in this bundle.
    plugins: [{
      name: "workspace-source",
      setup(builder) {
        builder.onResolve({ filter: /^[^./]/ }, (args) => {
          if (isBuiltin(args.path)) return { path: args.path, external: true };
          return {
            path: createRequire(path.join(args.resolveDir, "package.json")).resolve(args.path),
            external: !args.path.startsWith("@workspace/"),
          };
        });
      },
    }],
  });
  child = spawn(process.execPath, [output, ...process.argv.slice(2)], { stdio: "inherit" });
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
  process.exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
} finally {
  await rm(output, { force: true });
}
