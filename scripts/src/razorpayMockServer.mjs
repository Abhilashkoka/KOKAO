// Minimal stateful Razorpay API mock for browser e2e runs.
// Honors: GET /payments (credential test), POST /orders, GET /orders/:id,
// POST /subscriptions, GET /subscriptions/:id, POST /plans.
// Persists state + request log to /tmp so workflow restarts don't lose evidence.
import http from "node:http";
import fs from "node:fs";

const STATE_FILE = "/tmp/razorpay-mock-state.json";
const LOG_FILE = "/tmp/razorpay-mock-log.json";

function load(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}
const state = load(STATE_FILE, { orders: {}, subscriptions: {}, seq: 1 });
const log = load(LOG_FILE, []);
function persist() {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state));
  fs.writeFileSync(LOG_FILE, JSON.stringify(log));
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const path = url.pathname.replace(/\/+$/, "");
  const body = await readBody(req);
  log.push({ ts: new Date().toISOString(), method: req.method, path, body });

  function json(status, payload) {
    persist();
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(payload));
  }

  if (req.method === "GET" && path === "/payments") {
    return json(200, { entity: "collection", count: 0, items: [] });
  }
  if (req.method === "POST" && path === "/orders") {
    const id = `order_MOCK${String(state.seq++).padStart(8, "0")}`;
    const order = {
      id,
      entity: "order",
      amount: body.amount,
      currency: body.currency ?? "INR",
      receipt: body.receipt,
      status: "created",
      notes: body.notes ?? {},
    };
    state.orders[id] = order;
    return json(200, order);
  }
  if (req.method === "GET" && path.startsWith("/orders/")) {
    const order = state.orders[path.slice("/orders/".length)];
    if (!order) return json(404, { error: { description: "order not found" } });
    return json(200, order);
  }
  if (req.method === "POST" && path === "/plans") {
    const id = `plan_MOCK${String(state.seq++).padStart(8, "0")}`;
    return json(200, { id, entity: "plan", item: body.item });
  }
  if (req.method === "POST" && path === "/subscriptions") {
    const id = `sub_MOCK${String(state.seq++).padStart(8, "0")}`;
    const sub = {
      id,
      entity: "subscription",
      plan_id: body.plan_id,
      status: "created",
      current_end: null,
      notes: body.notes ?? {},
    };
    state.subscriptions[id] = sub;
    return json(200, sub);
  }
  if (req.method === "GET" && path.startsWith("/subscriptions/")) {
    const sub = state.subscriptions[path.slice("/subscriptions/".length)];
    if (!sub) return json(404, { error: { description: "subscription not found" } });
    return json(200, sub);
  }
  return json(404, { error: { description: `no mock for ${req.method} ${path}` } });
});

const port = Number(process.env.PORT || 9095);
server.listen(port, () => {
  console.log(`razorpay mock listening on ${port}`);
});
