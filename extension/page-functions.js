(() => {
  if (globalThis.ChromeBridgePage) {
    if (typeof module !== "undefined" && module.exports) {
      module.exports = globalThis.ChromeBridgePage;
    }
    return;
  }

  const state = { refs: [] };

  function classifyKind(element) {
    const tag = String(element.tag || "").toLowerCase();
    const role = String(element.role || "").toLowerCase();
    if (
      tag === "input" ||
      tag === "select" ||
      tag === "textarea" ||
      element.isContentEditable === true ||
      (tag === "label" && element.hasAssociatedControl === true) ||
      ["checkbox", "radio", "switch", "textbox", "combobox", "listbox", "slider"].includes(role)
    ) {
      return "input";
    }
    if ((tag === "a" && Boolean(element.href)) || role === "link") {
      return "link";
    }
    if (tag === "button" || tag === "summary" || role === "button") {
      return "button";
    }
    return "other";
  }

  function canSubmit(element) {
    const tag = String(element.tag || "").toLowerCase();
    const type = String(element.type || "").toLowerCase();
    if (element.inForm !== true) return false;
    if (tag === "button") return type !== "button";
    return tag === "input" && (type === "submit" || type === "image");
  }

  function hasRiskyLink(element) {
    const tag = String(element.tag || "").toLowerCase();
    if (tag !== "a" || !element.href) return false;
    if (element.hasDownload === true) return true;
    let protocol;
    try {
      protocol = new URL(element.href, "https://relative.invalid").protocol;
    } catch {
      return true;
    }
    return protocol !== "http:" && protocol !== "https:" && protocol !== "javascript:";
  }

  function guardClick(element, flags = {}) {
    if (classifyKind(element) === "input" && flags.allowInput !== true) {
      return { allowed: false, code: "INPUT_BLOCKED" };
    }
    if ((canSubmit(element) || hasRiskyLink(element)) && flags.allowRisky !== true) {
      return { allowed: false, code: "NEEDS_CONFIRMATION" };
    }
    return { allowed: true };
  }

  function guardKey(element, key, flags = {}) {
    const parts = [...key].length === 1 ? [key] : key.split("+");
    const name = parts.pop();
    if (name === "Enter" && (element.inForm === true || canSubmit(element)) && flags.allowRisky !== true) {
      return { allowed: false, code: "NEEDS_CONFIRMATION" };
    }
    const changesInput = ["Space", "Backspace", "Delete"].includes(name) && classifyKind(element) === "input";
    const character = parts.length === 0 && [...name].length === 1;
    const paste = name.toLowerCase() === "v" && (parts.includes("Meta") || parts.includes("Ctrl"));
    if ((changesInput || character || paste) && flags.allowInput !== true) {
      return { allowed: false, code: "INPUT_BLOCKED" };
    }
    return { allowed: true };
  }

  function preparePointer(args) {
    const point = args.x !== undefined;
    const element = point ? document.elementFromPoint(args.x, args.y) : currentRef(args.ref);
    if (!element) return failure(point ? "NEEDS_CONFIRMATION" : "STALE_REF", "対象要素を特定できません");
    if (args.click) {
      // 子要素への入力でも、送信ボタンやリンクへイベントが伝播する。
      for (let target = element; target; target = point ? target.parentElement : null) {
        const guard = guardClick(elementFacts(target), args);
        if (!guard.allowed) return failure(guard.code, "この操作には明示的な許可が必要です", describeElement(target, args.ref));
      }
    }
    if (point) return { ok: true, result: { element: describeElement(element), x: args.x, y: args.y } };
    element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    const rect = element.getBoundingClientRect();
    return { ok: true, result: { element: describeElement(element, args.ref), x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } };
  }

  function prepareType(args) {
    const element = currentRef(args.ref);
    if (!element) return failure("STALE_REF", "refが無効です");
    const detail = describeElement(element, args.ref);
    if (args.userInstructed !== true) return failure("INPUT_BLOCKED", "入力にはユーザーの明示的な指示が必要です", detail);
    if (!nativeValueSetter(element) && !element.isContentEditable) return failure("BAD_ARGS", "この要素には入力できません", detail);
    element.focus();
    return { ok: true, result: {} };
  }

  function checkKey(args) {
    const element = document.activeElement || document.body;
    const facts = element ? elementFacts(element) : {};
    const guard = guardKey(facts, args.key, args);
    if (!guard.allowed) return failure(guard.code, "この操作には明示的な許可が必要です", facts);
    return { ok: true, result: {} };
  }

  function elementFacts(element) {
    const tag = element.tagName.toLowerCase();
    return {
      tag,
      role: element.getAttribute("role") || "",
      type: element.getAttribute("type") || "",
      href: tag === "a" ? element.href || element.getAttribute("href") || "" : "",
      inForm: Boolean(element.form || element.closest("form")),
      hasDownload: tag === "a" && element.hasAttribute("download"),
      isContentEditable: element.isContentEditable,
      hasAssociatedControl: tag === "label" && Boolean(element.control),
    };
  }

  function isVisible(element) {
    const style = getComputedStyle(element);
    return (
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      style.opacity !== "0" &&
      element.getClientRects().length > 0
    );
  }

  function isInViewport(element) {
    const rect = element.getBoundingClientRect();
    return rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth;
  }

  function visibleText(element) {
    const candidates = [
      element.innerText,
      element.getAttribute("aria-label"),
      "value" in element && element.type !== "password" ? element.value : "",
      element.getAttribute("alt"),
    ];
    const text = candidates.find((value) => typeof value === "string" && value.trim()) || "";
    return text.replace(/\s+/g, " ").trim().slice(0, 120);
  }

  function describeElement(element, ref) {
    const facts = elementFacts(element);
    const form = element.form || element.closest("form");
    return {
      ref,
      kind: classifyKind(facts),
      tag: facts.tag,
      role: facts.role,
      type: facts.type,
      text: visibleText(element),
      href: facts.href,
      inForm: facts.inForm,
      formAction: form ? form.action || "" : "",
      formMethod: form ? String(form.method || "get").toLowerCase() : "",
      disabled: element.matches(":disabled") || element.getAttribute("aria-disabled") === "true",
      inViewport: isInViewport(element),
    };
  }

  function pageScroll() {
    const root = document.documentElement;
    const body = document.body;
    return {
      x: scrollX,
      y: scrollY,
      pageHeight: Math.max(
        root ? root.scrollHeight : 0,
        body ? body.scrollHeight : 0,
      ),
      viewportHeight: innerHeight,
    };
  }

  function failure(code, message, detail = {}) {
    return { ok: false, error: { code, message, detail } };
  }

  function currentRef(ref) {
    if (!Number.isInteger(ref) || !state.refs[ref] || !state.refs[ref].isConnected) return null;
    return state.refs[ref];
  }

  function readPage(args) {
    let root = document;
    if (args.selector) {
      try {
        root = document.querySelector(args.selector);
      } catch {
        return failure("BAD_ARGS", "selectorが不正です");
      }
      if (!root) root = null;
    }
    const source = root
      ? args.mode === "html"
        ? root === document
          ? document.documentElement?.outerHTML || ""
          : root.outerHTML || ""
        : root === document
          ? document.body?.innerText || document.documentElement?.innerText || ""
          : root.innerText || root.textContent || ""
      : "";
    return {
      ok: true,
      result: {
        url: location.href,
        title: document.title,
        source,
        scroll: pageScroll(),
      },
    };
  }

  function listElements(args) {
    const selector = [
      "a[href]",
      "button",
      "input",
      "select",
      "textarea",
      "summary",
      "[role=button]",
      "[role=link]",
      "[role=tab]",
      "[role=menuitem]",
      "[role=checkbox]",
      "[role=radio]",
      "[role=switch]",
      "[onclick]",
      "[contenteditable]",
    ].join(",");
    const elements = [...document.querySelectorAll(selector)].filter(
      (element) => isVisible(element) && (!args.inViewportOnly || isInViewport(element)),
    );
    state.refs = elements;
    return { ok: true, result: { elements: elements.map(describeElement) } };
  }

  function clickElement(args) {
    const element = currentRef(args.ref);
    if (!element) return failure("STALE_REF", "refが無効です");
    const detail = describeElement(element, args.ref);
    const guard = guardClick(elementFacts(element), args);
    if (!guard.allowed) return failure(guard.code, "この操作には明示的な許可が必要です", detail);
    element.click();
    return { ok: true, result: { clicked: detail } };
  }

  function nativeValueSetter(element) {
    let prototype = Object.getPrototypeOf(element);
    while (prototype) {
      const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
      if (setter) return setter;
      prototype = Object.getPrototypeOf(prototype);
    }
    return null;
  }

  function typeElement(args) {
    const element = currentRef(args.ref);
    if (!element) return failure("STALE_REF", "refが無効です");
    const detail = describeElement(element, args.ref);
    if (args.userInstructed !== true) {
      return failure("INPUT_BLOCKED", "入力にはユーザーの明示的な指示が必要です", detail);
    }
    const setter = nativeValueSetter(element);
    try {
      if (setter) {
        setter.call(element, args.text);
      } else if (element.isContentEditable) {
        element.textContent = args.text;
      } else {
        return failure("BAD_ARGS", "この要素には入力できません", detail);
      }
      element.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      element.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    } catch {
      return failure("BAD_ARGS", "この要素には入力できません", detail);
    }
    return { ok: true, result: { typed: true } };
  }

  function scrollPage(args) {
    if (args.by) {
      scrollBy(args.by.x, args.by.y);
    } else if (args.to === "top") {
      scrollTo(0, 0);
    } else if (args.to === "bottom") {
      scrollTo(0, document.documentElement.scrollHeight);
    } else if (args.to && typeof args.to === "object") {
      scrollTo(args.to.x, args.to.y);
    } else if (Number.isInteger(args.ref)) {
      const element = currentRef(args.ref);
      if (!element) return failure("STALE_REF", "refが無効です");
      element.scrollIntoView({ block: "center", inline: "nearest" });
    } else if (args.selector) {
      let element;
      try {
        element = document.querySelector(args.selector);
      } catch {
        return failure("BAD_ARGS", "selectorが不正です");
      }
      if (!element) return failure("BAD_ARGS", "selectorに一致する要素がありません");
      element.scrollIntoView({ block: "center", inline: "nearest" });
    }
    return { ok: true, result: { scroll: pageScroll() } };
  }

  function inspectElement(args) {
    let elements;
    try { elements = args.ref === undefined ? [...document.querySelectorAll(args.selector)] : [currentRef(args.ref)].filter(Boolean); }
    catch { return failure("BAD_ARGS", "selectorが不正です"); }
    const element = elements[0];
    if (!element) {
      if (args.ref !== undefined) return failure("STALE_REF", "refが無効です");
      return { ok: true, result: { count: 0, element: null } };
    }
    const computed = getComputedStyle(element);
    const props = args.props || ["display", "position", "width", "height", "margin", "padding", "font-size", "color", "background-color", "transform", "z-index", "opacity", "visibility"];
    const rect = element.getBoundingClientRect();
    const sides = (prefix, suffix = "") => Object.fromEntries(["top", "right", "bottom", "left"].map(side => [side, computed.getPropertyValue(`${prefix}-${side}${suffix}`)]));
    if (args.token) state.inspection = { token: args.token, element };
    return { ok: true, result: {
      count: elements.length,
      element: { tag: element.tagName.toLowerCase(), id: element.id || "", classes: [...element.classList], ...(args.ref === undefined ? {} : { ref: args.ref }) },
      rect: Object.fromEntries(["x", "y", "top", "right", "bottom", "left", "width", "height"].map(key => [key, rect[key]])),
      box: { margin: sides("margin"), padding: sides("padding"), border: sides("border", "-width") },
      computed: Object.fromEntries(props.map(name => [name, computed.getPropertyValue(name)])),
      url: location.href,
    } };
  }

  function inspectTarget(token) {
    const saved = state.inspection;
    return saved?.token === token && saved.element.isConnected ? saved.element : null;
  }

  function stylePage(args) {
    if (args.action === "add") {
      const element = document.createElement("style");
      const id = crypto.randomUUID();
      element.setAttribute("data-chrome-bridge", id);
      element.textContent = args.css;
      (document.head || document.documentElement).appendChild(element);
      return { ok: true, result: { id, added: true } };
    }
    const elements = [...document.querySelectorAll("style[data-chrome-bridge]")].filter(element => args.id === undefined || element.getAttribute("data-chrome-bridge") === args.id);
    const ids = elements.map(element => element.getAttribute("data-chrome-bridge"));
    for (const element of elements) element.remove();
    return { ok: true, result: { removed: elements.length, ids } };
  }

  async function performanceSnapshot() {
    const entries = new Map();
    const observers = [];
    const supported = typeof PerformanceObserver === "undefined" ? [] : PerformanceObserver.supportedEntryTypes || [];
    try {
      for (const type of ["largest-contentful-paint", "layout-shift", "paint"]) {
        if (!supported.includes(type)) continue;
        const values = [];
        entries.set(type, values);
        const observer = new PerformanceObserver(list => values.push(...list.getEntries()));
        observer.observe({ type, buffered: true });
        observers.push({ observer, values });
      }
      await new Promise(resolve => setTimeout(resolve, 0));
      for (const { observer, values } of observers) values.push(...observer.takeRecords());
    } finally {
      for (const { observer } of observers) observer.disconnect();
    }
    const lcp = entries.get("largest-contentful-paint")?.at(-1);
    let cls = entries.has("layout-shift") ? 0 : null;
    let sessionValue = 0, sessionStart = 0, previous = null;
    for (const shift of (entries.get("layout-shift") || []).sort((a, b) => a.startTime - b.startTime)) {
      if (shift.hadRecentInput) continue;
      if (previous === null || shift.startTime - previous >= 1000 || shift.startTime - sessionStart >= 5000) {
        sessionValue = 0;
        sessionStart = shift.startTime;
      }
      sessionValue += shift.value;
      cls = Math.max(cls, sessionValue);
      previous = shift.startTime;
    }
    const paint = entries.get("paint") || performance.getEntriesByType("paint");
    const navigation = performance.getEntriesByType("navigation")[0];
    const resources = performance.getEntriesByType("resource");
    const node = lcp?.element;
    return { ok: true, result: {
      lcp: lcp ? { value: lcp.startTime, element: node ? { tag: node.tagName.toLowerCase(), id: node.id || "", classes: [...node.classList], text: (node.textContent || "").replace(/\s+/g, " ").trim().slice(0, 120) } : null } : null,
      cls,
      fcp: paint.find(entry => entry.name === "first-contentful-paint")?.startTime ?? null,
      ttfb: navigation && navigation.responseStart > 0 ? navigation.responseStart - navigation.startTime : null,
      resourceCount: resources.length,
      transferSize: resources.reduce((sum, entry) => sum + (entry.transferSize || 0), 0),
    } };
  }

  function command(operation, args = {}) {
    switch (operation) {
      case "inspect": return inspectElement(args);
      case "releaseInspection": state.inspection = null; return { ok: true, result: {} };
      case "style": return stylePage(args);
      case "perf": return performanceSnapshot();
      case "preparePointer": return preparePointer(args);
      case "prepareType": return prepareType(args);
      case "checkKey": return checkKey(args);
      case "read":
        return readPage(args);
      case "elements":
        return listElements(args);
      case "click":
        return clickElement(args);
      case "type":
        return typeElement(args);
      case "scroll":
        return scrollPage(args);
      default:
        return failure("BAD_ARGS", "不明なページ操作です");
    }
  }

  const api = { classifyKind, canSubmit, hasRiskyLink, guardClick, guardKey, command, inspectTarget };
  globalThis.ChromeBridgePage = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
