() => {
  const BTN_REF_ATTR = "data-emulator-btn-ref";

  const clearBtnRefs = (root) => {
    const roots = [root];
    while (roots.length) {
      const current = roots.pop();
      if (!current || typeof current.querySelectorAll !== "function") continue;
      current.querySelectorAll(`[${BTN_REF_ATTR}]`).forEach((el) => {
        el.removeAttribute(BTN_REF_ATTR);
      });
      current.querySelectorAll("*").forEach((el) => {
        if (el.shadowRoot) roots.push(el.shadowRoot);
      });
    }
  };
  clearBtnRefs(document);

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
    return rect.width > 0 && rect.height > 0;
  };

  const isButtonLike = (el) => {
    if (!(el instanceof HTMLElement)) return false;
    if (el instanceof HTMLButtonElement) return true;
    if (el instanceof HTMLInputElement) {
      const type = (el.type || "text").toLowerCase();
      return type === "button" || type === "submit" || type === "reset";
    }
    const role = el.getAttribute("role")?.toLowerCase();
    return role === "button";
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
    if (ariaLabel && ariaLabel.trim()) return ariaLabel.trim().slice(0, 120);

    const text = (el.textContent || "").replace(/\s+/g, " ").trim();
    if (text) return text.slice(0, 120);

    if (el instanceof HTMLInputElement) {
      const value = el.value?.trim();
      if (value) return value.slice(0, 120);
    }

    const title = el.getAttribute("title");
    if (title && title.trim()) return title.trim();

    return el.tagName.toLowerCase();
  };

  const buttons = [];
  try {
    walkIncludingOpenShadow(document, (el) => {
      if (isButtonLike(el) && !isInert(el) && isVisible(el)) {
        buttons.push(el);
      }
    });
  } catch {
    // Exotic DOM trees may break traversal.
  }

  const elements = [];
  let counter = 0;

  for (const el of buttons) {
    counter += 1;
    const ref = `b${counter}`;
    el.setAttribute(BTN_REF_ATTR, ref);

    const disabled =
      el instanceof HTMLInputElement || el instanceof HTMLButtonElement
        ? el.disabled
        : el.getAttribute("aria-disabled") === "true";

    elements.push({
      ref,
      role: "button",
      label: getLabel(el),
      order: counter,
      disabled,
    });
  }

  return { elements };
}
