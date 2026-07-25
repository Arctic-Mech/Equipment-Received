/* Dev-only lint config. GitHub Pages ignores it — nothing here ships to the browser.
   It exists to catch one specific class of mistake: splitting app.js into modules and
   leaving a helper behind, so a function calls a name that no longer exists in its file.
   That kind of break is invisible to a browser smoke test whenever the failing line sits
   on a path the smoke test doesn't walk, so `no-undef` is the real gate.

   Run:  npx eslint@9 .

   Globals are listed inline on purpose — no package.json, no node_modules, no `globals`
   or `@eslint/js` dependency, so the command works in a clean checkout. Deliberately NOT
   extending eslint:recommended: only the two rules below are wanted here, and
   no-unused-vars in particular would flag the idb.js imports, which app.js re-imports to
   keep the module loaded even though the photo code that called them moved to Firestore. */

const browserGlobals = [
  // core document / window
  "window", "document", "navigator", "location", "history", "screen", "self",
  "localStorage", "sessionStorage", "indexedDB", "caches", "crypto", "performance",
  "console", "alert", "confirm", "prompt",
  // timers + scheduling
  "setTimeout", "clearTimeout", "setInterval", "clearInterval",
  "requestAnimationFrame", "cancelAnimationFrame", "queueMicrotask",
  // network
  "fetch", "Headers", "Request", "Response", "XMLHttpRequest", "WebSocket",
  "AbortController", "AbortSignal", "FormData", "URL", "URLSearchParams",
  // files + binary
  "Blob", "File", "FileList", "FileReader", "DataTransfer", "atob", "btoa",
  "TextEncoder", "TextDecoder", "structuredClone",
  // DOM types
  "Element", "HTMLElement", "HTMLCanvasElement", "HTMLImageElement", "HTMLInputElement",
  "Node", "NodeList", "NodeFilter", "SVGElement", "DocumentFragment", "DOMParser",
  "XMLSerializer", "CSS", "CustomEvent", "Event", "MouseEvent", "KeyboardEvent", "TouchEvent",
  "DragEvent", "ClipboardEvent", "Image", "Audio", "Option", "Range", "Selection",
  "getSelection", "getComputedStyle", "matchMedia", "scrollTo", "scrollBy",
  // observers
  "MutationObserver", "IntersectionObserver", "ResizeObserver",
  // notifications / workers / misc platform
  "Notification", "Worker", "SharedWorker", "ServiceWorker", "BroadcastChannel",
  "IDBKeyRange", "IDBRequest", "MediaRecorder", "AbortError", "OffscreenCanvas",
  "print", "open", "close", "postMessage", "addEventListener", "removeEventListener",
  "requestIdleCallback", "reportError",

  // classic <script> globals loaded before app.js in index.html
  "XLSX",        // https://cdn.sheetjs.com/xlsx-0.20.3/...
  "pdfjsLib",    // https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/...
];

const globals = Object.fromEntries(browserGlobals.map(name => [name, "readonly"]));

export default [
  {
    files: ["**/*.js", "**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals,
    },
    rules: {
      // The whole point: a helper left behind during a module split is an error, not a
      // runtime surprise on some page nobody clicked during testing.
      "no-undef": "error",
      // ES modules make imported bindings read-only. Assigning to one is a TypeError in
      // strict mode, and it is the trap that limits how far app.js can be split at all.
      "no-import-assign": "error",
    },
  },
];
