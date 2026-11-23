// Renders docs/CONCEPTS.md (HANDOFF Part A with <a id="aN"> anchors) so Lab banners can link to concepts.html#aN.
import { marked } from "marked";
import DOMPurify from "dompurify";

const docs = import.meta.glob<string>("../../docs/CONCEPTS.md", { eager: true, query: "?raw", import: "default" });
const md = Object.values(docs)[0];
const style = document.createElement("style");
style.textContent = `
  :root { color-scheme: dark; }
  body { margin:0; background:#0b0f17; color:#e5e7eb; font:15px/1.6 ui-sans-serif,system-ui,sans-serif; }
  main { max-width:860px; margin:0 auto; padding:24px 16px 80px; }
  h1,h2,h3 { line-height:1.25; } h2 { margin-top:2em; border-top:1px solid #1f2937; padding-top:1em; }
  table { border-collapse:collapse; display:block; overflow-x:auto; } td,th { border:1px solid #374151; padding:4px 8px; vertical-align:top; }
  code { background:#111827; padding:1px 4px; border-radius:3px; } a { color:#93c5fd; }
  :target + h2 { color:#fbbf24; }`;
document.head.appendChild(style);
const main = document.getElementById("doc")!;
// The doc is ours, but any HTML in it would run here: sanitize (keeps the <a id> anchors, drops scripts, handlers, javascript: links).
main.innerHTML = md ? DOMPurify.sanitize(marked.parse(md) as string) : "<p>docs/CONCEPTS.md was not found at build time.</p>";
if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView();
