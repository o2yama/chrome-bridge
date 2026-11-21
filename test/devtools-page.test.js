const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const source = name => fs.readFileSync(path.join(__dirname, '../extension', name), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
function event() {
  const listeners = new Set();
  return { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn), emit: (...args) => { for (const fn of listeners) fn(...args); } };
}
function pageSetup() {
  let sequence = 0;
  const styles = [];
  const element = {
    tagName: 'BUTTON', id: 'save', classList: ['primary'], textContent: ' Save ', innerText: 'Save', isConnected: true,
    getAttribute: () => null, hasAttribute: () => false, closest: () => null, matches: () => false,
    getBoundingClientRect: () => ({ x: 10, y: 20, left: 10, top: 20, right: 110, bottom: 60, width: 100, height: 40 }),
    getClientRects: () => [{}],
  };
  const computed = { display: 'block', visibility: 'visible', opacity: '1', getPropertyValue: name => ({ color: 'rgb(0, 0, 0)', 'margin-top': '4px', width: '100px' })[name] || '0px' };
  const context = vm.createContext({
    document: {
      querySelectorAll: selector => {
        if (selector === '[') throw new Error('invalid selector');
        if (selector === 'style[data-chrome-bridge]') return styles;
        if (selector === '.missing') return [];
        if (selector === '.primary') return [element, { ...element }];
        return [element];
      },
      createElement: tag => {
        assert.equal(tag, 'style');
        const attributes = new Map();
        const style = { setAttribute: (name, value) => attributes.set(name, value), getAttribute: name => attributes.get(name), remove: () => styles.splice(styles.indexOf(style), 1) };
        return style;
      },
      head: { appendChild: node => styles.push(node) },
    },
    getComputedStyle: () => computed, location: { href: 'https://example.com' }, innerWidth: 390, innerHeight: 844,
    crypto: { randomUUID: () => `style-${++sequence}` }, setTimeout,
  });
  vm.runInContext(source('page-functions.js'), context);
  return { context, api: context.ChromeBridgePage, styles, element };
}

test('inspect returns first match, count, rect, boxes and requested computed properties', () => {
  const { api } = pageSetup();
  const result = api.command('inspect', { selector: '.primary', props: ['color'] }).result;
  assert.equal(result.count, 2);
  assert.equal(result.element.id, 'save');
  assert.deepEqual(plain(result.computed), { color: 'rgb(0, 0, 0)' });
  assert.equal(result.rect.width, 100);
  assert.equal(result.box.margin.top, '4px');
  assert.equal(api.command('inspect', { selector: '.missing' }).result.count, 0);
  assert.equal(api.command('inspect', { selector: '[' }).error.code, 'BAD_ARGS');
});

test('inspect shares elements refs and retains exact DOM identity without DOM mutation', () => {
  const { api, element } = pageSetup();
  api.command('elements');
  assert.equal(api.command('inspect', { ref: 0, token: 'unique' }).result.element.ref, 0);
  assert.equal(api.inspectTarget('unique'), element);
  assert.equal(api.inspectTarget('wrong'), null);
  api.command('releaseInspection');
  assert.equal(api.inspectTarget('unique'), null);
  element.isConnected = false;
  assert.equal(api.command('inspect', { ref: 0 }).error.code, 'STALE_REF');
});

test('style adds literal CSS with independent IDs, clears selected or all injected styles', () => {
  const { api, styles } = pageSetup();
  const first = api.command('style', { action: 'add', css: 'body { color: red }' }).result;
  const second = api.command('style', { action: 'add', css: 'button::after { content: "</style>" }' }).result;
  assert.notEqual(first.id, second.id);
  assert.equal(styles[1].textContent, 'button::after { content: "</style>" }');
  assert.equal(styles[0].getAttribute('data-chrome-bridge'), first.id);
  assert.deepEqual(plain(api.command('style', { action: 'clear', id: first.id }).result), { removed: 1, ids: [first.id] });
  assert.equal(styles.length, 1);
  assert.equal(api.command('style', { action: 'clear', id: 'missing' }).result.removed, 0);
  assert.deepEqual(plain(api.command('style', { action: 'clear' }).result), { removed: 1, ids: [second.id] });
});

