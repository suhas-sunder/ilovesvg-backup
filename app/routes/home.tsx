import * as React from "react";
import type { Route } from "./+types/home";
import {
  json,
  unstable_createMemoryUploadHandler as createMemoryUploadHandler,
  unstable_parseMultipartFormData as parseMultipartFormData,
} from "@remix-run/node";
import { useFetcher, type ActionFunctionArgs } from "react-router";

/** Stable server flag: true on SSR render, false in client bundle */
const isServer = typeof document === "undefined";

/* ========================
   Meta
======================== */
export function meta({}: Route.MetaArgs) {
  const title = "i🩵SVG  -  Potrace (server, in-memory, live preview)";
  const description =
    "Convert images to SVG with Potrace on the server (RAM only). Lineart presets + Edge preprocessor for photos. Live preview, color & background.";
  return [
    { title },
    { name: "description", content: description },
    { name: "viewport", content: "width=device-width, initial-scale=1" },
    { name: "theme-color", content: "#0b2dff" },
    { property: "og:title", content: title },
    { property: "og:description", content: description },
    { property: "og:type", content: "website" },
  ];
}

export function loader({ context }: Route.LoaderArgs) {
  return { message: context.VALUE_FROM_EXPRESS };
}

/* ========================
   Limits & types (mirrored client/server)
======================== */
const MAX_UPLOAD_BYTES = 200 * 1024 * 1024; // 200 MB
const MAX_MP = 80; // ~80 megapixels (tune for your box)
const MAX_SIDE = 12_000; // max width or height in pixels
const ALLOWED_MIME = new Set(["image/png", "image/jpeg"]);

/* ========================
   Action: Potrace (RAM-only)
   + Optional server-side "Edge" preprocessor via sharp
======================== */
export async function action({ request }: ActionFunctionArgs) {
  try {
    const uploadHandler = createMemoryUploadHandler();
    const form = await parseMultipartFormData(request, uploadHandler);

    const file = form.get("file");
    if (!file || typeof file === "string") {
      return json({ error: "No file uploaded." }, { status: 400 });
    }

    // Basic type/size checks (authoritative)
    const webFile = file as File;
    if (!ALLOWED_MIME.has(webFile.type)) {
      return json(
        { error: "Only PNG or JPEG images are allowed." },
        { status: 415 }
      );
    }
    if ((webFile.size || 0) > MAX_UPLOAD_BYTES) {
      return json(
        { error: "File too large. Max 200 MB per image." },
        { status: 413 }
      );
    }

    // Read original bytes into Buffer
    const ab = await webFile.arrayBuffer();
    // @ts-ignore Buffer exists in Remix node runtime
    let input: Buffer = Buffer.from(ab);

    // --- Authoritative megapixel/side guard (cheap header decode via sharp) ---
    try {
      const { createRequire } = await import("node:module");
      const req = createRequire(import.meta.url);
      const sharp = req("sharp") as typeof import("sharp");
      const meta = await sharp(input).metadata();
      const w = meta.width ?? 0;
      const h = meta.height ?? 0;
      if (!w || !h) {
        return json(
          { error: "Could not read image dimensions. Try a different file." },
          { status: 415 }
        );
      }
      const mp = (w * h) / 1_000_000;
      if (w > MAX_SIDE || h > MAX_SIDE || mp > MAX_MP) {
        return json(
          {
            error: `Image too large: ${w}×${h} (~${mp.toFixed(
              1
            )} MP). Max ${MAX_SIDE}px per side or ${MAX_MP} MP.`,
          },
          { status: 413 }
        );
      }
    } catch {
      // If sharp metadata fails here, we still proceed — Potrace may handle small files fine.
      // (Limits will still be enforced client-side; this is just a best-effort server guard.)
    }

    // Potrace params
    const threshold = Number(form.get("threshold") ?? 224);
    const turdSize = Number(form.get("turdSize") ?? 2);
    const optTolerance = Number(form.get("optTolerance") ?? 0.28);
    const turnPolicy = String(form.get("turnPolicy") ?? "minority") as
      | "black"
      | "white"
      | "left"
      | "right"
      | "minority"
      | "majority";
    const lineColor = String(form.get("lineColor") ?? "#000000");
    const invert =
      String(form.get("invert") ?? "false").toLowerCase() === "true";

    // Background
    const transparent =
      String(form.get("transparent") ?? "true").toLowerCase() === "true";
    const bgColor = String(form.get("bgColor") ?? "#ffffff");

    // Preprocess (for photos)
    const preprocess = String(form.get("preprocess") ?? "none") as
      | "none"
      | "edge";
    const blurSigma = Number(form.get("blurSigma") ?? 0.8);
    const edgeBoost = Number(form.get("edgeBoost") ?? 1.0);

    // Normalize for Potrace (EXIF rotate, alpha flatten, grayscale, optional edge prepass)
    const prepped = await normalizeForPotrace(input, {
      preprocess,
      blurSigma,
      edgeBoost,
    });

    // Potrace (CJS API)
    const potrace = await import("potrace");
    const traceFn: any = (potrace as any).trace;
    const PotraceClass: any = (potrace as any).Potrace;

    const opts: any = {
      color: lineColor,
      threshold,
      turdSize,
      optTolerance,
      turnPolicy,
      invert,
      blackOnWhite: !invert,
    };

    const svgRaw: string = await new Promise((resolve, reject) => {
      if (typeof traceFn === "function") {
        traceFn(prepped, opts, (err: any, out: string) =>
          err ? reject(err) : resolve(out)
        );
      } else if (PotraceClass) {
        const p = new PotraceClass(opts);
        p.loadImage(prepped, (err: any) => {
          if (err) return reject(err);
          p.setParameters(opts);
          p.getSVG((err2: any, out: string) =>
            err2 ? reject(err2) : resolve(out)
          );
        });
      } else {
        reject(new Error("potrace API not found"));
      }
    });

    // Post-process SVG safely (defensive)
    const safeSvg = coerceSvg(svgRaw);
    const ensured = ensureViewBoxResponsive(safeSvg);
    const svg2 = recolorPaths(ensured.svg, lineColor);
    const svg3 = stripFullWhiteBackgroundRect(
      svg2,
      ensured.width,
      ensured.height
    );
    const finalSVG = transparent
      ? svg3
      : injectBackgroundRectString(
          svg3,
          ensured.width,
          ensured.height,
          bgColor
        );

    return json({
      svg: finalSVG,
      width: ensured.width,
      height: ensured.height,
    });
  } catch (err: any) {
    console.error("potrace action error:", err);
    return json(
      { error: err?.message || "Server error during conversion." },
      { status: 500 }
    );
  }
}

