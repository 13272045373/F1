// F1 赛事助手 · Service Worker
//
// 为什么需要它：
//   Chrome 判断一个网页"能不能装成 app"有硬性要求，其中一条就是
//   【必须有一个带 fetch 事件处理的 Service Worker】。
//   没有它，「添加到主屏幕」只会创建一个书签 —— 点开还是浏览器（带地址栏），
//   而不是像 app 那样独立全屏窗口。有了它，Chrome 会装成 WebAPK，
//   图标独立、没有地址栏、切换任务时也像个 app。
//
// 顺带的好处：静态文件会缓存，第二次打开几乎是瞬开；断网也能打开看已缓存的内容。

const CACHE = "f1-assistant-v1";

// 只预缓存这几个小的、稳定的文件。
// index.html 故意不放进来 —— 它每次改动都要能立刻看到，靠下面的"网络优先"来保证。
const PRECACHE = ["./", "./manifest.json", "./favicon.svg", "./icon-192.png", "./icon-512.png"];

self.addEventListener("install", (e) => {
  self.skipWaiting();   // 新版本立刻接管，不用等所有标签页关掉
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => Promise.all(PRECACHE.map((u) => c.add(u).catch(() => {}))))
      .catch(() => {})
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;

  let url;
  try { url = new URL(req.url); } catch { return; }

  // 跨域的（OpenF1 / github.io / 图片 CDN）一律不拦，交给浏览器自己处理
  if (url.origin !== self.location.origin) return;

  // 预取包：永远先要最新的，拿不到才用缓存
  if (url.pathname.endsWith("/data/f1.json")) {
    e.respondWith(fetch(req).catch(() => caches.match(req)));
    return;
  }

  // 本站其它资源：网络优先（保证改了就能看到），失败再落缓存（保证断网也能开）
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.status === 200 && res.type === "basic") {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || Response.error()))
  );
});
