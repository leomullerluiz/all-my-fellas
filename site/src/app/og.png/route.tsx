import { ImageResponse } from "next/og";

/*
 * The card social platforms and Google render for this page, generated at build
 * time — no binary asset to keep in sync with the copy.
 *
 * Deliberately a Route Handler at `og.png/route.tsx` rather than the
 * `opengraph-image.tsx` file convention. Under `output: "export"` + basePath the
 * convention gets two things wrong: it writes the file with no extension, so a
 * static host serves a PNG under the wrong Content-Type, and it overrides
 * `metadata.openGraph.images` — the one place the missing basePath could be
 * corrected. A named route exports to `out/og.png` and leaves metadata alone.
 *
 * Satori (what powers ImageResponse) supports flexbox and a subset of CSS only:
 * every element with more than one child needs an explicit `display`.
 */

// `output: "export"` refuses to build a route that has not declared itself static.
export const dynamic = "force-static";

const SIZE = { width: 1200, height: 630 };

const NODES = [
  { color: "#6e8bff", label: "agent" },
  { color: "#e5b454", label: "human gate" },
  { color: "#46c98b", label: "delivery" },
];

export function GET() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          background: "#0b0d12",
          backgroundImage:
            "radial-gradient(1000px 500px at 20% -10%, rgba(110,139,255,0.22), transparent 60%)",
          padding: 72,
          fontFamily: "sans-serif",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <div
            style={{
              display: "flex",
              width: 14,
              height: 14,
              borderRadius: 999,
              background: "#6e8bff",
            }}
          />
          <div style={{ fontSize: 30, color: "#e6e9ef", fontWeight: 600, letterSpacing: -0.5 }}>
            All My Fellas
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column" }}>
          <div
            style={{
              fontSize: 76,
              lineHeight: 1.1,
              color: "#e6e9ef",
              fontWeight: 700,
              letterSpacing: -2,
            }}
          >
            Describe a feature.
          </div>
          <div
            style={{
              fontSize: 76,
              lineHeight: 1.1,
              color: "#6e8bff",
              fontWeight: 700,
              letterSpacing: -2,
            }}
          >
            Get back a pull request.
          </div>
          <div style={{ marginTop: 28, fontSize: 30, lineHeight: 1.4, color: "#99a1b3" }}>
            A delivery pipeline staffed entirely by Claude agents.
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          {NODES.map((node) => (
            <div
              key={node.label}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                border: "1px solid #262b38",
                background: "#12151d",
                borderRadius: 999,
                padding: "10px 22px",
                fontSize: 24,
                color: "#99a1b3",
              }}
            >
              <div
                style={{
                  display: "flex",
                  width: 10,
                  height: 10,
                  borderRadius: 999,
                  background: node.color,
                }}
              />
              {node.label}
            </div>
          ))}
          <div style={{ marginLeft: "auto", fontSize: 24, color: "#626b7d" }}>
            7 agent stages · 2 human gates
          </div>
        </div>
      </div>
    ),
    SIZE,
  );
}