test('perf buffers observers, reports LCP, session-window CLS, timings and resource totals', async () => {
  const { api, context, element } = pageSetup();
  let disconnected = 0;
  const entries = {
    'largest-contentful-paint': [{ startTime: 1500, element }],
    'layout-shift': [
      { startTime: 500, value: 0.1 }, { startTime: 1000, value: 0.2 },
      { startTime: 1500, value: 8, hadRecentInput: true }, { startTime: 2200, value: 0.15 },
    ],
    paint: [{ name: 'first-contentful-paint', startTime: 700 }],
  };
  context.PerformanceObserver = class {
    static supportedEntryTypes = Object.keys(entries);
    observe(options) { assert.equal(options.buffered, true); this.type = options.type; }
    takeRecords() { return entries[this.type]; }
    disconnect() { disconnected++; }
  };
  context.performance = { getEntriesByType: type => type === 'navigation' ? [{ startTime: 20, responseStart: 150 }] : type === 'resource' ? [{ transferSize: 100 }, { transferSize: 200 }, { transferSize: 0 }] : [] };
  const result = (await api.command('perf')).result;
  assert.equal(result.lcp.value, 1500);
  assert.equal(result.lcp.element.id, 'save');
  assert.ok(Math.abs(result.cls - 0.3) < 1e-10);
  assert.equal(result.fcp, 700);
  assert.equal(result.ttfb, 130);
  assert.equal(result.resourceCount, 3);
  assert.equal(result.transferSize, 300);
  assert.equal(disconnected, 3);
});

function extensionSetup() {
  const calls = [];
  const chrome = { debugger: { onEvent: event(), onDetach: event() }, tabs: { onRemoved: event() } };
  class BridgeError extends Error { constructor(code, message) { super(message); this.code = code; } }
  const send = async (method, args) => {
    calls.push([method, args]);
    if (method === 'Runtime.enable') {
      chrome.debugger.onEvent.emit({ tabId: 1 }, 'Runtime.executionContextCreated', { context: { id: 5, auxData: { isDefault: true } } });
      chrome.debugger.onEvent.emit({ tabId: 1 }, 'Runtime.executionContextCreated', { context: { id: 6, auxData: { isDefault: false } } });
      chrome.debugger.onEvent.emit({ tabId: 1 }, 'Runtime.executionContextCreated', { context: { id: 7, auxData: { isDefault: false } } });
    }
    if (method === 'Runtime.evaluate') return { result: args.contextId === 7 ? { subtype: 'node', objectId: 'exact-ref' } : { subtype: 'undefined' } };
    if (method === 'DOM.requestNode') { assert.equal(args.objectId, 'exact-ref'); return { nodeId: 9 }; }
    if (method === 'CSS.getMatchedStylesForNode') { assert.equal(args.nodeId, 9); return {}; }
    if (method === 'Performance.getMetrics') return { metrics: [{ name: 'Nodes', value: 42 }, { name: 'Other', value: 1 }] };
    return {};
  };
  const context = vm.createContext({
    chrome, BridgeError, crypto: { randomUUID: () => 'inspection-token' }, debugConnections: new Map(),
    badArgs: message => { throw new BridgeError('BAD_ARGS', message); },
    requireTabId: args => { if (!Number.isInteger(args.tabId)) throw new BridgeError('BAD_ARGS', 'tab'); return args.tabId; },
    requireBooleanIfPresent: (args, key) => { if (args[key] !== undefined && typeof args[key] !== 'boolean') throw new BridgeError('BAD_ARGS', key); },
    executePage: async (tab, operation, args, allFrames, sender) => {
      calls.push(['page', operation, args]);
      if (operation === 'inspect' && args.token) assert.equal(sender, send);
      return [{ result: { result: { count: 1, url: 'https://example.com', cls: 0 } } }];
    },
    withDebugger: async (tab, task) => task(context.send), send,
  });
  vm.runInContext(source('devtools.js'), context);
  return { context, calls, chrome, send };
}

