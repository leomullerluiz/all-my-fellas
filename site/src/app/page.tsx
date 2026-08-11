import { Controls } from "@/components/controls";
import { FaqSection } from "@/components/faq-section";
import { Guardrails } from "@/components/guardrails";
import { Hero } from "@/components/hero";
import { Pillars } from "@/components/pillars";
import { Pipeline } from "@/components/pipeline";
import { Quickstart } from "@/components/quickstart";
import { Repositories } from "@/components/repositories";
import { Reveal } from "@/components/reveal";
import { Section } from "@/components/section";
import { SiteFooter } from "@/components/site-footer";
import { SiteNav } from "@/components/site-nav";
import { StructuredData } from "@/components/structured-data";

export default function Home() {
  return (
    <>
      <StructuredData />
      <SiteNav />

      <main className="flex-1">
        <Hero />

        <Section
          id="pipeline"
          eyebrow="The pipeline"
          title="Seven agent stages, two human decisions, one branch"
          lede="Every stage is a brand-new session that receives only the artifacts the previous stages produced. Each one leaves a validated Markdown document behind, so a retry costs one stage rather than the whole run."
        >
          <Pipeline />
        </Section>

        <Section
          id="why"
          eyebrow="Why All My Fellas"
          title="One agent can write the code. It cannot review it."
          lede="A one-line fix is faster by hand than seven agent stages and two gates. This earns its cost on work you would have written a plan for anyway."
        >
          <Pillars />
        </Section>

        <Section
          id="guardrails"
          eyebrow="Guardrails"
          title="What each role is allowed to touch"
          lede="Least privilege per role, enforced at the tool call rather than in the prompt. Every call — including the Developer's edits — passes a guard that confines paths to the task workspace and blocks destructive or credential-touching commands."
        >
          <Guardrails />
        </Section>

        <Section
          id="control"
          eyebrow="Running it unattended"
          title="Start it, close the tab"
          lede="The thesis is write the task and walk away, which only holds if walking away is safe. Everything here exists so that leaving is a decision rather than a gamble."
        >
          <Controls />
        </Section>

        <Section
          id="repositories"
          eyebrow="Repositories"
          title="Four APIs, and a fallback for everything else"
          lede="The provider is detected from the URL you paste, the connection is verified immediately, and the repository's real default branch is reported back — a main/master mismatch is the most common reason a first task dies at clone time."
        >
          <Repositories />
        </Section>

        <Section
          id="start"
          eyebrow="Get started"
          title="It runs on your machine"
          lede="Node 20.9 or newer, git on PATH, a Claude credential and a token for your git host. No provider CLI is needed — the pipeline calls each host's REST API directly."
        >
          <Quickstart />
        </Section>

        <Section id="faq" eyebrow="Questions" title="What it does not do">
          <FaqSection />
        </Section>

        <section className="border-b border-border">
          <div className="mx-auto max-w-[1120px] px-6 py-20 text-center">
            <Reveal>
              <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">
                Read the plan. Approve the diff. Merge it yourself.
              </h2>
            </Reveal>
            <Reveal delay={80}>
              <p className="mx-auto mt-4 max-w-xl text-sm leading-relaxed text-muted sm:text-base">
                Everything in between is someone else&apos;s job now.
              </p>
            </Reveal>
          </div>
        </section>
      </main>

      <SiteFooter />
    </>
  );
}
