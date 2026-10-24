import { expect, test } from "@playwright/test";
import type { APIRequestContext, Page } from "@playwright/test";

/**
 * Brand tile colour: the daisyUI light theme's `--color-primary`
 * (oklch(45% 0.24 277.023)) converted to sRGB, #422ad5. The icons are
 * static assets, so they carry the default (light) theme's primary.
 */
const TILE = { r: 0x42, g: 0x2a, b: 0xd5 };

/** The glyph is drawn in white on the tile. */
const GLYPH = { r: 0xff, g: 0xff, b: 0xff };

/** An RGBA pixel sampled from a decoded icon. */
interface Pixel {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** A decoded icon: its intrinsic size and sampled pixels. */
interface DecodedIcon {
  width: number;
  height: number;
  /** Top-left corner pixel. */
  corner: Pixel;
  /** Pixel at the centre, which lies on the glyph's horizontal stroke. */
  centre: Pixel;
  /** Pixel at (50%, 10%): tile background above the glyph. */
  tile: Pixel;
  /**
   * Farthest distance of any glyph pixel (clearly lighter than the tile)
   * from the centre, as a fraction of the width.
   */
  glyphReach: number;
}

/**
 * Decode an icon in the browser (the same decoder that renders it in a
 * tab or on a home screen) and sample its pixels. SVGs, which have no
 * intrinsic raster size, are rasterised at 64x64.
 */
async function decodeIcon(page: Page, href: string): Promise<DecodedIcon> {
  return page.evaluate(async (src) => {
    const img = new Image();
    img.src = src;
    await img.decode();
    const width = img.naturalWidth || 64;
    const height = img.naturalHeight || 64;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no 2d context");
    ctx.drawImage(img, 0, 0, width, height);
    const at = (x: number, y: number) => {
      const [r = 0, g = 0, b = 0, a = 0] = ctx.getImageData(x, y, 1, 1).data;
      return { r, g, b, a };
    };
    const { data } = ctx.getImageData(0, 0, width, height);
    let glyphReach = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const g = data[(y * width + x) * 4 + 1] ?? 0;
        const a = data[(y * width + x) * 4 + 3] ?? 0;
        // The tile's green channel is 0x2a; the white glyph's is 0xff.
        if (a === 255 && g > 0x2a + 20) {
          const reach =
            Math.hypot(x + 0.5 - width / 2, y + 0.5 - height / 2) / width;
          glyphReach = Math.max(glyphReach, reach);
        }
      }
    }
    return {
      width,
      height,
      corner: at(0, 0),
      centre: at(Math.floor(width / 2), Math.floor(height / 2)),
      tile: at(Math.floor(width / 2), Math.floor(height * 0.1)),
      glyphReach,
    };
  }, href);
}

/** Assert an opaque pixel matches a colour within anti-aliasing tolerance. */
function expectColour(
  pixel: Pixel,
  colour: { r: number; g: number; b: number },
): void {
  expect(pixel.a).toBe(255);
  expect(Math.abs(pixel.r - colour.r)).toBeLessThanOrEqual(3);
  expect(Math.abs(pixel.g - colour.g)).toBeLessThanOrEqual(3);
  expect(Math.abs(pixel.b - colour.b)).toBeLessThanOrEqual(3);
}

/**
 * Fetch an asset without any session cookie (icons are requested before
 * sign-in) and assert it is the real asset, not the SPA's index.html
 * fallback, which also answers 200 for unknown paths.
 */
async function expectAsset(
  request: APIRequestContext,
  href: string,
  contentType: string,
): Promise<void> {
  const response = await request.get(href);
  expect(response.status(), href).toBe(200);
  expect(response.headers()["content-type"], href).toContain(contentType);
}

/** The web app manifest as served. */
interface Manifest {
  name: string;
  short_name: string;
  start_url: string;
  scope: string;
  display: string;
  background_color: string;
  theme_color: string;
  icons: { src: string; sizes: string; type: string; purpose?: string }[];
}

