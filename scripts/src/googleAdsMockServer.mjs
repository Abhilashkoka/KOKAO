// Temporary Google Ads API mock for browser e2e runs.
// Covers: OAuth authorize redirect, token endpoint (code exchange + refresh,
// with a revocable refresh token), customer discovery incl. an MCC hierarchy,
// GAQL search for customers/campaigns/ad groups/ads, and campaign/budget
// mutates. Persists request log and mutable state to /tmp so workflow
// restarts around test runs don't lose evidence or state.
import http from "node:http";
import fs from "node:fs";

const LOG_FILE = "/tmp/google-ads-mock-log.json";
const STATE_FILE = "/tmp/google-ads-mock-state.json";

const MCC_ID = "9990001";
const CLIENT_ID = "9990002";
const REFRESH_TOKEN = "mock-google-refresh-token";

let log = [];
try {
  log = JSON.parse(fs.readFileSync(LOG_FILE, "utf8"));
} catch {}

const DEFAULT_STATE = {
  revoked: false,
  nextId: 555000002,
  nextBudgetId: 777000001,
  // budgets keyed by resource name
  budgets: {
    [`customers/${CLIENT_ID}/campaignBudgets/777000000`]: {
      resourceName: `customers/${CLIENT_ID}/campaignBudgets/777000000`,
      amountMicros: "50000000", // 50 USD/day = 5000 minor units
    },
  },
  campaigns: {
    555000001: {
      id: "555000001",
      customer: CLIENT_ID,
      name: "Sunrise Search Launch",
      status: "ENABLED",
      advertisingChannelType: "SEARCH",
      startDate: "2026-06-01",
      endDate: "",
      campaignBudget: `customers/${CLIENT_ID}/campaignBudgets/777000000`,
      metrics: {
        impressions: "24680",
        clicks: "1357",
        ctr: 0.055, // fraction; app renders ×100 = 5.5%
        costMicros: "87500000", // $87.50
        conversions: 42,
      },
    },
  },
  adGroups: {
    666000001: {
      id: "666000001",
      customer: CLIENT_ID,
      campaignId: "555000001",
      name: "Morning Pastries",
      status: "ENABLED",
      cpcBidMicros: "2500000", // $2.50 default max CPC = 250 minor units
      metrics: {
        impressions: "12000",
        clicks: "640",
        ctr: 0.053,
        costMicros: "41000000",
        conversions: 20,
      },
    },
  },
  ads: {
    888000001: {
      id: "888000001",
      customer: CLIENT_ID,
      campaignId: "555000001",
      adGroupId: "666000001",
      name: "Fresh Croissants RSA",
      status: "ENABLED",
      metrics: {
        impressions: "9000",
        clicks: "480",
        ctr: 0.053,
        costMicros: "30000000",
        conversions: 15,
      },
    },
  },
};

