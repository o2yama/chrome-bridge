const test = require("node:test");
const assert = require("node:assert/strict");

const {
  classifyKind,
  canSubmit,
  hasRiskyLink,
  guardClick,
} = require("../extension/page-functions.js");

test("kindを素の要素情報から分類する", () => {
  assert.equal(classifyKind({ tag: "a", href: "https://example.com" }), "link");
  assert.equal(classifyKind({ tag: "button" }), "button");
  assert.equal(classifyKind({ tag: "textarea" }), "input");
  assert.equal(classifyKind({ tag: "div", isContentEditable: true }), "input");
  assert.equal(classifyKind({ tag: "label", hasAssociatedControl: true }), "input");
  assert.equal(classifyKind({ tag: "div", role: "tab" }), "other");
  assert.equal(classifyKind({ tag: "div", role: "switch" }), "input");
  assert.equal(classifyKind({ tag: "button", role: "checkbox" }), "input");
});

test("フォームを送信しうる要素を判定する", () => {
  assert.equal(canSubmit({ tag: "button", type: "", inForm: true }), true);
  assert.equal(canSubmit({ tag: "button", type: "button", inForm: true }), false);
  assert.equal(canSubmit({ tag: "input", type: "submit", inForm: true }), true);
  assert.equal(canSubmit({ tag: "input", type: "image", inForm: true }), true);
  assert.equal(canSubmit({ tag: "input", type: "submit", inForm: false }), false);
});

test("確認が必要なリンクを判定する", () => {
  assert.equal(hasRiskyLink({ tag: "a", href: "https://example.com" }), false);
  assert.equal(hasRiskyLink({ tag: "a", href: "/next" }), false);
  assert.equal(hasRiskyLink({ tag: "a", href: "javascript:void(0)" }), false);
  assert.equal(hasRiskyLink({ tag: "a", href: "mailto:test@example.com" }), true);
  assert.equal(hasRiskyLink({ tag: "a", href: "https://example.com", hasDownload: true }), true);
});

test("入力要素のclickはallowInputを要求する", () => {
  assert.deepEqual(guardClick({ tag: "input", type: "text" }), {
    allowed: false,
    code: "INPUT_BLOCKED",
  });
  assert.deepEqual(guardClick({ tag: "input", type: "text" }, { allowInput: true }), {
    allowed: true,
  });
});

test("送信操作と危険なリンクはallowRiskyを要求する", () => {
  const submit = { tag: "button", type: "submit", inForm: true };
  assert.equal(guardClick(submit).code, "NEEDS_CONFIRMATION");
  assert.deepEqual(guardClick(submit, { allowRisky: true }), { allowed: true });
  assert.equal(guardClick({ tag: "a", href: "tel:0123456789" }).code, "NEEDS_CONFIRMATION");
});

test("入力兼送信要素では両方の許可を要求する", () => {
  const submit = { tag: "input", type: "submit", inForm: true };
  assert.equal(guardClick(submit, { allowRisky: true }).code, "INPUT_BLOCKED");
  assert.equal(guardClick(submit, { allowInput: true }).code, "NEEDS_CONFIRMATION");
  assert.deepEqual(guardClick(submit, { allowInput: true, allowRisky: true }), { allowed: true });
});

const { guardKey } = require("../extension/page-functions.js");

test("Enterはフォーム内と送信要素で確認を要求する", () => {
  for (const element of [{ tag: "input", inForm: true }, { tag: "button", type: "submit", inForm: true }, { tag: "div", inForm: true }]) {
    assert.equal(guardKey(element, "Enter").code, "NEEDS_CONFIRMATION");
    assert.equal(guardKey(element, "Ctrl+Enter").code, "NEEDS_CONFIRMATION");
    assert.deepEqual(guardKey(element, "Enter", { allowRisky: true }), { allowed: true });
  }
  assert.deepEqual(guardKey({ tag: "input" }, "Enter"), { allowed: true });
});

test("Spaceと削除キーは入力要素でだけ入力許可を要求する", () => {
  for (const key of ["Space", "Backspace", "Delete"]) {
    for (const element of [{ tag: "input" }, { tag: "div", isContentEditable: true }, { tag: "div", role: "textbox" }]) {
      assert.equal(guardKey(element, key).code, "INPUT_BLOCKED");
      assert.deepEqual(guardKey(element, key, { allowInput: true }), { allowed: true });
    }
    assert.deepEqual(guardKey({ tag: "button" }, key), { allowed: true });
  }
});

test("1文字と貼り付けはフォーカス先によらず入力許可を要求する", () => {
  for (const key of ["a", "あ", "+", " ", "Meta+v", "Ctrl+v", "Ctrl+Shift+V"]) {
    assert.equal(guardKey({ tag: "body" }, key).code, "INPUT_BLOCKED");
    assert.deepEqual(guardKey({}, key, { allowInput: true }), { allowed: true });
  }
  for (const key of ["Escape", "Tab", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown", "Home", "End", "Meta+a", "Ctrl+a"]) {
    assert.deepEqual(guardKey({ tag: "input", inForm: true }, key), { allowed: true });
  }
});
