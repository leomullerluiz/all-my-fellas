import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";

import { MotionProvider } from "@/components/motion-provider";
import { REPO_URL, SITE_DESCRIPTION, SITE_NAME, SITE_URL } from "@/lib/content";

import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const OG_TITLE = "Describe a feature. Get back a pull request.";
const OG_ALT = "All My Fellas — describe a feature, get back a pull request";

export const metadata: Metadata = {
  /*
   * Resolves every relative metadata URL — the OG image, the canonical link —
   * into an absolute one. Without it Next warns at build time and social
   * crawlers, which do not resolve relative paths, silently get no image.
   */
  metadataBase: new URL(SITE_URL),
  title: {
    default: "All My Fellas — a delivery pipeline staffed by LLM agents",
    // Used if the site ever grows a second page.
    template: `%s — ${SITE_NAME}`,
  },
  description: SITE_DESCRIPTION,
  applicationName: SITE_NAME,
  authors: [{ name: "Leonan Müller", url: "https://github.com/leomullerluiz" }],
  creator: "Leonan Müller",
  keywords: [
    "Claude Agent SDK",
    "AI coding agent",
    "multi-agent pipeline",
    "autonomous software delivery",
    "AI code review",
    "AI pull request",
    "agentic workflow",
    "self-hosted developer tool",
    "GitHub GitLab Bitbucket Azure DevOps automation",
  ],
  category: "technology",
  alternates: { canonical: SITE_URL },
  /*
   * Declared by hand rather than left to the `opengraph-image`/`apple-icon` file
   * conventions, which get two things wrong under `output: "export"` + basePath:
   * they emit the route without the basePath (a 404 on a project site), and they
   * emit it without a file extension, which a static host turns into the wrong
   * Content-Type. The images are named Route Handlers instead — see
   * src/app/og.png/route.tsx.
   */
  openGraph: {
    type: "website",
    url: SITE_URL,
    siteName: SITE_NAME,
    title: OG_TITLE,
    description: SITE_DESCRIPTION,
    locale: "en_US",
    images: [{ url: `${SITE_URL}/og.png`, width: 1200, height: 630, alt: OG_ALT }],
  },
  twitter: {
    card: "summary_large_image",
    title: OG_TITLE,
    description: SITE_DESCRIPTION,
    images: [{ url: `${SITE_URL}/og.png`, alt: OG_ALT }],
  },
  icons: {
    icon: [{ url: `${SITE_URL}/icon.svg`, type: "image/svg+xml" }],
    apple: [{ url: `${SITE_URL}/apple-touch-icon.png`, sizes: "180x180", type: "image/png" }],
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      // Lets Google use the full OG image and a longer snippet in results.
      "max-image-preview": "large",
      "max-snippet": -1,
      "max-video-preview": -1,
    },
  },
  other: {
    "github:repo": REPO_URL,
  },
};

export const viewport: Viewport = {
  // Matches the palette's two backgrounds so mobile browser chrome blends in.
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f6f7f9" },
    { media: "(prefers-color-scheme: dark)", color: "#0b0d12" },
  ],
  colorScheme: "dark light",
};

/*
 * Applies the stored theme before first paint. Without this the page renders
 * dark (the CSS default) and then snaps to light for anyone who chose light —
 * a flash no amount of React lifecycle can prevent, because React runs after
 * the browser has already painted.
 */
const THEME_BOOTSTRAP = `
try {
  var t = localStorage.getItem("amf-theme");
  if (t === "dark" || t === "light") document.documentElement.dataset.theme = t;
} catch (e) {}
`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
      </head>
      <body className="flex min-h-full flex-col">
        <MotionProvider>{children}</MotionProvider>
      </body>
    </html>
  );
}
