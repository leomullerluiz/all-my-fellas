import type { MetadataRoute } from "next";

import { SITE_URL } from "@/lib/content";

/*
 * Emitted as `out/sitemap.xml`.
 *
 * One entry, because the site is one page — the nav targets are anchors, not
 * URLs, and listing `#pipeline` as a location would be wrong. Unlike robots.txt,
 * a sitemap *is* valid at a subpath as long as every URL it lists sits at or
 * below that path, so this one works as published. It still has to be submitted
 * manually in Search Console: the robots.txt that would normally advertise it
 * is unreachable at a project-site subpath.
 *
 * `lastModified` is the build timestamp — the workflow only rebuilds when
 * `site/**` changes, so it tracks content changes rather than every push.
 */
// Required for `output: "export"` — see the note in robots.ts.
export const dynamic = "force-static";

const BUILT_AT = new Date();

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: `${SITE_URL}/`,
      lastModified: BUILT_AT,
      changeFrequency: "monthly",
      priority: 1,
    },
  ];
}
