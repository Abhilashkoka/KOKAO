// Temporary TikTok Marketing API v1.3 mock for browser e2e runs.
// Persists request log + mutable state to /tmp so workflow restarts around
// test runs don't lose evidence or reset mid-flow state.
//
// Point the API server at it with TIKTOK_ADS_BASE_OVERRIDE=http://127.0.0.1:9099
// (the adapter appends paths like /campaign/get/ directly to the base).
//
// Control endpoints (not part of the TikTok surface):
//   POST /__control  {"revoked": true|false}  — flip revoked-grant mode
//   POST /__control  {"reset": true}          — reset campaign state + log
//   GET  /__log                                — dump the request log
import http from "node:http";
import fs from "node:fs";

const LOG_FILE = "/tmp/tiktok-mock-log.json";
const STATE_FILE = "/tmp/tiktok-mock-state.json";

const DEFAULT_STATE = {
  revoked: false,
  // When true, /advertiser/info/ returns a server error (token exchange still
  // works) — simulates the advertiser verification call itself failing.
  advertiserError: false,
  campaign: {
    campaign_id: "7100000000000000001",
    campaign_name: "TT Summer Launch",
    operation_status: "ENABLE",
    secondary_status: "CAMPAIGN_STATUS_ENABLE",
    objective_type: "TRAFFIC",
    budget: 50, // major units, BUDGET_MODE_DAY
    budget_mode: "BUDGET_MODE_DAY",
  },
  adgroup: {
    adgroup_id: "7200000000000000001",
    adgroup_name: "TT Prospecting Ad Group",
    operation_status: "ENABLE",
    secondary_status: "ADGROUP_STATUS_DELIVERY_OK",
    budget: 20,
    budget_mode: "BUDGET_MODE_DAY",
    schedule_type: "SCHEDULE_FROM_NOW",
    schedule_start_time: "2026-07-01 00:00:00",
    schedule_end_time: "",
  },
  // Campaigns created via /campaign/create/ land here so read-back verify works.
  createdCampaigns: [],
  nextCampaignId: 7100000000000000099n.toString(),
  ads: [
    {
      ad_id: "7300000000000000001",
      ad_name: "TT Video Ad 1",
      operation_status: "ENABLE",
      secondary_status: "AD_STATUS_DELIVERY_OK",
      adgroup_id: "7200000000000000001",
      ad_text: "Fresh drops daily. Tap to see what everyone is talking about.",
      image_ids: ["img-tt-0001"],
    },
    {
      ad_id: "7300000000000000002",
      ad_name: "TT No Creative Ad",
      operation_status: "ENABLE",
      secondary_status: "AD_STATUS_DELIVERY_OK",
      adgroup_id: "7200000000000000001",
    },
  ],
};

let log = [];
try {
  log = JSON.parse(fs.readFileSync(LOG_FILE, "utf8"));
} catch {}
let state = structuredClone(DEFAULT_STATE);
try {
  state = { ...state, ...JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) };
} catch {}

function saveState() {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}
function record(entry) {
  log.push({ ...entry, at: new Date().toISOString() });
  fs.writeFileSync(LOG_FILE, JSON.stringify(log, null, 2));
}

const ADVERTISERS = [
  { advertiser_id: "9000000001", name: "KOKAO Test Advertiser", currency: "USD", status: "STATUS_ENABLE" },
  { advertiser_id: "9000000002", name: "KOKAO Secondary Advertiser", currency: "USD", status: "STATUS_ENABLE" },
];

// 1x1 blue PNG served at /mock-image.png for creative thumbnails.
const MOCK_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

