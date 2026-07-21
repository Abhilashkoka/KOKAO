// Minimal Expo push API mock for e2e verification of push receipt handling.
// - POST /--/api/v2/push/send      -> ok tickets for every message
// - POST /--/api/v2/push/getReceipts -> DeviceNotRegistered receipt for every id
// Persists a request log to /tmp/expo-push-mock-log.json (reloaded on boot)
// so evidence survives workflow restarts around test runs.
import http from "node:http";
import fs from "node:fs";

const LOG_FILE = "/tmp/expo-push-mock-log.json";
const PORT = Number(process.env.PORT || 9096);

let log = [];
try {
  log = JSON.parse(fs.readFileSync(LOG_FILE, "utf8"));
  if (!Array.isArray(log)) log = [];
} catch {
  log = [];
}

function record(entry) {
  log.push({ at: new Date().toISOString(), ...entry });
  try {
    fs.writeFileSync(LOG_FILE, JSON.stringify(log, null, 2));
  } catch {}
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(data || "{}"));
      } catch {
        resolve({});
      }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const url = req.url || "";
  if (req.method === "GET" && url.startsWith("/__log")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(log, null, 2));
    return;
  }
  if (req.method === "POST" && url.startsWith("/--/api/v2/push/getReceipts")) {
    const body = await readBody(req);
    const ids = Array.isArray(body.ids) ? body.ids : [];
    record({ endpoint: "getReceipts", ids });
    const data = {};
    for (const id of ids) {
      data[id] = {
        status: "error",
        message: "The device is not registered.",
        details: { error: "DeviceNotRegistered" },
      };
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ data }));
    return;
  }
  if (req.method === "POST" && url.startsWith("/--/api/v2/push/send")) {
    const body = await readBody(req);
    const messages = Array.isArray(body) ? body : [body];
    record({ endpoint: "send", count: messages.length, messages });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        data: messages.map((_, i) => ({
          status: "ok",
          id: `mock-ticket-${Date.now()}-${i}`,
        })),
      }),
    );
    return;
  }
  record({ endpoint: "unknown", method: req.method, url });
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ errors: [{ message: "not found" }] }));
});

server.listen(PORT, () => {
  console.log(`Expo push mock listening on ${PORT}, log at ${LOG_FILE}`);
});
