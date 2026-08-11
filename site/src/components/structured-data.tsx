import { FAQ, REPO_URL, SITE_DESCRIPTION, SITE_NAME, SITE_URL } from "@/lib/content";

/**
 * schema.org markup, built from the same `content.ts` the page renders so the
 * two can never describe different products.
 *
 * Deliberately no `aggregateRating` or `review`: those are what actually earn a
 * rich result for SoftwareApplication, and there is no honest data behind them.
 */
function softwareApplication() {
  return {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: SITE_NAME,
    description: SITE_DESCRIPTION,
    url: `${SITE_URL}/`,
    applicationCategory: "DeveloperApplication",
    applicationSubCategory: "Software delivery automation",
    operatingSystem: "Linux, macOS, Windows",
    isAccessibleForFree: true,
    codeRepository: REPO_URL,
    author: {
      "@type": "Person",
      name: "Leonan Müller",
      url: "https://github.com/leomullerluiz",
    },
    softwareRequirements: "Node.js >= 20.9, git, a Claude credential",
    keywords:
      "Claude Agent SDK, OpenAI, Gemini, multi-agent pipeline, AI code review, autonomous software delivery",
  };
}

/**
 * The FAQ section verbatim. Google has narrowed FAQ rich results to a handful of
 * site categories, so treat this as machine-readable context rather than a
 * guaranteed SERP feature — the content is genuinely Q&A either way.
 */
function faqPage() {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: FAQ.map((item) => ({
      "@type": "Question",
      name: item.question,
      acceptedAnswer: { "@type": "Answer", text: item.answer },
    })),
  };
}

/**
 * `<` is escaped because a literal `</script>` anywhere in the payload would
 * close the tag early. Nothing here is user-supplied today, but the escape is
 * what keeps that true if the copy ever comes from somewhere else.
 */
function serialize(payload: unknown): string {
  return JSON.stringify(payload).replace(/</g, "\\u003c");
}

export function StructuredData() {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: serialize(softwareApplication()) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: serialize(faqPage()) }}
      />
    </>
  );
}
