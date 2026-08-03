import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";

import { MotionProvider } from "@/components/motion-provider";

import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const description =
  "A local software delivery pipeline staffed entirely by Claude agents. Describe a feature; get back a branch and an open pull request on GitHub, GitLab, Bitbucket or Azure DevOps.";

export const metadata: Metadata = {
  title: "All My Fellas — a delivery pipeline staffed by Claude agents",
  description,
  openGraph: {
    title: "All My Fellas",
    description,
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "All My Fellas",
    description,
  },
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
