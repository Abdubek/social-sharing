export default function Home() {
  return (
    <div className="min-h-screen bg-zinc-50 font-sans dark:bg-black">
      <main className="mx-auto flex min-h-screen max-w-xl items-center justify-center px-6 pb-28">
        <img
          src="https://d8j0ntlcm91z4.cloudfront.net/user_30yFYHi31EXeFFWTDMAYMBjpYRY/4a823ae4-21e7-42c6-b2ca-115ccb9733ad.png"
          alt="Preview"
          className="h-auto w-full max-w-sm rounded-2xl object-contain shadow-sm"
        />
      </main>

      <div className="fixed inset-x-0 bottom-0 z-50 border-t border-zinc-200 bg-zinc-50/90 px-6 py-4 backdrop-blur dark:border-zinc-800 dark:bg-black/80">
        <div className="mx-auto max-w-xl">
          <button
            type="button"
            className="w-full rounded-xl bg-black px-4 py-3 text-base font-semibold text-white shadow-sm hover:bg-zinc-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-black dark:bg-white dark:text-black dark:hover:bg-zinc-200 dark:focus-visible:outline-white"
          >
            Share
          </button>
        </div>
      </div>
    </div>
  );
}
