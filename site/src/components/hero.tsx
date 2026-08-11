"use client";

import { ArrowRight, Sparkles } from "lucide-react";

import { StarLayer } from "@/components/animate-ui/components/backgrounds/stars";
import { Magnetic } from "@/components/animate-ui/primitives/effects/magnetic";
import {
  RippleButton,
  RippleButtonRipples,
} from "@/components/animate-ui/primitives/buttons/ripple";
import { CountingNumber } from "@/components/animate-ui/primitives/texts/counting-number";
import { GradientText } from "@/components/animate-ui/primitives/texts/gradient";
import { SplittingText } from "@/components/animate-ui/primitives/texts/splitting";
import {
  TypingText,
  TypingTextCursor,
} from "@/components/animate-ui/primitives/texts/typing";
import { GithubMark } from "@/components/icons";
import { Reveal } from "@/components/reveal";
import { REPO_URL, STATS } from "@/lib/content";

const TICKER = [
  "stakeholder · writing brief.md",
  "architect · reading the repository",
  "plan gate · waiting on you",
  "developer · committing to the task branch",
  "verification · npm test exited 0",
  "code review · never saw the developer's transcript",
  "qa · checking the acceptance criteria",
  "delivery · opening the pull request",
];

export function Hero() {
  return (
    <section id="top" className="relative isolate overflow-hidden border-b border-border">
      <div className="pointer-events-none absolute inset-0 bg-grid" aria-hidden />
      <div className="pointer-events-none absolute inset-0 overflow-hidden opacity-80" aria-hidden>
        <StarLayer
          count={340}
          size={1}
          starColor="var(--star-color)"
          transition={{ repeat: Infinity, duration: 160, ease: "linear" }}
        />
      </div>
      <div
        className="pointer-events-none absolute left-1/2 top-[-18rem] size-[44rem] -translate-x-1/2 rounded-full blur-[130px]"
        style={{ background: "var(--glow)" }}
        aria-hidden
      />

      <div className="relative mx-auto max-w-[1120px] px-6 pb-20 pt-20 sm:pt-28">
        <Reveal inView={false} delay={40}>
          <span className="inline-flex items-center gap-2 rounded-full border border-accent/40 bg-accent/10 px-3 py-1 text-[11px] font-medium leading-tight text-accent">
            <Sparkles className="size-3" />
            Built on the Claude Agent SDK
          </span>
        </Reveal>

        <h1 className="mt-6 max-w-3xl text-4xl font-semibold leading-[1.08] tracking-tight sm:text-5xl lg:text-6xl">
          <SplittingText
            text="Describe a feature."
            type="words"
            delay={180}
            stagger={0.08}
            initial={{ y: 24, opacity: 0, filter: "blur(6px)" }}
            animate={{ y: 0, opacity: 1, filter: "blur(0px)" }}
            transition={{ duration: 0.55, ease: "easeOut" }}
            className="block"
          />
          {/* `asChild` so the wrapper is a span: an <h1> takes phrasing
              content, and Effect's default motion.div would not be valid here. */}
          <Reveal asChild inView={false} delay={620} slide={{ direction: "up", offset: 24 }}>
            <span className="block pb-1">
              <GradientText
                text="Get back a pull request."
                gradient="linear-gradient(90deg, var(--accent) 0%, var(--info) 22%, var(--success) 50%, var(--info) 78%, var(--accent) 100%)"
              />
            </span>
          </Reveal>
        </h1>

        <Reveal inView={false} delay={780}>
          <p className="mt-6 max-w-2xl text-base leading-relaxed text-muted sm:text-lg">
            A local delivery pipeline staffed by LLM agents — stakeholder, product owner,
            architect, developer, code review, QA and homologation — with the test suite run by
            the pipeline itself in between. The brief, the stories and the technical plan are
            written for you. Your job is to read the plan and say yes or no.
          </p>
        </Reveal>

        <Reveal inView={false} delay={880}>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Magnetic strength={0.28} range={110}>
              <RippleButton asChild hoverScale={1.03} tapScale={0.97}>
                <a
                  href="#start"
                  className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-accent px-5 text-sm font-medium text-accent-foreground"
                >
                  Get started
                  <ArrowRight className="size-4" />
                  <RippleButtonRipples />
                </a>
              </RippleButton>
            </Magnetic>

            <a
              href={REPO_URL}
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-10 items-center justify-center gap-2 rounded-md border border-border bg-surface-raised px-5 text-sm font-medium transition-colors hover:bg-border/40"
            >
              <GithubMark className="size-4" />
              Read the source
            </a>
          </div>
        </Reveal>

        {/*
         * A standing-in-for-a-screenshot ticker. It types the same stage labels
         * the dashboard shows on a running card, which is the fastest way to say
         * "this is a pipeline, and it narrates itself" without a video.
         */}
        <Reveal inView={false} delay={1000}>
          <div className="mt-10 max-w-xl rounded-lg border border-border bg-surface px-4 py-3 font-mono text-xs shadow-sm sm:text-[13px]">
            <div className="flex items-center gap-2">
              <span className="inline-block size-1.5 shrink-0 rounded-full bg-success animate-pipeline-pulse" aria-hidden />
              <span className="shrink-0 text-muted">worker</span>
              <span className="shrink-0 text-border" aria-hidden>
                │
              </span>
              <TypingText
                text={TICKER}
                loop
                duration={26}
                holdDelay={1500}
                delay={1400}
                className="min-w-0 truncate text-foreground"
              >
                <TypingTextCursor
                  className="bg-accent"
                  style={{ height: "0.95em", transform: "translateY(0.15em)" }}
                />
              </TypingText>
            </div>
          </div>
        </Reveal>

        <dl className="mt-14 grid grid-cols-2 gap-x-6 gap-y-8 border-t border-border pt-8 lg:grid-cols-4">
          {/* Reveal renders the <div> a <dl> is allowed to wrap each pair in. */}
          {STATS.map((stat, index) => (
            <Reveal key={stat.label} inView={false} delay={1100 + index * 90}>
              <dt className="sr-only">{stat.label}</dt>
              <dd>
                <span className="text-3xl font-semibold tracking-tight tabular-nums">
                  <CountingNumber
                    number={stat.value}
                    delay={1200 + index * 90}
                    transition={{ stiffness: 110, damping: 40 }}
                  />
                </span>
                <span className="mt-1 block text-sm font-medium">{stat.label}</span>
                <span className="mt-0.5 block text-xs text-muted">{stat.detail}</span>
              </dd>
            </Reveal>
          ))}
        </dl>
      </div>
    </section>
  );
}
