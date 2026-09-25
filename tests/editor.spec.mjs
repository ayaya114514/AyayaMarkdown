import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

async function openEditor(page) {
  await page.goto("/");
  await page.waitForFunction(() => window.cm && document.querySelector("#preview h1"));
}

test("loads the complete editor without runtime errors", async ({ page }) => {
  const errors = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));

  await openEditor(page);
  await expect(page.locator("#preview .katex").first()).toBeVisible();
  await expect(page.locator("#preview .mermaid svg").first()).toBeVisible();
  expect(errors).toEqual([]);
});

test("sanitizes raw HTML event handlers", async ({ page }) => {
  await openEditor(page);
  await page.evaluate(() => {
    window.cm.setValue('# Safe\n\n<img src="xss-probe" onerror="this.dataset.executed=\'yes\';window.__xssProbe=1">');
  });
  await expect(page.locator("#preview h1")).toHaveText("Safe");

  const image = page.locator("#preview img");
  await expect(image).toHaveCount(1);
  await expect(image).not.toHaveAttribute("onerror", /.+/);
  await expect(image).not.toHaveAttribute("data-executed", "yes");
  expect(await page.evaluate(() => window.__xssProbe)).toBeUndefined();
});

test("keeps editing available when localStorage is blocked", async ({ page }) => {
  await page.addInitScript(() => {
    for (const method of ["getItem", "setItem", "removeItem"]) {
      Object.defineProperty(Storage.prototype, method, {
        configurable: true,
        value() {
          throw new DOMException("blocked", "SecurityError");
        },
      });
    }
  });
  await openEditor(page);
  await expect(page.locator("#preview h1")).toBeVisible();
  await expect(page.locator("#toast-container")).toContainText("界面设置无法保存");
});

test("exports the current editor value without waiting for live-preview debounce", async ({ page }, testInfo) => {
  await openEditor(page);
  await page.evaluate(() => window.cm.setValue("# Previous\n\nOLD CONTENT"));
  await expect(page.locator("#preview h1")).toHaveText("Previous");

  await page.evaluate(() => window.cm.setValue("# Current export\n\nFRESH CONTENT"));
  const downloadPromise = page.waitForEvent("download");
  await page.locator("#btn-export-html").click();
  const download = await downloadPromise;
  const outputPath = testInfo.outputPath("current-export.html");
  await download.saveAs(outputPath);
  const exported = await readFile(outputPath, "utf8");

  expect(exported).toContain("Current export");
  expect(exported).toContain("FRESH CONTENT");
  expect(exported).not.toContain("OLD CONTENT");
  expect(exported).not.toContain("onerror=");
  expect(exported).not.toContain("class=\"copy-btn\"");
});

test("preserves newest-first document order after reload", async ({ page }) => {
  await openEditor(page);
  await page.locator("#btn-new").click();
  await page.evaluate(() => window.cm.setValue("# Newest document"));
  await expect(page.locator(".document-title").first()).toHaveText("Newest document");
  await page.waitForTimeout(350);
  await page.reload();
  await page.waitForFunction(() => window.cm && document.querySelectorAll(".document-title").length === 2);
  await expect(page.locator(".document-title").first()).toHaveText("Newest document");
});

test("does not silently overwrite a document changed in another tab", async ({ context }) => {
  const firstTab = await context.newPage();
  const secondTab = await context.newPage();
  await openEditor(firstTab);
  await openEditor(secondTab);

  // 两边在对方保存前都改了同一篇文档：后保存的一方必须报冲突，而不是覆盖
  await firstTab.evaluate(() => window.cm.setValue("# First tab version"));
  await secondTab.waitForTimeout(100);
  await secondTab.evaluate(() => window.cm.setValue("# Conflicting second tab version"));
  await expect(secondTab.locator("#toast-container")).toContainText("另一标签页已更新此文档");

  // 冲突后继续输入不会反复弹同一条提示
  for (const text of ["a", "b", "c"]) {
    await secondTab.evaluate((value) => window.cm.replaceRange(value, { line: 0, ch: 0 }), text);
    await secondTab.waitForTimeout(300);
  }
  // toast 会自动消失，用即时计数而不是会重试的 toHaveCount
  expect(await secondTab.locator(".toast", { hasText: "另一标签页已更新此文档" }).count()).toBe(1);

  await secondTab.reload();
  await secondTab.waitForFunction(() => window.cm && document.querySelector("#preview h1"));
  await expect(secondTab.locator("#preview h1")).toHaveText("First tab version");
});

