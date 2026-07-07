You are given a task to integrate an existing React component in the codebase

The codebase should support:
- shadcn project structure  
- Tailwind CSS
- Typescript

If it doesn't, provide instructions on how to setup project via shadcn CLI, install Tailwind or Typescript.

Determine the default path for components and styles. 
If default path for components is not /components/ui, provide instructions on why it's important to create this folder
Copy-paste this component to /components/ui folder:
```tsx
glass-button.tsx
import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

function cn(...inputs: (string | undefined | null | false)[]): string {
  return inputs.filter(Boolean).join(" ");
}

const glassButtonVariants = cva(
  "relative isolate all-unset cursor-pointer rounded-full transition-all",
  {
    variants: {
      size: {
        default: "text-base font-medium",
        sm: "text-sm font-medium",
        lg: "text-lg font-medium",
        icon: "h-10 w-10",
      },
    },
    defaultVariants: {
      size: "default",
    },
  }
);

const glassButtonTextVariants = cva(
  "glass-button-text relative block select-none tracking-tighter",
  {
    variants: {
      size: {
        default: "px-6 py-3.5",
        sm: "px-4 py-2",
        lg: "px-8 py-4",
        icon: "flex h-10 w-10 items-center justify-center",
      },
    },
    defaultVariants: {
      size: "default",
    },
  }
);

export interface GlassButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof glassButtonVariants> {
  contentClassName?: string;
}

const GlassButton = React.forwardRef<HTMLButtonElement, GlassButtonProps>(
  ({ className, children, size, contentClassName, ...props }, ref) => {
    return (
      <div
        className={cn(
          "glass-button-wrap cursor-pointer rounded-full",
          className
        )}
      >
        <button
          className={cn("glass-button", glassButtonVariants({ size }))}
          ref={ref}
          {...props}
        >
          <span
            className={cn(
              glassButtonTextVariants({ size }),
              contentClassName
            )}
          >
            {children}
          </span>
        </button>
        <div className="glass-button-shadow rounded-full"></div>
      </div>
    );
  }
);
GlassButton.displayName = "GlassButton";

export { GlassButton, glassButtonVariants };

demo.tsx
import { GlassButton } from "@/components/ui/glass-button";

const ZapIcon = (props: React.SVGProps<SVGSVGElement>) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="24"
    height="24"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    {...props}
  >
    <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
  </svg>
);

const DottedBackground = () => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    height="100%"
    width="100%"
    className="pointer-events-none absolute inset-0 z-0"
  >
    <defs>
      <pattern
        patternUnits="userSpaceOnUse"
        height="30"
        width="30"
        id="dottedGrid"
      >
        <circle
          fill="oklch(from var(--foreground) l c h / 30%)"
          r="1"
          cy="2"
          cx="2"
        ></circle>
      </pattern>
    </defs>
    <rect fill="url(#dottedGrid)" height="100%" width="100%"></rect>
  </svg>
);

const GlassButtonDemo = () => {
  return (
    <div className="relative flex h-screen w-full flex-col items-center justify-center gap-8 bg-background p-10">
      <DottedBackground />
      <div className="z-10 text-center">
        <div className="mt-4 flex flex-wrap items-center justify-center gap-6">
          <GlassButton
            size="sm"
          >
            Small
          </GlassButton>
          <GlassButton
            size="default"
            contentClassName="flex items-center gap-2"
          >
            <span>Generate</span>
            
            <ZapIcon className="h-5 w-5" />
          </GlassButton>
          <GlassButton
            size="lg"
          >
            Submit
          </GlassButton>
          <GlassButton
            size="icon"
          >
            <ZapIcon className="h-5 w-5" />
          </GlassButton>
        </div>
      </div>
    </div>
  );
};

export default GlassButtonDemo;

```

Install NPM dependencies:
```bash
class-variance-authority
```

Implementation Guidelines
 1. Analyze the component structure and identify all required dependencies
 2. Review the component's argumens and state
 3. Identify any required context providers or hooks and install them
 4. Questions to Ask
 - What data/props will be passed to this component?
 - Are there any specific state management requirements?
 - Are there any required assets (images, icons, etc.)?
 - What is the expected responsive behavior?
 - What is the best place to use this component in the app?

Steps to integrate
 0. Copy paste all the code above in the correct directories
 1. Install external dependencies
 2. Fill image assets with Unsplash stock images you know exist
 3. Use lucide-react icons for svgs or logos if component requires them