const METRICS = {
  campaign_id: { impressions: "12345", clicks: "678", ctr: "5.49", spend: "42.5", conversion: "31" },
  adgroup_id: { impressions: "8000", clicks: "400", ctr: "5.0", spend: "25.0", conversion: "18" },
  ad_id: { impressions: "8000", clicks: "400", ctr: "5.0", spend: "25.0", conversion: "18" },
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  let raw = "";
  for await (const chunk of req) raw += chunk;
  let body = {};
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {}
  const path = url.pathname.replace(/\/*$/, "/");

  const send = (obj, httpStatus = 200) => {
    res.writeHead(httpStatus, { "content-type": "application/json" });
    res.end(JSON.stringify(obj));
  };
  const ok = (data) => send({ code: 0, message: "OK", data });

  // -- control surface -------------------------------------------------
  if (path === "/__control/") {
    if (typeof body.revoked === "boolean") state.revoked = body.revoked;
    if (typeof body.advertiserError === "boolean") state.advertiserError = body.advertiserError;
    if (body.reset) {
      state = structuredClone(DEFAULT_STATE);
      log = [];
      fs.writeFileSync(LOG_FILE, "[]");
    }
    saveState();
    record({ method: "POST", path, kind: "control", body });
    return send({ ok: true, revoked: state.revoked, advertiserError: state.advertiserError });
  }
  if (path === "/__log/" || path === "/__log") {
    return send(log);
  }

  record({ method: req.method, path, query: Object.fromEntries(url.searchParams), body });

  // -- OAuth token exchange (works even in revoked mode so reconnect can recover)
  if (path === "/oauth2/access_token/") {
    if (body.auth_code === "bad") {
      return send({ code: 40110, message: "auth_code invalid", data: {} });
    }
    state.revoked = false;
    saveState();
    return ok({
      access_token: "mock-tiktok-access-token",
      advertiser_ids: ADVERTISERS.map((a) => a.advertiser_id),
    });
  }

  if (state.revoked) {
    // Token revoked business code — adapter maps this to authFailed.
    return send({ code: 40105, message: "Access token is expired or revoked. Please reauthorize.", data: {} });
  }

  if (path === "/advertiser/info/") {
    if (state.advertiserError) {
      return send({ code: 50000, message: "Internal service error. Please try again later.", data: {} });
    }
    let ids = [];
    try {
      ids = JSON.parse(url.searchParams.get("advertiser_ids") || "[]").map(String);
    } catch {}
    return ok({ list: ADVERTISERS.filter((a) => ids.includes(a.advertiser_id)) });
  }

  if (path === "/campaign/get/") {
    const all = [state.campaign, ...(state.createdCampaigns ?? [])];
    let filterIds = null;
    try {
      const f = JSON.parse(url.searchParams.get("filtering") || "null");
      if (f && Array.isArray(f.campaign_ids)) filterIds = f.campaign_ids.map(String);
    } catch {}
    const list = filterIds ? all.filter((c) => filterIds.includes(c.campaign_id)) : all;
    return ok({ list });
  }
  if (path === "/adgroup/get/") {
    return ok({ list: [state.adgroup] });
  }

  if (path === "/adgroup/update/") {
    if (String(body.adgroup_id) !== state.adgroup.adgroup_id) {
      return send({ code: 40002, message: "Ad group not found", data: {} });
    }
    if (body.adgroup_name != null) state.adgroup.adgroup_name = String(body.adgroup_name);
    if (body.budget != null) {
      state.adgroup.budget = Number(body.budget);
      state.adgroup.budget_mode = String(body.budget_mode || state.adgroup.budget_mode);
    }
    if (body.schedule_type != null) {
      state.adgroup.schedule_type = String(body.schedule_type);
      state.adgroup.schedule_start_time = String(body.schedule_start_time || "");
      state.adgroup.schedule_end_time =
        body.schedule_type === "SCHEDULE_START_END" ? String(body.schedule_end_time || "") : "";
    }
    saveState();
    return ok({ adgroup_id: state.adgroup.adgroup_id });
  }

  if (path === "/adgroup/status/update/") {
    state.adgroup.operation_status = body.operation_status === "DISABLE" ? "DISABLE" : "ENABLE";
    state.adgroup.secondary_status =
      state.adgroup.operation_status === "ENABLE"
        ? "ADGROUP_STATUS_DELIVERY_OK"
        : "ADGROUP_STATUS_DISABLE";
    saveState();
    return ok({ adgroup_ids: [state.adgroup.adgroup_id] });
  }
  if (path === "/ad/get/") {
    const all = state.ads ?? [];
    let filterIds = null;
    try {
      const f = JSON.parse(url.searchParams.get("filtering") || "null");
      if (f && Array.isArray(f.ad_ids)) filterIds = f.ad_ids.map(String);
    } catch {}
    const list = filterIds ? all.filter((a) => filterIds.includes(a.ad_id)) : all;
    return ok({ list });
  }

  if (path === "/ad/update/") {
    const creatives = Array.isArray(body.creatives) ? body.creatives : [];
    const updated = [];
    for (const c of creatives) {
      const ad = (state.ads ?? []).find((a) => a.ad_id === String(c.ad_id));
      if (!ad) {
        return send({ code: 40002, message: "Ad not found", data: {} });
      }
      if (String(body.adgroup_id ?? "") !== ad.adgroup_id) {
        return send({ code: 40002, message: "Ad group mismatch", data: {} });
      }
      if (c.ad_name != null) ad.ad_name = String(c.ad_name);
      updated.push(ad.ad_id);
    }
    saveState();
    return ok({ ad_ids: updated });
  }

  if (path === "/ad/status/update/") {
    const ids = (Array.isArray(body.ad_ids) ? body.ad_ids : []).map(String);
    const hits = (state.ads ?? []).filter((a) => ids.includes(a.ad_id));
    if (hits.length !== ids.length) {
      return send({ code: 40002, message: "Ad not found", data: {} });
    }
    const operation = body.operation_status === "DISABLE" ? "DISABLE" : "ENABLE";
    for (const ad of hits) {
      ad.operation_status = operation;
      ad.secondary_status =
        operation === "ENABLE" ? "AD_STATUS_DELIVERY_OK" : "AD_STATUS_DISABLE";
    }
    saveState();
    return ok({ ad_ids: ids });
  }

  if (path === "/file/image/ad/info/") {
    let ids = [];
    try {
      ids = JSON.parse(url.searchParams.get("image_ids") || "[]").map(String);
    } catch {}
    const host = req.headers.host || "localhost";
    return ok({
      list: ids
        .filter((id) => (state.ads ?? []).some((a) => (a.image_ids ?? []).includes(id)))
        .map((id) => ({ image_id: id, image_url: `http://${host}/mock-image.png` })),
    });
  }

  if (path === "/mock-image.png/" || path === "/mock-image.png") {
    res.writeHead(200, { "content-type": "image/png" });
    return res.end(MOCK_PNG);
  }

  if (path === "/report/integrated/get/") {
    let dims = [];
    try {
      dims = JSON.parse(url.searchParams.get("dimensions") || "[]");
    } catch {}
    const idDim = dims[0];
    const rows = [];
    if (idDim === "campaign_id") {
      rows.push({ dimensions: { campaign_id: state.campaign.campaign_id }, metrics: METRICS.campaign_id });
    } else if (idDim === "adgroup_id") {
      rows.push({ dimensions: { adgroup_id: state.adgroup.adgroup_id }, metrics: METRICS.adgroup_id });
    } else if (idDim === "ad_id") {
      rows.push({ dimensions: { ad_id: (state.ads ?? [])[0]?.ad_id }, metrics: METRICS.ad_id });
    }
    return ok({ list: rows });
  }

  if (path === "/campaign/update/") {
    if (String(body.campaign_id) !== state.campaign.campaign_id) {
      return send({ code: 40002, message: "Campaign not found", data: {} });
    }
    if (body.campaign_name != null) state.campaign.campaign_name = String(body.campaign_name);
    if (body.budget != null) {
      state.campaign.budget = Number(body.budget);
      state.campaign.budget_mode = String(body.budget_mode || state.campaign.budget_mode);
    }
    saveState();
    return ok({ campaign_id: state.campaign.campaign_id });
  }

  if (path === "/campaign/status/update/") {
    state.campaign.operation_status = body.operation_status === "DISABLE" ? "DISABLE" : "ENABLE";
    state.campaign.secondary_status =
      state.campaign.operation_status === "ENABLE" ? "CAMPAIGN_STATUS_ENABLE" : "CAMPAIGN_STATUS_DISABLE";
    saveState();
    return ok({ campaign_ids: [state.campaign.campaign_id] });
  }

  if (path === "/campaign/create/") {
    const id = String(state.nextCampaignId ?? "7100000000000000099");
    state.nextCampaignId = (BigInt(id) + 1n).toString();
    const operation = body.operation_status === "ENABLE" ? "ENABLE" : "DISABLE";
    const campaign = {
      campaign_id: id,
      campaign_name: String(body.campaign_name ?? "Untitled"),
      operation_status: operation,
      secondary_status:
        operation === "ENABLE" ? "CAMPAIGN_STATUS_ENABLE" : "CAMPAIGN_STATUS_DISABLE",
      objective_type: String(body.objective_type ?? "TRAFFIC"),
      budget: body.budget != null ? Number(body.budget) : null,
      budget_mode: String(body.budget_mode ?? "BUDGET_MODE_INFINITE"),
    };
    state.createdCampaigns = [...(state.createdCampaigns ?? []), campaign];
    saveState();
    return ok({ campaign_id: id });
  }

  record({ method: req.method, path, kind: "unknown" });
  return send({ code: 40000, message: `Mock has no handler for ${path}`, data: {} });
});

const port = Number(process.env.PORT || 9099);
server.listen(port, "0.0.0.0", () => {
  console.log(`tiktok mock listening on ${port}, log at ${LOG_FILE}`);
});
