import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-full text-sm font-medium transition-all duration-200 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 active:scale-[0.98]",
  {
    variants: {
      variant: {
        // Glass style: translucent tinted pill with blur; hover brightens the
        // glass (stays glass, no solid fill).
        default: "glass-btn text-primary",
        destructive:
          "border border-destructive/25 bg-destructive/10 text-destructive backdrop-blur-md shadow-[inset_0_1px_0_0_rgba(255,255,255,0.6),0_4px_16px_-4px_rgba(0,0,0,0.15)] hover:bg-destructive/20 hover:border-destructive/40",
        outline: "glass-btn-neutral",
        secondary: "glass-btn-neutral text-secondary-foreground",
        ghost:
          "border border-transparent hover:bg-white/40 dark:hover:bg-white/10 hover:backdrop-blur-md hover:border-foreground/10",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "min-h-9 px-5 py-2",
        sm: "min-h-8 px-4 text-xs",
        lg: "min-h-10 px-8",
        icon: "h-9 w-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button"
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    )
  }
)
Button.displayName = "Button"

export { Button, buttonVariants }