test("syncs edits between tabs without false conflicts from unchanged flushes", async ({ context }) => {
  const firstTab = await context.newPage();
  const secondTab = await context.newPage();
  await openEditor(firstTab);
  await openEditor(secondTab);

  // 第一个标签页没有修改，只是被切到后台（会 flush 一次）
  await firstTab.evaluate(() => window.dispatchEvent(new Event("pagehide")));
  await firstTab.waitForTimeout(200);

  await secondTab.evaluate(() => window.cm.setValue("# Edited in second tab"));
  await secondTab.waitForTimeout(400);
  await expect(secondTab.locator(".toast.error")).toHaveCount(0);

  // 另一标签页无本地修改，自动刷新成最新内容
  await expect(firstTab.locator("#preview h1")).toHaveText("Edited in second tab");
  await expect(firstTab.locator(".document-title").first()).toHaveText("Edited in second tab");
});

test("does not bump the saved version of an unchanged document when switching", async ({ page }) => {
  await openEditor(page);
  const readVersions = () =>
    page.evaluate(
      () =>
        new Promise((resolve) => {
          const request = indexedDB.open("ayaya-markdown");
          request.onsuccess = () => {
            const all = request.result.transaction("documents").objectStore("documents").getAll();
            all.onsuccess = () => resolve(Object.fromEntries(all.result.map((doc) => [doc.id, doc.updatedAt])));
          };
        })
    );

  await page.locator("#btn-new").click();
  await page.waitForTimeout(300);
  const before = await readVersions();
  await page.waitForTimeout(50);
  await page.locator(".document-switch").nth(1).click();
  await page.locator(".document-switch").nth(0).click();
  await page.waitForTimeout(300);
  expect(await readVersions()).toEqual(before);
});

test("keeps existing documents when the first IndexedDB read fails", async ({ page }) => {
  await openEditor(page);
  await page.evaluate(() => window.cm.setValue("# Precious document"));
  await page.waitForTimeout(400);

  await page.addInitScript(() => {
    if (sessionStorage.getItem("idb-read-failed-once")) return;
    sessionStorage.setItem("idb-read-failed-once", "1");
    const original = IDBObjectStore.prototype.getAll;
    IDBObjectStore.prototype.getAll = function () {
      IDBObjectStore.prototype.getAll = original;
      throw new DOMException("simulated read failure", "UnknownError");
    };
  });
  await page.reload();
  await page.waitForFunction(() => window.cm && document.querySelector(".document-title"));
  await expect(page.locator("#toast-container")).toContainText("本地文档读取失败");
  await page.waitForTimeout(400);

  await page.reload();
  await page.waitForFunction(() => window.cm && document.querySelector("#preview h1"));
  await expect(page.locator(".document-title")).toHaveText(["Precious document"]);
});

test("exports once per Ctrl/Cmd+S even when the editor has focus", async ({ page }) => {
  await openEditor(page);
  let downloads = 0;
  page.on("download", () => downloads++);
  await page.locator(".CodeMirror").click();
  await page.keyboard.press("ControlOrMeta+s");
  await page.waitForTimeout(800);
  expect(downloads).toBe(1);
});

test("renders math only from math syntax, not currency or escaped dollars", async ({ page }) => {
  await openEditor(page);
  await page.evaluate(() =>
    window.cm.setValue(
      "# Math\n\n价格 $5 和 $10。\n\n转义 \\$5 和 \\$6。\n\n行内 $x^2$ 与 \\(y^2\\)。\n\n\\[z^2\\]\n\n$$\nw^2\n$$"
    )
  );
  const paragraphs = page.locator("#preview > p");
  await expect(paragraphs.nth(0)).toHaveText("价格 $5 和 $10。");
  await expect(paragraphs.nth(0).locator(".katex")).toHaveCount(0);
  await expect(paragraphs.nth(1)).toHaveText("转义 $5 和 $6。");
  await expect(paragraphs.nth(2).locator(".katex")).toHaveCount(2);
  await expect(page.locator("#preview .math-block .katex-display")).toHaveCount(2);
});

test("keeps preview heading ids from colliding with app ids", async ({ page }) => {
  await openEditor(page);
  await page.evaluate(() => window.cm.setValue('# preview\n\n<div id="editor">raw</div>\n\n[back](#preview)'));
  await expect(page.locator("#preview h1")).toHaveId("preview-1");
  expect(await page.evaluate(() => ["preview", "editor"].map((id) => document.querySelectorAll(`#${id}`).length))).toEqual([1, 1]);
});

