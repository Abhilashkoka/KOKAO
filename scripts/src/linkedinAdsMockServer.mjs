// Temporary LinkedIn Marketing (Ads) REST API mock for browser e2e runs.
// Persists its request log and mutable state to /tmp so workflow restarts
// around test runs don't lose evidence or state.
import http from "node:http";
import fs from "node:fs";

const LOG_FILE = "/tmp/linkedin-ads-mock-log.json";
const STATE_FILE = "/tmp/linkedin-ads-mock-state.json";

let log = [];
try {
  log = JSON.parse(fs.readFileSync(LOG_FILE, "utf8"));
} catch {}

const DEFAULT_STATE = {
  nextId: 630000001,
  adAccounts: [
    { id: 511001, name: "KOKAO LinkedIn Test Account", currency: "USD", status: "ACTIVE" },
  ],
  // Keyed by id. Starts EMPTY so the DraftDialog "no campaign groups yet"
  // hint is observable before the first group is created.
  groups: {},
  campaigns: {},
  // Keyed by numeric id: { id, intendedStatus, campaign (urn), content: { reference } }
  creatives: {},
  // Keyed by post urn: { commentary, content? } ; missing URN → 404.
  posts: {},
  // Keyed by image URN → { downloadUrl }.
  images: {},
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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  let raw = "";
  for await (const chunk of req) raw += chunk;
  let body = {};
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {}
  const path = decodeURIComponent(url.pathname.replace(/^\/+/, ""));

  const send = (obj, status = 200, headers = {}) => {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify(obj));
  };

  // A tiny 1x1 PNG the browser can render as an ad thumbnail.
  if (req.method === "GET" && path === "mock-image.png") {
    record({ method: "GET", path, kind: "image_download" });
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      "base64",
    );
    res.writeHead(200, { "content-type": "image/png" });
    return res.end(png);
  }

  // Image read (thumbnail URL resolution)
  const im = path.match(/^images\/(urn:.+)$/);
  if (req.method === "GET" && im) {
    const img = (state.images ?? {})[im[1]];
    record({ method: "GET", path, kind: "read_image", found: !!img });
    if (!img) return send({ message: "Unknown image" }, 404);
    return send(img);
  }

  // Targeting typeahead (facet-scoped) + URN name resolution (q=urns)
  if (req.method === "GET" && path === "adTargetingEntities") {
    const facetUrn = url.searchParams.get("facet") || "";
    const q = (url.searchParams.get("query") || "").toLowerCase();
    record({ method: "GET", path, kind: "targeting_typeahead", facet: facetUrn, query: q });
    const catalog = {
      "urn:li:adTargetingFacet:locations": [
        { urn: "urn:li:geo:103644278", name: "United States" },
        { urn: "urn:li:geo:101174742", name: "Canada" },
        { urn: "urn:li:geo:102713980", name: "India" },
      ],
      "urn:li:adTargetingFacet:industries": [
        { urn: "urn:li:industry:4", name: "Computer Software" },
        { urn: "urn:li:industry:6", name: "Internet" },
        { urn: "urn:li:industry:43", name: "Financial Services" },
      ],
      "urn:li:adTargetingFacet:jobFunctions": [
        { urn: "urn:li:function:13", name: "Information Technology" },
        { urn: "urn:li:function:15", name: "Marketing" },
      ],
      "urn:li:adTargetingFacet:titles": [
        { urn: "urn:li:title:9580", name: "Software Engineer" },
        { urn: "urn:li:title:340", name: "Marketing Manager" },
        { urn: "urn:li:title:100", name: "Product Manager" },
      ],
    };
    if (url.searchParams.get("q") === "urns") {
      const all = Object.values(catalog).flat();
      const urnsParam = url.searchParams.get("urns") || "";
      const wanted = decodeURIComponent(urnsParam)
        .replace(/^List\(/, "")
        .replace(/\)$/, "")
        .split(",")
        .map((u) => decodeURIComponent(u.trim()))
        .filter(Boolean);
      const els = all.filter((e) => wanted.includes(e.urn));
      return send({ elements: els });
    }
    const els = (catalog[facetUrn] || []).filter((e) =>
      e.name.toLowerCase().includes(q),
    );
    return send({ elements: els });
  }

  // Analytics
  if (req.method === "GET" && path === "adAnalytics") {
    record({ method: "GET", path, kind: "analytics" });
    return send({ elements: [] });
  }

  // Ad accounts list
  if (req.method === "GET" && path === "adAccounts") {
    record({ method: "GET", path, kind: "list_adaccounts" });
    return send({ elements: state.adAccounts });
  }

  // Single ad account
  let m = path.match(/^adAccounts\/(\d+)$/);
  if (req.method === "GET" && m) {
    record({ method: "GET", path, kind: "read_adaccount" });
    const acct = state.adAccounts.find((a) => String(a.id) === m[1]);
    if (!acct) return send({ message: "Unknown ad account" }, 404);
    return send(acct);
  }

  // Campaign groups: list + create
  m = path.match(/^adAccounts\/(\d+)\/adCampaignGroups$/);
  if (m) {
    if (req.method === "GET") {
      record({ method: "GET", path, kind: "list_campaign_groups" });
      return send({ elements: Object.values(state.groups) });
    }
    if (req.method === "POST") {
      const id = state.nextId++;
      state.groups[id] = {
        id,
        name: body.name || "Untitled group",
        status: body.status || "PAUSED",
        totalBudget: body.totalBudget ?? undefined,
        runSchedule: body.runSchedule ?? { start: Date.now() },
      };
      saveState();
      record({
        method: "POST",
        path,
        kind: "create_campaign_group",
        id,
        name: body.name,
        status: body.status,
        totalBudget: body.totalBudget ?? null,
      });
      return send({}, 201, { "x-restli-id": String(id) });
    }
  }

  // Single campaign group (read-back for verify + PARTIAL_UPDATE)
  m = path.match(/^adAccounts\/(\d+)\/adCampaignGroups\/(\d+)$/);
  if (m) {
    const g = state.groups[m[2]];
    if (!g) return send({ message: "Unknown campaign group" }, 404);
    if (req.method === "GET") {
      record({ method: "GET", path, kind: "read_campaign_group" });
      return send(g);
    }
    if (req.method === "POST") {
      const set = body?.patch?.$set ?? {};
      Object.assign(g, set);
      const del = body?.patch?.$delete ?? [];
      for (const key of del) delete g[key];
      saveState();
      record({ method: "POST", path, kind: "update_campaign_group", set, delete: del });
      return send({});
    }
  }

  // Campaigns: list + create
  m = path.match(/^adAccounts\/(\d+)\/adCampaigns$/);
  if (m) {
    if (req.method === "GET") {
      record({ method: "GET", path, kind: "list_campaigns" });
      return send({ elements: Object.values(state.campaigns) });
    }
    if (req.method === "POST") {
      const id = state.nextId++;
      state.campaigns[id] = {
        id,
        name: body.name || "Untitled",
        status: body.status || "PAUSED",
        campaignGroup: body.campaignGroup,
        dailyBudget: body.dailyBudget ?? undefined,
        totalBudget: body.totalBudget ?? undefined,
        runSchedule: body.runSchedule ?? { start: Date.now() },
      };
      saveState();
      record({
        method: "POST",
        path,
        kind: "create_campaign",
        id,
        name: body.name,
        status: body.status,
        campaignGroup: body.campaignGroup ?? null,
      });
      return send({}, 201, { "x-restli-id": String(id) });
    }
  }

  // Single campaign
  m = path.match(/^adAccounts\/(\d+)\/adCampaigns\/(\d+)$/);
  if (m) {
    const c = state.campaigns[m[2]];
    if (!c) return send({ message: "Unknown campaign" }, 404);
    if (req.method === "GET") {
      record({ method: "GET", path, kind: "read_campaign" });
      return send(c);
    }
    if (req.method === "POST") {
      const set = body?.patch?.$set ?? {};
      Object.assign(c, set);
      saveState();
      record({ method: "POST", path, kind: "update_campaign", set });
      return send({});
    }
  }

  const creatives = (state.creatives ??= {});
  const posts = (state.posts ??= {});

  const creativeShape = (c) => ({
    id: `urn:li:sponsoredCreative:${c.id}`,
    intendedStatus: c.intendedStatus,
    review: { status: c.reviewStatus ?? "APPROVED" },
    campaign: c.campaign,
    content: c.content,
  });

  // Creatives: list (q=criteria) + create
  m = path.match(/^adAccounts\/(\d+)\/creatives$/);
  if (m) {
    if (req.method === "GET") {
      record({ method: "GET", path, kind: "list_creatives", query: url.search });
      const campaignsParam = url.searchParams.get("campaigns") || "";
      const wanted = decodeURIComponent(campaignsParam);
      const els = Object.values(creatives)
        .filter((c) => !wanted || wanted.includes(String(c.campaign)))
        .map(creativeShape);
      return send({ elements: els });
    }
    if (req.method === "POST") {
      const id = state.nextId++;
      creatives[id] = {
        id,
        intendedStatus: body.intendedStatus || "PAUSED",
        campaign: body.campaign,
        content: body.content,
      };
      saveState();
      record({ method: "POST", path, kind: "create_creative", id });
      return send({}, 201, { "x-restli-id": `urn:li:sponsoredCreative:${id}` });
    }
  }

  // Single creative: read + PARTIAL_UPDATE (urn is percent-encoded in the path)
  m = path.match(/^adAccounts\/(\d+)\/creatives\/(.+)$/);
  if (m) {
    const urn = decodeURIComponent(m[2]);
    const idMatch = urn.match(/(\d+)$/);
    const c = idMatch ? creatives[idMatch[1]] : undefined;
    if (!c) return send({ message: "Unknown creative" }, 404);
    if (req.method === "GET") {
      record({ method: "GET", path, kind: "read_creative", id: c.id });
      return send(creativeShape(c));
    }
    if (req.method === "POST") {
      const set = body?.patch?.$set ?? {};
      if (set.intendedStatus) c.intendedStatus = set.intendedStatus;
      saveState();
      record({ method: "POST", path, kind: "update_creative", id: c.id, set });
      return send({});
    }
  }

  // Dark post read (ad copy preview)
  m = path.match(/^posts\/(.+)$/);
  if (req.method === "GET" && m) {
    const urn = decodeURIComponent(m[1]);
    record({ method: "GET", path, kind: "read_post", urn });
    const p = posts[urn];
    if (!p) return send({ message: "Unknown post" }, 404);
    return send({ commentary: p.commentary, content: p.content ?? {} });
  }

  record({ method: req.method, path, kind: "unknown" });
  send({ elements: [] });
});

const port = Number(process.env.PORT || 9098);
server.listen(port, "0.0.0.0", () => {
  console.log(
    `linkedin ads mock listening on ${port}, log ${LOG_FILE}, state ${STATE_FILE}`,
  );
});
