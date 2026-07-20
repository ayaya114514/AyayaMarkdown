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

  await firstTab.evaluate(() => window.cm.setValue("# First tab version"));
  await firstTab.waitForTimeout(350);
  await secondTab.evaluate(() => window.cm.setValue("# Conflicting second tab version"));
  await expect(secondTab.locator("#toast-container")).toContainText("另一标签页已更新此文档");

  await secondTab.reload();
  await secondTab.waitForFunction(() => window.cm && document.querySelector("#preview h1"));
  await expect(secondTab.locator("#preview h1")).toHaveText("First tab version");
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
