import { ButtonHTMLAttributes, forwardRef } from "react";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "ghost" | "danger";
  size?: "sm" | "md";
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = "primary", size = "md", className = "", children, ...props }, ref) => {
    const base =
      "inline-flex items-center justify-center font-medium rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed";

    const variants = {
      primary: "bg-brand text-white hover:bg-brand-600",
      ghost:   "text-gray-600 hover:bg-gray-100 hover:text-gray-900",
      danger:  "bg-red-500 text-white hover:bg-red-600",
    };

    const sizes = {
      sm: "text-xs px-2.5 py-1.5 gap-1",
      md: "text-sm px-4 py-2 gap-2",
    };

    return (
      <button
        ref={ref}
        className={`${base} ${variants[variant]} ${sizes[size]} ${className}`}
        {...props}
      >
        {children}
      </button>
    );
  }
);

Button.displayName = "Button";
