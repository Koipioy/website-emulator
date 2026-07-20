import type { InteractableElement } from "../shared/protocol.js";
import { actionsForElement } from "../shared/element-actions.js";

export type ActCommand =
  | { action: "scroll-up" }
  | { action: "scroll-down" }
  | { action: "navigate"; url: string }
  | { element: number; action: "click" }
  | { element: number; action: "fill"; value: string }
  | { element: number; action: "select"; value: string }
  | { element: number; action: "check"; checked: boolean }
  | { element: number; action: "press"; key: string }
  | { element: number; action: "scroll-into-view" };

export interface PageSnapshotLike {
  url: string;
  title: string;
  elements: InteractableElement[];
  buttons: InteractableElement[];
}

export interface ChoicesResponse {
  url: string;
  title: string;
  choices: ActCommand[];
  cached?: boolean;
}

const NO_SESSION_CHOICES: ActCommand[] = [{ action: "navigate", url: "https://example.com" }];

function choicesForElement(el: InteractableElement): ActCommand[] {
  if (el.order == null) return [];

  const element = el.order;
  const choices: ActCommand[] = [];
  const actions = actionsForElement(el);

  for (const act of actions) {
    switch (act.type) {
      case "click":
        choices.push({ element, action: "click" });
        break;
      case "scroll":
        choices.push({ element, action: "scroll-into-view" });
        break;
      case "fill":
        choices.push({ element, action: "fill", value: el.value ?? "" });
        break;
      case "select":
        if (el.options?.length) {
          for (const opt of el.options) {
            choices.push({ element, action: "select", value: opt.value });
          }
        } else {
          choices.push({ element, action: "select", value: el.value ?? "" });
        }
        break;
      case "check":
        choices.push({ element, action: "check", checked: true });
        if (el.role !== "radio") {
          choices.push({ element, action: "check", checked: false });
        }
        break;
      case "press":
        choices.push({ element, action: "press", key: "Enter" });
        break;
    }
  }

  return choices;
}

export function buildChoices(snapshot: PageSnapshotLike | null): ActCommand[] {
  if (!snapshot) return [...NO_SESSION_CHOICES];

  const choices: ActCommand[] = [
    { action: "scroll-up" },
    { action: "scroll-down" },
    { action: "navigate", url: snapshot.url },
  ];

  for (const el of [...snapshot.elements, ...snapshot.buttons]) {
    choices.push(...choicesForElement(el));
  }

  return choices;
}

export function choicesResponse(snapshot: PageSnapshotLike | null, cached?: boolean): ChoicesResponse {
  return {
    url: snapshot?.url ?? "",
    title: snapshot?.title ?? "",
    choices: buildChoices(snapshot),
    ...(cached !== undefined ? { cached } : {}),
  };
}

export function isActCommand(value: unknown): value is ActCommand {
  if (!value || typeof value !== "object" || !("action" in value)) return false;
  const cmd = value as ActCommand;
  if (cmd.action === "scroll-up" || cmd.action === "scroll-down") return true;
  if (cmd.action === "navigate") return typeof cmd.url === "string";
  if ("element" in cmd && typeof cmd.element === "number") {
    switch (cmd.action) {
      case "click":
      case "scroll-into-view":
        return true;
      case "fill":
        return typeof cmd.value === "string";
      case "select":
        return typeof cmd.value === "string";
      case "check":
        return typeof cmd.checked === "boolean";
      case "press":
        return typeof cmd.key === "string";
      default:
        return false;
    }
  }
  return false;
}
