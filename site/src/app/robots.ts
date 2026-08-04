import type { MetadataRoute } from "next";

import { SITE_URL } from "@/lib/content";

/*
 * Emitted as `out/robots.txt`.
 *
 * Caveat worth knowing: crawlers only read robots.txt from the *domain* root,
 * and this is a GitHub Pages project site served from a subpath — so at
 * `<user>.github.io/all-my-fellas/robots.txt` nothing reads it. It is here so
 * the file is correct the day the site moves to a custom domain, and so the
 * sitemap location is recorded somewhere discoverable. Until then, submit the
 * sitemap URL by hand in Search Console.
 */
// Metadata routes are Route Handlers; `output: "export"` refuses to build one
// that has not declared itself static.
export const dynamic = "force-static";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
    },
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  };
}
