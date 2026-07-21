// Temporary Threads Graph API mock for browser e2e runs.
// Persists its request log to /tmp/threads-mock-log.json so workflow
// restarts around test runs don't lose the evidence.
import http from "node:http";
import fs from "node:fs";

const LOG_FILE = "/tmp/threads-mock-log.json";
let log = [];
try {
  log = JSON.parse(fs.readFileSync(LOG_FILE, "utf8"));
} catch {}

function record(entry) {
  log.push({ ...entry, at: new Date().toISOString() });
  fs.writeFileSync(LOG_FILE, JSON.stringify(log, null, 2));
}

let nextId = 90000;

// Outage mode: while enabled, publish endpoints return 500 so publish cores
// classify the failure as a transient platform outage (errorStatus 503).
// Toggle via POST /__control {"outage": true|false}. Persisted so workflow
// restarts around test runs don't silently clear it.
const STATE_FILE = "/tmp/threads-mock-state.json";
let outage = false;
try {
  outage = !!JSON.parse(fs.readFileSync(STATE_FILE, "utf8")).outage;
} catch {}
function saveState() {
  fs.writeFileSync(STATE_FILE, JSON.stringify({ outage }));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  let body = "";
  for await (const chunk of req) body += chunk;
  const params = new URLSearchParams(body);
  const path = url.pathname;

  const send = (obj) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(obj));
  };

  if (req.method === "POST" && path === "/__control") {
    try {
      const ctl = JSON.parse(body);
      if (typeof ctl.outage === "boolean") outage = ctl.outage;
      saveState();
    } catch {}
    record({ method: "POST", path, kind: "control", outage });
    return send({ ok: true, outage });
  }

  if (req.method === "GET" && path === "/me") {
    record({ method: "GET", path });
    return send({ id: "mock-threads-user", username: "mockuser" });
  }
  if (req.method === "GET" && /\/threads$/.test(path)) {
    record({ method: "GET", path, kind: "probe" });
    return send({ data: [] });
  }
  if (req.method === "POST" && /\/threads$/.test(path)) {
    const id = `container-${nextId++}`;
    record({
      method: "POST",
      path,
      kind: "create",
      text: params.get("text") || url.searchParams.get("text") || null,
      id,
    });
    return send({ id });
  }
  if (req.method === "POST" && /\/threads_publish$/.test(path)) {
    if (outage) {
      record({ method: "POST", path, kind: "publish-outage-500" });
      res.writeHead(500, { "content-type": "application/json" });
      return res.end(
        JSON.stringify({ error: { message: "Service temporarily unavailable" } }),
      );
    }
    const id = `post-${nextId++}`;
    // Artificial delay so the UI's in-flight disabled state is observable.
    await new Promise((r) => setTimeout(r, 2500));
    record({ method: "POST", path, kind: "publish", id });
    return send({ id });
  }
  record({ method: req.method, path, kind: "unknown" });
  send({ data: [] });
});

const port = Number(process.env.PORT || 9000);
server.listen(port, "0.0.0.0", () => {
  console.log(`threads mock listening on ${port}, log at ${LOG_FILE}`);
});
