import type { InteractableElement, PopupScope } from "../shared/protocol.js";
import {
  actionsForElement,
  serializeElementForApi,
  type SerializedElement,
} from "../shared/element-actions.js";

export type ActCommand =
  | { action: "scroll-up" }
  | { action: "scroll-down" }
  | { action: "navigate"; url: string }
  | { id: number; action: "click" }
  | { id: number; action: "fill"; value: string }
  | { id: number; action: "select"; value: string }
  | { id: number; action: "check"; checked: boolean }
  | { id: number; action: "press"; key: string }
  | { id: number; action: "scroll-into-view" };

export interface PageSnapshotLike {
  url: string;
  title: string;
  elements: InteractableElement[];
  buttons: InteractableElement[];
  screenshot?: string;
  popup?: PopupScope | null;
}

export interface ChoicesResponse {
  url: string;
  title: string;
  choices: ActCommand[];
  cached?: boolean;
}

export interface StateResponse {
  url: string;
  title: string;
  elements: SerializedElement[];
  buttons: SerializedElement[];
  screenshot?: string;
  popup: PopupScope | null;
  choices: ActCommand[];
  cached: boolean;
}

const NO_SESSION_CHOICES: ActCommand[] = [{ action: "navigate", url: "https://example.com" }];

function choicesForElement(el: InteractableElement): ActCommand[] {
  if (el.order == null) return [];

  const id = el.order;
  const choices: ActCommand[] = [];
  const actions = actionsForElement(el);

  for (const act of actions) {
    switch (act.type) {
      case "click":
        choices.push({ id, action: "click" });
        break;
      case "scroll":
        choices.push({ id, action: "scroll-into-view" });
        break;
      case "fill":
        choices.push({ id, action: "fill", value: el.value ?? "" });
        break;
      case "select":
        if (el.options?.length) {
          for (const opt of el.options) {
            choices.push({ id, action: "select", value: opt.value });
          }
        } else {
          choices.push({ id, action: "select", value: el.value ?? "" });
        }
        break;
      case "check":
        choices.push({ id, action: "check", checked: true });
        if (el.role !== "radio") {
          choices.push({ id, action: "check", checked: false });
        }
        break;
      case "press":
        choices.push({ id, action: "press", key: "Enter" });
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

export function stateResponse(snapshot: PageSnapshotLike | null, cached: boolean): StateResponse {
  return {
    url: snapshot?.url ?? "",
    title: snapshot?.title ?? "",
    elements: (snapshot?.elements ?? []).map(serializeElementForApi),
    buttons: (snapshot?.buttons ?? []).map(serializeElementForApi),
    ...(snapshot?.screenshot ? { screenshot: snapshot.screenshot } : {}),
    popup: snapshot?.popup ?? null,
    choices: buildChoices(snapshot),
    cached,
  };
}

export function isActCommand(value: unknown): value is ActCommand {
  if (!value || typeof value !== "object" || !("action" in value)) return false;
  const cmd = value as ActCommand;
  if (cmd.action === "scroll-up" || cmd.action === "scroll-down") return true;
  if (cmd.action === "navigate") return typeof cmd.url === "string";
  if ("id" in cmd && typeof cmd.id === "number") {
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