test.describe("favicon and app icons", () => {
  test("the browser tab icons are declared and served", async ({
    page,
    request,
  }) => {
    await page.goto("/");

    const svgHref = await page
      .locator('link[rel="icon"][type="image/svg+xml"]')
      .getAttribute("href");
    expect(svgHref).toBe("/favicon.svg");
    await expectAsset(request, "/favicon.svg", "image/svg+xml");
    const svg = await decodeIcon(page, "/favicon.svg");
    expectColour(svg.tile, TILE);
    expectColour(svg.centre, GLYPH);

    // Legacy browsers (and tools that ignore <link>) request /favicon.ico
    // directly, so it is both declared and served at the root.
    const icoHref = await page
      .locator('link[rel="icon"][sizes="32x32"]')
      .getAttribute("href");
    expect(icoHref).toBe("/favicon.ico");
    await expectAsset(request, "/favicon.ico", "image/x-icon");
    const ico = await decodeIcon(page, "/favicon.ico");
    expect([ico.width, ico.height]).toEqual([32, 32]);
    expectColour(ico.tile, TILE);
    expectColour(ico.centre, GLYPH);
  });

  test("the Apple touch icon is a full-bleed opaque 180px tile", async ({
    page,
    request,
  }) => {
    await page.goto("/");
    const href = await page
      .locator('link[rel="apple-touch-icon"]')
      .getAttribute("href");
    expect(href).toBe("/apple-touch-icon.png");
    await expectAsset(request, "/apple-touch-icon.png", "image/png");

    const icon = await decodeIcon(page, "/apple-touch-icon.png");
    expect([icon.width, icon.height]).toEqual([180, 180]);
    // iOS rounds the corners itself and backs transparency with black, so
    // the corner must already be the opaque tile colour.
    expectColour(icon.corner, TILE);
    expectColour(icon.tile, TILE);
    expectColour(icon.centre, GLYPH);
  });

  test("the web app manifest installs JiveDrive standalone with Android icons", async ({
    page,
    request,
  }) => {
    await page.goto("/");
    const href = await page
      .locator('link[rel="manifest"]')
      .getAttribute("href");
    expect(href).toBe("/site.webmanifest");
    await expectAsset(
      request,
      "/site.webmanifest",
      "application/manifest+json",
    );

    const manifest = (await (
      await request.get("/site.webmanifest")
    ).json()) as Manifest;
    expect(manifest).toMatchObject({
      name: "JiveDrive",
      short_name: "JiveDrive",
      start_url: "/",
      scope: "/",
      display: "standalone",
      background_color: "#ffffff",
      theme_color: "#f8f8f8",
    });

    // Every declared icon is served at the size and type it claims.
    for (const icon of manifest.icons) {
      await expectAsset(request, icon.src, icon.type);
      const decoded = await decodeIcon(page, icon.src);
      expect(`${decoded.width}x${decoded.height}`, icon.src).toBe(icon.sizes);
      expectColour(decoded.tile, TILE);
      expectColour(decoded.centre, GLYPH);
    }

    // Purpose "any" icons are shown as-is, so they carry the rounded tile
    // with transparent corners, like the browser tab favicon.
    const any = manifest.icons.filter(
      (icon) => (icon.purpose ?? "any") === "any",
    );
    expect(any.map((icon) => icon.sizes).sort()).toEqual([
      "192x192",
      "512x512",
    ]);
    for (const icon of any) {
      const decoded = await decodeIcon(page, icon.src);
      expect(decoded.corner.a, icon.src).toBe(0);
    }

    // Android crops maskable icons to its own shape, so the maskable icon
    // must be full-bleed (the tile reaches the corners) with the whole
    // glyph inside the safe zone: the central circle of radius 40%.
    const maskable = manifest.icons.filter(
      (icon) => icon.purpose === "maskable",
    );
    expect(maskable.map((icon) => icon.sizes)).toEqual(["512x512"]);
    const decoded = await decodeIcon(page, maskable[0]?.src ?? "");
    expectColour(decoded.corner, TILE);
    expect(decoded.glyphReach).toBeGreaterThan(0);
    expect(decoded.glyphReach).toBeLessThanOrEqual(0.4);
  });

  test("the browser chrome colour matches the header bar in each theme", async ({
    page,
  }) => {
    await page.goto("/");
    const themeColours = await page
      .locator('meta[name="theme-color"]')
      .evaluateAll((metas) =>
        metas.map((meta) => ({
          media: meta.getAttribute("media"),
          content: meta.getAttribute("content"),
        })),
      );
    // daisyUI base-200 (the header bar) for light (oklch(98% 0 0)) and
    // dark (oklch(23.26% 0.014 253.1)), converted to sRGB.
    expect(themeColours).toEqual([
      { media: "(prefers-color-scheme: light)", content: "#f8f8f8" },
      { media: "(prefers-color-scheme: dark)", content: "#191e24" },
    ]);
  });
});
