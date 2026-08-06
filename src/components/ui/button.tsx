import { type VariantProps, cva } from "class-variance-authority";
import { Slot } from "radix-ui";
import type { ButtonHTMLAttributes, Ref } from "react";

import { cn } from "@/lib/utils";

export const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 rounded-md text-sm font-medium transition-colors " +
    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent " +
    "disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        primary: "bg-accent text-accent-foreground hover:opacity-90",
        secondary: "border border-border bg-surface-raised hover:bg-border/40",
        ghost: "hover:bg-border/40",
        danger: "bg-danger text-white hover:opacity-90",
        success: "bg-success text-black hover:opacity-90",
      },
      size: {
        sm: "h-8 px-3",
        md: "h-9 px-4",
        lg: "h-10 px-5",
        // Square, icon-only footprint — added for the `Calendar` component's
        // nav/day buttons (`task-filter-bar.tsx`), which have no text label.
        icon: "size-8 p-0",
      },
    },
    defaultVariants: { variant: "primary", size: "md" },
  },
);

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof buttonVariants> & { asChild?: boolean; ref?: Ref<HTMLButtonElement> };

// `ref` is accepted as a plain prop (React 19 no longer needs `forwardRef`) so
// `Calendar`'s day buttons (`calendar.tsx`) can focus the keyboard-navigated
// cell imperatively, same as upstream shadcn's generated component does.
export function Button({ className, variant, size, asChild = false, ref, ...props }: ButtonProps) {
  const Comp = asChild ? Slot.Root : "button";
  return (
    <Comp
      ref={ref}
      data-slot="button"
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  );
}
