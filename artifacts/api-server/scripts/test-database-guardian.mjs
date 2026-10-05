// Crash cleanup for the local API test cluster. Linux /proc start time also
// prevents a recycled PID from keeping abandoned test data alive indefinitely.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const [directory, owner] = process.argv.slice(2);
if (!directory || path.dirname(directory) !== os.tmpdir() ||
    !/^kokao-api-test-[0-9a-f-]{36}$/.test(path.basename(directory)) ||
    !/^\d+$/.test(owner)) process.exit(1);
function identity() {
  try {
    const stat = fs.readFileSync(`/proc/${owner}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return fields[0] === "Z" ? null : fields[19];
  } catch { return null; }
}
const initial = identity();
const timer = setInterval(() => {
  if (!fs.existsSync(directory)) { clearInterval(timer); return; }
  if (initial && identity() === initial) return;
  const data = path.join(directory, "data");
  try {
    if (fs.existsSync(path.join(data, "postmaster.pid"))) {
      execFileSync("pg_ctl", ["-D", data, "-m", "immediate", "-w", "stop"], { stdio: "ignore" });
    }
    fs.rmSync(directory, { recursive: true, force: true });
    clearInterval(timer);
  } catch {
    // Retry shutdown; don't delete a running cluster's files.
  }
}, 1000);
