/* 문장 수집창고 — 서비스워커
   앱 화면 파일을 버전별로 저장해 두고, 켤 때는 저장본으로 바로 열어요(인터넷을 기다리지 않음).
   새 버전은 이 파일(sw.js)이 바뀌면 브라우저가 알아서 받아 오고, 앱이 한 번 새로고침돼요.
   ⚠️ 앱 파일을 고치면 V 를 올리고, index.html 의 ?v= 와 app.js 의 APP_VERSION 도 같은 숫자로 맞춰요. */

const V = 29;
const CACHE = "sentence-archive-v" + V;
// 페이지가 실제로 요청하는 주소 그대로 (?v= 포함). 주소가 정확히 같을 때만 저장본을 써서 옛 파일과 섞이지 않아요.
const SHELL = [
  "./",
  `styles.css?v=${V}`,
  `config.js?v=${V}`,
  `app.js?v=${V}`,
  "manifest.webmanifest",
  "icons/apple-touch-icon.png",
  "icons/icon-192.png",
  "icons/icon-512.png",
];
const CDN_HOSTS = ["cdn.jsdelivr.net", "fonts.googleapis.com", "fonts.gstatic.com"];
// 라이브러리·글꼴은 주소에 버전이 고정돼 있어서, 앱 버전이 바뀌어도 지우지 않는 별도 저장소에 둬요 (글꼴을 다시 받지 않게)
const CDN_CACHE = "sentence-cdn";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE)
      // cache: "reload" — 브라우저 HTTP 캐시에 남은 옛 파일이 아니라 서버의 새 파일을 받아요
      .then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: "reload" }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      // 예전 앱 파일 캐시만 지워요 ("sentence-fonts" 내 폰트, "sentence-cdn" 라이브러리·글꼴은 남겨요)
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("sentence-archive-") && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

const appShell = () => caches.open(CACHE).then((c) => c.match("./"));

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  if (url.origin === self.location.origin) {
    if (url.pathname.endsWith("/sw.js")) return; // 서비스워커 파일은 브라우저가 직접 확인

    // 앱 열기(화면 이동): 저장된 index.html 로 바로. 없을 때(처음 설치 중)만 인터넷
    // (recover.html 같은 다른 페이지는 아래에서 따로 받아요)
    const scope = new URL(self.registration.scope).pathname;
    if (req.mode === "navigate" && (url.pathname === scope || url.pathname === scope + "index.html")) {
      event.respondWith(
        appShell().then((hit) => hit || fetch(req).catch(() => new Response("오프라인이에요", { status: 503 })))
      );
      return;
    }

    // 그 밖의 내 파일: 같은 주소의 저장본 → 없으면 인터넷에서 받아 저장
    event.respondWith(
      caches.open(CACHE).then((c) => c.match(req).then((hit) => hit || fetch(req).then((res) => {
        if (res.ok) c.put(req, res.clone());
        return res;
      }).catch(() => (req.destination === "document" ? appShell() : Response.error()))))
    );
    return;
  }

  // 라이브러리·글꼴(버전 고정): 저장본 먼저
  if (CDN_HOSTS.includes(url.hostname)) {
    event.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        if (res.ok || res.type === "opaque") {
          const copy = res.clone();
          caches.open(CDN_CACHE).then((c) => c.put(req, copy));
        }
        return res;
      }))
    );
  }
  // 그 밖(Supabase 등)은 그대로 통과
});
