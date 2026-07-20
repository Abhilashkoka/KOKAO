// Temporary Meta Marketing (Ads) Graph API mock for browser e2e runs.
// Persists its request log and mutable campaign state to /tmp so workflow
// restarts around test runs don't lose evidence or state.
import http from "node:http";
import fs from "node:fs";

const LOG_FILE = "/tmp/meta-ads-mock-log.json";
const STATE_FILE = "/tmp/meta-ads-mock-state.json";

let log = [];
try {
  log = JSON.parse(fs.readFileSync(LOG_FILE, "utf8"));
} catch {}

const DEFAULT_STATE = {
  nextId: 120000000000002,
  adAccounts: [
    {
      id: "act_777001",
      account_id: "777001",
      name: "KOKAO Test Ad Account",
      currency: "USD",
      account_status: 1,
    },
  ],
  campaigns: {
    "120000000000001": {
      id: "120000000000001",
      account: "act_777001",
      name: "Summer Sale",
      status: "PAUSED",
      objective: "OUTCOME_TRAFFIC",
      daily_budget: "5000",
      lifetime_budget: null,
      start_time: null,
      stop_time: null,
    },
  },
  adSets: {
    "130000000000001": {
      id: "130000000000001",
      campaign: "120000000000001",
      name: "Summer Sale - Prospecting",
      status: "PAUSED",
      daily_budget: "2000",
      lifetime_budget: null,
      start_time: "2026-07-01T00:00:00+0000",
      end_time: "2026-07-31T00:00:00+0000",
    },
  },
};

let state;
try {
  state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  if (!state.adSets) state.adSets = structuredClone(DEFAULT_STATE.adSets);
} catch {
  state = structuredClone(DEFAULT_STATE);
}

function saveState() {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}
function record(entry) {
  log.push({ ...entry, at: new Date().toISOString() });
  fs.writeFileSync(LOG_FILE, JSON.stringify(log, null, 2));
}

function campaignFields(c) {
  return {
    id: c.id,
    name: c.name,
    status: c.status,
    effective_status: c.status,
    objective: c.objective,
    daily_budget: c.daily_budget ?? undefined,
    lifetime_budget: c.lifetime_budget ?? undefined,
    start_time: c.start_time ?? undefined,
    stop_time: c.stop_time ?? undefined,
  };
}

function adSetFields(s) {
  return {
    id: s.id,
    name: s.name,
    status: s.status,
    effective_status: s.status,
    daily_budget: s.daily_budget ?? undefined,
    lifetime_budget: s.lifetime_budget ?? undefined,
    start_time: s.start_time ?? undefined,
    end_time: s.end_time ?? undefined,
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  let body = "";
  for await (const chunk of req) body += chunk;
  const params = new URLSearchParams(body);
  // Strip a leading slash; the API server appends paths like `me/adaccounts`.
  const path = url.pathname.replace(/^\/+/, "");

  const send = (obj, status = 200) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(obj));
  };

  if (req.method === "GET" && path === "me/adaccounts") {
    record({ method: "GET", path, kind: "list_adaccounts" });
    return send({ data: state.adAccounts });
  }

  // Insights: <act_id>/insights
  if (req.method === "GET" && /\/insights$/.test(path)) {
    const level = url.searchParams.get("level") || "campaign";
    record({ method: "GET", path, kind: "insights", level });
    if (level !== "campaign") return send({ data: [] });
    // Delivery only for the seeded campaign.
    const seeded = state.campaigns["120000000000001"];
    if (!seeded) return send({ data: [] });
    return send({
      data: [
        {
          campaign_id: seeded.id,
          impressions: "12345",
          clicks: "678",
          ctr: "5.49",
          spend: "42.5",
          actions: [{ action_type: "link_click", value: "678" }],
        },
      ],
    });
  }

  // <act_id>/campaigns
  const campListMatch = path.match(/^(act_\d+)\/campaigns$/);
  if (campListMatch) {
    const account = campListMatch[1];
    if (req.method === "GET") {
      record({ method: "GET", path, kind: "list_campaigns" });
      return send({
        data: Object.values(state.campaigns)
          .filter((c) => c.account === account)
          .map(campaignFields),
      });
    }
    if (req.method === "POST") {
      const id = String(state.nextId++);
      state.campaigns[id] = {
        id,
        account,
        name: params.get("name") || "Untitled",
        status: params.get("status") || "PAUSED",
        objective: params.get("objective") || "OUTCOME_TRAFFIC",
        daily_budget: params.get("daily_budget"),
        lifetime_budget: params.get("lifetime_budget"),
        start_time: params.get("start_time"),
        stop_time: params.get("stop_time"),
      };
      saveState();
      record({
        method: "POST",
        path,
        kind: "create_campaign",
        id,
        name: params.get("name"),
        status: params.get("status"),
        daily_budget: params.get("daily_budget"),
      });
      return send({ id });
    }
  }

  // <id>/adsets and <id>/ads
  if (req.method === "GET" && /\/adsets$/.test(path)) {
    const campaignId = path.split("/")[0];
    record({ method: "GET", path, kind: "list_adsets" });
    return send({
      data: Object.values(state.adSets)
        .filter((s) => s.campaign === campaignId)
        .map(adSetFields),
    });
  }
  if (req.method === "GET" && /\/ads$/.test(path)) {
    record({ method: "GET", path, kind: "list_ads" });
    return send({ data: [] });
  }

  // Single object reads: ad account or campaign
  if (req.method === "GET" && /^act_\d+$/.test(path)) {
    record({ method: "GET", path, kind: "read_adaccount" });
    const acct = state.adAccounts.find((a) => a.id === path);
    if (!acct) {
      return send({ error: { message: "Unknown ad account", code: 100 } }, 404);
    }
    return send({ id: acct.id, name: acct.name, currency: acct.currency });
  }
  if (req.method === "GET" && /^\d+$/.test(path)) {
    record({ method: "GET", path, kind: "read_object" });
    const s = state.adSets[path];
    if (s) return send(adSetFields(s));
    const c = state.campaigns[path];
    if (!c) return send({ error: { message: "Unknown object", code: 100 } }, 404);
    return send(campaignFields(c));
  }

  // Update object: POST <id>
  if (req.method === "POST" && /^\d+$/.test(path)) {
    const s = state.adSets[path];
    if (s) {
      const changed = {};
      for (const key of [
        "name",
        "status",
        "daily_budget",
        "lifetime_budget",
        "start_time",
        "end_time",
      ]) {
        const v = params.get(key);
        if (v != null) {
          s[key] = v;
          changed[key] = v;
        }
      }
      saveState();
      record({ method: "POST", path, kind: "update_adset", changed });
      return send({ success: true });
    }
    const c = state.campaigns[path];
    if (!c) return send({ error: { message: "Unknown object", code: 100 } }, 404);
    const changed = {};
    for (const key of [
      "name",
      "status",
      "daily_budget",
      "lifetime_budget",
      "start_time",
      "stop_time",
    ]) {
      const v = params.get(key);
      if (v != null) {
        c[key] = v;
        changed[key] = v;
      }
    }
    saveState();
    record({ method: "POST", path, kind: "update_object", changed });
    return send({ success: true });
  }

  record({ method: req.method, path, kind: "unknown" });
  send({ data: [] });
});

const port = Number(process.env.PORT || 9099);
server.listen(port, "0.0.0.0", () => {
  console.log(
    `meta ads mock listening on ${port}, log ${LOG_FILE}, state ${STATE_FILE}`,
  );
});
