"use client"

import { Toaster as Sonner, type ToasterProps } from "sonner"
import { CircleCheckIcon, InfoIcon, TriangleAlertIcon, OctagonXIcon, Loader2Icon } from "lucide-react"

/**
 * shadcn's generated template resolves `theme` via `next-themes`'s
 * `useTheme()` and paints the toast surface with `var(--popover)` /
 * `var(--border)`. Neither exists in this codebase: theme is resolved
 * server-side once via `getSettings().theme` (see `layout.tsx`), and
 * `globals.css`'s `@theme inline` block only defines the `--color-` prefixed
 * token names, not the raw ones shadcn's default expects. So `theme` is
 * required as a prop instead of read from context, and the surface uses this
 * project's existing Tailwind color utilities (matching `badge.tsx` /
 * `button.tsx`) instead of shadcn's default inline CSS vars.
 */
const Toaster = ({ theme, ...props }: ToasterProps) => {
  return (
    <Sonner
      theme={theme}
      className="toaster group"
      icons={{
        success: (
          <CircleCheckIcon className="size-4" />
        ),
        info: (
          <InfoIcon className="size-4" />
        ),
        warning: (
          <TriangleAlertIcon className="size-4" />
        ),
        error: (
          <OctagonXIcon className="size-4" />
        ),
        loading: (
          <Loader2Icon className="size-4 animate-spin" />
        ),
      }}
      toastOptions={{
        classNames: {
          toast: "border border-border bg-surface-raised text-foreground rounded-md shadow-lg",
        },
      }}
      {...props}
    />
  )
}

export { Toaster }
