() => {
  const REF_ATTR_LOCAL = "data-emulator-ref";

  const INTERACTIVE_ROLES = [
    "button",
    "checkbox",
    "combobox",
    "link",
    "listbox",
    "menuitem",
    "menuitemcheckbox",
    "menuitemradio",
    "option",
    "radio",
    "searchbox",
    "slider",
    "spinbutton",
    "switch",
    "tab",
    "textbox",
    "treeitem",
  ];

  const ROLE_SELECTOR = INTERACTIVE_ROLES.map((r) => `[role="${r}"]`).join(",");
  const TAG_SELECTOR = [
    "button",
    "a[href]",
    'input:not([type="hidden"]):not([disabled])',
    "select:not([disabled])",
    "textarea:not([disabled])",
  ].join(",");

  document.querySelectorAll(`[${REF_ATTR_LOCAL}]`).forEach((el) => {
    el.removeAttribute(REF_ATTR_LOCAL);
  });

  const candidates = new Set();
  document.querySelectorAll(`${TAG_SELECTOR},${ROLE_SELECTOR}`).forEach((el) => {
    candidates.add(el);
  });

  const isVisible = (el) => {
    if (!(el instanceof HTMLElement)) return false;
    if (el.getAttribute("aria-hidden") === "true") return false;
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 && rect.height <= 0) return false;
    return true;
  };

  const getLabel = (el) => {
    const ariaLabel = el.getAttribute("aria-label");
    if (ariaLabel && ariaLabel.trim()) return ariaLabel.trim();

    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const text = labelledBy
        .split(/\s+/)
        .map((id) => {
          const node = document.getElementById(id);
          return node && node.textContent ? node.textContent.trim() : "";
        })
        .filter(Boolean)
        .join(" ");
      if (text) return text;
    }

    if (
      el instanceof HTMLInputElement ||
      el instanceof HTMLSelectElement ||
      el instanceof HTMLTextAreaElement
    ) {
      const id = el.id;
      if (id) {
        const labelEl = document.querySelector(`label[for="${CSS.escape(id)}"]`);
        if (labelEl && labelEl.textContent && labelEl.textContent.trim()) {
          return labelEl.textContent.trim();
        }
      }
    }

    const text = (el.textContent || "").replace(/\s+/g, " ").trim();
    if (text) return text.slice(0, 120);

    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      const placeholder = el.getAttribute("placeholder");
      if (placeholder && placeholder.trim()) return placeholder.trim();
      const name = el.getAttribute("name");
      if (name && name.trim()) return name.trim();
    }

    const title = el.getAttribute("title");
    if (title && title.trim()) return title.trim();

    return el.tagName.toLowerCase();
  };

  const inferRole = (el) => {
    const explicitRole = el.getAttribute("role");
    if (explicitRole) {
      if (["button", "tab", "menuitem"].includes(explicitRole)) return "button";
      if (explicitRole === "link") return "link";
      if (["textbox", "searchbox", "spinbutton"].includes(explicitRole)) return "textbox";
      if (
        explicitRole === "checkbox" ||
        explicitRole === "menuitemcheckbox" ||
        explicitRole === "switch"
      ) {
        return "checkbox";
      }
      if (explicitRole === "radio" || explicitRole === "menuitemradio") return "radio";
      if (explicitRole === "combobox" || explicitRole === "listbox") return "combobox";
    }

    if (el instanceof HTMLAnchorElement && el.href) return "link";
    if (el instanceof HTMLButtonElement) return "button";
    if (el instanceof HTMLSelectElement) return "select";
    if (el instanceof HTMLTextAreaElement) return "textbox";
    if (el instanceof HTMLInputElement) {
      const type = (el.type || "text").toLowerCase();
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "button" || type === "submit" || type === "reset") return "button";
      return "textbox";
    }

    return "button";
  };

  const elements = [];
  let counter = 0;

  for (const el of candidates) {
    if (!isVisible(el)) continue;

    const role = inferRole(el);
    if (!role) continue;

    counter += 1;
    const ref = `e${counter}`;
    el.setAttribute(REF_ATTR_LOCAL, ref);

    const item = {
      ref,
      role,
      label: getLabel(el),
      disabled:
        el instanceof HTMLInputElement ||
        el instanceof HTMLButtonElement ||
        el instanceof HTMLSelectElement ||
        el instanceof HTMLTextAreaElement
          ? el.disabled
          : el.getAttribute("aria-disabled") === "true",
    };

    if (el instanceof HTMLAnchorElement) {
      item.href = el.href;
    }

    if (el instanceof HTMLInputElement) {
      item.inputType = el.type || "text";
      if (role === "textbox") item.value = el.value;
      if (role === "checkbox" || role === "radio") item.checked = el.checked;
    }

    if (el instanceof HTMLTextAreaElement) {
      item.value = el.value;
    }

    if (el instanceof HTMLSelectElement) {
      item.value = el.value;
      item.options = Array.from(el.options).map((opt) => ({
        value: opt.value,
        label: (opt.textContent && opt.textContent.trim()) || opt.value,
      }));
    }

    elements.push(item);
  }

  return elements;
}
