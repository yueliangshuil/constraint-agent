"use client";

import { useMemo } from "react";
import MarkdownIt from "markdown-it";
import DOMPurify from "isomorphic-dompurify";

/**
 * Markdown 渲染（markdown-it + DOMPurify）
 * 模型输出视为不可信内容，渲染前统一 XSS 清洗；排版用 Tailwind prose。
 */
const md = new MarkdownIt({ html: true, linkify: true, breaks: true });

export default function Markdown({ content }: { content: string }) {
  const html = useMemo(() => {
    const raw = md.render(content);
    return DOMPurify.sanitize(raw);
  }, [content]);

  return (
    <div
      className="prose prose-sm dark:prose-invert max-w-none"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
