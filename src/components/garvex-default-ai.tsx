"use client";

import { useEffect } from "react";

export function GarvexDefaultAI() {
  useEffect(() => {
    const select = document.querySelector<HTMLSelectElement>(".garvex-v4-composer-meta select");
    if (!select || select.value === "" || !select.options.length) return;
    if (!Array.from(select.options).some((option) => option.value === "")) return;
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
    setter?.call(select, "");
    select.dispatchEvent(new Event("change", { bubbles: true }));
  }, []);

  return null;
}
