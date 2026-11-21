const inspectionContexts = new Map();

chrome.debugger.onEvent.addListener(({ tabId }, method, params) => {
  if (method === "Runtime.executionContextCreated") {
    const context = params.context;
    if (!context.auxData?.isDefault) {
      if (!inspectionContexts.has(tabId)) inspectionContexts.set(tabId, new Map());
      inspectionContexts.get(tabId).set(context.id, context);
    }
  } else if (method === "Runtime.executionContextDestroyed") {
    inspectionContexts.get(tabId)?.delete(params.executionContextId);
  } else if (method === "Runtime.executionContextsCleared") {
    inspectionContexts.delete(tabId);
  }
});
chrome.debugger.onDetach.addListener(({ tabId }) => inspectionContexts.delete(tabId));
chrome.tabs.onRemoved.addListener(tabId => inspectionContexts.delete(tabId));

function validateInspect(args) {
  requireTabId(args);
  if ((args.selector !== undefined) === (args.ref !== undefined)) badArgs("selector または ref を1つ指定してください");
  if (args.selector !== undefined && (typeof args.selector !== "string" || !args.selector)) badArgs("selectorが不正です");
  if (args.ref !== undefined && (!Number.isInteger(args.ref) || args.ref < 0)) badArgs("refが不正です");
  if (args.props !== undefined && (!Array.isArray(args.props) || !args.props.length || args.props.some(name => typeof name !== "string" || !name.trim()))) badArgs("propsが不正です");
  requireBooleanIfPresent(args, "rules");
}

async function inspect(args) {
  validateInspect(args);
  const tabId = args.tabId;
  if (!args.rules) return (await executePage(tabId, "inspect", args))[0].result.result;
  return withDebugger(tabId, async send => {
    const token = crypto.randomUUID();
    const sheets = new Map();
    const onEvent = (source, method, params) => {
      if (source.tabId === tabId && method === "CSS.styleSheetAdded") sheets.set(params.header.styleSheetId, params.header);
    };
    let runtime = false, dom = false, css = false;
    chrome.debugger.onEvent.addListener(onEvent);
    try {
      const result = (await executePage(tabId, "inspect", { ...args, token }, false, send))[0].result.result;
      if (!result.count) return { ...result, rules: [] };
      if (!debugConnections.has(tabId)) {
        await send("Runtime.enable");
        runtime = true;
      }
      await send("DOM.enable");
      dom = true;
      await send("CSS.enable");
      css = true;
      await send("DOM.getDocument", { depth: 0 });
      let nodeId;
      for (const context of inspectionContexts.get(tabId)?.values() || []) {
        const remote = await send("Runtime.evaluate", {
          expression: `globalThis.ChromeBridgePage?.inspectTarget(${JSON.stringify(token)})`,
          contextId: context.id, objectGroup: token, returnByValue: false,
        }).catch(() => ({}));
        if (remote.result?.subtype !== "node" || !remote.result.objectId) continue;
        ({ nodeId } = await send("DOM.requestNode", { objectId: remote.result.objectId }));
        if (nodeId) break;
      }
      if (!nodeId) throw new BridgeError("STALE_REF", "検査対象の要素が見つかりません（ページ遷移の可能性）");
      const matched = await send("CSS.getMatchedStylesForNode", { nodeId });
      const animated = await send("CSS.getAnimatedStylesForNode", { nodeId }).catch(() => null);
      return { ...result, rules: matchedRules(matched, sheets, result.url, animated) };
    } finally {
      await send("Runtime.releaseObjectGroup", { objectGroup: token }).catch(() => {});
      await executePage(tabId, "releaseInspection", {}, false, send).catch(() => {});
      if (css) await send("CSS.disable").catch(() => {});
      if (dom) await send("DOM.disable").catch(() => {});
      if (runtime) {
        await send("Runtime.disable").catch(() => {});
        inspectionContexts.delete(tabId);
      }
      chrome.debugger.onEvent.removeListener(onEvent);
    }
  });
}

