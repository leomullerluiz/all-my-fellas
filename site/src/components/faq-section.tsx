"use client";

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/animate-ui/components/radix/accordion";
import { Reveal } from "@/components/reveal";
import { FAQ } from "@/lib/content";

export function FaqSection() {
  return (
    <Reveal>
      <Accordion
        type="single"
        collapsible
        className="rounded-lg border border-border bg-surface px-5"
      >
        {FAQ.map((item) => (
          <AccordionItem key={item.value} value={item.value} className="border-border">
            <AccordionTrigger className="text-sm hover:no-underline">
              {item.question}
            </AccordionTrigger>
            <AccordionContent className="max-w-3xl leading-relaxed text-muted">
              {item.answer}
            </AccordionContent>
          </AccordionItem>
        ))}
      </Accordion>
    </Reveal>
  );
}
