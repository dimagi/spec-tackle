import { memo, type ElementType } from "react";

type Props = { html: string; className?: string; as?: ElementType } & Record<string, unknown>;

/**
 * Server-rendered HTML. React only rewrites innerHTML when the string changes, so DOM
 * classes the review UI adds inside it (anchor highlights) survive re-renders.
 */
export const Html = memo(function Html({ html, as: Tag = "div", ...rest }: Props) {
  return <Tag {...rest} dangerouslySetInnerHTML={{ __html: html }} />;
});