/* ---------- Image normalization for Potrace (server-side, robust) ---------- */
async function normalizeForPotrace(
  input: Buffer,
  opts: { preprocess: "none" | "edge"; blurSigma: number; edgeBoost: number }
): Promise<Buffer> {
  try {
    // Lazy CJS import so this never leaks into client bundle
    const { createRequire } = await import("node:module");
    const req = createRequire(import.meta.url);
    const sharp = req("sharp") as typeof import("sharp");

    sharp.cache(false);
    // sharp.concurrency(2); // uncomment for tiny droplets

    // Decode + respect EXIF
    let base = sharp(input).rotate();

    // Soft guard (keeps behavior but avoids OOM)
    try {
      const meta = await base.metadata();
      const w = meta.width ?? 0;
      const h = meta.height ?? 0;
      const mp = (w * h) / 1_000_000;
      if (w > MAX_SIDE || h > MAX_SIDE || mp > MAX_MP) {
        base = base.resize({ width: 4000, height: 4000, fit: "inside" });
      }
    } catch {
      // ignore metadata errors; proceed
    }

    if (opts.preprocess === "edge") {
      const { data, info } = await base
        .flatten({ background: { r: 255, g: 255, b: 255 } })
        .removeAlpha()
        .grayscale()
        .blur(opts.blurSigma > 0 ? opts.blurSigma : undefined)
        .raw()
        .toBuffer({ resolveWithObject: true });

      const W = info.width | 0;
      const H = info.height | 0;
      if (W <= 1 || H <= 1) {
        return await sharp(input)
          .rotate()
          .flatten({ background: { r: 255, g: 255, b: 255 } })
          .removeAlpha()
          .grayscale()
          .gamma()
          .normalize()
          .png()
          .toBuffer();
      }

      const src = data as Buffer; // 1 channel
      const out = Buffer.alloc(W * H, 255);

      const kx = [-1, 0, 1, -2, 0, 2, -1, 0, 1];
      const ky = [-1, -2, -1, 0, 0, 0, 1, 2, 1];

      for (let y = 1; y < H - 1; y++) {
        for (let x = 1; x < W - 1; x++) {
          let gx = 0,
            gy = 0,
            n = 0;
          for (let j = -1; j <= 1; j++) {
            for (let i = -1; i <= 1; i++) {
              const v = src[(y + j) * W + (x + i)];
              gx += v * kx[n];
              gy += v * ky[n];
              n++;
            }
          }
          let m = Math.sqrt(gx * gx + gy * gy) * opts.edgeBoost;
          if (m > 255) m = 255;
          out[y * W + x] = 255 - m; // edges dark, background light
        }
      }

      if (isFlatBuffer(out)) {
        return await sharp(input)
          .rotate()
          .flatten({ background: { r: 255, g: 255, b: 255 } })
          .removeAlpha()
          .grayscale()
          .gamma()
          .normalize()
          .png()
          .toBuffer();
      }

      return await sharp(out, { raw: { width: W, height: H, channels: 1 } })
        .png()
        .toBuffer();
    }

    return await base
      .flatten({ background: { r: 255, g: 255, b: 255 } })
      .removeAlpha()
      .grayscale()
      .gamma()
      .normalize()
      .png()
      .toBuffer();
  } catch {
    // If sharp isn't available (platform build missing), just return original
    return input;
  }
}

