import type { InteractableElement } from "./protocol.js";

export interface ElementActionInfo {
  type: "click" | "fill" | "select" | "check" | "press" | "scroll";
  description: string;
  parameters?: string[];
}

const SCROLL: ElementActionInfo = {
  type: "scroll",
  description: "Scroll the element into view",
};

export function actionsForElement(el: InteractableElement): ElementActionInfo[] {
  if (el.disabled) return [SCROLL];

  switch (el.role) {
    case "button":
    case "link":
      return [
        { type: "click", description: "Click the element" },
        SCROLL,
      ];

    case "textbox":
      return [
        { type: "fill", description: "Fill with a text value", parameters: ["value"] },
        { type: "press", description: "Press a key (e.g. Enter)", parameters: ["key"] },
        SCROLL,
      ];

    case "checkbox":
    case "radio":
      return [
        { type: "check", description: "Set checked state", parameters: ["checked"] },
        SCROLL,
      ];

    case "select":
      return [
        { type: "select", description: "Choose an option", parameters: ["value"] },
        SCROLL,
      ];

    case "combobox":
      if (el.options && el.options.length > 0) {
        return [
          { type: "select", description: "Choose an option", parameters: ["value"] },
          SCROLL,
        ];
      }
      return [
        { type: "fill", description: "Fill with a text value", parameters: ["value"] },
        { type: "press", description: "Press a key (e.g. Enter)", parameters: ["key"] },
        SCROLL,
      ];

    default:
      return [
        { type: "click", description: "Click the element" },
        SCROLL,
      ];
  }
}
