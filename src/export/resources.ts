import { mathSvg } from "./math";
import type { Block, Run } from "./document";

export interface Raster {
  data: Uint8Array;
  url: string;
  width: number;
  height: number;
}

async function rasterize(url: string, label: string): Promise<Raster> {
  const image = new Image();
  const loaded = new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () =>
      reject(new Error(`Cannot decode image or equation “${label}”.`));
  });
  image.src = url;
  let timer: number | undefined;
  try {
    await Promise.race([
      loaded,
      new Promise<never>((_, reject) => {
        timer = window.setTimeout(
          () => reject(new Error(`Image “${label}” took too long to decode.`)),
          15000,
        );
      }),
    ]);
    if (!image.naturalWidth || !image.naturalHeight)
      throw new Error(`Image “${label}” has no dimensions.`);
    if (image.naturalWidth * image.naturalHeight > 32_000_000)
      throw new Error(
        `Image “${label}” exceeds 32 megapixels. Resize it before exporting.`,
      );
    const scale = Math.min(
      url.startsWith("data:image/svg+xml") ? 3 : 1,
      2000 / image.naturalWidth,
      2800 / image.naturalHeight,
    );
    // Only already-sanitized data images are drawn; this canvas is never attached.
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("This webview cannot create export images.");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const png = canvas.toDataURL("image/png");
    const binary = atob(png.slice(png.indexOf(",") + 1));
    const data = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return {
      data,
      url: png,
      width: image.naturalWidth,
      height: image.naturalHeight,
    };
  } finally {
    clearTimeout(timer);
    image.src = "";
  }
}

export async function resolveResources(
  blocks: Block[],
): Promise<Map<Run, Raster>> {
  const result = new Map<Run, Raster>();
  let total = 0;
  let equations = 0;
  const visit = async (items: Block[]) => {
    for (const block of items) {
      if (block.kind === "table") {
        for (const row of block.rows) for (const cell of row) await visit(cell);
        continue;
      }
      for (const run of block.runs) {
        if (!run.image && !run.math) continue;
        let url = run.image;
        if (run.math) {
          if (++equations > 500)
            throw new Error(
              "Export supports at most 500 equations; split this document.",
            );
          url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(mathSvg(run.math))}`;
        }
        const raster = await rasterize(url!, run.alt ?? "Image");
        total += raster.data.byteLength;
        if (total > 40 * 1024 * 1024)
          throw new Error(
            "Converted images exceed 40 MiB. Reduce their size or split the document.",
          );
        result.set(run, raster);
      }
    }
  };
  await visit(blocks);
  return result;
}
