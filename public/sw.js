/* easy-pi-webui Service Worker —— 只负责「外壳」，不碰数据。
 *
 * 策略（故意这么选，别改成 cache-first）：
 * - 页面导航与外壳静态资源一律 network-first：先取网络，成功就顺手更新缓存，
 *   失败（断网）才回退缓存。这样改完前端代码刷新就是新的，不会卡在旧版本。
 * - /api/* 完全不拦截、不缓存、不伪造：请求直接交给浏览器/服务端。
 *   包括 /api/upload、/api/file（预览/下载）、/api/sessions/search、/api/session/export、/api/session/branch 和 SSE（/api/events）。SW 不参与。
 * - 缓存名带版本号；activate 时删掉旧版本的缓存。
 * - install 预缓存外壳 + skipWaiting()，activate 里 clientsClaim()，
 *   新版本不用等所有标签页关掉才生效。
 */

const CACHE_NAME = "pi-webui-v20";

// 只预缓存外壳。图标/logo/manifest 一起带上，断网时至少界面完整。
const SHELL_ASSETS = [
  "/",
  "/index.html",
  "/styles.css",
  "/js/app.js",
  "/js/markdown.js",
  "/js/task-status.js",
  "/logo.svg",
  "/icons/mark.svg",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/icon-512-maskable.png",
  "/icons/apple-touch-icon-180.png",
  "/manifest.webmanifest",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      // 单个资源失败（比如以后删了某个文件）不要让整次安装失败，
      // 否则 SW 永远装不上，通知和离线外壳一起没了。
      await Promise.all(
        SHELL_ASSETS.map((url) =>
          cache.add(new Request(url, { cache: "reload" })).catch(() => {})
        )
      );
      await self.skipWaiting();
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      );
      await self.clients.claim();
    })()
  );
});

function isShellAsset(pathname) {
  if (pathname === "/styles.css") return true;
  if (pathname === "/logo.svg") return true;
  if (pathname === "/manifest.webmanifest") return true;
  if (pathname.startsWith("/icons/")) return true;
  if (pathname.startsWith("/js/") && pathname.endsWith(".js")) return true;
  return false;
}

async function networkFirst(request, fallbackUrl) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const response = await fetch(request);
    // 只缓存正常的同源响应，别把 404 / 重定向 / opaque 塞进缓存。
    if (response && response.ok && response.type === "basic") {
      cache.put(request, response.clone()).catch(() => {});
    }
    return response;
  } catch (error) {
    const cached = await cache.match(request);
    if (cached) return cached;
    if (fallbackUrl) {
      const fallback = await cache.match(fallbackUrl);
      if (fallback) return fallback;
    }
    throw error;
  }
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }
  if (url.origin !== self.location.origin) return;

  // API（含 SSE /api/events）一律不经过 SW：不缓存、不伪造响应。
  if (url.pathname.startsWith("/api/")) return;

  if (request.mode === "navigate") {
    event.respondWith(networkFirst(request, "/index.html"));
    return;
  }

  if (isShellAsset(url.pathname)) {
    event.respondWith(networkFirst(request));
  }
});

// 阶段 C 的完成通知优先走 registration.showNotification，
// 点击后由这里聚焦已有窗口；没有窗口就打开首页。
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      for (const client of windows) {
        if (new URL(client.url).origin === self.location.origin) {
          await client.focus();
          return;
        }
      }
      await self.clients.openWindow("/");
    })()
  );
});
