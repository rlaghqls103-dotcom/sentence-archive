/* 문장 수집창고 — 서비스워커
   앱 화면 파일을 저장해 두어 빠르게 열리고, 인터넷이 없어도 화면이 뜨게 합니다.
   앱 파일은 '인터넷 먼저'로 받아서 업데이트가 바로 반영됩니다. */

const CACHE = "sentence-archive-v14";
const SHELL = [
  "./",
  "index.html",
  "styles.css",
  "app.js",
  "config.js",
  "manifest.webmanifest",
  "icons/apple-touch-icon.png",
  "icons/icon-192.png",
  "icons/icon-512.png",
];
const CDN_HOSTS = ["cdn.jsdelivr.net", "fonts.googleapis.com", "fonts.gstatic.com"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      // 예전 앱 파일 캐시만 지워요 (내 폰트 캐시 "sentence-fonts" 는 남겨요)
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("sentence-archive-") && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // 내 앱 파일: 인터넷 먼저, 안 되면 저장본
  if (url.origin === self.location.origin) {
    event.respondWith(
      fetch(req, { cache: "no-cache" }) // 항상 서버에 새 버전이 있는지 확인
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => caches.match(req, { ignoreSearch: true }).then((r) => r || caches.match("index.html")))
    );
    return;
  }

  // 라이브러리·글꼴(버전 고정): 저장본 먼저
  if (CDN_HOSTS.includes(url.hostname)) {
    event.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        if (res.ok || res.type === "opaque") {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      }))
    );
  }
  // 그 밖(Supabase 등)은 그대로 통과
});
