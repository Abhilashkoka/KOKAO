import { useGetMe } from "@workspace/api-client-react";
import { ShieldAlert, Check, X, Sparkles } from "lucide-react";

/**
 * KOKAO — application-level brand kit (superadmin only).
 *
 * Content is a faithful reproduction of the KOKAO brand guidelines. All brand
 * colours are centralised in the `K` palette below so a colour swap is a single
 * edit; the wording/content is intentionally left unchanged.
 */
const K = {
  accentA: "#B9FF3A", // Set A · gc4
  accentB: "#9BF80A", // Set B · gc6
  ink: "#14141A",
  tileInk: "#0A0A0C",
  surface: "#16171B",
  paper: "#F6F3EC",
  white: "#FFFFFF",
  inkOnDark: "#F4F3EE",
  // Neutral / incidental tones from the source guidelines
  pageBackdrop: "#CFCbC2",
  coverSubtitle: "#C7Cabf",
  bodyGrey: "#3a3a42",
  paraGrey: "#77726A",
  capGrey: "#8A857B",
  kickGreyPaper: "#9B968D",
  kickGreyDark: "#6F7468",
  footGreyPaper: "#B4AFA6",
  footGreyDark: "#4E5249",
  doGreen: "#2E8B57",
  dontRed: "#B23A3A",
  cardBorder: "rgba(20,20,26,0.10)",
  aiStudioBg: "#EAF7CE",
  aiStudioText: "#4a7a12",
} as const;

function Mark({
  size,
  ring,
  dot,
  r = 34,
  sw = 11,
  dr = 9,
}: {
  size: number;
  ring: string;
  dot: string;
  r?: number;
  sw?: number;
  dr?: number;
}) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100">
      <circle cx="50" cy="50" r={r} fill="none" stroke={ring} strokeWidth={sw} />
      <circle cx="50" cy="50" r={dr} fill={dot} />
    </svg>
  );
}

function Wordmark({
  fontSize,
  color,
  accent,
  letterSpacing,
}: {
  fontSize: number;
  color: string;
  accent: string;
  letterSpacing: number;
}) {
  return (
    <div
      style={{
        fontFamily: "'Sora', sans-serif",
        fontSize,
        fontWeight: 800,
        letterSpacing,
        color,
        lineHeight: 0.9,
      }}
    >
      KOKA<span style={{ color: accent }}>O</span>
    </div>
  );
}

const kick = (color: string): React.CSSProperties => ({
  fontFamily: "'IBM Plex Mono', monospace",
  fontSize: 12,
  fontWeight: 600,
  letterSpacing: 3,
  textTransform: "uppercase",
  color,
});

const h2Style: React.CSSProperties = {
  fontFamily: "'Sora', sans-serif",
  fontSize: 40,
  fontWeight: 800,
  letterSpacing: -1.6,
  margin: "10px 0 34px",
};

const h3Style: React.CSSProperties = {
  fontFamily: "'Sora', sans-serif",
  fontSize: 15,
  fontWeight: 700,
  marginBottom: 14,
};

const capStyle: React.CSSProperties = {
  fontFamily: "'IBM Plex Mono', monospace",
  fontSize: 10.5,
  letterSpacing: 0.5,
  color: K.capGrey,
  marginTop: 9,
  textTransform: "uppercase",
};

const cardBase: React.CSSProperties = {
  background: K.white,
  border: `1px solid ${K.cardBorder}`,
  borderRadius: 18,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};

function Foot({ pageLabel, dark }: { pageLabel: string; dark?: boolean }) {
  const color = dark ? K.footGreyDark : K.footGreyPaper;
  return (
    <div
      style={{
        position: "absolute",
        left: 72,
        right: 72,
        bottom: 34,
        display: "flex",
        justifyContent: "space-between",
        fontFamily: "'IBM Plex Mono', monospace",
        fontSize: 10,
        letterSpacing: 1,
        color,
        textTransform: "uppercase",
      }}
    >
      <span>KOKAO Brand Kit</span>
      <span>{pageLabel}</span>
    </div>
  );
}

