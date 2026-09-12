"use client";

import { memo, type ComponentProps } from "react";
import { Streamdown } from "streamdown";

/**
 * Vendored from Vercel AI Elements' MessageResponse component and intentionally
 * kept small for this repository. It gives every AI-generated response proper
 * streaming-aware Markdown rendering instead of raw text output.
 */
export type MessageResponseProps = ComponentProps<typeof Streamdown>;

export const MessageResponse = memo(
  ({ className, ...props }: MessageResponseProps) => (
    <Streamdown
      className={`size-full [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 ${className ?? ""}`}
      {...props}
    />
  ),
  (prevProps, nextProps) =>
    prevProps.children === nextProps.children &&
    nextProps.isAnimating === prevProps.isAnimating,
);

MessageResponse.displayName = "MessageResponse";
