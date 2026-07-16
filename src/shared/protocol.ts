export type ElementRole =
  | "button"
  | "link"
  | "textbox"
  | "checkbox"
  | "radio"
  | "select"
  | "combobox";

export interface SelectOption {
  value: string;
  label: string;
}

export interface InteractableElement {
  ref: string;
  role: ElementRole;
  label: string;
  value?: string;
  checked?: boolean;
  options?: SelectOption[];
  href?: string;
  disabled?: boolean;
  inputType?: string;
}

export interface SessionState {
  connected: boolean;
  url: string;
  title: string;
}

// Client → Server

export interface NavigateMessage {
  type: "navigate";
  url: string;
}

export interface ClickMessage {
  type: "click";
  ref: string;
}

export interface FillMessage {
  type: "fill";
  ref: string;
  value: string;
}

export interface SelectMessage {
  type: "select";
  ref: string;
  value: string;
}

export interface CheckMessage {
  type: "check";
  ref: string;
  checked: boolean;
}

export interface PressMessage {
  type: "press";
  ref: string;
  key: string;
}

export interface RefreshMessage {
  type: "refresh";
}

export interface DisconnectMessage {
  type: "disconnect";
}

export type ClientMessage =
  | NavigateMessage
  | ClickMessage
  | FillMessage
  | SelectMessage
  | CheckMessage
  | PressMessage
  | RefreshMessage
  | DisconnectMessage;

// Server → Client

export interface SessionServerMessage {
  type: "session";
  session: SessionState;
}

export interface ElementsServerMessage {
  type: "elements";
  elements: InteractableElement[];
  url: string;
  title: string;
}

export interface ActionResultServerMessage {
  type: "action_result";
  ref: string;
  success: boolean;
  error?: string;
}

export interface ErrorServerMessage {
  type: "error";
  message: string;
}

export type ServerMessage =
  | SessionServerMessage
  | ElementsServerMessage
  | ActionResultServerMessage
  | ErrorServerMessage;

export function parseClientMessage(data: string): ClientMessage {
  const parsed = JSON.parse(data) as ClientMessage;
  if (!parsed || typeof parsed !== "object" || !("type" in parsed)) {
    throw new Error("Invalid message");
  }
  return parsed;
}
