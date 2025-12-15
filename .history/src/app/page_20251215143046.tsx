"use client";

import Image from "next/image";
import {
  shareImageToInstagram,
  shareImageToInstagramDirect,
} from "@/src/shared/lib/share";

export default function Home() {
  const imageUrl =
    "https://d8j0ntlcm91z4.cloudfront.net/user_30yFYHi31EXeFFWTDMAYMBjpYRY/4a823ae4-21e7-42c6-b2ca-115ccb9733ad.png";

  async function onShare() {
    // Prefer a “direct” flow (clipboard + deep link), but fall back to Web Share
    // if the device/browser doesn't support it.
    let result = await shareImageToInstagramDirect({
      imageUrl,
      filename: "social-sharing.png",
      title: "Share image",
    });

    if (!result.ok && result.reason === "not_supported") {
      result = await shareImageToInstagram({
        imageUrl,
        filename: "social-sharing.png",
        title: "Share image",
      });
    }

    if (!result.ok && result.reason !== "user_cancelled") {
      alert(
        result.reason === "not_supported"
          ? "Sharing is not supported in this browser. Try on mobile Safari or Chrome."
          : `Share failed: ${result.reason}`,
      );
    }
  }

  return (
    <div className="min-h-screen bg-zinc-50 font-sans dark:bg-black">
      <main className="mx-auto flex min-h-screen max-w-xl items-center justify-center px-6 pb-28">
        <Image
          src={imageUrl}
          alt="Preview"
          width={640}
          height={640}
          sizes="(max-width: 640px) 80vw, 384px"
          className="h-auto w-full max-w-sm rounded-2xl object-contain shadow-sm"
          priority
        />
      </main>

      <div className="fixed inset-x-0 bottom-0 z-50 border-t border-zinc-200 bg-zinc-50/90 px-6 py-4 backdrop-blur dark:border-zinc-800 dark:bg-black/80">
        <div className="mx-auto max-w-xl">
          <button
            type="button"
            onClick={onShare}
            className="w-full rounded-xl bg-black px-4 py-3 text-base font-semibold text-white shadow-sm hover:bg-zinc-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-black dark:bg-white dark:text-black dark:hover:bg-zinc-200 dark:focus-visible:outline-white"
          >
            Share
          </button>
        </div>
      </div>
    </div>
  );
}
