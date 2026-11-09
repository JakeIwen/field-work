/** Matches the browser's toolbar color (meta theme-color) to the page background
 * after a mode or palette change. Canvas converts the computed oklch to sRGB,
 * which every browser accepts there. */
export function syncThemeColor() {
  if (typeof window.requestAnimationFrame !== "function") return;
  // Wait a frame: on first load the stylesheets may not be applied yet.
  window.requestAnimationFrame(() => {
    const meta = document.querySelector('meta[name="theme-color"]');
    const context = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
    if (!meta || !context) return;
    context.fillStyle = window.getComputedStyle(document.body).backgroundColor;
    context.fillRect(0, 0, 1, 1);
    const [red, green, blue] = context.getImageData(0, 0, 1, 1).data;
    meta.setAttribute("content", `#${[red, green, blue].map(channel => channel.toString(16).padStart(2, "0")).join("")}`);
  });
}
