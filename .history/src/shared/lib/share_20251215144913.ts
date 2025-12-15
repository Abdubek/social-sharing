export type ShareProviderId = "instagram";

export type SharePayload = {
  kind: "image";
  /** Publicly reachable image URL (CORS-enabled for fetch). */
  imageUrl: string;
  /** Optional filename override for the shared file. */
  filename?: string;
  /** Optional title shown in the native share sheet (varies by OS/app). */
  title?: string;
  /** Optional text/caption shown in the native share sheet (varies by OS/app). */
  text?: string;
};

export type ShareResult =
  | {
      ok: true;
      provider: ShareProviderId;
      method: "web_share" | "deep_link" | "deep_link_clipboard";
      details?: {
        clipboard: "copied" | "failed" | "not_supported" | "skipped";
        deepLinkOpened?: boolean;
        fetchedVia?: "direct" | "next_image_optimizer";
      };
    }
  | {
      ok: false;
      provider: ShareProviderId;
      reason:
        | "not_in_browser"
        | "not_supported"
        | "clipboard_not_supported"
        | "fetch_failed"
        | "user_cancelled"
        | "unknown";
      error?: unknown;
    };

export type ShareOptions = {
  /**
   * Which provider to route to.
   *
   * Planned to grow: add new providers (e.g. "telegram", "x", "facebook")
   * by extending `ShareProviderId` and `providers` below.
   */
  provider: ShareProviderId;
  payload: SharePayload;
};

type ShareProvider = (payload: SharePayload) => Promise<ShareResult>;

/**
 * High-level share entry point.
 *
 * Note: On the web, we cannot reliably force-share directly into Instagram.
 * The best supported approach is invoking the OS share sheet via Web Share
 * API (mobile Safari / Android Chrome), where the user can pick Instagram.
 */
export async function share(options: ShareOptions): Promise<ShareResult> {
  const provider = providers[options.provider];
  return provider(options.payload);
}

/** Convenience wrapper for the most common use case today. */
export async function shareImageToInstagram(
  options: Omit<SharePayload, "kind">,
) {
  return share({
    provider: "instagram",
    payload: { kind: "image", ...options },
  });
}

/**
 * Best-effort “direct” Instagram flow for the web:
 * - download image
 * - try to copy it to clipboard as an image (if supported)
 * - open Instagram via deep link (e.g. Story camera)
 *
 * Reality check: browsers cannot reliably inject an image directly into Instagram.
 * This is only a convenience flow that *may* reduce steps for the user.
 */
export async function shareImageToInstagramDirect(
  options: Omit<SharePayload, "kind"> & {
    /**
     * Optional preloaded file. If provided, we can attempt clipboard copy
     * without awaiting a network fetch inside the click handler (much more
     * reliable on iOS Safari due to “user gesture” constraints).
     */
    file?: File;
    /**
     * Which Instagram surface to open.
     * Planned to grow: "story_camera" / "app" / "dm" etc as we learn what works.
     */
    target?: "story_camera" | "app";
    /** If true, skip clipboard attempt and only open the deep link. */
    skipClipboard?: boolean;
  },
): Promise<ShareResult> {
  if (typeof window === "undefined" || typeof navigator === "undefined") {
    return { ok: false, provider: "instagram", reason: "not_in_browser" };
  }

  const target = options.target ?? "story_camera";
  const deepLink =
    target === "story_camera" ? "instagram://story-camera" : "instagram://app";

  let clipboardOk = false;
  let clipboardStatus: "copied" | "failed" | "not_supported" | "skipped" =
    "skipped";
  let fetchedVia: "direct" | "next_image_optimizer" | undefined;

  if (!options.skipClipboard) {
    clipboardStatus = isClipboardWriteSupported() ? "failed" : "not_supported";

    if (isClipboardWriteSupported()) {
      try {
        const prepared =
          options.file ??
          (await fileFromUrl(options.imageUrl, options.filename, {
            allowNextImageOptimizerFallback: true,
          }));

        clipboardOk = await tryWriteImageToClipboard(prepared);
        clipboardStatus = clipboardOk ? "copied" : "failed";
        fetchedVia = (prepared as PreparedFile).__fetchedVia;
      } catch (error) {
        // If we can't fetch/copy, still allow deep-linking to proceed.
        void error;
        clipboardOk = false;
        clipboardStatus = "failed";
      }
    }
  }

  const deepLinkOpened = tryOpenDeepLink(deepLink);
  if (!deepLinkOpened) {
    return { ok: false, provider: "instagram", reason: "not_supported" };
  }

  return {
    ok: true,
    provider: "instagram",
    method: clipboardOk ? "deep_link_clipboard" : "deep_link",
    details: {
      clipboard: clipboardStatus,
      deepLinkOpened,
      fetchedVia,
    },
  };
}

const providers: Record<ShareProviderId, ShareProvider> = {
  instagram: shareImageViaWebShare,
};