let state;
try {
  state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
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

function campaignRow(c, withMetrics = true) {
  const budget = state.budgets[c.campaignBudget];
  const row = {
    campaign: {
      id: c.id,
      name: c.name,
      status: c.status,
      advertisingChannelType: c.advertisingChannelType,
      startDate: c.startDate || undefined,
      endDate: c.endDate || undefined,
      campaignBudget: c.campaignBudget,
    },
    campaignBudget: budget
      ? { resourceName: budget.resourceName, amountMicros: budget.amountMicros }
      : undefined,
  };
  if (withMetrics && c.metrics) row.metrics = c.metrics;
  return row;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  let raw = "";
  for await (const chunk of req) raw += chunk;

  const send = (obj, status = 200) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(obj));
  };

  const headers = {
    authorization: req.headers.authorization ? "present" : "missing",
    developerToken: req.headers["developer-token"] ?? null,
    loginCustomerId: req.headers["login-customer-id"] ?? null,
  };

  // --- Control endpoints -------------------------------------------------
  if (url.pathname === "/__control/revoke") {
    state.revoked = true;
    saveState();
    record({ kind: "control_revoke" });
    return send({ ok: true, revoked: true });
  }
  if (url.pathname === "/__control/restore") {
    state.revoked = false;
    saveState();
    record({ kind: "control_restore" });
    return send({ ok: true, revoked: false });
  }
  if (url.pathname === "/__control/log") {
    return send(log);
  }

  // --- OAuth authorize: immediately grant and bounce back ----------------
  if (req.method === "GET" && url.pathname === "/authorize") {
    const redirectUri = url.searchParams.get("redirect_uri") || "";
    const stateParam = url.searchParams.get("state") || "";
    record({
      kind: "authorize",
      scope: url.searchParams.get("scope"),
      accessType: url.searchParams.get("access_type"),
      prompt: url.searchParams.get("prompt"),
    });
    const target = `${redirectUri}?code=mock-auth-code&state=${encodeURIComponent(stateParam)}`;
    res.writeHead(302, { location: target });
    return res.end();
  }

  // --- OAuth token endpoint ----------------------------------------------
  if (req.method === "POST" && url.pathname === "/token") {
    const params = new URLSearchParams(raw);
    const grant = params.get("grant_type");
    record({ kind: "token", grant });
    if (grant === "authorization_code") {
      state.revoked = false;
      saveState();
      // expires_in below the 60s refresh slack so every API call refreshes,
      // making revocation take effect immediately.
      return send({
        access_token: `mock-access-${Date.now()}`,
        refresh_token: REFRESH_TOKEN,
        expires_in: 30,
        token_type: "Bearer",
      });
    }
    if (grant === "refresh_token") {
      if (state.revoked || params.get("refresh_token") !== REFRESH_TOKEN) {
        return send(
          { error: "invalid_grant", error_description: "Token has been revoked." },
          400,
        );
      }
      return send({
        access_token: `mock-access-${Date.now()}`,
        expires_in: 30,
        token_type: "Bearer",
      });
    }
    return send({ error: "unsupported_grant_type" }, 400);
  }

  // --- Google Ads REST API ------------------------------------------------
  // listAccessibleCustomers: only the MCC is directly accessible.
  if (/\/customers:listAccessibleCustomers$/.test(url.pathname)) {
    record({ kind: "list_accessible_customers", headers });
    return send({ resourceNames: [`customers/${MCC_ID}`] });
  }

  // GAQL search
  const searchMatch = url.pathname.match(/\/customers\/(\d+)\/googleAds:search$/);
  if (searchMatch && req.method === "POST") {
    const customerId = searchMatch[1];
    let query = "";
    try {
      query = JSON.parse(raw).query || "";
    } catch {}

    if (query.includes("FROM customer_client")) {
      record({ kind: "search_customer_client", customerId, headers });
      if (customerId !== MCC_ID) return send({ results: [] });
      return send({
        results: [
          {
            customerClient: {
              id: MCC_ID,
              descriptiveName: "KOKAO Manager (MCC)",
              currencyCode: "USD",
              manager: true,
              level: "0",
              status: "ENABLED",
            },
          },
          {
            customerClient: {
              id: CLIENT_ID,
              descriptiveName: "Sunrise Bakery Ads",
              currencyCode: "USD",
              manager: false,
              level: "1",
              status: "ENABLED",
            },
          },
        ],
      });
    }

    if (query.includes("FROM customer")) {
      record({ kind: "search_customer", customerId, headers });
      if (customerId !== CLIENT_ID) {
        return send(
          { error: { code: 403, message: "Unknown customer", status: "PERMISSION_DENIED" } },
          403,
        );
      }
      return send({
        results: [
          {
            customer: {
              id: CLIENT_ID,
              descriptiveName: "Sunrise Bakery Ads",
              currencyCode: "USD",
            },
          },
        ],
      });
    }

    if (query.includes("FROM campaign")) {
      const idMatch = query.match(/campaign\.id = (\d+)/);
      record({
        kind: "search_campaign",
        customerId,
        campaignId: idMatch?.[1] ?? null,
        headers,
      });
      let list = Object.values(state.campaigns).filter(
        (c) => c.customer === customerId,
      );
      if (idMatch) list = list.filter((c) => c.id === idMatch[1]);
      const withMetrics = query.includes("metrics.");
      return send({ results: list.map((c) => campaignRow(c, withMetrics)) });
    }

    if (query.includes("FROM ad_group_ad")) {
      const campMatchQ = query.match(/campaign\.id = (\d+)/);
      const adIdMatch = query.match(/ad_group_ad\.ad\.id = (\d+)/);
      record({
        kind: "search_ads",
        customerId,
        campaignId: campMatchQ?.[1] ?? null,
        adId: adIdMatch?.[1] ?? null,
        headers,
      });
      let list = Object.values(state.ads).filter((a) => a.customer === customerId);
      if (campMatchQ) list = list.filter((a) => a.campaignId === campMatchQ[1]);
      if (adIdMatch) list = list.filter((a) => a.id === adIdMatch[1]);
      const withMetrics = query.includes("metrics.");
      return send({
        results: list.map((a) => ({
          adGroupAd: {
            status: a.status,
            ad: { id: a.id, name: a.name },
          },
          adGroup: { id: a.adGroupId },
          ...(withMetrics && a.metrics ? { metrics: a.metrics } : {}),
        })),
      });
    }
    if (query.includes("FROM ad_group")) {
      const campMatchQ = query.match(/campaign\.id = (\d+)/);
      const groupIdMatch = query.match(/ad_group\.id = (\d+)/);
      record({
        kind: "search_ad_groups",
        customerId,
        campaignId: campMatchQ?.[1] ?? null,
        adGroupId: groupIdMatch?.[1] ?? null,
        headers,
      });
      let list = Object.values(state.adGroups).filter(
        (g) => g.customer === customerId,
      );
      if (campMatchQ) list = list.filter((g) => g.campaignId === campMatchQ[1]);
      if (groupIdMatch) list = list.filter((g) => g.id === groupIdMatch[1]);
      const withMetrics = query.includes("metrics.");
      return send({
        results: list.map((g) => ({
          adGroup: {
            id: g.id,
            name: g.name,
            status: g.status,
            cpcBidMicros: g.cpcBidMicros,
          },
          ...(withMetrics && g.metrics ? { metrics: g.metrics } : {}),
        })),
      });
    }

    record({ kind: "search_unknown", customerId, query, headers });
    return send({ results: [] });
  }

  // campaignBudgets:mutate
  const budgetMatch = url.pathname.match(
    /\/customers\/(\d+)\/campaignBudgets:mutate$/,
  );
  if (budgetMatch && req.method === "POST") {
    const customerId = budgetMatch[1];
    const ops = (JSON.parse(raw).operations ?? []);
    const results = [];
    for (const op of ops) {
      if (op.create) {
        const resource = `customers/${customerId}/campaignBudgets/${state.nextBudgetId++}`;
        state.budgets[resource] = {
          resourceName: resource,
          amountMicros: String(op.create.amountMicros),
        };
        record({
          kind: "mutate_budget_create",
          customerId,
          amountMicros: op.create.amountMicros,
          headers,
        });
        results.push({ resourceName: resource });
      } else if (op.update) {
        const resource = op.update.resourceName;
        if (!state.budgets[resource]) {
          return send({ error: { code: 404, message: "Budget not found" } }, 404);
        }
        state.budgets[resource].amountMicros = String(op.update.amountMicros);
        record({
          kind: "mutate_budget_update",
          customerId,
          resource,
          amountMicros: op.update.amountMicros,
          headers,
        });
        results.push({ resourceName: resource });
      }
    }
    saveState();
    return send({ results });
  }

  // campaigns:mutate
  const campMatch = url.pathname.match(/\/customers\/(\d+)\/campaigns:mutate$/);
  if (campMatch && req.method === "POST") {
    const customerId = campMatch[1];
    const ops = (JSON.parse(raw).operations ?? []);
    const results = [];
    for (const op of ops) {
      if (op.create) {
        const id = String(state.nextId++);
        state.campaigns[id] = {
          id,
          customer: customerId,
          name: op.create.name,
          status: op.create.status || "PAUSED",
          advertisingChannelType: op.create.advertisingChannelType || "SEARCH",
          startDate: op.create.startDate || "",
          endDate: op.create.endDate || "",
          campaignBudget: op.create.campaignBudget,
          metrics: null,
        };
        record({
          kind: "mutate_campaign_create",
          customerId,
          id,
          name: op.create.name,
          status: op.create.status,
          channelType: op.create.advertisingChannelType,
          headers,
        });
        results.push({ resourceName: `customers/${customerId}/campaigns/${id}` });
      } else if (op.update) {
        const id = (op.update.resourceName || "").split("/").pop();
        const c = state.campaigns[id];
        if (!c) {
          return send({ error: { code: 404, message: "Campaign not found" } }, 404);
        }
        const changed = {};
        for (const key of ["name", "status", "startDate", "endDate"]) {
          if (op.update[key] != null) {
            c[key] = op.update[key];
            changed[key] = op.update[key];
          }
        }
        record({ kind: "mutate_campaign_update", customerId, id, changed, headers });
        results.push({ resourceName: op.update.resourceName });
      }
    }
    saveState();
    return send({ results });
  }

  // adGroups:mutate
  const agMatch = url.pathname.match(/\/customers\/(\d+)\/adGroups:mutate$/);
  if (agMatch && req.method === "POST") {
    const customerId = agMatch[1];
    const ops = (JSON.parse(raw).operations ?? []);
    const results = [];
    for (const op of ops) {
      if (op.update) {
        const id = (op.update.resourceName || "").split("/").pop();
        const g = state.adGroups[id];
        if (!g) {
          return send({ error: { code: 404, message: "Ad group not found" } }, 404);
        }
        const changed = {};
        for (const key of ["name", "status", "cpcBidMicros"]) {
          if (op.update[key] != null) {
            g[key] = op.update[key];
            changed[key] = op.update[key];
          }
        }
        record({
          kind: "mutate_ad_group_update",
          customerId,
          id,
          updateMask: op.updateMask ?? null,
          changed,
          headers,
        });
        results.push({ resourceName: op.update.resourceName });
      }
    }
    saveState();
    return send({ results });
  }

  // adGroupAds:mutate (resourceName customers/<cid>/adGroupAds/<adGroupId>~<adId>)
  const agaMatch = url.pathname.match(/\/customers\/(\d+)\/adGroupAds:mutate$/);
  if (agaMatch && req.method === "POST") {
    const customerId = agaMatch[1];
    const ops = (JSON.parse(raw).operations ?? []);
    const results = [];
    for (const op of ops) {
      if (op.update) {
        const composite = (op.update.resourceName || "").split("/").pop();
        const [adGroupId, adId] = composite.split("~");
        const a = state.ads[adId];
        if (!a || a.adGroupId !== adGroupId) {
          return send({ error: { code: 404, message: "Ad not found" } }, 404);
        }
        const changed = {};
        if (op.update.status != null) {
          a.status = op.update.status;
          changed.status = op.update.status;
        }
        record({
          kind: "mutate_ad_group_ad_update",
          customerId,
          adGroupId,
          adId,
          updateMask: op.updateMask ?? null,
          changed,
          headers,
        });
        results.push({ resourceName: op.update.resourceName });
      }
    }
    saveState();
    return send({ results });
  }

  record({ kind: "unknown", method: req.method, path: url.pathname });
  send({ error: { code: 404, message: `Unhandled mock path ${url.pathname}` } }, 404);
});

const port = Number(process.env.PORT || 9098);
server.listen(port, "0.0.0.0", () => {
  console.log(
    `google ads mock listening on ${port}, log ${LOG_FILE}, state ${STATE_FILE}`,
  );
});
