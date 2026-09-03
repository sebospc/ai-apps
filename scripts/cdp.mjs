/**
 * A browser, driven over the Chrome DevTools Protocol, with no dependencies.
 *
 * Node 22 ships a global WebSocket, and CDP is just JSON over one — so a real browser costs us a
 * ~120 line file instead of Playwright and its download step. Enough to type into a form, click,
 * navigate and read the page back, which is all a functional test of this app needs.
 *
 * Requires Node >= 22 (WebSocket) and Google Chrome installed.
 */

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

/**
 * Runs in the page before any of the app's own code. `requestAnimationFrame` fires just before the
 * browser paints the frame, so the background read there is the colour the reader's first frame
 * actually shows — a theme that only turns dark on hydration is a white flash, and this catches it.
 */
const FIRST_PAINT_PROBE = `
  window.__smith = { cumulativeLayoutShift: 0, firstPaintBackground: null };
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      // A shift the reader caused by clicking is not a shift they were surprised by.
      if (!entry.hadRecentInput) window.__smith.cumulativeLayoutShift += entry.value;
    }
  }).observe({ type: "layout-shift", buffered: true });
  const readBackground = () => {
    if (!document.body) return requestAnimationFrame(readBackground);
    window.__smith.firstPaintBackground = getComputedStyle(document.body).backgroundColor;
  };
  requestAnimationFrame(readBackground);
`;

/**
 * `insecure` is for the production stack, where Caddy issues the certificate from its own CA. A
 * throwaway profile pointed at localhost is the one place ignoring the chain costs nothing, and the
 * alternative — installing a CA into the machine's keychain from a test — costs a lot.
 */
export async function launch({
  port = 9222,
  headless = true,
  insecure = process.env.SMITH_INSECURE_TLS === "1",
} = {}) {
  const profile = mkdtempSync(join(tmpdir(), "smith-cdp-"));
  const chrome = spawn(
    CHROME,
    [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      ...(headless ? ["--headless=new"] : []),
      ...(insecure ? ["--ignore-certificate-errors"] : []),
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-extensions",
      "about:blank",
    ],
    { stdio: "ignore", detached: false }
  );

  const target = await waitFor(async () => {
    const res = await fetch(`http://127.0.0.1:${port}/json/list`);
    const targets = await res.json();
    return targets.find((t) => t.type === "page");
  }, "Chrome did not expose a page target");

  const page = await connect(target.webSocketDebuggerUrl);
  page.close = async () => {
    // Cleanup runs in a `finally`, so it must never throw: an error here would replace the actual
    // test failure with a temp-directory complaint, which is how you lose an afternoon.
    try {
      page.socket.close();
      chrome.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 300)); // let Chrome flush its profile before removing it
      // The profile holds the session cookie; a leftover one would poison the next run.
      rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      /* the OS will reap the temp dir */
    }
  };
  return page;
}

