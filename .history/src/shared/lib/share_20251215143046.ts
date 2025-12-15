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
  if (!options.skipClipboard) {
    try {
      const file = await fileFromUrl(options.imageUrl, options.filename);
      clipboardOk = await tryWriteImageToClipboard(file);
    } catch (error) {
      // If we can't fetch/copy, still allow deep-linking to proceed.
      // Only fail hard on fetch errors if clipboard is the only expected behavior.
      // Here we continue to open Instagram anyway.
      void error;
    }
  }

  const opened = tryOpenDeepLink(deepLink);
  if (!opened) {
    return { ok: false, provider: "instagram", reason: "not_supported" };
  }

  return {
    ok: true,
    provider: "instagram",
    method: clipboardOk ? "deep_link_clipboard" : "deep_link",
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

async function fileFromUrl(imageUrl: string, filename?: string): Promise<File> {
  const response = await fetch(imageUrl, { mode: "cors" });
  if (!response.ok) {
    throw new Error(
      `Failed to fetch image: ${response.status} ${response.statusText}`,
    );
  }

  const blob = await response.blob();
  const contentType = blob.type || response.headers.get("content-type") || "";

  const inferredExtension = extensionFromContentType(contentType);
  const safeName = filename?.trim() || `shared-image${inferredExtension}`;

  return new File([blob], safeName, {
    type: contentType || "application/octet-stream",
    lastModified: Date.now(),
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
  const ClipboardItemCtor = (
    globalThis as unknown as { ClipboardItem?: unknown }
  ).ClipboardItem;
  if (typeof ClipboardItemCtor !== "function") return false;

  // Some browsers require `image/png` / `image/jpeg` etc.
  const mime = file.type || "image/png";

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const item = new (ClipboardItemCtor as any)({ [mime]: file });
    await clipboard.write([item]);
    return true;
  } catch {
    return false;
  }
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