function Page({
  children,
  dark,
}: {
  children: React.ReactNode;
  dark?: boolean;
}) {
  return (
    <section
      style={{
        width: "100%",
        maxWidth: 960,
        minHeight: 1000,
        margin: "0 auto 26px",
        background: dark ? K.tileInk : K.paper,
        color: dark ? K.inkOnDark : K.ink,
        padding: "70px 72px",
        position: "relative",
        overflow: "hidden",
        borderRadius: 20,
        boxShadow: "0 10px 40px rgba(0,0,0,0.12)",
        fontFamily: "'Sora', sans-serif",
      }}
    >
      {children}
    </section>
  );
}

export function AppBrandKitPage() {
  const { data: me, isLoading } = useGetMe();

  // Deny by default: render nothing sensitive until the role is resolved, then
  // only allow explicit superadmins. This static brand-guidelines page holds no
  // server data, so no cross-tenant boundary is at risk; the gate mirrors the
  // app's convention of not showing admin surfaces to non-superadmins.
  if (isLoading || !me) {
    return (
      <div className="flex items-center justify-center py-24 text-muted-foreground">
        Loading...
      </div>
    );
  }

  if (!me.isSuperadmin) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center">
        <ShieldAlert className="h-12 w-12 text-muted-foreground mb-4" />
        <h1 className="text-2xl font-bold">Access denied</h1>
        <p className="text-muted-foreground mt-2">
          You do not have permission to view this page.
        </p>
      </div>
    );
  }

  return (
    <div style={{ background: K.pageBackdrop, borderRadius: 24, padding: "26px 12px" }}>
      {/* ===== COVER ===== */}
      <Page dark>
        <div style={kick(K.accentA)}>Brand Guidelines · 2026</div>
        <div style={{ display: "flex", alignItems: "center", gap: 26, marginTop: 120 }}>
          <Mark size={120} ring={K.accentA} dot={K.accentA} />
          <Wordmark fontSize={96} color={K.inkOnDark} accent={K.accentA} letterSpacing={-5} />
        </div>
        <p
          style={{
            maxWidth: 560,
            marginTop: 40,
            fontSize: 20,
            lineHeight: 1.5,
            color: K.coverSubtitle,
          }}
        >
          AI copywriting, creative &amp; content generation with auto-publishing.
          Plug and play for professionals.
        </p>
        <div style={{ marginTop: 80, display: "flex", gap: 16 }}>
          <div style={{ width: 120, height: 64, borderRadius: 12, background: K.accentA }} />
          <div style={{ width: 120, height: 64, borderRadius: 12, background: K.accentB }} />
          <div
            style={{
              width: 120,
              height: 64,
              borderRadius: 12,
              background: K.surface,
              border: "1px solid rgba(255,255,255,.12)",
            }}
          />
          <div style={{ width: 120, height: 64, borderRadius: 12, background: K.paper }} />
        </div>
        <Foot pageLabel="01 · Cover" dark />
      </Page>

      {/* ===== LOGO SUITE ===== */}
      <Page>
        <div style={kick(K.kickGreyPaper)}>The Logo</div>
        <h2 style={h2Style}>Logo suite</h2>
        <p
          style={{
            maxWidth: 640,
            color: K.paraGrey,
            fontSize: 15,
            lineHeight: 1.55,
            marginBottom: 32,
          }}
        >
          The KOKAO mark is an open “hub” aperture — the final O of the name. It
          appears as an icon, a wordmark, and a horizontal lockup. Two accent
          greens are approved: <b>Set A · gc4</b> and <b>Set B · gc6</b>.
        </p>

        <h3 style={h3Style}>Primary lockup — Set A</h3>
        <div style={{ ...cardBase, height: 150, background: K.tileInk, marginBottom: 24 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
            <Mark size={56} ring={K.accentA} dot={K.accentA} />
            <Wordmark fontSize={46} color={K.inkOnDark} accent={K.accentA} letterSpacing={-2} />
          </div>
        </div>

        <div style={{ display: "flex", gap: 22, flexWrap: "wrap" }}>
          <div>
            <div style={{ ...cardBase, width: 210, height: 150, background: K.tileInk }}>
              <Mark size={70} ring={K.accentA} dot={K.accentA} />
            </div>
            <div style={capStyle}>Mark</div>
          </div>
          <div>
            <div style={{ ...cardBase, width: 210, height: 150, background: K.tileInk }}>
              <Wordmark fontSize={34} color={K.inkOnDark} accent={K.accentA} letterSpacing={-1.4} />
            </div>
            <div style={capStyle}>Wordmark</div>
          </div>
          <div>
            <div style={{ ...cardBase, width: 210, height: 150 }}>
              <div
                style={{
                  width: 88,
                  height: 88,
                  borderRadius: 23,
                  background: K.accentA,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <Mark size={52} ring={K.tileInk} dot={K.tileInk} />
              </div>
            </div>
            <div style={capStyle}>App icon</div>
          </div>
          <div>
            <div style={{ ...cardBase, width: 210, height: 150 }}>
              <div
                style={{
                  fontFamily: "'Sora', sans-serif",
                  fontSize: 34,
                  fontWeight: 800,
                  letterSpacing: -1.4,
                  color: K.ink,
                }}
              >
                KOKAO
              </div>
            </div>
            <div style={capStyle}>Mono ink</div>
          </div>
        </div>

        <h3 style={{ ...h3Style, marginTop: 34 }}>Set B · gc6</h3>
        <div style={{ display: "flex", gap: 22, flexWrap: "wrap" }}>
          <div>
            <div style={{ ...cardBase, width: 210, height: 130, background: K.tileInk }}>
              <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
                <Mark size={42} ring={K.accentB} dot={K.accentB} />
                <Wordmark fontSize={26} color={K.inkOnDark} accent={K.accentB} letterSpacing={-1} />
              </div>
            </div>
            <div style={capStyle}>Lockup</div>
          </div>
          <div>
            <div style={{ ...cardBase, width: 210, height: 130 }}>
              <div
                style={{
                  width: 78,
                  height: 78,
                  borderRadius: 21,
                  background: K.accentB,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <Mark size={46} ring={K.tileInk} dot={K.tileInk} />
              </div>
            </div>
            <div style={capStyle}>App icon</div>
          </div>
          <div>
            <div style={{ ...cardBase, width: 210, height: 130, background: K.tileInk }}>
              <Mark size={60} ring={K.accentB} dot={K.accentB} />
            </div>
            <div style={capStyle}>Mark</div>
          </div>
        </div>
        <Foot pageLabel="02 · Logo" />
      </Page>

      {/* ===== COLOR ===== */}
      <Page>
        <div style={kick(K.kickGreyPaper)}>Palette</div>
        <h2 style={h2Style}>Color</h2>
        <div style={{ display: "flex", gap: 20, flexWrap: "wrap" }}>
          <ColorSwatch flex height={150} color={K.accentA} name="Set A · gc4" hex="#B9FF3A" rgb="rgb(185,255,58)" />
          <ColorSwatch flex height={150} color={K.accentB} name="Set B · gc6" hex="#9BF80A" rgb="rgb(155,248,10)" />
          <ColorSwatch flex height={150} color={K.ink} name="Ink" hex="#14141A" rgb="rgb(20,20,26)" />
        </div>
        <div style={{ display: "flex", gap: 20, marginTop: 24, flexWrap: "wrap" }}>
          <ColorSwatch flex height={110} color={K.tileInk} name="Tile ink" hex="#0A0A0C" />
          <ColorSwatch flex height={110} color={K.surface} name="Surface" hex="#16171B" />
          <ColorSwatch flex height={110} color={K.paper} name="Paper" hex="#F6F3EC" bordered />
          <ColorSwatch flex height={110} color={K.white} name="White" hex="#FFFFFF" bordered />
        </div>
        <p style={{ marginTop: 32, maxWidth: 640, color: K.paraGrey, fontSize: 15, lineHeight: 1.55 }}>
          The neon greens are built for <b>dark surfaces</b>. Use ink or tile-ink
          as the background, green as a single high-energy accent, and
          white/paper for text on dark. On green, always use ink for text.
        </p>
        <Foot pageLabel="03 · Color" />
      </Page>

      {/* ===== TYPOGRAPHY ===== */}
      <Page>
        <div style={kick(K.kickGreyPaper)}>Type</div>
        <h2 style={h2Style}>Typography</h2>
        <div style={{ borderBottom: `1px solid ${K.cardBorder}`, paddingBottom: 26, marginBottom: 26 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
            <div style={{ fontFamily: "'Sora', sans-serif", fontSize: 30, fontWeight: 800 }}>Sora</div>
            <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 12, color: K.capGrey }}>
              Display · Wordmark · Headings
            </div>
          </div>
          <div style={{ fontFamily: "'Sora', sans-serif", fontSize: 64, fontWeight: 800, letterSpacing: -3, marginTop: 14 }}>
            Aa Bb Cc
          </div>
          <div style={{ fontFamily: "'Sora', sans-serif", fontSize: 22, marginTop: 8, color: K.bodyGrey }}>
            The quick brown fox jumps over the lazy dog 0123456789
          </div>
          <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 12, color: K.capGrey, marginTop: 14 }}>
            Weights: 400 · 500 · 600 · 700 · 800 &nbsp;|&nbsp; SIL OFL 1.1
          </div>
        </div>
        <div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
            <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 26, fontWeight: 600 }}>IBM Plex Mono</div>
            <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 12, color: K.capGrey }}>
              Labels · Code · Captions
            </div>
          </div>
          <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 40, fontWeight: 600, marginTop: 14 }}>
            Aa Bb Cc
          </div>
          <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 16, marginTop: 8, color: K.bodyGrey }}>
            The quick brown fox 0123456789
          </div>
          <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 12, color: K.capGrey, marginTop: 14 }}>
            Weights: 400 · 500 · 600 &nbsp;|&nbsp; SIL OFL 1.1
          </div>
        </div>
        <div
          style={{
            marginTop: 34,
            background: K.white,
            border: `1px solid ${K.cardBorder}`,
            borderRadius: 16,
            padding: 26,
          }}
        >
          <div
            style={{
              fontFamily: "'IBM Plex Mono', monospace",
              fontSize: 11,
              letterSpacing: 2,
              color: K.kickGreyPaper,
              textTransform: "uppercase",
            }}
          >
            Type scale
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: "8px 30px",
              marginTop: 14,
              fontSize: 14,
              color: K.bodyGrey,
            }}
          >
            <span>Display / wordmark — 800, tracking −2 to −6</span>
            <span>H1 — 40–56 / 800</span>
            <span>H2 — 24–32 / 700</span>
            <span>Body — 15–17 / 400–500</span>
            <span>Caption — 10–12 / 600 mono, UPPERCASE +2</span>
            <span>Telugu variant — Baloo Tammudu 2</span>
          </div>
        </div>
        <Foot pageLabel="04 · Type" />
      </Page>

      {/* ===== USAGE ===== */}
      <Page>
        <div style={kick(K.kickGreyPaper)}>Application</div>
        <h2 style={h2Style}>Clear space, sizing &amp; usage</h2>
        <div style={{ display: "flex", gap: 22, flexWrap: "wrap" }}>
          <div>
            <div style={{ ...cardBase, width: 280, height: 200, background: K.tileInk, position: "relative" }}>
              <div
                style={{
                  position: "absolute",
                  inset: 26,
                  border: `1px dashed ${hexA(K.accentA, 0.4)}`,
                  borderRadius: 8,
                }}
              />
              <Mark size={70} ring={K.accentA} dot={K.accentA} />
            </div>
            <div style={capStyle}>Clear space = inner-dot height, all sides</div>
          </div>
          <div>
            <div style={{ ...cardBase, width: 280, height: 200, gap: 26 }}>
              <div
                style={{
                  width: 24,
                  height: 24,
                  borderRadius: 6,
                  background: K.tileInk,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <Mark size={15} ring={K.accentA} dot={K.accentA} r={32} sw={13} dr={14} />
              </div>
              <div
                style={{
                  width: 40,
                  height: 40,
                  borderRadius: 10,
                  background: K.accentA,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <Mark size={24} ring={K.tileInk} dot={K.tileInk} r={32} sw={12} dr={13} />
              </div>
            </div>
            <div style={capStyle}>Min: mark 24px · app icon 40px</div>
          </div>
        </div>

        <h3 style={{ ...h3Style, marginTop: 34 }}>Do &amp; Don't</h3>
        <div style={{ display: "flex", gap: 22, flexWrap: "wrap" }}>
          <div>
            <div style={{ ...cardBase, width: 200, height: 130, background: K.tileInk }}>
              <Mark size={50} ring={K.accentA} dot={K.accentA} />
            </div>
            <div style={{ ...capStyle, color: K.doGreen, display: "flex", alignItems: "center", gap: 6 }}>
              <Check className="h-3.5 w-3.5" /> Green on dark
            </div>
          </div>
          <div>
            <div style={{ ...cardBase, width: 200, height: 130, background: K.white }}>
              <div style={{ opacity: 0.9 }}>
                <Mark size={50} ring={K.accentA} dot={K.accentA} />
              </div>
            </div>
            <div style={{ ...capStyle, color: K.dontRed, display: "flex", alignItems: "center", gap: 6 }}>
              <X className="h-3.5 w-3.5" /> Green on white (low contrast)
            </div>
          </div>
          <div>
            <div style={{ ...cardBase, width: 200, height: 130, background: K.tileInk }}>
              <svg width="70" height="50" viewBox="0 0 140 100" preserveAspectRatio="none">
                <circle cx="70" cy="50" r="34" fill="none" stroke={K.accentA} strokeWidth="11" />
                <circle cx="70" cy="50" r="9" fill={K.accentA} />
              </svg>
            </div>
            <div style={{ ...capStyle, color: K.dontRed, display: "flex", alignItems: "center", gap: 6 }}>
              <X className="h-3.5 w-3.5" /> Never stretch
            </div>
          </div>
          <div>
            <div style={{ ...cardBase, width: 200, height: 130, background: K.tileInk }}>
              <div style={{ filter: `drop-shadow(0 4px 6px ${hexA(K.accentA, 0.9)})` }}>
                <Mark size={50} ring={K.accentA} dot={K.accentA} />
              </div>
            </div>
            <div style={{ ...capStyle, color: K.dontRed, display: "flex", alignItems: "center", gap: 6 }}>
              <X className="h-3.5 w-3.5" /> No glows / shadows
            </div>
          </div>
        </div>

        <h3 style={{ ...h3Style, marginTop: 34 }}>UI elements</h3>
        <div style={{ display: "flex", gap: 22, alignItems: "center", flexWrap: "wrap" }}>
          <div
            style={{
              background: K.accentA,
              color: K.tileInk,
              borderRadius: 13,
              padding: "14px 24px",
              fontWeight: 700,
              fontSize: 15,
              display: "flex",
              gap: 10,
              alignItems: "center",
            }}
          >
            <Mark size={18} ring={K.tileInk} dot={K.tileInk} r={32} sw={13} dr={15} />
            Generate
          </div>
          <div
            style={{
              border: `2px solid ${K.ink}`,
              color: K.ink,
              borderRadius: 13,
              padding: "11px 22px",
              fontWeight: 600,
              fontSize: 14,
            }}
          >
            Publish
          </div>
          <div
            style={{
              background: K.ink,
              color: K.accentA,
              borderRadius: 30,
              padding: "9px 20px",
              fontWeight: 800,
              fontSize: 15,
            }}
          >
            KOKAO
          </div>
          <div
            style={{
              background: K.aiStudioBg,
              color: K.aiStudioText,
              borderRadius: 30,
              padding: "8px 18px",
              fontWeight: 600,
              fontSize: 13,
              display: "flex",
              gap: 6,
              alignItems: "center",
            }}
          >
            <Sparkles className="h-3.5 w-3.5" /> AI Studio
          </div>
        </div>
        <Foot pageLabel="05 · Usage" />
      </Page>
    </div>
  );
}

function ColorSwatch({
  color,
  height,
  name,
  hex,
  rgb,
  bordered,
  flex,
}: {
  color: string;
  height: number;
  name: string;
  hex: string;
  rgb?: string;
  bordered?: boolean;
  flex?: boolean;
}) {
  return (
    <div style={flex ? { flex: 1, minWidth: 200 } : undefined}>
      <div
        style={{
          height,
          borderRadius: 16,
          background: color,
          border: bordered ? `1px solid ${K.cardBorder}` : undefined,
        }}
      />
      <div style={{ marginTop: 12 }}>
        <b style={{ fontFamily: "'Sora', sans-serif" }}>{name}</b>
        <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 12, color: K.paraGrey, marginTop: 4 }}>
          {hex}
          {rgb ? (
            <>
              <br />
              {rgb}
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function hexA(hex: string, alpha: number): string {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}
