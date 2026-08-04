import { ImageResponse } from "next/og";

/*
 * iOS home-screen icon. `icon.svg` covers browser tabs, but Safari wants a PNG
 * here, so the same three-node mark is redrawn in flexbox and rasterised at
 * build time. Apple applies its own rounding, hence the square background.
 *
 * A named route rather than the `apple-icon.tsx` convention, for the same reason
 * as og.png — see the note there.
 */

// `output: "export"` refuses to build a route that has not declared itself static.
export const dynamic = "force-static";

const SIZE = { width: 180, height: 180 };

const NODES = ["#6e8bff", "#e5b454", "#46c98b"];

export function GET() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          background: "#0b0d12",
        }}
      >
        {/*
          Geometry scaled straight off icon.svg (×5.625 from its 32px grid), so
          the two marks are the same drawing: 36px nodes, 45px apart, on a 14px
          spine. The spine is painted first and the nodes cover its ends.
        */}
        <div
          style={{
            position: "relative",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "space-between",
            width: 36,
            height: 126,
          }}
        >
          <div
            style={{
              position: "absolute",
              display: "flex",
              left: 11,
              top: 18,
              width: 14,
              height: 90,
              borderRadius: 999,
              background: "#2b3145",
            }}
          />
          {NODES.map((color) => (
            <div
              key={color}
              style={{
                display: "flex",
                width: 36,
                height: 36,
                borderRadius: 999,
                background: color,
              }}
            />
          ))}
        </div>
      </div>
    ),
    SIZE,
  );
}
