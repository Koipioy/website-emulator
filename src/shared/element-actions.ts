import type { InteractableElement } from "./protocol.js";

export interface ElementActionInfo {
  type: "click" | "fill" | "select" | "check" | "press" | "scroll";
  description: string;
  parameters?: string[];
}

export interface SerializedElement {
  id?: number;
  description: string;
  actions: ElementActionInfo[];
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

export function elementDescription(el: InteractableElement): string {
  const role = el.role.charAt(0).toUpperCase() + el.role.slice(1);
  const parts: string[] = [];

  if (el.label) {
    parts.push(`${role}: ${el.label}`);
  } else {
    parts.push(role);
  }

  if (el.href) parts.push(el.href);
  if (el.value) parts.push(`value "${el.value}"`);
  if (el.checked !== undefined) parts.push(el.checked ? "checked" : "unchecked");
  if (el.inputType) parts.push(`type ${el.inputType}`);
  if (el.options?.length) {
    const optionLabels = el.options.map((opt) => opt.label).join(", ");
    parts.push(`options: ${optionLabels}`);
  }
  if (el.disabled) parts.push("disabled");

  return parts.join(" · ");
}

export function serializeElementForApi(el: InteractableElement): SerializedElement {
  return {
    id: el.order,
    description: elementDescription(el),
    actions: actionsForElement(el),
  };
}
