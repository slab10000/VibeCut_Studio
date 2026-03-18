/**
 * Tauri's WKWebView sandboxes DataTransfer, so dataTransfer.getData() can
 * return an empty string in the drop handler even after setData() was called.
 * We mirror the payload in a module-level variable as a reliable fallback.
 */
export const libraryDrag = {
  clipId: null as string | null,
};
