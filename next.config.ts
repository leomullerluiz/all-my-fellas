import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // `better-sqlite3` is a native addon; it must be `require`d at runtime instead
  // of being bundled by Turbopack into the server output.
  serverExternalPackages: ["better-sqlite3"],
};

export default nextConfig;
