/**
 * Regenerate the raster app icons from the single source,
 * `frontend/public/favicon.svg`, using the Chromium that Playwright
 * already installs for the e2e suite (no image-processing dependency).
 *
 * Run after changing the SVG, then commit the regenerated files:
 *
 *   bun run icons
 *
 * Outputs (all in `frontend/public/`, copied to the site root by Vite):
 * - favicon.ico: 32px rounded tile, a PNG wrapped in an ICO container
 * - icon-192.png, icon-512.png: rounded tile, transparent corners
 *   (manifest purpose "any")
 * - apple-touch-icon.png: 180px full-bleed opaque tile (iOS rounds the
 *   corners itself and backs transparency with black)
 * - icon-maskable-512.png: full-bleed tile with the glyph scaled into the
 *   maskable safe zone (the central circle of radius 40%)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "@playwright/test";
import type { Page } from "@playwright/test";

const PUBLIC_DIR = resolve(import.meta.dir, "../frontend/public");

/** How one raster icon is rendered from the SVG. */
interface IconSpec {
  /** Output file name in the public directory. */
  file: string;
  /** Width and height in pixels. */
  size: number;
  /** Fill the square behind the rounded tile with the tile colour. */
  fullBleed: boolean;
  /** Scale of the SVG within the square (1 = edge to edge). */
  scale: number;
}

const PNG_ICONS: IconSpec[] = [
  { file: "icon-192.png", size: 192, fullBleed: false, scale: 1 },
  { file: "icon-512.png", size: 512, fullBleed: false, scale: 1 },
  { file: "apple-touch-icon.png", size: 180, fullBleed: true, scale: 1 },
  // At 0.8 the glyph's farthest point sits ~36% from the centre, inside
  // the 40% maskable safe-zone radius.
  { file: "icon-maskable-512.png", size: 512, fullBleed: true, scale: 0.8 },
];

const ICO_ICON: IconSpec = {
  file: "favicon.ico",
  size: 32,
  fullBleed: false,
  scale: 1,
};

/**
 * Read the tile colour from the SVG's background `<rect>` fill, so the
 * SVG stays the only place the colour is defined.
 *
 * @param svg - the favicon SVG source
 * @returns the tile's fill colour, e.g. "#422ad5"
 */
function tileColour(svg: string): string {
  const match = /<rect\b[^>]*\bfill="(#[0-9a-fA-F]{6})"/.exec(svg);
  if (!match?.[1]) throw new Error("favicon.svg has no <rect> hex fill");
  return match[1];
}

/**
 * Wrap a PNG in a single-image ICO container. ICO files may embed PNG
 * data directly (supported since Windows Vista and by every browser).
 *
 * @param png - the PNG bytes
 * @param size - the PNG's width and height in pixels (1-256)
 * @returns the ICO file bytes
 */
function pngToIco(png: Uint8Array, size: number): Uint8Array {
  const header = new DataView(new ArrayBuffer(22));
  header.setUint16(0, 0, true); // reserved
  header.setUint16(2, 1, true); // type: icon
  header.setUint16(4, 1, true); // image count
  header.setUint8(6, size === 256 ? 0 : size); // width (0 means 256)
  header.setUint8(7, size === 256 ? 0 : size); // height
  header.setUint8(8, 0); // palette size
  header.setUint8(9, 0); // reserved
  header.setUint16(10, 1, true); // colour planes
  header.setUint16(12, 32, true); // bits per pixel
  header.setUint32(14, png.byteLength, true); // image size
  header.setUint32(18, 22, true); // image offset
  const ico = new Uint8Array(22 + png.byteLength);
  ico.set(new Uint8Array(header.buffer), 0);
  ico.set(png, 22);
  return ico;
}

/**
 * Render the SVG to a PNG at the spec's size.
 *
 * @param page - a Chromium page at device scale factor 1
 * @param svg - the favicon SVG source
 * @param spec - size, bleed and scale of the output
 * @returns the PNG bytes
 */
async function renderPng(
  page: Page,
  svg: string,
  spec: IconSpec,
): Promise<Uint8Array> {
  const background = spec.fullBleed ? tileColour(svg) : "transparent";
  const inset = (spec.size * (1 - spec.scale)) / 2;
  const src = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
  await page.setViewportSize({ width: spec.size, height: spec.size });
  await page.setContent(
    `<html><body style="margin:0;background:${background}">` +
      `<img src="${src}" style="display:block;position:absolute;` +
      `left:${inset}px;top:${inset}px;` +
      `width:${spec.size * spec.scale}px;height:${spec.size * spec.scale}px">` +
      `</body></html>`,
  );
  await page.locator("img").evaluate((img: HTMLImageElement) => img.decode());
  return page.screenshot({ type: "png", omitBackground: !spec.fullBleed });
}

/**
 * Render every raster icon from favicon.svg and write them to the public
 * directory.
 */
async function main(): Promise<void> {
  const svg = readFileSync(join(PUBLIC_DIR, "favicon.svg"), "utf8");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ deviceScaleFactor: 1 });
    for (const spec of PNG_ICONS) {
      writeFileSync(
        join(PUBLIC_DIR, spec.file),
        await renderPng(page, svg, spec),
      );
      console.log(`wrote ${spec.file}`);
    }
    const png = await renderPng(page, svg, ICO_ICON);
    writeFileSync(
      join(PUBLIC_DIR, ICO_ICON.file),
      pngToIco(png, ICO_ICON.size),
    );
    console.log(`wrote ${ICO_ICON.file}`);
  } finally {
    await browser.close();
  }
}

if (import.meta.main) await main();