/** Heuristic: flat if min==max OR very low variance OR mean ≈ 0/255. */
function isFlatBuffer(buf: Buffer, sampleStep = 53): boolean {
  const len = buf.length;
  if (len === 0) return true;

  let min = 255,
    max = 0,
    sum = 0,
    count = 0;
  for (let i = 0; i < len; i += sampleStep) {
    const v = buf[i];
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
    count++;
  }
  const mean = sum / Math.max(count, 1);
  const range = max - min;

  if (range <= 2) return true;
  if (mean <= 8 || mean >= 247) return true;

  let varSum = 0;
  for (let i = 0; i < len; i += sampleStep) {
    const v = buf[i] - mean;
    varSum += v * v;
  }
  const variance = varSum / Math.max(count - 1, 1);
  return variance < 8;
}

/* ---------- SVG helpers (Node-safe, no DOMParser) ---------- */
function coerceSvg(svgRaw: string | null | undefined): string {
  const fallback =
    '<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024"></svg>';
  if (!svgRaw) return fallback;
  const trimmed = String(svgRaw).trim();
  if (/^<svg\b/i.test(trimmed)) return trimmed;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">${trimmed}</svg>`;
}

function ensureViewBoxResponsive(svg: string): {
  svg: string;
  width: number;
  height: number;
} {
  const openTagMatch = svg.match(/<svg\b[^>]*>/i);
  if (!openTagMatch) return { svg, width: 1024, height: 1024 };

  const openTag = openTagMatch[0];
  const hasViewBox = /viewBox\s*=\s*["'][^"']*["']/.test(openTag);
  const widthMatch = openTag.match(/width\s*=\s*["'](\d+(\.\d+)?)(px)?["']/i);
  const heightMatch = openTag.match(/height\s*=\s*["'](\d+(\.\d+)?)(px)?["']/i);
  let width = widthMatch ? Number(widthMatch[1]) : 1024;
  let height = heightMatch ? Number(heightMatch[1]) : 1024;

  let newOpen = openTag;

  if (!hasViewBox) {
    newOpen = newOpen.replace(
      /<svg\b/i,
      `<svg viewBox="0 0 ${Math.round(width)} ${Math.round(height)}"`
    );
  }

  newOpen = newOpen
    .replace(/\swidth\s*=\s*["'][^"']*["']/i, "")
    .replace(/\sheight\s*=\s*["'][^"']*["']/i, "");

  const newSVG = svg.replace(openTag, newOpen);
  return { svg: newSVG, width, height };
}

function recolorPaths(svg: string, fillColor: string): string {
  let out = svg.replace(
    /<path\b([^>]*?)\sfill\s*=\s*["'][^"']*["']([^>]*?)>/gi,
    (_m, a, b) => `<path${a} fill="${fillColor}"${b}>`
  );
  out = out.replace(
    /<path\b((?:(?!>)[\s\S])*?)>(?![\s\S]*?<\/path>)/gi,
    (m, attrs) => {
      if (/fill\s*=/.test(attrs)) return m;
      return `<path${attrs} fill="${fillColor}">`;
    }
  );
  return out;
}

function stripFullWhiteBackgroundRect(
  svg: string,
  width: number,
  height: number
): string {
  const whitePattern =
    /(#ffffff|#fff|white|rgb\(255\s*,\s*255\s*,\s*255\)|rgba\(255\s*,\s*255\s*,\s*255\s*,\s*1\))/i;

  const numeric = new RegExp(
    `<rect\\b[^>]*x\\s*=\\s*["']0["'][^>]*y\\s*=\\s*["']0["'][^>]*width\\s*=\\s*["']${escapeReg(
      String(width)
    )}["'][^>]*height\\s*=\\s*["']${escapeReg(
      String(height)
    )}["'][^>]*fill\\s*=\\s*["']${whitePattern.source}["'][^>]*>`,
    "ig"
  );

  const percent = new RegExp(
    `<rect\\b[^>]*x\\s*=\\s*["']0%?["'][^>]*y\\s*=\\s*["']0%?["'][^>]*width\\s*=\\s*["']100%["'][^>]*height\\s*=\\s*["']100%["'][^>]*fill\\s*=\\s*["']${whitePattern.source}["'][^>]*>`,
    "ig"
  );

  return svg.replace(numeric, "").replace(percent, "");
}

function injectBackgroundRectString(
  svg: string,
  width: number,
  height: number,
  color: string
): string {
  const openTagMatch = svg.match(/<svg\b[^>]*>/i);
  if (!openTagMatch) return svg;
  const openTag = openTagMatch[0];

  const rect = `<rect x="0" y="0" width="${width}" height="${height}" fill="${color}"/>`;
  const idx = svg.indexOf(openTag) + openTag.length;
  return svg.slice(0, idx) + rect + svg.slice(idx);
}

function escapeReg(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/* ========================
   UI (types)
======================== */
type Settings = {
  threshold: number;
  turdSize: number;
  optTolerance: number;
  turnPolicy: "black" | "white" | "left" | "right" | "minority" | "majority";
  lineColor: string;
  invert: boolean;

  // background
  transparent: boolean;
  bgColor: string;

  // preprocess
  preprocess: "none" | "edge";
  blurSigma: number;
  edgeBoost: number;
};

type Preset = {
  id: string;
  label: string;
  settings: Partial<Settings>;
};

/* (same presets as before — omitted here for brevity in explanation) */
const PRESETS: Preset[] = [
  {
    id: "line-accurate",
    label: "Lineart  -  Accurate (default)",
    settings: {
      preprocess: "none",
      threshold: 224,
      turdSize: 2,
      optTolerance: 0.28,
      turnPolicy: "minority",
      lineColor: "#000000",
      invert: false,
    },
  },
  {
    id: "line-bold",
    label: "Lineart  -  Bold",
    settings: {
      preprocess: "none",
      threshold: 212,
      turdSize: 3,
      optTolerance: 0.38,
      turnPolicy: "majority",
    },
  },
  {
    id: "line-fine",
    label: "Lineart  -  Fine detail",
    settings: {
      preprocess: "none",
      threshold: 232,
      turdSize: 1,
      optTolerance: 0.22,
      turnPolicy: "minority",
    },
  },
  {
    id: "line-gap",
    label: "Lineart  -  Seal gaps",
    settings: {
      preprocess: "none",
      threshold: 218,
      turdSize: 3,
      optTolerance: 0.34,
      turnPolicy: "black",
    },
  },
  {
    id: "photo-soft",
    label: "Photo Edge  -  Soft",
    settings: {
      preprocess: "edge",
      blurSigma: 1.2,
      edgeBoost: 0.9,
      threshold: 210,
      turdSize: 2,
      optTolerance: 0.35,
    },
  },
  {
    id: "photo-normal",
    label: "Photo Edge  -  Normal",
    settings: {
      preprocess: "edge",
      blurSigma: 0.9,
      edgeBoost: 1.1,
      threshold: 220,
      turdSize: 2,
      optTolerance: 0.35,
    },
  },
  {
    id: "photo-bold",
    label: "Photo Edge  -  Bold",
    settings: {
      preprocess: "edge",
      blurSigma: 0.6,
      edgeBoost: 1.4,
      threshold: 230,
      turdSize: 3,
      optTolerance: 0.4,
    },
  },
  {
    id: "edge-clean",
    label: "Edge  -  Clean",
    settings: {
      preprocess: "edge",
      blurSigma: 0.8,
      edgeBoost: 1.2,
      threshold: 236,
      turdSize: 2,
      optTolerance: 0.45,
    },
  },
  {
    id: "scan-clean",
    label: "Scan  -  Clean (remove speckles)",
    settings: {
      preprocess: "none",
      threshold: 226,
      turdSize: 4,
      optTolerance: 0.3,
      turnPolicy: "majority",
      lineColor: "#000000",
      invert: false,
    },
  },
  {
    id: "scan-aggressive",
    label: "Scan  -  Aggressive (close gaps)",
    settings: {
      preprocess: "none",
      threshold: 218,
      turdSize: 5,
      optTolerance: 0.42,
      turnPolicy: "black",
      lineColor: "#000000",
      invert: false,
    },
  },
  {
    id: "logo-clean",
    label: "Logo  -  Clean shapes",
    settings: {
      preprocess: "none",
      threshold: 210,
      turdSize: 2,
      optTolerance: 0.25,
      turnPolicy: "majority",
      lineColor: "#000000",
      invert: false,
    },
  },
  {
    id: "logo-thin",
    label: "Logo  -  Thin details",
    settings: {
      preprocess: "none",
      threshold: 238,
      turdSize: 1,
      optTolerance: 0.2,
      turnPolicy: "minority",
      lineColor: "#000000",
      invert: false,
    },
  },
  {
    id: "noisy-denoise",
    label: "Noisy Photo  -  Denoise Edge",
    settings: {
      preprocess: "edge",
      blurSigma: 1.6,
      edgeBoost: 1.25,
      threshold: 222,
      turdSize: 3,
      optTolerance: 0.38,
      turnPolicy: "majority",
    },
  },
  {
    id: "low-contrast",
    label: "Low-contrast Photo  -  Boost edges",
    settings: {
      preprocess: "edge",
      blurSigma: 1.0,
      edgeBoost: 1.6,
      threshold: 228,
      turdSize: 2,
      optTolerance: 0.36,
      turnPolicy: "minority",
    },
  },
  {
    id: "invert-white-on-black",
    label: "Invert  -  White lines on black",
    settings: {
      preprocess: "none",
      threshold: 225,
      turdSize: 2,
      optTolerance: 0.3,
      turnPolicy: "minority",
      invert: true,
      lineColor: "#ffffff",
    },
  },
  {
    id: "comics-inks",
    label: "Comics  -  Inks (chunky)",
    settings: {
      preprocess: "edge",
      blurSigma: 0.7,
      edgeBoost: 1.5,
      threshold: 234,
      turdSize: 3,
      optTolerance: 0.48,
      turnPolicy: "black",
      lineColor: "#000000",
    },
  },
  {
    id: "blueprint",
    label: "Diagram  -  Blueprint (invert + blue)",
    settings: {
      preprocess: "none",
      threshold: 230,
      turdSize: 2,
      optTolerance: 0.3,
      turnPolicy: "minority",
      invert: true,
      lineColor: "#0ea5e9",
    },
  },
  {
    id: "whiteboard",
    label: "Whiteboard  -  Anti-glare",
    settings: {
      preprocess: "edge",
      blurSigma: 1.3,
      edgeBoost: 1.15,
      threshold: 220,
      turdSize: 2,
      optTolerance: 0.34,
      turnPolicy: "majority",
      lineColor: "#0f172a",
    },
  },
];

const DEFAULTS: Settings = {
  threshold: 224,
  turdSize: 2,
  optTolerance: 0.28,
  turnPolicy: "minority",
  lineColor: "#000000",
  invert: false,

  transparent: true,
  bgColor: "#ffffff",

  preprocess: "none",
  blurSigma: 0.8,
  edgeBoost: 1.0,
};

type ServerResult = {
  svg?: string;
  error?: string;
  width?: number;
  height?: number;
};

type HistoryItem = {
  svg: string;
  width: number;
  height: number;
  stamp: number;
};

export default function Home({ loaderData }: Route.ComponentProps) {
  const fetcher = useFetcher<ServerResult>();
  const [file, setFile] = React.useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = React.useState<string | null>(null);
  const [settings, setSettings] = React.useState<Settings>(DEFAULTS);
  const [activePreset, setActivePreset] =
    React.useState<string>("line-accurate");
  const busy = fetcher.state !== "idle";
  const [err, setErr] = React.useState<string | null>(null);

  // client-side measured dims (nice UX plus precheck)
  const [dims, setDims] = React.useState<{
    w: number;
    h: number;
    mp: number;
  } | null>(null);

  // Hydration guard
  const [hydrated, setHydrated] = React.useState(false);
  React.useEffect(() => setHydrated(true), []);

  // Attempts history (newest first)
  const [history, setHistory] = React.useState<HistoryItem[]>([]);

  React.useEffect(() => {
    if (fetcher.data?.error) setErr(fetcher.data.error);
    else setErr(null);
  }, [fetcher.data]);

  // When a new server SVG arrives, push to history (max 10)
  React.useEffect(() => {
    if (fetcher.data?.svg) {
      const item: HistoryItem = {
        svg: fetcher.data.svg,
        width: fetcher.data.width ?? 0,
        height: fetcher.data.height ?? 0,
        stamp: Date.now(),
      };
      setHistory((prev) => [item, ...prev].slice(0, 10));
    }
  }, [fetcher.data?.svg, fetcher.data?.width, fetcher.data?.height]);

  React.useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  async function measureAndSet(file: File) {
    try {
      const { w, h } = await getImageSize(file);
      const mp = (w * h) / 1_000_000;
      setDims({ w, h, mp });
    } catch {
      setDims(null);
    }
  }

  function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    if (!f.type.startsWith("image/")) {
      setErr("Please choose a PNG or JPEG.");
      return;
    }
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setFile(f);
    setPreviewUrl(URL.createObjectURL(f));
    setErr(null);
    setDims(null);
    // async measure (no await)
    measureAndSet(f);
    e.currentTarget.value = "";
  }
  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    const f = e.dataTransfer.files?.[0];
    if (!f) return;
    if (!f.type.startsWith("image/")) {
      setErr("Please choose a PNG or JPEG.");
      return;
    }
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setFile(f);
    setPreviewUrl(URL.createObjectURL(f));
    setErr(null);
    setDims(null);
    measureAndSet(f);
  }

  async function submitConvert() {
    if (!file) {
      setErr("Choose an image first.");
      return;
    }

    // Client-side precheck (friendly UX; server still authoritative)
    try {
      await validateBeforeSubmit(file);
    } catch (e: any) {
      setErr(e?.message || "Image is too large.");
      return;
    }

    const fd = new FormData();
    fd.append("file", file);
    fd.append("threshold", String(settings.threshold));
    fd.append("turdSize", String(settings.turdSize));
    fd.append("optTolerance", String(settings.optTolerance));
    fd.append("turnPolicy", settings.turnPolicy);
    fd.append("lineColor", settings.lineColor);
    fd.append("invert", String(settings.invert));
    fd.append("transparent", String(settings.transparent));
    fd.append("bgColor", settings.bgColor);
    fd.append("preprocess", settings.preprocess);
    fd.append("blurSigma", String(settings.blurSigma));
    fd.append("edgeBoost", String(settings.edgeBoost));
    setErr(null);

    // IMPORTANT: target this route's index action to avoid hitting "root" action
    fetcher.submit(fd, {
      method: "POST",
      encType: "multipart/form-data",
      action: `${window.location.pathname}?index`,
    });
  }

  // Always-on live preview (debounced)
  const debounceRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  React.useEffect(() => {
    if (!file) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      submitConvert();
    }, 400);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file, settings, activePreset]);

  // Disable logic identical on SSR and first client render
  const buttonDisabled = isServer || !hydrated || busy || !file;

  // Apply preset without carrying user overrides (e.g., invert)
  function applyPreset(preset: Preset) {
    setActivePreset(preset.id);
    setSettings((s) => {
      // preserve only background choices; everything else from DEFAULTS
      const baseline: Settings = {
        ...DEFAULTS,
        transparent: s.transparent,
        bgColor: s.bgColor,
      };
      const lineColor =
        preset.settings.lineColor !== undefined
          ? preset.settings.lineColor
          : s.lineColor;

      return {
        ...baseline,
        lineColor,
        ...preset.settings,
      } as Settings;
    });
  }

  const [toast, setToast] = React.useState<string | null>(null);

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(null), 1500);
  }

  function handleCopySvg(svg: string) {
    navigator.clipboard.writeText(svg).then(() => {
      showToast("SVG copied");
    });
  }

  return (
    <main className="min-h-[100dvh] bg-slate-50 text-slate-900">
      <div className="max-w-[1180px] mx-auto px-4 pt-6 pb-12">
        <header className="text-center mb-2">
          <h1 className="inline-flex items-center gap-2 text-[34px] font-extrabold leading-none m-0">
            <span>i</span>
            <span
              role="img"
              aria-label="love"
              className="text-[34px] -translate-y-[1px]"
            >
              🩵
            </span>
            <span className="text-[#0b2dff]">SVG</span>
          </h1>
          <p className="mt-1 text-slate-600">
            Convert your png, jpeg, and other image files into crisp vector
            graphics and illustrations.
          </p>
        </header>

        <section className="grid grid-cols-1 md:grid-cols-2 gap-4 items-start">
          {/* INPUT */}
          <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm overflow-hidden min-w-0">
            <h2 className="m-0 mb-3 text-lg text-slate-900">Input</h2>

            {/* Presets */}
            <div className="flex flex-wrap gap-2 mb-2 min-w-0">
              {PRESETS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => applyPreset(p)}
                  className={[
                    "px-3 py-1.5 rounded-md border text-slate-900 cursor-pointer transition-colors",
                    activePreset === p.id
                      ? "bg-[#e7eeff] border-[#0b2dff]"
                      : "bg-white border-slate-200 hover:bg-slate-50",
                  ].join(" ")}
                >
                  {p.label}
                </button>
              ))}
            </div>

            {/* Limits helper */}
            <div className="text-[13px] text-slate-600 mb-2">
              Limits: <b>200 MB</b> • <b>{MAX_MP} MP</b> • <b>{MAX_SIDE}px</b>{" "}
              max side.
            </div>

            {/* Dropzone */}
            {!file ? (
              <div
                role="button"
                tabIndex={0}
                onDragOver={(e) => e.preventDefault()}
                onDrop={onDrop}
                onClick={() => document.getElementById("file-inp")?.click()}
                className="border border-dashed border-[#c8d3ea] rounded-xl p-4 text-center cursor-pointer min-h-[10em] flex justify-center items-center bg-[#f9fbff] hover:bg-[#f2f6ff] focus:outline-none focus:ring-2 focus:ring-blue-200"
              >
                <div className="text-sm text-slate-600">
                  Click, drag & drop, or paste a PNG/JPEG
                </div>
                <input
                  id="file-inp"
                  type="file"
                  accept="image/png,image/jpeg"
                  onChange={onPick}
                  className="hidden"
                />
              </div>
            ) : (
              <>
                <div className="flex items-center justify-between gap-2 px-3 py-2 rounded-lg bg-[#f7faff] border border-[#dae6ff] text-slate-900 mt-0">
                  <div className="flex items-center min-w-0 gap-2">
                    {previewUrl && (
                      <img
                        src={previewUrl}
                        alt=""
                        className="w-[22px] h-[22px] rounded-md object-cover mr-1"
                      />
                    )}
                    <span title={file?.name || ""} className="truncate">
                      {file?.name} • {prettyBytes(file?.size || 0)}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      if (previewUrl) URL.revokeObjectURL(previewUrl);
                      setFile(null);
                      setPreviewUrl(null);
                      setDims(null);
                      setErr(null);
                    }}
                    className="px-2 py-1 rounded-md border border-[#d6e4ff] bg-[#eff4ff] cursor-pointer hover:bg-[#e5eeff]"
                  >
                    ×
                  </button>
                </div>
                {dims && (
                  <div className="mt-2 text-[13px] text-slate-700">
                    Detected size:{" "}
                    <b>
                      {dims.w}×{dims.h}
                    </b>{" "}
                    (~{dims.mp.toFixed(1)} MP)
                  </div>
                )}
              </>
            )}

            {/* Settings */}
            <div className="mt-3 flex flex-col gap-2 min-w-0">
              <Field label="Preprocess">
                <select
                  value={settings.preprocess}
                  onChange={(e) =>
                    setSettings((s) => ({
                      ...s,
                      preprocess: e.target.value as any,
                    }))
                  }
                  className="w-full px-2 py-1.5 rounded-md border border-[#dbe3ef] bg-white text-slate-900"
                >
                  <option value="none">None (lineart)</option>
                  <option value="edge">Edge (photo/painting)</option>
                </select>
              </Field>

              {settings.preprocess === "edge" && (
                <>
                  <Field label={`Blur σ (${settings.blurSigma})`}>
                    <Num
                      value={settings.blurSigma}
                      min={0}
                      max={3}
                      step={0.1}
                      onChange={(v) =>
                        setSettings((s) => ({ ...s, blurSigma: v }))
                      }
                    />
                  </Field>
                  <Field label={`Edge boost (${settings.edgeBoost})`}>
                    <Num
                      value={settings.edgeBoost}
                      min={0.5}
                      max={2.0}
                      step={0.1}
                      onChange={(v) =>
                        setSettings((s) => ({ ...s, edgeBoost: v }))
                      }
                    />
                  </Field>
                </>
              )}

              <Field label={`Threshold (${settings.threshold})`}>
                <input
                  type="range"
                  min={0}
                  max={255}
                  step={1}
                  value={settings.threshold}
                  onChange={(e) =>
                    setSettings((s) => ({
                      ...s,
                      threshold: Number(e.target.value),
                    }))
                  }
                  className="w-full accent-[#0b2dff]"
                />
              </Field>

              <Field label="Turd size">
                <Num
                  value={settings.turdSize}
                  min={0}
                  max={10}
                  step={1}
                  onChange={(v) => setSettings((s) => ({ ...s, turdSize: v }))}
                />
              </Field>

              <Field label="Curve tolerance">
                <Num
                  value={settings.optTolerance}
                  min={0.05}
                  max={1.2}
                  step={0.05}
                  onChange={(v) =>
                    setSettings((s) => ({ ...s, optTolerance: v }))
                  }
                />
              </Field>

              <Field label="Turn policy">
                <select
                  value={settings.turnPolicy}
                  onChange={(e) =>
                    setSettings((s) => ({
                      ...s,
                      turnPolicy: e.target.value as any,
                    }))
                  }
                  className="w-full px-2 py-1.5 rounded-md border border-[#dbe3ef] bg-white text-slate-900"
                >
                  <option value="black">black</option>
                  <option value="white">white</option>
                  <option value="left">left</option>
                  <option value="right">right</option>
                  <option value="minority">minority</option>
                  <option value="majority">majority</option>
                </select>
              </Field>

              <Field label="Line color">
                <input
                  type="color"
                  value={settings.lineColor}
                  onChange={(e) =>
                    setSettings((s) => ({ ...s, lineColor: e.target.value }))
                  }
                  className="w-14 h-7 rounded-md border border-[#dbe3ef] bg-white"
                />
              </Field>

              <Field label="Invert lineart">
                <input
                  type="checkbox"
                  checked={settings.invert}
                  onChange={(e) =>
                    setSettings((s) => ({ ...s, invert: e.target.checked }))
                  }
                  className="h-4 w-4 accent-[#0b2dff]"
                />
              </Field>

              <Field label="Background">
                <div className="flex items-center gap-2 min-w-0">
                  <input
                    type="checkbox"
                    checked={settings.transparent}
                    onChange={(e) =>
                      setSettings((s) => ({
                        ...s,
                        transparent: e.target.checked,
                      }))
                    }
                    title="Transparent background"
                    className="h-4 w-4 accent-[#0b2dff]"
                  />
                  <span className="text-[13px] text-slate-700">
                    Transparent
                  </span>
                  <input
                    type="color"
                    value={settings.bgColor}
                    onChange={(e) =>
                      setSettings((s) => ({ ...s, bgColor: e.target.value }))
                    }
                    aria-disabled={settings.transparent}
                    className={[
                      "w-14 h-7 rounded-md border border-[#dbe3ef] bg-white",
                      settings.transparent
                        ? "opacity-50 pointer-events-none"
                        : "",
                    ].join(" ")}
                    title={
                      settings.transparent
                        ? "Uncheck to pick a background color"
                        : "Pick background color"
                    }
                  />
                </div>
              </Field>
            </div>

            {/* Convert button + errors */}
            <div className="flex items-center gap-3 mt-3 flex-wrap">
              <button
                type="button"
                onClick={submitConvert}
                disabled={buttonDisabled}
                suppressHydrationWarning
                className={[
                  "px-3.5 py-2 rounded-lg font-bold border transition-colors",
                  "text-white bg-[#0b2dff] border-[#0a24da] hover:bg-[#0a24da] hover:border-[#091ec0]",
                  "disabled:opacity-70 disabled:cursor-not-allowed",
                ].join(" ")}
              >
                {busy ? "Converting…" : "Convert"}
              </button>
              {err && <span className="text-red-700 text-sm">{err}</span>}
            </div>

            {/* Input preview below controls */}
            {previewUrl && (
              <div className="mt-3 border border-slate-200 rounded-xl overflow-hidden bg-white">
                <img
                  src={previewUrl}
                  alt="Input"
                  className="w-full h-auto block"
                />
              </div>
            )}
          </div>

          {/* RESULTS */}
          <div className="bg-sky-50/10 border border-slate-200 rounded-xl p-4 h-full shadow-sm min-w-0">
            <h2 className="m-0 mb-3 text-lg text-slate-900">Result</h2>

            {history.length > 0 ? (
              <div className="grid gap-3">
                {history.map((item) => (
                  <div
                    key={item.stamp}
                    className="rounded-xl border border-slate-200 bg-white p-2"
                  >
                    <div className="rounded-xl border border-slate-200 bg-white min-h-[240px] flex items-center justify-center p-2">
                      <img
                        src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(
                          item.svg
                        )}`}
                        alt="SVG result"
                        className="max-w-full h-auto"
                      />
                    </div>
                    <div className="flex gap-3 items-center mt-3 flex-wrap justify-between">
                      <span className="text-[13px] text-slate-700">
                        {item.width > 0 && item.height > 0
                          ? `${item.width} × ${item.height} px`
                          : "size unknown"}
                      </span>
                      <div className="flex gap-2 flex-wrap">
                        <button
                          type="button"
                          onClick={() => {
                            const b = new Blob([item.svg], {
                              type: "image/svg+xml;charset=utf-8",
                            });
                            const u = URL.createObjectURL(b);
                            const a = document.createElement("a");
                            a.href = u;
                            a.download = "converted.svg";
                            document.body.appendChild(a);
                            a.click();
                            a.remove();
                            URL.revokeObjectURL(u);
                          }}
                          className="px-3 py-2 rounded-lg font-semibold border bg-sky-500 hover:bg-sky-600 text-white border-sky-600 cursor-pointer"
                        >
                          Download SVG
                        </button>
                        <button
                          type="button"
                          onClick={() => handleCopySvg(item.svg)}
                          className="px-3 py-2 rounded-lg font-medium border border-slate-200 bg-slate-50 hover:bg-slate-100 text-slate-900 cursor-pointer"
                        >
                          Copy SVG
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-slate-600 m-0">
                {busy ? "Converting…" : "Your converted file will appear here."}
              </p>
            )}
          </div>
        </section>
      </div>

      {/* Toast */}
      {toast && (
        <div className="fixed right-4 bottom-4 bg-slate-900 text-white px-4 py-2 rounded-lg shadow-lg text-sm z-[1000]">
          {toast}
        </div>
      )}
    </main>
  );
}

/* ===== Client-side helpers (dimension precheck) ===== */
async function getImageSize(file: File): Promise<{ w: number; h: number }> {
  // Prefer createImageBitmap when available (fast & memory-friendly)
  if ("createImageBitmap" in window) {
    const bmp = await createImageBitmap(file);
    return { w: bmp.width, h: bmp.height };
  }
  // Fallback to <img>.decode()
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return { w: img.naturalWidth, h: img.naturalHeight };
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function validateBeforeSubmit(file: File) {
  if (!ALLOWED_MIME.has(file.type)) {
    throw new Error("Only PNG or JPEG images are allowed.");
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new Error("File too large. Max 200 MB per image.");
  }
  const { w, h } = await getImageSize(file);
  if (!w || !h) throw new Error("Could not read image dimensions.");
  const mp = (w * h) / 1_000_000;
  if (w > MAX_SIDE || h > MAX_SIDE || mp > MAX_MP) {
    throw new Error(
      `Image too large: ${w}×${h} (~${mp.toFixed(1)} MP). ` +
        `Max ${MAX_SIDE}px per side or ${MAX_MP} MP.`
    );
  }
}

/* ===== UI helpers ===== */
function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex items-center gap-2 bg-[#fafcff] border border-[#edf2fb] rounded-lg px-3 py-2 min-w-0">
      <span className="min-w-[180px] text-[13px] text-slate-700 shrink-0">
        {label}
      </span>
      <div className="flex items-center gap-2 flex-1 min-w-0">{children}</div>
    </label>
  );
}
function Num({
  value,
  min,
  max,
  step,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
}) {
  return (
    <input
      type="number"
      value={value}
      min={min}
      max={max}
      step={step}
      onChange={(e) => onChange(Number(e.target.value))}
      className="w-[110px] px-2 py-1.5 rounded-md border border-[#dbe3ef] bg-white text-slate-900"
    />
  );
}
function prettyBytes(bytes: number) {
  const u = ["B", "KB", "MB", "GB"];
  let v = bytes,
    i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${u[i]}`;
}