function matchedRules(matched, sheets, pageUrl, animated) {
  const rules = [];
  const addStyle = (style, rule, inherited = 0, inline = false, attribute = false) => {
    if (!style) return;
    const sheet = sheets.get(style.styleSheetId || rule?.styleSheetId);
    const sourceURL = sheet?.sourceURL || rule?.sourceURL || (inline ? pageUrl : "");
    const offset = sheet?.startLine || 0;
    const range = rule?.selectorList?.selectors?.[0]?.range || style.range;
    const uncertain = Boolean(rule?.startingStyles?.length);
    const layer = (rule?.layers || []).map(item => item.text || `${style.styleSheetId}:${item.range?.startLine}:${item.range?.startColumn}`).join(" / ");
    const inactive = Boolean((rule?.matchingSelectors && !rule.matchingSelectors.length) || rule?.media?.some(media => media.mediaList?.length && !media.mediaList.some(query => query.active)) || rule?.supports?.some(query => query.active === false));
    const properties = style.cssProperties || [];
    const declarations = properties.filter(property => !property.implicit && (!style.range || property.range)).map(property => ({
      name: property.name, value: property.value, important: Boolean(property.important),
      disabled: Boolean(property.disabled), parsedOk: property.parsedOk !== false,
      line: property.range ? offset + property.range.startLine + 1 : null,
      overridden: null,
      _longhands: property.longhandProperties?.length ? property.longhandProperties.map(item => item.name) : [property.name],
    }));
    rules.push({
      selector: inline ? "element.style" : attribute ? "presentational attributes" : rule?.selectorList?.text || "",
      origin: rule?.origin || "regular", sourceURL,
      line: range ? offset + range.startLine + 1 : null,
      inherited, declarations,
      _inline: inline, _attribute: attribute, _uncertain: uncertain, _inactive: inactive, _layer: layer,
    });
  };
  const addMatches = (payload, depth = 0) => {
    for (const match of payload.matchedCSSRules || []) addStyle(match.rule.style, { ...match.rule, matchingSelectors: match.matchingSelectors }, depth);
    addStyle(payload.attributesStyle, null, depth, false, true);
    addStyle(payload.inlineStyle, null, depth, true);
  };
  addMatches(matched);
  (matched.inherited || []).forEach((payload, i) => addMatches(payload, i + 1));
  const animatedNames = new Set([
    ...(animated?.transitionsStyle?.cssProperties || []),
    ...(animated?.animationStyles || []).flatMap(item => item.style?.cssProperties || []),
  ].flatMap(property => property.longhandProperties?.length ? property.longhandProperties.map(item => item.name) : [property.name]));
  const candidates = new Map();
  for (const [index, rule] of rules.entries()) {
    for (const [position, declaration] of rule.declarations.entries()) {
      if (declaration.disabled || !declaration.parsedOk || rule._inactive) {
        declaration.overridden = false;
        declaration.inactive = true;
        continue;
      }
      for (const name of declaration._longhands) {
        if (!candidates.has(name)) candidates.set(name, []);
        candidates.get(name).push({ rule, declaration, index, position });
      }
    }
  }
  const rank = candidate => {
    const { rule, declaration } = candidate;
    const important = declaration.important;
    const origin = rule.origin === "user-agent" ? (important ? 3 : 0) : rule.origin === "injected" ? (important ? 2 : 1) : (important ? 1 : 2);
    return [Number(important), origin, Number(rule._inline), rule._attribute ? -1 : 0,  ];
  };
  const compare = (a, b) => {
    const ar = rank(a), br = rank(b);
    for (let i = 0; i < ar.length; i++) if (ar[i] !== br[i]) return br[i] - ar[i];
    if (a.declaration.important && a.rule._layer !== b.rule._layer) {
      if (!a.rule._layer) return 1;
      if (!b.rule._layer) return -1;
      return a.index - b.index;
    }
    return b.index - a.index || b.position - a.position;
  };
  const winners = new Map();
  for (const [name, values] of candidates) {
    const own = values.filter(candidate => candidate.rule.inherited === 0);
    if ((own.length > 1 && own.some(candidate => candidate.rule.origin === "injected")) || own.some(candidate => candidate.rule._uncertain || /^(revert|revert-layer)$/.test(candidate.declaration.value.trim())) || animatedNames.has(name)) continue;
    if (own.length) winners.set(name, own.sort(compare)[0].declaration);
  }
  for (const rule of rules) {
    for (const declaration of rule.declarations) {
      const names = declaration._longhands;
      if (!declaration.inactive && rule.inherited === 0 && names.every(name => winners.has(name))) {
        const overridden = names.filter(name => winners.get(name) !== declaration);
        declaration.overridden = overridden.length === names.length;
        if (overridden.length && overridden.length < names.length) declaration.overriddenProperties = overridden;
      }
      delete declaration._longhands;
    }
    for (const key of Object.keys(rule)) if (key.startsWith("_")) delete rule[key];
  }
  return rules;
}

async function style(args) {
  const tabId = requireTabId(args);
  if (!["add", "clear"].includes(args.action)) badArgs("style の操作が不正です");
  if (args.action === "add" && (typeof args.css !== "string" || !args.css || args.id !== undefined)) badArgs("cssが不正です");
  if (args.action === "clear" && (args.css !== undefined || (args.id !== undefined && (typeof args.id !== "string" || !args.id)))) badArgs("idが不正です");
  return (await executePage(tabId, "style", args))[0].result.result;
}

async function perf(args) {
  const tabId = requireTabId(args);
  return withDebugger(tabId, async send => {
    let enabled = false;
    try {
      await send("Performance.enable");
      enabled = true;
      const page = (await executePage(tabId, "perf", {}, false, send))[0].result.result;
      const { metrics } = await send("Performance.getMetrics");
      const names = new Set(["Timestamp", "Documents", "Frames", "JSHeapUsedSize", "JSHeapTotalSize", "Nodes", "LayoutCount", "RecalcStyleCount", "LayoutDuration", "RecalcStyleDuration", "ScriptDuration", "TaskDuration", "TaskOtherDuration", "ThreadTime", "ProcessTime"]);
      return { metrics: Object.fromEntries((metrics || []).filter(item => names.has(item.name)).map(item => [item.name, item.value])), ...page };
    } finally {
      if (enabled) await send("Performance.disable").catch(() => {});
    }
  });
}
