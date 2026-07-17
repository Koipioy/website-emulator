({ attr, refId }) => {
  const isCssVisible = (el) => {
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
    if (Number.parseFloat(style.opacity || "1") <= 0) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };

  const intersectsViewport = (rect) =>
    rect.bottom > 0 &&
    rect.top < window.innerHeight &&
    rect.right > 0 &&
    rect.left < window.innerWidth;

  const isOnTop = (target, x, y) => {
    let node = document.elementFromPoint(x, y);
    while (node) {
      if (node === target) return true;
      const parent = node.parentElement;
      if (parent) {
        node = parent;
        continue;
      }
      const root = node.getRootNode();
      if (root instanceof ShadowRoot && root.host) {
        node = root.host;
        continue;
      }
      break;
    }
    return false;
  };

  const el = document.querySelector(`[${attr}="${refId}"]`);
  if (!(el instanceof HTMLElement)) return { visible: false };

  if (!isCssVisible(el)) return { visible: false };

  const rect = el.getBoundingClientRect();
  if (!intersectsViewport(rect)) return { visible: false };

  const cx = Math.min(Math.max(rect.left + rect.width / 2, 0), window.innerWidth - 1);
  const cy = Math.min(Math.max(rect.top + rect.height / 2, 0), window.innerHeight - 1);

  if (!isOnTop(el, cx, cy)) return { visible: false };

  return {
    visible: true,
    bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
  };
}
