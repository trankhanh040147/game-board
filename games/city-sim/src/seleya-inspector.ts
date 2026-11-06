type Picked = { tag: string; text: string; component?: string; selector: string };

function componentOf(element: Element): string | undefined {
  const key = Object.keys(element).find((name) => name.startsWith("__reactFiber$"));
  let fiber = key ? (element as unknown as Record<string, { type?: unknown; return?: unknown }>)[key] : undefined;
  while (fiber) {
    const type = fiber.type;
    if (typeof type === "function" && /^[A-Z]/.test(type.name)) return type.name;
    fiber = fiber.return as typeof fiber;
  }
  return undefined;
}

function selectorOf(element: Element): string {
  const parts: string[] = [];
  for (let node: Element | null = element; node && node !== document.body && parts.length < 4; node = node.parentElement) {
    const first = node.classList.item(0);
    parts.unshift(first ? node.tagName.toLowerCase() + "." + first : node.tagName.toLowerCase());
  }
  return parts.join(" > ");
}

if (window.parent !== window) {
  let on = false;
  const box = document.createElement("div");
  box.style.cssText = "position:fixed;pointer-events:none;z-index:2147483647;border:2px solid #7c5cff;background:rgba(124,92,255,.12);display:none;";
  const show = (element: Element | null) => {
    if (!element || element === document.body || element === document.documentElement) {
      box.style.display = "none";
      return;
    }
    const rect = element.getBoundingClientRect();
    box.style.cssText += "display:block;left:" + rect.left + "px;top:" + rect.top + "px;width:" + rect.width + "px;height:" + rect.height + "px;";
  };
  window.addEventListener("message", (event) => {
    if (event.source !== window.parent) return;
    const data = event.data as { type?: string; on?: boolean } | null;
    if (data?.type !== "seleya:select") return;
    on = Boolean(data.on);
    document.body.style.cursor = on ? "crosshair" : "";
    if (on) document.body.appendChild(box);
    else show(null);
  });
  document.addEventListener("mouseover", (event) => {
    if (on) show(event.target as Element);
  });
  document.addEventListener(
    "click",
    (event) => {
      if (!on) return;
      event.preventDefault();
      event.stopPropagation();
      const element = event.target as Element;
      const picked: Picked = {
        tag: element.tagName.toLowerCase(),
        text: (element.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 200),
        component: componentOf(element),
        selector: selectorOf(element),
      };
      on = false;
      document.body.style.cursor = "";
      show(null);
      window.parent.postMessage({ type: "seleya:selected", ...picked }, "*");
    },
    true,
  );
}
