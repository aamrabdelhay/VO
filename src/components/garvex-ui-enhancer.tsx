"use client";

import { useEffect, useRef } from "react";

function escapeHtml(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;");
}

function inlineMarkdown(value: string) {
  let html = escapeHtml(value);
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  html = html.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  html = html.replace(/_([^_]+)_/g, "<em>$1</em>");
  html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer noopener">$1</a>');
  return html;
}

function renderMarkdown(source: string) {
  const normalized = source.replace(/\r\n?/g, "\n").trim();
  if (!normalized) return "";
  const lines = normalized.split("\n");
  const out: string[] = [];
  let inCode = false;
  let code: string[] = [];
  let listType: "ul" | "ol" | null = null;
  let paragraph: string[] = [];

  const closeParagraph = () => {
    if (paragraph.length) {
      out.push(`<p>${paragraph.map(inlineMarkdown).join("<br>")}</p>`);
      paragraph = [];
    }
  };
  const closeList = () => {
    if (listType) {
      out.push(`</${listType}>`);
      listType = null;
    }
  };

  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      closeParagraph();
      closeList();
      if (!inCode) {
        inCode = true;
        code = [];
      } else {
        out.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
        inCode = false;
        code = [];
      }
      continue;
    }
    if (inCode) {
      code.push(line);
      continue;
    }
    if (!line.trim()) {
      closeParagraph();
      closeList();
      continue;
    }
    const heading = line.match(/^\s*(#{1,6})\s+(.+?)\s*$/);
    if (heading) {
      closeParagraph();
      closeList();
      const level = Math.min(6, heading[1].length);
      out.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`);
      continue;
    }
    const unordered = line.match(/^\s*[-*]\s+(.+)$/);
    if (unordered) {
      closeParagraph();
      if (listType !== "ul") {
        closeList();
        listType = "ul";
        out.push("<ul>");
      }
      out.push(`<li>${inlineMarkdown(unordered[1])}</li>`);
      continue;
    }
    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (ordered) {
      closeParagraph();
      if (listType !== "ol") {
        closeList();
        listType = "ol";
        out.push("<ol>");
      }
      out.push(`<li>${inlineMarkdown(ordered[1])}</li>`);
      continue;
    }
    closeList();
    paragraph.push(line.trim());
  }

  if (inCode) out.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
  closeParagraph();
  closeList();
  return out.join("");
}

function copyIcon(ok = false) {
  return ok
    ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg>'
    : '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="11" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h2"/></svg>';
}

function stageIndex(phase: string) {
  const value = phase.toLowerCase();
  if (/listen|thinking/.test(value)) return 0;
  if (/context|inspect|analy/.test(value)) return 1;
  if (/source|research|search|evidence/.test(value)) return 3;
  if (/final|complete|ready/.test(value)) return 4;
  return 2;
}

export function GarvexUiEnhancer() {
  const mutating = useRef(false);

  useEffect(() => {
    const enhance = () => {
      if (mutating.current) return;
      const welcome = document.querySelector<HTMLElement>(".garvex-v4-welcome");
      const orb = document.querySelector<HTMLElement>(".garvex-v4-orb-wrap");
      if (welcome && orb && !welcome.contains(orb)) {
        welcome.insertBefore(orb, welcome.firstChild);
      }

      document.querySelectorAll<HTMLButtonElement>(".garvex-v4-input-row > button").forEach((button, index) => {
        if (index === 0) {
          button.dataset.garvexLegacyRecord = "true";
          button.setAttribute("aria-hidden", "true");
          button.style.display = "none";
        }
      });

      document.querySelectorAll<HTMLElement>(".garvex-v4-message .garvex-v4-content").forEach((content) => {
        const raw = content.dataset.garvexRaw ?? content.textContent ?? "";
        if (content.dataset.garvexRaw === raw && content.dataset.garvexRendered === "true") return;
        content.dataset.garvexRaw = raw;
        mutating.current = true;
        content.innerHTML = renderMarkdown(raw);
        content.dataset.garvexRendered = "true";
        mutating.current = false;
      });

      document.querySelectorAll<HTMLElement>(".garvex-v4-message").forEach((message) => {
        if (message.querySelector(".garvex-copy-btn")) return;
        const content = message.querySelector<HTMLElement>(".garvex-v4-content");
        if (!content) return;
        const button = document.createElement("button");
        button.type = "button";
        button.className = "garvex-copy-btn";
        button.setAttribute("aria-label", "Copy message");
        button.setAttribute("title", "Copy");
        button.innerHTML = copyIcon(false);
        button.addEventListener("click", async () => {
          try {
            await navigator.clipboard.writeText(content.textContent ?? "");
            button.innerHTML = copyIcon(true);
            setTimeout(() => { button.innerHTML = copyIcon(false); }, 900);
          } catch {}
        });
        content.insertAdjacentElement("afterend", button);
      });

      document.querySelectorAll<HTMLElement>(".garvex-v4-thinking").forEach((box) => {
        if (box.dataset.garvexThinking === "true") return;
        box.dataset.garvexThinking = "true";
        mutating.current = true;
        box.innerHTML = `
          <div class="garvex-thinking-orb"><span></span></div>
          <div class="garvex-thinking-copy"><strong>Garvex is working</strong><span>Visible progress without exposing private reasoning</span></div>
          <div class="garvex-thinking-steps">
            <span data-step="0">Listening to request</span>
            <span data-step="1">Checking context</span>
            <span data-step="2">Generating answer</span>
            <span data-step="3">Checking sources</span>
            <span data-step="4">Finalizing</span>
          </div>`;
        mutating.current = false;
      });

      const phaseNode = document.querySelector<HTMLElement>(".garvex-v4-topcenter > span");
      const updateThinking = () => {
        const idx = stageIndex(phaseNode?.textContent ?? "");
        document.querySelectorAll<HTMLElement>(".garvex-thinking-steps").forEach((steps) => {
          steps.querySelectorAll<HTMLElement>("[data-step]").forEach((step) => {
            const stepIndex = Number(step.dataset.step ?? 0);
            step.classList.toggle("active", stepIndex === idx);
            step.classList.toggle("done", stepIndex < idx);
          });
        });
      };
      updateThinking();
    };

    enhance();
    const observer = new MutationObserver(enhance);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    const phaseObserver = new MutationObserver(enhance);
    const phaseNode = document.querySelector<HTMLElement>(".garvex-v4-topcenter > span");
    if (phaseNode) phaseObserver.observe(phaseNode, { childList: true, characterData: true, subtree: true });
    const timer = window.setInterval(enhance, 180);
    return () => {
      observer.disconnect();
      phaseObserver.disconnect();
      window.clearInterval(timer);
    };
  }, []);

  return null;
}