async function connect(url) {
  const socket = new WebSocket(url);
  const pending = new Map();
  let nextId = 1;

  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", () => reject(new Error("CDP socket failed")), { once: true });
  });

  // What the page complained about since the last visit. Reset by `goto`, read by `audit`.
  const recorded = { messages: [], requests: [] };

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.method) return observe(message.method, message.params);
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    message.error ? waiter.reject(new Error(message.error.message)) : waiter.resolve(message.result);
  });

  function observe(method, params) {
    if (method === "Runtime.consoleAPICalled" && (params.type === "error" || params.type === "warning")) {
      const text = params.args.map(describe).join(" ");
      recorded.messages.push(`console.${params.type}: ${text}`);
    }
    if (method === "Log.entryAdded" && params.entry.level === "error") {
      recorded.messages.push(`log: ${params.entry.text} ${params.entry.url ?? ""}`.trim());
    }
    if (method === "Network.responseReceived" && params.response.status >= 400) {
      recorded.requests.push(`${params.response.status} ${params.response.url}`);
    }
  }

  const describe = (arg) =>
    arg.description ?? (arg.value === undefined ? arg.type : JSON.stringify(arg.value));

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Log.enable");
  await send("Network.enable");
  // Both measurements have to exist before the first byte of the document: layout shift is only
  // observable while it happens, and the background at first paint stops being readable the moment
  // hydration repaints it.
  await send("Page.addScriptToEvaluateOnNewDocument", { source: FIRST_PAINT_PROBE });

  const page = {
    socket,
    send,

    /** Evaluate in the page and return the value. Throws if the expression throws. */
    async evaluate(expression) {
      const { result, exceptionDetails } = await send("Runtime.evaluate", {
        expression: `(async () => { ${expression} })()`,
        awaitPromise: true,
        returnByValue: true,
      });
      if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? "page threw");
      return result.value;
    },

    async goto(url) {
      recorded.messages.length = 0;
      recorded.requests.length = 0;
      await send("Page.navigate", { url });
      await page.waitForText("", { timeout: 15000 }); // settles on document ready
    },

    /**
     * Everything the current visit did wrong, gathered since the last `goto`. A page that is
     * quiet on all four counts is a page nobody has to apologise for.
     */
    async audit() {
      const probe = await page.evaluate(`
        // Judge the page only once it has finished being one. 'complete' means every subresource
        // resolved, so a request that 404s late still counts; idle means hydration has drained off
        // the main thread, which is when React reports a mismatch; and the two frames give the
        // layout-shift observer time to deliver what it has already queued.
        if (document.readyState !== "complete") {
          await new Promise((r) => window.addEventListener("load", r, { once: true }));
        }
        await new Promise((r) => requestIdleCallback(r, { timeout: 3000 }));
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        return {
          cumulativeLayoutShift: window.__smith ? window.__smith.cumulativeLayoutShift : null,
          firstPaintBackground: window.__smith ? window.__smith.firstPaintBackground : null,
          background: getComputedStyle(document.body).backgroundColor,
        };
      `);
      return { ...probe, messages: [...recorded.messages], requests: [...recorded.requests] };
    },

    /** Poll until the page's text contains `needle`. The only synchronisation this app needs. */
    async waitForText(needle, { timeout = 10000 } = {}) {
      return waitFor(
        async () => {
          const text = await page.evaluate("return document.body ? document.body.innerText : ''");
          return text.includes(needle) ? text : null;
        },
        `timed out waiting for ${JSON.stringify(needle)}`,
        timeout
      );
    },

    text() {
      return page.evaluate("return document.body.innerText");
    },

    async fill(selector, value) {
      const ok = await page.evaluate(`
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return false;
        const setter = Object.getOwnPropertyDescriptor(el.constructor.prototype, "value").set;
        setter.call(el, ${JSON.stringify(value)});
        el.dispatchEvent(new Event("input", { bubbles: true }));
        return true;
      `);
      if (!ok) throw new Error(`no element matches ${selector}`);
    },

    async click(selector) {
      const ok = await page.evaluate(`
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return false;
        el.click();
        return true;
      `);
      if (!ok) throw new Error(`no element matches ${selector}`);
    },

    url() {
      return page.evaluate("return location.pathname");
    },

    /**
     * Render the whole page at `width` and write it to `path`.
     *
     * Two overrides rather than one: the height has to be the document's own, and the document
     * only knows its height once it has been laid out at that width. Capturing the viewport alone
     * would frame the top of every screen and miss exactly the kind of thing a screenshot is for.
     */
    async screenshot(path, { width, maxHeight = 4000 } = {}) {
      const metrics = { width, deviceScaleFactor: 1, mobile: false };
      await send("Emulation.setDeviceMetricsOverride", { ...metrics, height: 800 });
      const height = await page.evaluate(`
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        return document.documentElement.scrollHeight;
      `);
      await send("Emulation.setDeviceMetricsOverride", {
        ...metrics,
        height: Math.min(Math.max(height, 200), maxHeight),
      });
      const { data } = await send("Page.captureScreenshot", { format: "png" });
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, Buffer.from(data, "base64"));
    },

    /**
     * Whether the page can be scrolled sideways at the current width, and what is sticking out.
     *
     * Text is measured as well as boxes, and that is the point: the thing that actually runs off a
     * phone is an unbreakable string — a file path, a branch name — whose own element stays inside
     * the card while its glyphs do not. Chrome reports no oversized box for that at all.
     *
     * Content inside a deliberately scrollable container is not a bug, that is what `overflow-x:
     * auto` is for, so an offender only counts when nothing between it and the root clips.
     */
    overflow() {
      return page.evaluate(`
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        const root = document.documentElement;
        const viewport = root.clientWidth;
        const clipped = (el) => {
          for (let p = el; p; p = p.parentElement) {
            const overflowX = getComputedStyle(p).overflowX;
            if (overflowX === "auto" || overflowX === "scroll" || overflowX === "hidden") return true;
          }
          return false;
        };
        const describe = (el, right) =>
          el.tagName.toLowerCase() +
          (typeof el.className === "string" && el.className.trim()
            ? "." + el.className.trim().split(/\\s+/).slice(0, 3).join(".")
            : "") +
          " → " + Math.round(right) + "px";

        const offenders = [];
        for (const el of document.querySelectorAll("body *")) {
          const box = el.getBoundingClientRect();
          if (box.width > 0 && box.right > viewport + 1 && !clipped(el.parentElement)) {
            offenders.push(describe(el, box.right));
          }
        }
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          if (!node.nodeValue.trim() || clipped(node.parentElement)) continue;
          const range = document.createRange();
          range.selectNodeContents(node);
          const box = range.getBoundingClientRect();
          if (box.right > viewport + 1) {
            offenders.push(describe(node.parentElement, box.right) + ' "' + node.nodeValue.trim().slice(0, 40) + '"');
          }
        }
        return {
          viewport,
          scrollWidth: root.scrollWidth,
          // Nesting means the same overflow is reported by a box and by its children; the first
          // few are the ones worth naming.
          offenders: [...new Set(offenders)].slice(0, 5),
        };
      `);
    },

    /** Back to whatever size Chrome was launched with, so the next audit measures a normal window. */
    resetViewport() {
      return send("Emulation.clearDeviceMetricsOverride");
    },
  };
  return page;
}

async function waitFor(probe, message, timeout = 20000) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value !== null && value !== undefined && value !== false) return value;
    } catch (err) {
      lastError = err;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`${message}${lastError ? ` (last error: ${lastError.message})` : ""}`);
}