test("counts CJK characters individually in the word statistic", async ({ page }) => {
  await openEditor(page);
  await page.evaluate(() => window.cm.setValue("# 中文测试\n\nhello world，没有空格。"));
  await expect(page.locator("#stat-words")).toHaveText("10");
});

test("restores the copy button label after repeated clicks", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await openEditor(page);
  await page.evaluate(() => window.cm.setValue("# Copy\n\n```js\nlet answer = 42;\n```"));
  await expect(page.locator("#preview h1")).toHaveText("Copy");
  const wrapper = page.locator("#preview .code-block-wrapper");
  const button = wrapper.locator(".copy-btn");
  await wrapper.hover();
  await button.click();
  await page.waitForTimeout(300);
  await button.click();
  await expect(button).toContainText("已复制");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("let answer = 42;");
  await page.waitForTimeout(1700);
  await expect(button).toHaveText("复制");
});

test("opens external preview links in a new tab", async ({ page }) => {
  await openEditor(page);
  await page.evaluate(() => window.cm.setValue("# Links\n\n[out](https://example.com) [in](#links)"));
  await expect(page.locator('#preview a[href="https://example.com"]')).toHaveAttribute("target", "_blank");
  await expect(page.locator('#preview a[href="#links"]')).not.toHaveAttribute("target", /.+/);
});

test("splits editor and preview evenly by default", async ({ page }) => {
  await openEditor(page);
  const widths = await page.evaluate(() =>
    [".pane-editor", ".pane-preview"].map((selector) => document.querySelector(selector).getBoundingClientRect().width)
  );
  expect(Math.abs(widths[0] - widths[1])).toBeLessThan(4);
});

test("exports Mermaid diagrams with a light theme", async ({ page }, testInfo) => {
  await openEditor(page);
  await page.evaluate(() => window.cm.setValue("# Diagram\n\n```mermaid\ngraph LR\n  A --> B\n```"));
  await expect(page.locator("#preview h1")).toHaveText("Diagram");
  await expect(page.locator("#preview .mermaid svg")).toBeVisible();
  const downloadPromise = page.waitForEvent("download");
  await page.locator("#btn-export-html").click();
  const outputPath = testInfo.outputPath("diagram.html");
  await (await downloadPromise).saveAs(outputPath);
  const exported = await readFile(outputPath, "utf8");
  expect(exported).toContain("<svg");
  expect(exported.toLowerCase()).toContain("#ececff");
  expect(exported).not.toContain("%%{init");
});

test("resets a desktop split when entering the mobile layout", async ({ page }) => {
  await openEditor(page);
  const splitter = page.locator("#splitter");
  const box = await splitter.boundingBox();
  if (!box) throw new Error("splitter is not visible");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x - 150, box.y + box.height / 2, { steps: 5 });
  await page.mouse.up();
  await expect(page.locator(".pane-editor")).toHaveAttribute("style", /flex/);

  await page.setViewportSize({ width: 390, height: 800 });
  const sizes = await page.evaluate(() => ({
    editor: document.querySelector(".pane-editor").getBoundingClientRect().height,
    preview: document.querySelector(".pane-preview").getBoundingClientRect().height,
  }));
  expect(sizes.editor).toBeGreaterThan(150);
  expect(sizes.preview).toBeGreaterThan(150);
  expect(Math.abs(sizes.editor - sizes.preview)).toBeLessThan(40);
});

test("keeps the top toolbar inside a 320px viewport", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await openEditor(page);
  await expect(page.locator("#btn-github")).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
});

test("exposes editor feedback and resizers to assistive technology", async ({ page }) => {
  await openEditor(page);
  await expect(page.locator(".CodeMirror textarea")).toHaveAttribute("aria-label", "Markdown 编辑器");
  await expect(page.locator("#splitter")).toHaveAttribute("role", "separator");
  await expect(page.locator("#document-sidebar-resizer")).toHaveAttribute("tabindex", "0");
  await expect(page.locator("#toast-container")).toHaveAttribute("aria-live", "polite");
});

test("supports keyboard navigation in the toolbar overflow menu", async ({ page }) => {
  await openEditor(page);
  const moreButton = page.locator("#btn-toolbar-more");
  await expect(moreButton).toBeVisible();
  await moreButton.click();

  const menuItems = page.locator('#editor-tool-popup [role="menuitem"]');
  await expect(menuItems.first()).toBeFocused();
  await menuItems.first().press("End");
  await expect(menuItems.last()).toBeFocused();
  await menuItems.last().press("ArrowDown");
  await expect(menuItems.first()).toBeFocused();
});