test('inspect rules resolves the exact isolated-world object and cleans up domains', async () => {
  const { context, calls } = extensionSetup();
  const result = await context.inspect({ tabId: 1, ref: 0, rules: true });
  assert.deepEqual(plain(result.rules), []);
  assert.deepEqual(calls.filter(call => call[0] === 'Runtime.evaluate').map(call => call[1].contextId), [6, 7]);
  assert.equal(calls.find(call => call[0] === 'DOM.requestNode')[1].objectId, 'exact-ref');
  assert.ok(calls.some(call => call[0] === 'CSS.disable'));
  assert.ok(calls.some(call => call[0] === 'DOM.disable'));
  assert.ok(calls.some(call => call[0] === 'Runtime.disable'));
  assert.equal(vm.runInContext('inspectionContexts.size', context), 0);
});

test('inspect keeps debug Runtime enabled and cleans up CSS/DOM on failure', async () => {
  const { context, calls, chrome } = extensionSetup();
  context.debugConnections.set(1, {});
  chrome.debugger.onEvent.emit({ tabId: 1 }, 'Runtime.executionContextCreated', { context: { id: 7, auxData: { isDefault: false } } });
  const original = context.send;
  context.send = async (method, args) => {
    if (method === 'CSS.getMatchedStylesForNode') throw new Error('CSS failed');
    return original(method, args);
  };
  // The page recovery sender must be the current debugger sender.
  context.executePage = async () => [{ result: { result: { count: 1 } } }];
  await assert.rejects(context.inspect({ tabId: 1, selector: 'button', rules: true }), /CSS failed/);
  assert.ok(calls.some(call => call[0] === 'CSS.disable'));
  assert.ok(calls.some(call => call[0] === 'DOM.disable'));
  assert.ok(!calls.some(call => call[0] === 'Runtime.disable'));
  chrome.debugger.onDetach.emit({ tabId: 1 });
  assert.equal(vm.runInContext('inspectionContexts.size', context), 0);
});

const cssRule = (selector, properties, extra = {}) => ({ matchingSelectors: [0], rule: {
  selectorList: { text: selector, selectors: [{ text: selector }] }, origin: 'regular',
  style: { styleSheetId: 'sheet', range: { startLine: 4 }, cssProperties: properties.map((property, index) => ({ range: { startLine: 4 + index }, ...property })) }, ...extra,
} });

test('rules use CDP cascade order, important, inline and expanded shorthand declarations', () => {
  const { context } = extensionSetup();
  const rules = context.matchedRules({ matchedCSSRules: [
    cssRule('button', [{ name: 'color', value: 'red' }, { name: 'margin', value: '4px', longhandProperties: ['top', 'right', 'bottom', 'left'].map(side => ({ name: `margin-${side}` })) }]),
    cssRule('.primary', [{ name: 'color', value: 'blue', important: true }, { name: 'margin-top', value: '8px' }]),
  ], inlineStyle: { cssProperties: [{ name: 'color', value: 'green' }] } }, new Map([['sheet', { sourceURL: 'https://example.com/style.css', startLine: 10 }]]), 'https://example.com', {});
  assert.equal(rules[0].declarations[0].overridden, true);
  assert.equal(rules[1].declarations[0].overridden, false);
  assert.equal(rules[2].declarations[0].overridden, true);
  assert.equal(rules[0].declarations[1].overridden, false);
  assert.deepEqual(plain(rules[0].declarations[1].overriddenProperties), ['margin-top']);
  assert.equal(rules[0].sourceURL, 'https://example.com/style.css');
  assert.equal(rules[0].line, 15);
});

test('rules distinguish disabled declarations and keep complex/inherited cascade unknown', () => {
  const { context } = extensionSetup();
  const rules = context.matchedRules({ matchedCSSRules: [
    cssRule('button', [{ name: 'color', value: 'red', disabled: true }, { name: 'width', value: '1px' }]),
    cssRule('.primary', [{ name: 'width', value: '2px' }], { startingStyles: [{}] }),
  ], inherited: [{ matchedCSSRules: [cssRule('body', [{ name: 'color', value: 'black' }])] }] }, new Map(), '', {});
  assert.equal(rules[0].declarations[0].inactive, true);
  assert.equal(rules[0].declarations[1].overridden, null);
  assert.equal(rules[2].inherited, 1);
  assert.equal(rules[2].declarations[0].overridden, null);
});

