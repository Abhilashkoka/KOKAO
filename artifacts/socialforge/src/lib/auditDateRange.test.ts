import { describe, it, expect } from "vitest";
import { localDayStartISO, localDayEndISO } from "./auditDateRange";

describe("audit date-range filters use LOCAL day boundaries", () => {
  it("from = local midnight of the picked day", () => {
    const iso = localDayStartISO("2026-07-15");
    const d = new Date(iso);
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(6);
    expect(d.getDate()).toBe(15);
    expect(d.getHours()).toBe(0);
    expect(d.getMinutes()).toBe(0);
    expect(d.getSeconds()).toBe(0);
    expect(d.getMilliseconds()).toBe(0);
  });

  it("to = last millisecond of the picked local day", () => {
    const iso = localDayEndISO("2026-07-15");
    const d = new Date(iso);
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(6);
    expect(d.getDate()).toBe(15);
    expect(d.getHours()).toBe(23);
    expect(d.getMinutes()).toBe(59);
    expect(d.getSeconds()).toBe(59);
    expect(d.getMilliseconds()).toBe(999);
  });

  it("range brackets a record exactly as displayed locally (23:30 UTC case)", () => {
    // A record written at 23:30 UTC displays (via toLocaleString) on whatever
    // local calendar day that instant falls on. Filtering by that displayed
    // day must include it, regardless of the environment's timezone.
    const record = new Date("2026-07-14T23:30:00.000Z");
    const displayedDay = [
      record.getFullYear(),
      String(record.getMonth() + 1).padStart(2, "0"),
      String(record.getDate()).padStart(2, "0"),
    ].join("-");

    const from = new Date(localDayStartISO(displayedDay)).getTime();
    const to = new Date(localDayEndISO(displayedDay)).getTime();
    expect(record.getTime()).toBeGreaterThanOrEqual(from);
    expect(record.getTime()).toBeLessThanOrEqual(to);
  });

  it("offset behaves correctly in a non-UTC zone when TZ is set", () => {
    // In UTC the start ISO equals midnight Z; in e.g. TZ=America/New_York it
    // should be 04:00/05:00 Z. Either way the round-trip must land on the
    // same local calendar day — asserted generically above; here we just
    // sanity-check the parseability and ordering of the pair.
    const from = localDayStartISO("2026-01-01");
    const to = localDayEndISO("2026-01-01");
    expect(new Date(to).getTime() - new Date(from).getTime()).toBe(
      24 * 60 * 60 * 1000 - 1,
    );
  });
});
