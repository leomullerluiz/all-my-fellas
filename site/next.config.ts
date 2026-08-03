import path from "node:path";
import { fileURLToPath } from "node:url";

import type { NextConfig } from "next";

/*
 * GitHub Pages serves a project site from a subpath (`/all-my-fellas`), so every
 * asset URL has to carry that prefix — but only in the deployed build. The Pages
 * workflow sets NEXT_PUBLIC_BASE_PATH; `next dev` leaves it empty and serves
 * from the root, which is what you want locally.
 */
const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

const nextConfig: NextConfig = {
  /*
   * The pipeline's lockfile sits one directory up, so Turbopack would otherwise
   * infer the repository root as this app's root and widen module resolution and
   * file watching to the whole project. This app is self-contained.
   */
  turbopack: { root: path.dirname(fileURLToPath(import.meta.url)) },

  // No server, no SSR: `next build` writes plain HTML/CSS/JS into `out/`.
  output: "export",
  basePath,
  // `/about` -> `/about/index.html`, which is what a static host expects.
  trailingSlash: true,
  // The default image loader needs a server; Pages has none.
  images: { unoptimized: true },
};

export default nextConfig;