test('page command validation fails before injection and perf disables its domain', async () => {
  const { context, calls } = extensionSetup();
  for (const args of [{ tabId: 1 }, { tabId: 1, selector: 'a', ref: 0 }, { tabId: 1, ref: -1 }, { tabId: 1, selector: 'a', props: [] }]) await assert.rejects(context.inspect(args), { code: 'BAD_ARGS' });
  await assert.rejects(context.style({ tabId: 1, action: 'add', css: '' }), { code: 'BAD_ARGS' });
  await assert.rejects(context.style({ tabId: 1, action: 'clear', id: 12 }), { code: 'BAD_ARGS' });
  assert.equal(calls.length, 0);
  const result = await context.perf({ tabId: 1 });
  assert.deepEqual(plain(result.metrics), { Nodes: 42 });
  assert.ok(calls.some(call => call[0] === 'Performance.disable'));
});

test('CLS session starts at the first shift rather than navigation start', async () => {
  const { context, api } = pageSetup();
  context.PerformanceObserver = class {
    static supportedEntryTypes = ['layout-shift'];
    observe() {}
    takeRecords() { return [500, 1400, 2300, 3200, 4100, 5000].map(startTime => ({ startTime, value: 0.1 })); }
    disconnect() {}
  };
  context.performance = { getEntriesByType: () => [] };
  const result = (await api.command('perf')).result;
  assert.ok(Math.abs(result.cls - 0.6) < 1e-10);
});

test('normal layers use CDP order and important reverses layer order, including unlayered rules', () => {
  const { context } = extensionSetup();
  const matchedCSSRules = [
    cssRule('.base', [{ name: 'color', value: 'red' }, { name: 'width', value: '1px', important: true }], { layers: [{ text: 'base' }], scopes: [{ text: '(.scope)' }] }),
    cssRule('.components', [{ name: 'color', value: 'blue' }, { name: 'width', value: '2px', important: true }], { layers: [{ text: 'components' }], containerQueries: [{ text: '(width > 10px)' }] }),
    cssRule('.unlayered', [{ name: 'color', value: 'green' }, { name: 'width', value: '3px', important: true }]),
  ];
  const rules = context.matchedRules({ matchedCSSRules }, new Map(), '', {});
  assert.equal(rules[0].declarations[0].overridden, true);
  assert.equal(rules[2].declarations[0].overridden, false);
  assert.equal(rules[0].declarations[1].overridden, false);
  assert.equal(rules[1].declarations[1].overridden, true);
  assert.equal(rules[2].declarations[1].overridden, true);
  const withInline = context.matchedRules({ matchedCSSRules, inlineStyle: { cssProperties: [{ name: 'width', value: '4px', important: true }] } }, new Map(), '', {});
  assert.equal(withInline[0].declarations[1].overridden, true);
  assert.equal(withInline[3].declarations[0].overridden, false);
});

test('generated longhands without source ranges do not override their own shorthand', () => {
  const { context } = extensionSetup();
  const match = cssRule('button', [{ name: 'margin', value: '0', longhandProperties: [{ name: 'margin-top' }] }]);
  match.rule.style.cssProperties.push({ name: 'margin-top', value: '0px', implicit: false });
  const rules = context.matchedRules({ matchedCSSRules: [match] }, new Map(), '', {});
  assert.equal(rules[0].declarations.length, 1);
  assert.equal(rules[0].declarations[0].overridden, false);
});

test('injected origins are not misclassified as user styles when declarations compete', () => {
  const { context } = extensionSetup();
  const rules = context.matchedRules({ matchedCSSRules: [
    cssRule('button', [{ name: 'color', value: 'red', important: true }], { origin: 'injected' }),
    cssRule('button', [{ name: 'color', value: 'blue', important: true }]),
  ] }, new Map(), '', {});
  assert.equal(rules[0].declarations[0].overridden, null);
  assert.equal(rules[1].declarations[0].overridden, null);
});


test('empty longhand metadata retains the declaration itself', () => {
  const { context } = extensionSetup();
  const rules = context.matchedRules({ matchedCSSRules: [cssRule('button', [{ name: 'color', value: 'red', longhandProperties: [] }])] }, new Map(), '', {});
  assert.equal(rules[0].declarations[0].overridden, false);
});