async function shareImageViaWebShare(
  payload: SharePayload,
): Promise<ShareResult> {
  if (typeof window === "undefined" || typeof navigator === "undefined") {
    return { ok: false, provider: "instagram", reason: "not_in_browser" };
  }

  if (!("share" in navigator) || typeof navigator.share !== "function") {
    return { ok: false, provider: "instagram", reason: "not_supported" };
  }

  if (payload.kind !== "image") {
    return { ok: false, provider: "instagram", reason: "unknown" };
  }

  let file: File;
  try {
    file = await fileFromUrl(payload.imageUrl, payload.filename);
  } catch (error) {
    return { ok: false, provider: "instagram", reason: "fetch_failed", error };
  }

  // `navigator.canShare` is optional; on some browsers it is missing.
  // If it's present and rejects the payload, bail out early.
  try {
    if ("canShare" in navigator) {
      const canShare = navigator.canShare?.({ files: [file] });
      if (canShare === false) {
        return { ok: false, provider: "instagram", reason: "not_supported" };
      }
    }
  } catch {
    // Ignore canShare errors and try sharing anyway.
  }

  try {
    await navigator.share({
      files: [file],
      title: payload.title,
      text: payload.text,
    });

    return { ok: true, provider: "instagram", method: "web_share" };
  } catch (error) {
    // AbortError is the common cancellation signal.
    if (isAbortError(error)) {
      return {
        ok: false,
        provider: "instagram",
        reason: "user_cancelled",
        error,
      };
    }

    return { ok: false, provider: "instagram", reason: "unknown", error };
  }
}

type PreparedFile = File & { __fetchedVia?: "direct" | "next_image_optimizer" };

async function fileFromUrl(
  imageUrl: string,
  filename?: string,
  options?: { allowNextImageOptimizerFallback?: boolean },
): Promise<PreparedFile> {
  // Many CDNs (including CloudFront) do not allow CORS fetches from browsers.
  // We first try direct fetch, then (optionally) fall back to Next's image
  // optimizer endpoint which is same-origin and fetches server-side.
  const direct = await tryFetchBlob(imageUrl);
  if (direct) {
    return fileFromBlob(direct, filename, "direct");
  }

  if (
    options?.allowNextImageOptimizerFallback &&
    typeof window !== "undefined"
  ) {
    const viaNext = await tryFetchBlob(buildNextImageOptimizerUrl(imageUrl));
    if (viaNext) {
      return fileFromBlob(viaNext, filename, "next_image_optimizer");
    }
  }

  throw new Error("Failed to fetch image (direct and fallback).");
}

function fileFromBlob(
  blob: Blob,
  filename: string | undefined,
  fetchedVia: "direct" | "next_image_optimizer",
): PreparedFile {
  const contentType = blob.type || "";
  const inferredExtension = extensionFromContentType(contentType);
  const safeName = filename?.trim() || `shared-image${inferredExtension}`;

  const file = new File([blob], safeName, {
    type: contentType || "application/octet-stream",
    lastModified: Date.now(),
  }) as PreparedFile;

  file.__fetchedVia = fetchedVia;
  return file;
}

async function tryFetchBlob(url: string): Promise<Blob | null> {
  try {
    const response = await fetch(url, { mode: "cors" });
    if (!response.ok) return null;
    return await response.blob();
  } catch {
    return null;
  }
}

function buildNextImageOptimizerUrl(remoteUrl: string): string {
  const url = new URL("/_next/image", window.location.origin);
  url.searchParams.set("url", remoteUrl);
  // 1080 is a reasonable IG-friendly width; Next will pick a format.
  url.searchParams.set("w", "1080");
  url.searchParams.set("q", "90");
  return url.toString();
}

/**
 * Public helper to prefetch/prepare a shareable File ahead of time.
 * Use this to avoid losing “user activation” before clipboard writes.
 */
export async function prepareShareImageFile(options: {
  imageUrl: string;
  filename?: string;
}): Promise<File> {
  return fileFromUrl(options.imageUrl, options.filename, {
    allowNextImageOptimizerFallback: true,
  });
}

function extensionFromContentType(contentType: string): string {
  const type = contentType.toLowerCase().split(";")[0].trim();

  switch (type) {
    case "image/png":
      return ".png";
    case "image/jpeg":
      return ".jpg";
    case "image/webp":
      return ".webp";
    case "image/gif":
      return ".gif";
    default:
      return "";
  }
}

function isAbortError(error: unknown): boolean {
  if (error && typeof error === "object") {
    // DOMException isn't always directly available across environments.
    const anyError = error as { name?: unknown };
    return anyError.name === "AbortError";
  }

  return false;
}

async function tryWriteImageToClipboard(file: File): Promise<boolean> {
  // Clipboard image write is not universally supported and requires a user gesture.
  const clipboard = navigator.clipboard;
  if (!clipboard || typeof clipboard.write !== "function") return false;

  // ClipboardItem might not exist in all browsers.
  if (typeof ClipboardItem === "undefined") return false;

  // Some browsers require `image/png` / `image/jpeg` etc.
  const mime = inferImageMime(file) || "image/png";

  try {
    const blob = file.slice(0, file.size, mime);
    const item = new ClipboardItem({ [mime]: blob });
    await clipboard.write([item]);
    return true;
  } catch {
    return false;
  }
}

function isClipboardWriteSupported(): boolean {
  const clipboard = navigator.clipboard;
  if (!clipboard || typeof clipboard.write !== "function") return false;
  return typeof ClipboardItem !== "undefined";
}

function inferImageMime(file: File): string | null {
  if (file.type && file.type.startsWith("image/")) return file.type;
  const name = file.name.toLowerCase();
  if (name.endsWith(".png")) return "image/png";
  if (name.endsWith(".jpg") || name.endsWith(".jpeg")) return "image/jpeg";
  if (name.endsWith(".webp")) return "image/webp";
  if (name.endsWith(".gif")) return "image/gif";
  return null;
}

function tryOpenDeepLink(url: string): boolean {
  try {
    // Using assign() keeps it in the same browsing context (often required on iOS).
    window.location.assign(url);
    return true;
  } catch {
    try {
      window.open(url, "_blank");
      return true;
    } catch {
      return false;
    }
  }
}
