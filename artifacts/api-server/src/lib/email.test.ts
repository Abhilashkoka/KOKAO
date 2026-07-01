import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { sendEmail } from "./email";

const ORIGINAL_ENV = {
  hostname: process.env.REPLIT_CONNECTORS_HOSTNAME,
  identity: process.env.REPL_IDENTITY,
  renewal: process.env.WEB_REPL_RENEWAL,
};

function restoreEnv(): void {
  for (const [key, value] of [
    ["REPLIT_CONNECTORS_HOSTNAME", ORIGINAL_ENV.hostname],
    ["REPL_IDENTITY", ORIGINAL_ENV.identity],
    ["WEB_REPL_RENEWAL", ORIGINAL_ENV.renewal],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  restoreEnv();
});

describe("sendEmail", () => {
  it("no-ops (returns false) when the connector identity is not present", async () => {
    process.env.REPLIT_CONNECTORS_HOSTNAME = "connectors.example.com";
    delete process.env.REPL_IDENTITY;
    delete process.env.WEB_REPL_RENEWAL;
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const ok = await sendEmail({
      to: "a@b.com",
      subject: "s",
      text: "t",
    });

    expect(ok).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("no-ops when the connector has no api_key/from_email settings", async () => {
    process.env.REPLIT_CONNECTORS_HOSTNAME = "connectors.example.com";
    process.env.REPL_IDENTITY = "identity-token";
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ items: [{ settings: {} }] }), {
          status: 200,
        }),
      );

    const ok = await sendEmail({ to: "a@b.com", subject: "s", text: "t" });

    expect(ok).toBe(false);
    // Only the connector lookup happened; no SendGrid send attempted.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("posts to SendGrid with the resolved credentials when configured", async () => {
    process.env.REPLIT_CONNECTORS_HOSTNAME = "connectors.example.com";
    process.env.REPL_IDENTITY = "identity-token";
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            items: [
              {
                settings: {
                  api_key: "SG.secret",
                  from_email: "noreply@socialforge.app",
                },
              },
            ],
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 202 }));

    const ok = await sendEmail({
      to: "user@example.com",
      subject: "Facebook Page disconnected - reconnect needed",
      text: "reconnect here",
      html: "<p>reconnect here</p>",
    });

    expect(ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    const [url, init] = fetchSpy.mock.calls[1] as [string, RequestInit];
    expect(url).toBe("https://api.sendgrid.com/v3/mail/send");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer SG.secret",
    );
    const body = JSON.parse(init.body as string);
    expect(body.from.email).toBe("noreply@socialforge.app");
    expect(body.personalizations[0].to[0].email).toBe("user@example.com");
    // text/plain must come before text/html for SendGrid.
    expect(body.content[0].type).toBe("text/plain");
    expect(body.content[1].type).toBe("text/html");
  });

  it("returns false when SendGrid rejects the send", async () => {
    process.env.REPLIT_CONNECTORS_HOSTNAME = "connectors.example.com";
    process.env.REPL_IDENTITY = "identity-token";
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            items: [
              { settings: { api_key: "SG.secret", from_email: "f@x.com" } },
            ],
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response("bad request", { status: 400 }));

    const ok = await sendEmail({ to: "a@b.com", subject: "s", text: "t" });

    expect(ok).toBe(false);
  });
});
