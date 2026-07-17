() => {
  const REF_ATTR_LOCAL = "data-emulator-ref";

  const clearRefs = (root) => {
    const roots = [root];
    while (roots.length) {
      const current = roots.pop();
      if (!current || typeof current.querySelectorAll !== "function") continue;
      current.querySelectorAll(`[${REF_ATTR_LOCAL}]`).forEach((el) => {
        el.removeAttribute(REF_ATTR_LOCAL);
      });
      current.querySelectorAll("*").forEach((el) => {
        if (el.shadowRoot) roots.push(el.shadowRoot);
      });
    }
  };
  clearRefs(document);

  const isInert = (el) => {
    let node = el;
    while (node && node instanceof Element) {
      if (node.hasAttribute("inert")) return true;
      if (node.getAttribute("aria-hidden") === "true") return true;
      node = node.parentElement;
    }
    return false;
  };

  const isVisible = (el) => {
    if (!(el instanceof HTMLElement)) return false;
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
    if (Number.parseFloat(style.opacity || "1") <= 0) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 || rect.height > 0;
  };

  const isNaturallyTabbable = (el) => {
    if (el instanceof HTMLButtonElement) return !el.disabled;
    if (el instanceof HTMLInputElement) {
      if (el.disabled || el.type === "hidden") return false;
      return true;
    }
    if (el instanceof HTMLSelectElement) return !el.disabled;
    if (el instanceof HTMLTextAreaElement) return !el.disabled;
    if (el instanceof HTMLAnchorElement) {
      const href = el.getAttribute("href");
      return Boolean(href && href.trim());
    }
    if (el.tagName === "AREA") {
      const href = el.getAttribute("href");
      return Boolean(href && href.trim());
    }
    if (el.tagName === "SUMMARY") return true;
    if (el.isContentEditable) return true;
    return false;
  };

  const getTabIndex = (el) => {
    if (!(el instanceof HTMLElement)) return null;
    if (el.hasAttribute("tabindex")) {
      const parsed = Number.parseInt(el.getAttribute("tabindex") || "", 10);
      return Number.isNaN(parsed) ? null : parsed;
    }
    return isNaturallyTabbable(el) ? 0 : null;
  };

  const isTabbable = (el) => {
    if (!(el instanceof HTMLElement)) return false;
    if (isInert(el)) return false;
    if (!isVisible(el)) return false;
    if (el.getAttribute("aria-disabled") === "true") return false;

    const tabIndex = getTabIndex(el);
    if (tabIndex === null || tabIndex < 0) return false;

    if (el instanceof HTMLInputElement && el.disabled) return false;
    if (el instanceof HTMLButtonElement && el.disabled) return false;
    if (el instanceof HTMLSelectElement && el.disabled) return false;
    if (el instanceof HTMLTextAreaElement && el.disabled) return false;

    if (isNaturallyTabbable(el)) return true;
    if (el.hasAttribute("tabindex") && tabIndex >= 0) return true;
    return false;
  };

  const getChildElements = (node) => {
    if (node instanceof Document) {
      return node.documentElement ? [node.documentElement] : [];
    }
    if (node instanceof DocumentFragment || node instanceof Element) {
      const childNodes = node.childNodes;
      if (!childNodes) return [];
      return Array.from(childNodes).filter((child) => child instanceof Element);
    }
    return [];
  };

  const walkIncludingOpenShadow = (root, visit) => {
    const walk = (node) => {
      if (!(node instanceof Element || node instanceof Document || node instanceof DocumentFragment)) {
        return;
      }

      for (const child of getChildElements(node)) {
        visit(child);
        if (child.shadowRoot) walk(child.shadowRoot);
        walk(child);
      }
    };

    walk(root);
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
      if (text) return text.slice(0, 120);
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
    if (el instanceof HTMLInputElement) {
      const type = (el.type || "text").toLowerCase();
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "button" || type === "submit" || type === "reset") return "button";
      return "textbox";
    }
    if (el instanceof HTMLTextAreaElement) return "textbox";
    if (el instanceof HTMLSelectElement) return "select";

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

    return "button";
  };

  const tabbable = [];
  try {
    walkIncludingOpenShadow(document, (el) => {
      if (isTabbable(el)) tabbable.push(el);
    });
  } catch {
    // Captcha / exotic DOM trees may break traversal — continue with what we have.
  }

  const positive = tabbable
    .filter((el) => getTabIndex(el) > 0)
    .sort((a, b) => getTabIndex(a) - getTabIndex(b));
  const zero = tabbable.filter((el) => getTabIndex(el) <= 0);
  const ordered = [...positive, ...zero];

  const elements = [];
  let counter = 0;

  for (const el of ordered) {
    counter += 1;
    const ref = `e${counter}`;
    el.setAttribute(REF_ATTR_LOCAL, ref);

    const role = inferRole(el);
    const tabIndex = getTabIndex(el) ?? 0;

    const item = {
      ref,
      role,
      label: getLabel(el),
      tabIndex,
      order: counter,
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
      item.options = Array.from(el.options ?? []).map((opt) => ({
        value: opt.value,
        label: (opt.textContent && opt.textContent.trim()) || opt.value,
      }));
    }

    elements.push(item);
  }

  return {
    elements,
    popup: null,
  };
}
