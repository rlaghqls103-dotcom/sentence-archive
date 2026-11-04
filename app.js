/* 문장 수집창고 — 앱 로직 */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const cfg = window.APP_CONFIG || {};

  // ---------- 작은 도구들 ----------

  const store = {
    get(key, fallback) {
      try {
        const v = localStorage.getItem(key);
        return v == null ? fallback : JSON.parse(v);
      } catch { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* 저장공간 없음: 무시 */ }
    },
    remove(key) {
      try { localStorage.removeItem(key); } catch { /* 무시 */ }
    },
  };

  const WEEK = ["일", "월", "화", "수", "목", "금", "토"];
  const pad = (n) => String(n).padStart(2, "0");
  function fmtDate(iso) {
    const d = new Date(iso);
    return `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())}`;
  }
  function fmtLongDate(d) {
    return `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일 (${WEEK[d.getDay()]})`;
  }

  let toastTimer;
  function toast(msg) {
    const el = $("toast");
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("show"), 2400);
  }

  // 줄이 바뀐 자리 표시용 보이지 않는 글자 (확인 패널을 만든 뒤 지워요)
  const BRK = "\u2063";

  // 사진에서 복사한 문장은 줄 끝마다 줄바꿈이 들어가요. 문단(빈 줄)은 남기고 나머지는 한 줄로 합쳐요.
  // mark=true 면 합친 자리에 BRK 를 남겨, 나중에 "줄이 바뀐 자리"로 보여줘요.
  function joinLines(text, mark = false) {
    return text
      .replace(/\r\n?/g, "\n")
      .split(/\n\s*\n/)
      .map((p) => p
        .replace(/([A-Za-z])-\n(?=[a-z])/g, "$1") // 영어 하이픈 줄바꿈
        .replace(/[ \t]*\n[ \t]*/g, mark ? BRK + " " : " ")
        .replace(/[ \t]{2,}/g, " ")
        .trim())
      .filter(Boolean)
      .join("\n\n");
  }

  // 곧은 따옴표(" ')를 책처럼 둥근 따옴표(“ ” ‘ ’)로
  function smartQuotes(t) {
    return t
      .replace(/(^|[\s(\[{<「『“‘—–-])"/g, "$1“").replace(/"/g, "”")
      .replace(/(^|[\s(\[{<「『“—–-])'/g, "$1‘").replace(/'/g, "’");
  }

  // ---------- 창이 열린 동안 뒤 배경 고정 ----------
  // 아이폰 Safari 는 창(dialog)이 떠 있어도 뒤 화면이 같이 스크롤돼서, 창이 열리면 body 를 그 자리에 고정해요.
  let lockedY = null;
  function syncScrollLock() {
    const anyOpen = !!document.querySelector("dialog[open]");
    const b = document.body;
    if (anyOpen && lockedY === null) {
      lockedY = window.scrollY;
      document.documentElement.classList.add("modal-open");
      Object.assign(b.style, { position: "fixed", top: `-${lockedY}px`, left: "0", right: "0", width: "100%" });
    } else if (!anyOpen && lockedY !== null) {
      document.documentElement.classList.remove("modal-open");
      Object.assign(b.style, { position: "", top: "", left: "", right: "", width: "" });
      window.scrollTo(0, lockedY); // 창을 닫으면 보던 자리 그대로
      lockedY = null;
    }
  }
  const dialogWatcher = new MutationObserver(syncScrollLock);
  document.querySelectorAll("dialog").forEach((d) => dialogWatcher.observe(d, { attributes: true, attributeFilter: ["open"] }));

  // ---------- 화면 전환 ----------

  const views = { setup: $("view-setup"), auth: $("view-auth"), main: $("view-main") };
  function show(name) {
    for (const key of Object.keys(views)) views[key].hidden = key !== name;
    $("tabbar").hidden = name !== "main";
    const boot = $("boot");
    if (boot) boot.remove(); // 시작 화면은 처음 한 번만
    document.documentElement.classList.toggle("has-tabbar", name === "main");
  }

  // 앱 버전: 홈 화면 앱이 최신인지 화면에서 확인할 수 있어요
  const APP_VERSION = "v26";
  $("app-version").textContent = APP_VERSION;

  // 서비스워커: 새 버전이 배포되면 알아서 받아서 한 번 새로고침해요
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", async () => {
      try {
        const hadController = !!navigator.serviceWorker.controller;
        const reg = await navigator.serviceWorker.register("sw.js", { updateViaCache: "none" });
        let reloaded = false;
        navigator.serviceWorker.addEventListener("controllerchange", () => {
          // 처음 설치될 때는 새로고침하지 않고, 이미 쓰던 앱이 새 버전으로 바뀔 때만
          if (!hadController || reloaded) return;
          reloaded = true;
          location.reload();
        });
        document.addEventListener("visibilitychange", () => {
          if (document.visibilityState === "visible") reg.update().catch(() => {});
        });
      } catch { /* 서비스워커 없이도 앱은 동작해요 */ }
    });
  }

  if (!cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY) {
    show("setup");
    return;
  }
  if (!window.supabase) {
    views.setup.querySelector("p").textContent = "앱을 불러오지 못했어요. 인터넷 연결을 확인한 뒤 다시 열어주세요.";
    show("setup");
    return;
  }

  const sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });

  // ---------- 상태 ----------

  let user = null;
  let items = [];
  let query = "";
  let bookFilter = null;
  let channel = null;
  // 감상문: 책 제목 → { body, finished_on, updated_at } (문장과 따로 관리, 오늘의 문장에는 안 나와요)
  let notes = new Map();
  let notesMissing = false; // book_notes 표가 아직 없으면(SQL 실행 전) 안내
  let activeTab = "sentences";
  let lastLoad = 0;
  let lastShown = [];
  let todayOffset = 0; // [다른 문장]을 누른 만큼

  const syncEl = $("sync-state");
  function setSync(state) {
    syncEl.className = "sync-dot " + state;
    const label = {
      live: "실시간 연동 중",
      busy: "불러오는 중",
      offline: "오프라인 — 연결되면 다시 불러와요",
      idle: "연동 대기",
    }[state] || "";
    syncEl.title = label;
    syncEl.setAttribute("aria-label", label);
  }

  // ---------- 로그인 ----------

  let signUpMode = false;
  const authMsg = $("auth-message");

  function setAuthMode(signUp) {
    signUpMode = signUp;
    $("auth-submit").textContent = signUp ? "계정 만들기" : "로그인";
    $("auth-toggle").textContent = signUp ? "이미 계정이 있어요. 로그인하기" : "처음이신가요? 계정 만들기";
    $("auth-password").autocomplete = signUp ? "new-password" : "current-password";
    authMsg.textContent = "";
    authMsg.className = "form-message";
  }

  function authErrorText(error) {
    const m = (error && error.message) || "";
    if (/Invalid login credentials/i.test(m)) return "이메일 또는 비밀번호가 맞지 않아요.";
    if (/already registered/i.test(m)) return "이미 가입된 이메일이에요. 로그인해 주세요.";
    if (/Signups not allowed/i.test(m)) return "새 계정 만들기가 꺼져 있어요.";
    if (/Email not confirmed/i.test(m)) return "메일 인증이 아직 안 됐어요. 받은 메일의 링크를 눌러주세요.";
    if (/Password should be/i.test(m)) return "비밀번호는 6자 이상이어야 해요.";
    if (/fetch|network/i.test(m)) return "인터넷 연결을 확인해 주세요.";
    return m || "문제가 생겼어요. 잠시 후 다시 시도해 주세요.";
  }

  $("auth-toggle").addEventListener("click", () => setAuthMode(!signUpMode));

  $("auth-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = $("auth-email").value.trim();
    const password = $("auth-password").value;
    const btn = $("auth-submit");
    btn.disabled = true;
    authMsg.className = "form-message";
    authMsg.textContent = "";
    try {
      if (signUpMode) {
        const { data, error } = await sb.auth.signUp({ email, password });
        if (error) throw error;
        if (!data.session) {
          setAuthMode(false);
          authMsg.className = "form-message ok";
          authMsg.textContent = "확인 메일을 보냈어요. 메일의 링크를 누른 뒤 여기서 로그인해 주세요.";
        }
      } else {
        const { error } = await sb.auth.signInWithPassword({ email, password });
        if (error) throw error;
      }
    } catch (err) {
      authMsg.textContent = authErrorText(err);
    } finally {
      btn.disabled = false;
    }
  });

  $("logout-btn").addEventListener("click", async () => {
    if (!confirm("로그아웃할까요?")) return;
    await sb.auth.signOut();
  });

  let started = false;
  sb.auth.onAuthStateChange((_event, session) => {
    const next = session ? session.user : null;
    if (started && (next && next.id) === (user && user.id)) return;
    started = true;
    user = next;
    // Supabase 권장: 콜백 안에서 바로 다른 요청을 하지 않고 한 박자 뒤에 처리
    setTimeout(() => (user ? enterMain() : enterAuth()), 0);
  });

  // ---------- 내 폰트 (Supabase 비공개 보관함) ----------
  // 로그인한 뒤 Storage 의 "fonts" 보관함에서 폰트 파일을 받아 문장·제목(--serif)에 적용해요.
  // 한 번 받은 파일은 이 기기에 저장해 두어(Cache Storage) 다음부터는 바로, 오프라인에서도 떠요.
  const FONT_FAMILY = "ArchiveCustom";
  const FONT_CACHE = "sentence-fonts";
  const FONT_EXT = /\.(woff2|woff|otf|ttf)$/i;
  let fontsApplied = false;

  // 파일 이름으로 굵기를 정해요 (예: 29CM-Editorial-Bold.otf → 700). 표시가 없으면 400.
  function fontWeight(name) {
    const n = name.toLowerCase().replace(/[-_ ]/g, "");
    const num = name.match(/(?:^|\D)([1-9]00)(?:\D|$)/);
    if (num) return num[1];
    const words = [
      ["extrabold", 800], ["ultrabold", 800], ["semibold", 600], ["demibold", 600],
      ["extralight", 200], ["ultralight", 200], ["thin", 100], ["hairline", 100],
      ["light", 300], ["medium", 500], ["bold", 700], ["black", 900], ["heavy", 900],
    ];
    for (const [w, v] of words) if (n.includes(w)) return String(v);
    return "400";
  }

  function fontCacheKey(file) {
    return `https://fonts.local/${encodeURIComponent(file.name)}?v=${encodeURIComponent(file.updated_at || "")}`;
  }

  async function fontBytes(file, cache) {
    const key = fontCacheKey(file);
    if (cache) {
      const hit = await cache.match(key);
      if (hit) return hit.arrayBuffer();
    }
    const { data, error } = await sb.storage.from("fonts").download(file.name);
    if (error) throw error;
    const buf = await data.arrayBuffer();
    if (cache) { try { await cache.put(key, new Response(buf.slice(0))); } catch { /* 저장공간 없음: 무시 */ } }
    return buf;
  }

  // 맨 아래에 지금 어떤 글꼴로 보이는지 표시 (제대로 적용됐는지 확인용)
  function setFontStatus(text) { const el = $("font-status"); if (el) el.textContent = text; }


  // 문장 글꼴 고르기: 기본은 마루부리, '내 폰트'를 고르면 Supabase 보관함의 폰트를 받아 써요 (기기마다 저장)
  const fontChoice = $("font-choice");
  fontChoice.value = store.get("fontChoice", "default") === "custom" ? "custom" : "default";
  function applyFontChoice() {
    if (fontChoice.value === "custom") {
      setFontStatus("내 폰트를 불러오는 중…");
      loadCustomFont().catch((err) => { console.warn("내 폰트를 불러오지 못했어요", err); setFontStatus("내 폰트를 불러오지 못했어요"); });
    } else {
      document.documentElement.classList.remove("custom-font");
      setFontStatus("");
    }
  }
  fontChoice.addEventListener("change", () => { store.set("fontChoice", fontChoice.value); applyFontChoice(); });

  async function loadCustomFont() {
    if (fontsApplied) { document.documentElement.classList.add("custom-font"); setFontStatus(""); return; }
    let files;
    try {
      const { data, error } = await sb.storage.from("fonts").list("", { limit: 100 });
      if (error) throw error;
      files = (data || [])
        .filter((f) => f.name && FONT_EXT.test(f.name))
        .map((f) => ({ name: f.name, updated_at: f.updated_at || f.created_at || "" }));
      store.set("fontFiles", files);
    } catch {
      files = store.get("fontFiles", []); // 오프라인이면 마지막 목록과 저장해 둔 파일로
    }
    // 같은 굵기·모양이 여러 형식으로 있으면 하나만 (woff2 > woff > otf > ttf)
    const rank = (n) => ["woff2", "woff", "otf", "ttf"].indexOf(n.split(".").pop().toLowerCase());
    const best = new Map();
    for (const f of files) {
      const k = fontWeight(f.name) + (/italic|oblique/i.test(f.name) ? "i" : "");
      if (!best.has(k) || rank(f.name) < rank(best.get(k).name)) best.set(k, f);
    }
    files = [...best.values()];
    if (!files.length) { setFontStatus("내 폰트 파일을 찾지 못해서 마루부리로 보여요"); return; }

    let cache = null;
    try { cache = await caches.open(FONT_CACHE); } catch { /* 사생활 보호 모드 등: 캐시 없이 */ }
    const results = await Promise.allSettled(files.map(async (f) => {
      const face = new FontFace(FONT_FAMILY, await fontBytes(f, cache), {
        weight: fontWeight(f.name),
        style: /italic|oblique/i.test(f.name) ? "italic" : "normal",
        display: "swap",
      });
      await face.load();
      return face;
    }));
    const faces = results.filter((r) => r.status === "fulfilled").map((r) => r.value);
    results.filter((r) => r.status === "rejected").forEach((r) => console.warn("내 폰트를 불러오지 못했어요", r.reason));
    if (!faces.length) { setFontStatus("내 폰트를 불러오지 못해서 마루부리로 보여요"); return; }
    faces.forEach((f) => document.fonts.add(f));
    fontsApplied = true;
    setFontStatus(faces.length < files.length ? `내 폰트 일부(${files.length - faces.length}개)를 불러오지 못했어요` : "");
    if (user && fontChoice.value === "custom") document.documentElement.classList.add("custom-font");

    // 바뀌거나 지운 폰트의 예전 저장본 정리
    if (cache) {
      const keep = new Set(files.map(fontCacheKey));
      for (const req of await cache.keys()) if (!keep.has(req.url)) cache.delete(req);
    }
  }

  function enterAuth() {
    document.documentElement.classList.remove("custom-font"); // 로그인 화면은 기본 폰트
    if (channel) { sb.removeChannel(channel); channel = null; }
    items = [];
    bookFilter = null;
    query = "";
    $("sentence-list").replaceChildren();
    notes = new Map();
    $("note-list").replaceChildren();
    setAuthMode(false);
    show("auth");
  }

  function enterMain() {
    show("main");
    applyFontChoice();
    items = store.get("cache:" + user.id, []);
    loadBookRows(store.get("colors:" + user.id, []));
    loadNoteRows(store.get("notes:" + user.id, []));
    setTab(store.get("tab", "sentences"), { scroll: false });
    const lastBook = store.get("lastBook", "");
    if (lastBook && !$("compose-book").value) $("compose-book").value = lastBook;
    paintBook($("compose-book-swatch"), $("compose-book").value);
    if (!$("compose-author").value) $("compose-author").value = authorOf($("compose-book").value);
    const draft = store.get("draft", "");
    if (draft && !$("compose-content").value) $("compose-content").value = draft;
    render();
    load();
    subscribe();
  }

  // ---------- 불러오기 / 실시간 동기화 ----------

  async function load() {
    if (!user) return;
    lastLoad = Date.now();
    setSync("busy");
    const PAGE = 1000;
    const all = [];
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await sb
        .from("sentences")
        .select("*")
        .order("created_at", { ascending: false })
        .range(from, from + PAGE - 1);
      if (error) {
        setSync("offline");
        return;
      }
      all.push(...data);
      if (data.length < PAGE) break;
    }
    items = all;
    store.set("cache:" + user.id, items);
    // 직접 고른 책 색 (표가 아직 없으면 조용히 넘어가요)
    // 책 정보(색·작가). 작가 칸이 아직 없으면(SQL 실행 전) 색만 불러와요
    let { data: books, error: booksError } = await sb.from("book_colors").select("book_title,color,author");
    if (booksError) ({ data: books, error: booksError } = await sb.from("book_colors").select("book_title,color"));
    if (!booksError && books) { loadBookRows(books); saveBooksCache(); }
    // 감상문 (표가 아직 없으면 감상문 탭에 안내만 해요)
    const { data: noteRows, error: notesError } = await sb.from("book_notes").select("book_title,body,finished_on,updated_at");
    notesMissing = !!notesError && isMissingTable(notesError);
    if (!notesError && noteRows) { loadNoteRows(noteRows); saveNotesCache(); }
    render();
    setSync(channel && channel.state === "joined" ? "live" : "idle");
  }

  function upsertLocal(row) {
    const i = items.findIndex((x) => x.id === row.id);
    if (i >= 0) items[i] = row;
    else items.push(row);
    items.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    store.set("cache:" + user.id, items);
  }
  function removeLocal(id) {
    items = items.filter((x) => x.id !== id);
    store.set("cache:" + user.id, items);
  }

  function subscribe() {
    if (channel) sb.removeChannel(channel);
    channel = sb
      .channel("sentences-" + user.id)
      .on("postgres_changes", { event: "*", schema: "public", table: "sentences" }, (payload) => {
        if (payload.eventType === "DELETE") {
          if (payload.old && payload.old.id) removeLocal(payload.old.id);
        } else if (payload.new && payload.new.user_id === user.id) {
          upsertLocal(payload.new);
        }
        render();
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "book_colors" }, (payload) => {
        if (payload.eventType === "DELETE") {
          if (payload.old && payload.old.book_title) { bookCustom.delete(payload.old.book_title); bookAuthor.delete(payload.old.book_title); }
        } else if (payload.new && payload.new.user_id === user.id) {
          const r = payload.new;
          if (HEX.test(r.color || "")) bookCustom.set(r.book_title, r.color); else bookCustom.delete(r.book_title);
          if (r.author) bookAuthor.set(r.book_title, r.author); else bookAuthor.delete(r.book_title);
        }
        saveBooksCache();
        render();
        if (dialog.open) renderSwatches();
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "book_notes" }, (payload) => {
        if (payload.eventType === "DELETE") {
          if (payload.old && payload.old.book_title) notes.delete(payload.old.book_title);
        } else if (payload.new && payload.new.user_id === user.id) {
          const r = payload.new;
          notes.set(r.book_title, { body: r.body || "", finished_on: r.finished_on || null, updated_at: r.updated_at || null });
        }
        saveNotesCache();
        render();
      })
      .subscribe((status) => {
        if (status === "SUBSCRIBED") setSync("live");
        else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") setSync("offline");
      });
  }

  function refreshIfStale() {
    if (user && Date.now() - lastLoad > 3000) load();
  }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") refreshIfStale();
  });
  window.addEventListener("online", refreshIfStale);
  window.addEventListener("offline", () => setSync("offline"));

  // ---------- 그리기 ----------

  // ---------- 책마다 고유한 색 ----------
  // 책 제목으로 색을 정해서, 어느 기기에서 보든 같은 책은 늘 같은 색이에요.
  // 보내주신 전집 책장 사진에서 뽑은 책등 색 38가지 [색, 이름] — 색상환 순서
  // (흰 책등을 기준으로 조명을 보정하고, 카메라가 지나치게 진하게 찍은 색은 인쇄 표지 정도로 낮췄어요.
  //  색을 바꾸고 싶으면 여기만 고치면 돼요. 글자색은 자동)
  const BOOK_COLORS = [
    ["#d42a2a", "진홍"], ["#bb1f36", "크림슨"], ["#8a1f33", "와인"], ["#d44955", "다홍"],
    ["#f26970", "산호분홍"], ["#e25a14", "귤"], ["#ef7a3c", "주황"], ["#f69a64", "살구"],
    ["#f5d320", "노랑"], ["#b3b81e", "라임"], ["#a4b76c", "연두"], ["#668f54", "풀잎"],
    ["#426a3f", "숲"], ["#60aba0", "비취"], ["#479189", "청록"], ["#2c7d70", "상록"],
    ["#0e6659", "심록"], ["#0e7aa0", "청록파랑"], ["#2ea1d7", "파랑"], ["#77b4de", "하늘"],
    ["#12437c", "감청"], ["#3c5195", "코발트"], ["#6672bd", "페리윙클"], ["#3b22a0", "군청"],
    ["#ad81ce", "라벤더"], ["#9062aa", "제비꽃"], ["#6d3b84", "보라"], ["#6d1d5a", "플럼"],
    ["#a4167a", "마젠타"], ["#b74289", "자홍"], ["#cb7094", "모브"], ["#aa576c", "말린장미"],
    ["#f77ea6", "연분홍"], ["#f15195", "분홍"], ["#ea2a82", "핫핑크"], ["#e01e5a", "체리"],
    ["#8a8f94", "회색"], ["#2b2b2b", "먹색"],
  ];
  // 자동 배정용: 색상이 서로 멀리 떨어진 18색을 번갈아 늘어놓았어요.
  // (팔레트에 분홍 계열이 많아서, 전체에서 고르면 비슷한 색이 몰리기 쉬워요)
  const AUTO_NAMES = [
    "진홍", "청록파랑", "노랑", "보라", "풀잎", "분홍", "코발트", "주황", "상록",
    "라벤더", "다홍", "하늘", "라임", "플럼", "비취", "살구", "감청", "핫핑크",
  ];
  const AUTO = AUTO_NAMES.map((n) => BOOK_COLORS.findIndex(([, name]) => name === n)).filter((i) => i >= 0);
  // 표지 색 위 글자색: 기본은 흰색, 아주 밝은 색(노랑·살구·라임·연두·하늘 등)에서만 먹색
  function luminance(h) {
    const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
      .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  }
  function inkFor(hex) { return luminance(hex) > 0.40 ? "#1b1b1b" : "#ffffff"; }
  // 조금 밝은 색 위의 흰 글자는 옅은 그림자로 또렷하게
  function shadowFor(hex) {
    const L = luminance(hex);
    return L <= 0.40 && L > 0.2 ? "0 1px 2px rgba(0, 0, 0, .28)" : "none";
  }
  let bookCustom = new Map(); // 책 제목 → 직접 고른 색 (Supabase book_colors)
  let bookAuthor = new Map(); // 책 제목 → 작가 (같은 표의 author)
  const authorOf = (title) => bookAuthor.get((title || "").trim()) || "";
  // 책 정보(색·작가)를 기기에 저장해 두기
  function saveBooksCache() {
    if (!user) return;
    const titles = new Set([...bookCustom.keys(), ...bookAuthor.keys()]);
    store.set("colors:" + user.id, [...titles].map((t) => ({ book_title: t, color: bookCustom.get(t) || null, author: bookAuthor.get(t) || null })));
  }
  function loadBookRows(rows) {
    bookCustom = toColorMap(rows);
    bookAuthor = new Map((rows || []).filter((r) => r && r.book_title && r.author).map((r) => [r.book_title, r.author]));
  }
  const HEX = /^#[0-9a-f]{6}$/i;
  // 저장된 책 색 목록을 Map 으로 (형식이 맞지 않는 값은 건너뛰어요)
  const toColorMap = (rows) => new Map((rows || [])
    .filter((c) => c && typeof c.book_title === "string" && HEX.test(c.color || ""))
    .map((c) => [c.book_title, c.color]));

  // 책이 12권 이하일 때는 서로 다른 색이 되도록 배정해요.
  // 오래전에 처음 담은 책부터 순서대로, 제목으로 정한 색이 이미 쓰였으면 다음 색으로 넘어가요.
  // (책을 새로 추가해도 기존 책 색은 바뀌지 않아요)
  let bookColorMap = new Map();
  // 자동 배정은 AUTO 목록 안에서: 제목으로 시작 자리를 정하고, 이미 쓰인 색이면 다음 칸으로
  function hashIndex(t) {
    let h = 2166136261; // FNV-1a
    for (const ch of t) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619); }
    return (h >>> 0) % AUTO.length;
  }
  function freeIndex(t, used) {
    let k = hashIndex(t);
    if (AUTO.every((i) => used.has(i))) return AUTO[k]; // 18권을 넘으면 색을 다시 써요
    while (used.has(AUTO[k])) k = (k + 1) % AUTO.length;
    return AUTO[k];
  }
  function assignBookColors() {
    const map = new Map(), used = new Set();
    // 직접 고른 색은 먼저 자리를 차지해요 (자동 배정이 같은 색을 피하도록)
    for (const hex of bookCustom.values()) {
      const i = BOOK_COLORS.findIndex(([c]) => c.toLowerCase() === hex.toLowerCase());
      if (i >= 0) used.add(i);
    }
    // items 는 최신순이라 거꾸로(오래된 것부터) 훑어요
    for (let k = items.length - 1; k >= 0; k--) {
      const t = (items[k].book_title || "").trim();
      if (!t || map.has(t) || bookCustom.has(t)) continue;
      const i = freeIndex(t, used);
      used.add(i);
      map.set(t, i);
    }
    // 문장 없이 감상문만 있는 책도 겹치지 않는 색으로
    for (const t of notes.keys()) {
      if (map.has(t) || bookCustom.has(t)) continue;
      const i = freeIndex(t, used);
      used.add(i);
      map.set(t, i);
    }
    bookColorMap = map;
  }
  function bookColor(title) {
    const t = (title || "").trim();
    if (!t) return null;
    if (bookCustom.has(t)) { const bg = bookCustom.get(t); return { bg, ink: inkFor(bg), shadow: shadowFor(bg) }; }
    const i = bookColorMap.has(t) ? bookColorMap.get(t) : freeIndex(t, new Set(bookColorMap.values()));
    const bg = BOOK_COLORS[i][0];
    return { bg, ink: inkFor(bg), shadow: shadowFor(bg) };
  }
  function paintBook(el, title) {
    const c = bookColor(title);
    if (c) { el.style.setProperty("--book", c.bg); el.style.setProperty("--book-ink", c.ink); el.style.setProperty("--book-shadow", c.shadow); }
    else { el.style.removeProperty("--book"); el.style.removeProperty("--book-ink"); el.style.removeProperty("--book-shadow"); }
  }

  function bookStats() {
    const map = new Map(); // 최근에 쓴 책이 먼저
    for (const it of items) {
      const t = (it.book_title || "").trim();
      if (!t) continue;
      map.set(t, (map.get(t) || 0) + 1);
    }
    return [...map.entries()];
  }

  function highlight(parent, text, q) {
    if (!q) { parent.append(text); return; }
    const lower = text.toLowerCase();
    let i = 0;
    for (;;) {
      const j = lower.indexOf(q, i);
      if (j < 0) break;
      if (j > i) parent.append(text.slice(i, j));
      const mark = document.createElement("mark");
      mark.textContent = text.slice(j, j + q.length);
      parent.append(mark);
      i = j + q.length;
    }
    if (i < text.length) parent.append(text.slice(i));
  }

  // 『책 제목』 작가 · p.12
  function bookLine(it) {
    const au = authorOf(it.book_title);
    const title = it.book_title ? `『${it.book_title}』${au ? " " + au : ""}` : "";
    return [title, it.page ? `p.${it.page}` : ""].filter(Boolean).join(" · ");
  }

  // ---------- 오늘의 문장 ----------
  // 날짜로 고르기 때문에 같은 날에는 PC와 폰에서 같은 문장이 보여요. [다른 문장]으로 넘겨볼 수 있어요.
  const dayKey = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
  function renderToday() {
    const card = $("today-card");
    if (items.length === 0 || store.get("todayHidden", "") === dayKey()) { card.hidden = true; return; }
    const ordered = [...items].sort((a, b) => (a.created_at < b.created_at ? -1 : 1)); // 오래된 순(기기마다 같게)
    let h = 0;
    for (const ch of dayKey()) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    const it = ordered[(h + todayOffset) % ordered.length];
    card.hidden = false;
    card.dataset.id = it.id;
    paintBook(card, it.book_title);
    $("today-text").textContent = smartQuotes(it.content);
    $("today-book").textContent = bookLine(it);
    $("today-next").hidden = items.length < 2;
  }

  // ---------- 내보내기 ----------
  function exportName(ext) {
    const base = "문장수집창고" + (bookFilter ? "_" + bookFilter.replace(/[\\/:*?"<>|]/g, "") : "");
    return `${base}_${dayKey()}.${ext}`;
  }
  // 아이폰은 공유 시트(파일에 저장·보내기)로, 안 되면 바로 내려받기로
  async function shareOrDownload(name, type, body) {
    const file = new File([body], name, { type });
    try {
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: name });
        return;
      }
    } catch (err) {
      if (err && err.name === "AbortError") return; // 사용자가 공유를 닫음
    }
    // 내려받기는 일부 브라우저가 한글 파일 이름을 버려서, 영어 이름으로 (예: sentences_2026-11-02.csv)
    const ascii = "sentences" + (bookFilter ? "_book" : "") + "_" + dayKey() + name.slice(name.lastIndexOf("."));
    const url = URL.createObjectURL(file);
    const a = Object.assign(document.createElement("a"), { href: url, download: ascii });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }
  function exportText() {
    const blocks = lastShown.map((it) => {
      const head = [bookLine(it), fmtDate(it.created_at)].filter(Boolean).join(" · ");
      return [head, smartQuotes(it.content), it.memo ? `— ${smartQuotes(it.memo)}` : ""].filter(Boolean).join("\n");
    });
    shareOrDownload(exportName("txt"), "text/plain;charset=utf-8", blocks.join("\n\n") + "\n");
  }
  function exportCsv() {
    const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const rows = [["날짜", "책 제목", "작가", "페이지", "문장", "나의 생각"]]
      .concat(lastShown.map((it) => [fmtDate(it.created_at), it.book_title, authorOf(it.book_title), it.page, smartQuotes(it.content), it.memo && smartQuotes(it.memo)]));
    // 맨 앞 BOM: 엑셀에서 한글이 깨지지 않게
    shareOrDownload(exportName("csv"), "text/csv;charset=utf-8", "\uFEFF" + rows.map((r) => r.map(esc).join(",")).join("\r\n"));
  }

  function render() {
    assignBookColors();
    updateSwatch();
    const books = bookStats();
    if (bookFilter && !books.some(([t]) => t === bookFilter)) bookFilter = null;

    $("count-line").textContent = items.length
      ? `문장 ${items.length}개 · 책 ${books.length}권` + (notes.size ? ` · 감상문 ${notes.size}편` : "")
      : (notes.size ? `감상문 ${notes.size}편` : "첫 문장을 기다리고 있어요");

    // 작가 자동완성
    $("author-list").replaceChildren(...[...new Set(bookAuthor.values())].map((a) => Object.assign(document.createElement("option"), { value: a })));

    // 책별 보기 칩
    const chips = $("book-chips");
    chips.hidden = books.length === 0;
    const mkChip = (label, value, n) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = value ? "chip book" : "chip";
      if (value) paintBook(b, value);
      b.setAttribute("role", "tab");
      b.setAttribute("aria-selected", String(bookFilter === value));
      b.textContent = label;
      if (n != null) {
        const s = document.createElement("span");
        s.className = "n";
        s.textContent = n;
        b.append(s);
      }
      b.addEventListener("click", () => { bookFilter = value; render(); });
      return b;
    };
    chips.replaceChildren(mkChip("전체", null, items.length), ...books.map(([t, n]) => mkChip(t, t, n)));

    // 목록
    const q = query.trim().toLowerCase();
    const shown = items.filter((it) => {
      if (bookFilter && (it.book_title || "").trim() !== bookFilter) return false;
      if (!q) return true;
      return [it.content, it.book_title, authorOf(it.book_title), it.memo].some((s) => s && s.toLowerCase().includes(q));
    });

    const list = $("sentence-list");
    list.replaceChildren(...shown.map((it) => card(it, q)));
    $("empty-state").hidden = items.length > 0;
    $("no-result").hidden = items.length === 0 || shown.length > 0;
    lastShown = shown;
    renderToday();
    $("export-bar").hidden = shown.length === 0;
    $("export-count").textContent = (bookFilter || q) ? `지금 보이는 문장 ${shown.length}개` : `전체 문장 ${shown.length}개`;
    renderNotes();
    if (bookDialog.open) renderBook();
  }

  function card(it, q) {
    const li = document.createElement("li");
    li.className = "sentence";
    li.tabIndex = 0;
    li.dataset.id = it.id;
    paintBook(li, it.book_title);

    // 표지처럼 책 색으로 칠한 띠: 『책 제목』 · p.12 ……… 날짜
    const band = document.createElement("div");
    band.className = "sentence-band";
    const book = document.createElement("span");
    book.className = "sentence-book";
    if (it.book_title) {
      book.append("『");
      highlight(book, it.book_title, q);
      book.append("』");
      const au = authorOf(it.book_title);
      if (au) { const a = document.createElement("span"); a.className = "sentence-author"; highlight(a, au, q); book.append(" ", a); }
    }
    if (it.page) book.append(`${it.book_title ? " · " : ""}p.${it.page}`);
    const date = document.createElement("time");
    date.className = "sentence-date";
    date.dateTime = it.created_at;
    date.textContent = fmtDate(it.created_at);
    band.append(book, date);

    const body = document.createElement("div");
    body.className = "sentence-body";
    const p = document.createElement("p");
    p.className = "sentence-text";
    highlight(p, smartQuotes(it.content), q);
    body.append(p);
    if (it.memo) {
      const m = document.createElement("p");
      m.className = "sentence-memo";
      highlight(m, smartQuotes(it.memo), q);
      body.append(m);
    }

    li.append(band, body);
    li.addEventListener("click", () => openView(it.id, li, lastShown.map((x) => x.id)));
    li.addEventListener("keydown", (e) => { if (e.key === "Enter") openView(it.id, li, lastShown.map((x) => x.id)); });
    return li;
  }

  // ---------- 문장 담기 ----------

  const content = $("compose-content");
  const bookInput = $("compose-book");
  const pageInput = $("compose-page");
  // 책 제목 칸 옆 점: 적는 대로 그 책의 색을 보여줘요
  function updateSwatch() { paintBook($("compose-book-swatch"), $("compose-book").value); }
  bookInput.addEventListener("input", updateSwatch);
  const authorInput = $("compose-author");
  let authorAuto = true; // 작가 칸을 직접 고치기 전까지는 책에 맞춰 자동으로 채워요
  function fillAuthor() { if (authorAuto) authorInput.value = authorOf(bookInput.value); }
  bookInput.addEventListener("input", fillAuthor);
  authorInput.addEventListener("input", () => { authorAuto = authorInput.value.trim() === ""; });
  setTimeout(updateSwatch, 0);

  function updateToday() {
    const d = new Date();
    $("today-label").textContent = `오늘 · ${fmtDate(d)} (${WEEK[d.getDay()]})`;
  }
  updateToday();
  setInterval(updateToday, 60 * 1000);

  // 카메라 앱을 다녀오는 사이 앱이 새로고침돼도 쓰던 내용이 남도록
  content.addEventListener("input", () => store.set("draft", content.value));

  // 입력칸에 넣기: 둥근 따옴표로 바꾸고, 줄이 바뀐 자리(BRK)가 있으면 확인 패널을 띄워요
  function insertText(text) {
    text = smartQuotes(text);
    const cur = content.value;
    let at = 0;
    if (!cur.trim()) content.value = stripBreaks(text);
    else {
      const start = content.selectionStart ?? cur.length;
      const end = content.selectionEnd ?? cur.length;
      // 이미 쓴 글 뒤에 이어 붙일 때는 한 칸 띄워요
      const sep = start > 0 && !/\s$/.test(cur.slice(0, start)) ? " " : "";
      at = start + sep.length;
      content.value = cur.slice(0, start) + sep + stripBreaks(text) + cur.slice(end);
    }
    showBreaks(text, at);
    store.set("draft", content.value);
  }

  // ---------- 줄이 바뀐 자리 확인 ----------
  // 한글 책은 단어 중간에서도 줄이 바뀌어서, 사진에서 가져오면 "없 는"처럼 공백이 생길 수 있어요.
  // 줄이 바뀐 자리를 칩으로 보여주고, 누르면 그 자리만 붙이거나 다시 띄워요.
  const breaksBox = $("breaks");
  const breaksList = $("breaks-list");
  let breaks = [];
  const stripBreaks = (t) => t.split(BRK).join("");
  // 조사·어미로 자주 시작하는 글자: 이런 글자로 시작하면 단어가 이어졌을 가능성이 높아요
  const LIKELY = new Set([..."은는이가을를에의도와과로만께서며고다요니까지야랑던한할된될든게죠"]);

  function showBreaks(text, at) {
    breaks = [];
    let plainPos = at;
    const parts = text.split(BRK);
    for (let i = 0; i < parts.length - 1; i++) {
      plainPos += parts[i].length;
      const left = (parts[i].match(/(\S+)$/) || [])[1];
      const right = (parts[i + 1].match(/^\s(\S+)/) || [])[1];
      if (left && right) {
        const hangul = /[가-힣]$/.test(left) && /^[가-힣]/.test(right);
        breaks.push({ left, right, pos: plainPos, joined: false, likely: hangul && LIKELY.has(right[0]) });
      }
    }
    renderBreaks();
  }

  function renderBreaks() {
    breaksBox.hidden = breaks.length === 0;
    $("breaks-join-likely").hidden = !breaks.some((b) => b.likely && !b.joined);
    breaksList.replaceChildren(...breaks.map((b, i) => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "break-chip" + (b.likely ? " likely" : "");
      chip.setAttribute("aria-pressed", String(b.joined));
      chip.title = b.joined ? "다시 띄우기" : "붙여 쓰기";
      const l = document.createElement("span"); l.textContent = b.left.slice(-3);
      const gap = document.createElement("span"); gap.className = "gap"; gap.textContent = b.joined ? "" : "␣";
      const r = document.createElement("span"); r.textContent = b.right.slice(0, 3);
      chip.append(l, gap, r);
      chip.addEventListener("click", () => toggleBreak(i));
      return chip;
    }));
  }

  // 원래 자리 근처에서 "앞말 뒷말" ↔ "앞말뒷말"을 찾아 바꿔요 (그사이 글을 고쳤어도 가장 가까운 곳)
  function toggleBreak(i) {
    const b = breaks[i];
    const from = b.joined ? b.left + b.right : b.left + " " + b.right;
    const to = b.joined ? b.left + " " + b.right : b.left + b.right;
    const v = content.value;
    let best = -1, dist = Infinity;
    for (let k = v.indexOf(from); k >= 0; k = v.indexOf(from, k + 1)) {
      const d = Math.abs(k + b.left.length - b.pos);
      if (d < dist) { dist = d; best = k; }
    }
    if (best < 0) { toast("그 자리를 찾지 못했어요. 입력칸에서 직접 고쳐 주세요"); return; }
    content.value = v.slice(0, best) + to + v.slice(best + from.length);
    const delta = to.length - from.length;
    breaks.forEach((o) => { if (o.pos > b.pos) o.pos += delta; });
    b.joined = !b.joined;
    store.set("draft", content.value);
    renderBreaks();
  }

  function clearBreaks() { breaks = []; renderBreaks(); }
  $("breaks-close").addEventListener("click", clearBreaks);
  $("breaks-join-likely").addEventListener("click", () => {
    breaks.forEach((b, i) => { if (b.likely && !b.joined) toggleBreak(i); });
  });

  $("paste-btn").addEventListener("click", async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (!text || !text.trim()) { toast("복사된 문장이 없어요"); return; }
      insertText(text.trim());
      content.focus();
    } catch {
      content.focus();
      toast("입력칸을 길게 눌러 ‘붙여넣기’를 선택해 주세요");
    }
  });

  $("join-lines-btn").addEventListener("click", () => {
    if (!content.value.trim()) return;
    const marked = smartQuotes(joinLines(content.value, true));
    content.value = stripBreaks(marked);
    showBreaks(marked, 0);
    store.set("draft", content.value);
    toast("줄바꿈을 정리했어요");
  });

  content.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      $("compose").requestSubmit();
    }
  });

  $("compose").addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = smartQuotes(content.value.trim());
    if (!text) { content.focus(); return; }
    const book = bookInput.value.trim();
    const page = pageInput.value.trim();
    const btn = $("compose-submit");
    btn.disabled = true;
    const { data, error } = await sb
      .from("sentences")
      .insert({ content: text, book_title: book || null, page: page || null })
      .select()
      .single();
    btn.disabled = false;
    if (error) {
      toast("저장하지 못했어요. 인터넷 연결을 확인해 주세요.");
      return;
    }
    upsertLocal(data);
    if (book) setBookAuthor(book, authorInput.value); // 작가는 책마다 한 번만 저장
    store.set("lastBook", book);
    store.remove("draft");
    clearBreaks();
    content.value = "";
    pageInput.value = "";
    query = "";
    $("search").value = "";
    if (bookFilter && bookFilter !== book) bookFilter = null;
    render();
    toast("문장을 담았어요");
  });

  // ---------- 📷 사진에서 문장 가져오기 ----------
  // 사진은 이 기기 화면에만 잠깐 띄우고, 어디에도 올리거나 저장하지 않아요.

  const photoInputs = [$("camera-input"), $("retake-input")];
  const photoDialog = $("photo-dialog");
  const photoShell = $("photo-shell");
  const photoStage = $("photo-stage");
  const photoFrame = $("photo-frame");
  const photoImg = $("photo-img");
  const cropLayer = $("crop-layer");
  const cropBoxEl = $("crop-box");
  const cropReadBtn = $("crop-read");
  let photoFile = null;
  let photoUrl = null;
  let ocrBusy = false;
  let cropBox = null; // 사진 기준 비율 좌표 { x, y, w, h } (0~1)

  // 📷·다시 찍기 버튼 위에는 투명한 사진 선택칸이 겹쳐 있어서, 누르면 기기가 직접 카메라를 열어요.
  // (아이폰 홈 화면 앱은 스크립트나 label 로 여는 방식을 막을 때가 있어요)

  function onPhotoPicked(e) {
    const input = e.target;
    const file = input.files && input.files[0];
    input.value = ""; // 같은 사진을 다시 골라도 change 가 일어나도록
    if (!file) return;
    photoFile = file;
    if (photoUrl) URL.revokeObjectURL(photoUrl);
    photoUrl = URL.createObjectURL(file);
    photoImg.src = photoUrl;
    setMode("view");
    setOcrProgress(null);
    if (!photoDialog.open) photoDialog.showModal();
  }
  for (const input of photoInputs) input.addEventListener("change", onPhotoPicked);

  // 사진을 화면 안에 꽉 차게 맞추고, 틀(frame)을 사진 크기와 똑같이 맞춰요
  function fitFrame() {
    if (!photoImg.naturalWidth) return;
    const sw = photoStage.clientWidth, sh = photoStage.clientHeight;
    const scale = Math.min(sw / photoImg.naturalWidth, sh / photoImg.naturalHeight);
    photoFrame.style.width = Math.floor(photoImg.naturalWidth * scale) + "px";
    photoFrame.style.height = Math.floor(photoImg.naturalHeight * scale) + "px";
    drawCropBox();
  }
  photoImg.addEventListener("load", fitFrame);
  window.addEventListener("resize", () => { if (photoDialog.open) fitFrame(); });

  function setMode(mode) {
    photoShell.dataset.mode = mode;
    if (mode === "view") setCropBox(null);
    setOcrProgress(null);
  }

  function closePhoto() {
    if (photoDialog.open) photoDialog.close();
  }
  photoDialog.addEventListener("close", () => {
    photoImg.removeAttribute("src");
    photoFrame.style.width = photoFrame.style.height = "";
    if (photoUrl) URL.revokeObjectURL(photoUrl);
    photoUrl = null;
    photoFile = null;
    setMode("view");
  });
  $("photo-close").addEventListener("click", closePhoto);

  $("photo-paste").addEventListener("click", async () => {
    let text = "";
    try { text = await navigator.clipboard.readText(); } catch { text = null; }
    closePhoto();
    if (text === null) {
      content.focus();
      toast("입력칸을 길게 눌러 ‘붙여넣기’를 선택해 주세요");
      return;
    }
    if (!text.trim()) { toast("먼저 사진 속 문장을 골라 복사해 주세요"); return; }
    insertText(text.trim());
    content.focus();
  });

  // p: 0~1 진행률, "busy"는 진행률을 모를 때(움직이는 막대), null 은 숨기기
  function setOcrProgress(p, label) {
    const box = $("ocr-progress");
    if (p == null) { box.hidden = true; return; }
    box.hidden = false;
    const busy = p === "busy";
    box.querySelector(".ocr-bar").classList.toggle("indeterminate", busy);
    $("ocr-bar-fill").style.width = busy ? "" : Math.round(p * 100) + "%";
    $("ocr-label").textContent = label || "";
  }

  // ---------- ✂︎ 범위 선택 ----------

  $("photo-ocr").addEventListener("click", () => setMode("crop"));
  $("crop-cancel").addEventListener("click", () => setMode("view"));

  function setCropBox(box) {
    cropBox = box;
    cropReadBtn.disabled = !box || ocrBusy;
    drawCropBox();
  }
  function drawCropBox() {
    cropLayer.classList.toggle("has-box", !!cropBox);
    cropBoxEl.hidden = !cropBox;
    if (!cropBox) return;
    Object.assign(cropBoxEl.style, {
      left: cropBox.x * 100 + "%",
      top: cropBox.y * 100 + "%",
      width: cropBox.w * 100 + "%",
      height: cropBox.h * 100 + "%",
    });
  }

  const clamp01 = (v) => Math.min(1, Math.max(0, v));
  let drag = null;

  function pointFromEvent(e) {
    const r = cropLayer.getBoundingClientRect();
    return { x: clamp01((e.clientX - r.left) / r.width), y: clamp01((e.clientY - r.top) / r.height), r };
  }

  cropLayer.addEventListener("pointerdown", (e) => {
    if (ocrBusy) return;
    e.preventDefault();
    const pt = pointFromEvent(e);
    const handle = e.target.closest(".crop-handle");
    if (handle && cropBox) {
      // 모서리를 잡으면: 반대쪽 모서리를 고정하고 크기 조절
      const h = handle.dataset.h;
      const fx = h.includes("w") ? cropBox.x + cropBox.w : cropBox.x;
      const fy = h.includes("n") ? cropBox.y + cropBox.h : cropBox.y;
      drag = { type: "draw", ax: fx, ay: fy };
    } else if (cropBox && e.target.closest(".crop-box")) {
      drag = { type: "move", sx: pt.x, sy: pt.y, box: { ...cropBox } };
    } else {
      drag = { type: "draw", ax: pt.x, ay: pt.y };
      setCropBox({ x: pt.x, y: pt.y, w: 0, h: 0 });
    }
    cropLayer.setPointerCapture(e.pointerId);
  });

  cropLayer.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const pt = pointFromEvent(e);
    if (drag.type === "move") {
      const b = drag.box;
      const x = Math.min(1 - b.w, Math.max(0, b.x + pt.x - drag.sx));
      const y = Math.min(1 - b.h, Math.max(0, b.y + pt.y - drag.sy));
      setCropBox({ ...b, x, y });
    } else {
      setCropBox({
        x: Math.min(drag.ax, pt.x),
        y: Math.min(drag.ay, pt.y),
        w: Math.abs(pt.x - drag.ax),
        h: Math.abs(pt.y - drag.ay),
      });
    }
  });

  function endDrag(e) {
    if (!drag) return;
    drag = null;
    try { cropLayer.releasePointerCapture(e.pointerId); } catch { /* 무시 */ }
    // 너무 작은 상자(그냥 톡 누른 것)는 지워요
    const r = cropLayer.getBoundingClientRect();
    if (cropBox && (cropBox.w * r.width < 16 || cropBox.h * r.height < 10)) setCropBox(null);
  }
  cropLayer.addEventListener("pointerup", endDrag);
  cropLayer.addEventListener("pointercancel", endDrag);

  // ---------- 글자 인식 (구글 Cloud Vision) ----------
  // 고른 부분과 주변 여백만 잘라서 Supabase 중간 서버("ocr" 함수)로 보내고,
  // 중간 서버가 비밀 키로 구글 Cloud Vision 에 읽기를 맡겨요. 키는 앱 코드에 없어요.

  // 상자에 여백을 붙여 원본 사진에서 잘라요. 가장자리 단어도 문맥 있게 읽히도록.
  async function cropForCloud(file, box) {
    const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
    const mx = box.w * 0.06;
    const my = Math.max(box.h * 0.25, 0.02);
    const crop = {
      x: Math.max(0, box.x - mx),
      y: Math.max(0, box.y - my),
    };
    crop.w = Math.min(1, box.x + box.w + mx) - crop.x;
    crop.h = Math.min(1, box.y + box.h + my) - crop.y;
    const sx = crop.x * bmp.width, sy = crop.y * bmp.height;
    const sw = crop.w * bmp.width, sh = crop.h * bmp.height;
    const scale = Math.min(1, 2000 / Math.max(sw, sh)); // 긴 변 최대 2000px
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(sw * scale));
    canvas.height = Math.max(1, Math.round(sh * scale));
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bmp, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    if (bmp.close) bmp.close();
    const image = canvas.toDataURL("image/jpeg", 0.9).split(",")[1];
    return { image, crop, cw: canvas.width, ch: canvas.height };
  }

  // 중간 서버가 돌려준 줄·단어(잘라낸 사진의 픽셀 좌표)를 사진 전체 기준 비율 좌표로 바꿔요
  function toPhotoLines(lines, crop, cw, ch) {
    return lines.map((ws) => {
      const words = ws.map((w) => ({
        text: w.t,
        sp: w.sp,
        cx: crop.x + ((w.x0 + w.x1) / 2 / cw) * crop.w,
        cy: crop.y + ((w.y0 + w.y1) / 2 / ch) * crop.h,
      }));
      return { words, cy: words.reduce((a, w) => a + w.cy, 0) / words.length };
    });
  }

  // 상자 안에 중심이 들어온 단어만 모아요. 띄어쓰기는 구글이 알려준 대로.
  // 기울어진 사진에서 위아래 줄 끝 몇 단어가 상자 모서리에 걸리는데,
  // 줄 전체의 중심이 상자 밖이면 그 줄은 빼요.
  // 줄이 바뀌는 곳: 줄 끝 단어에 띄어쓰기 표시가 없으면(단어 중간에서 줄이 바뀐 것) 붙여 써요.
  function wordsInBox(lines, box) {
    const inY = (y) => y >= box.y && y <= box.y + box.h;
    const inX = (x) => x >= box.x && x <= box.x + box.w;
    let text = "";
    for (const line of lines) {
      if (!inY(line.cy)) continue;
      const ws = line.words.filter((w) => inX(w.cx) && inY(w.cy));
      if (!ws.length) continue;
      ws.forEach((w, i) => {
        const last = i === ws.length - 1;
        const cutByBox = last && w !== line.words[line.words.length - 1];
        const lineEnd = last; // 이 줄(또는 상자에 잘린 줄)의 마지막 단어
        if (lineEnd && (w.sp || cutByBox)) text += w.text + BRK + " ";
        else text += w.text + (w.sp ? " " : "");
      });
    }
    return text.replace(new RegExp(BRK + " $"), "").trim();
  }

  function cleanOcrText(text) {
    return joinLines(
      text
        .replace(/[|¦]/g, "")                      // 줄·테두리를 글자로 잘못 읽은 것
        .replace(/[ \t]+([.,!?…」』”’)])/g, "$1"), // 문장부호 앞의 불필요한 공백
      true
    );
  }

  // 중간 서버 오류를 알기 쉬운 말로
  async function cloudErrorText(error) {
    if (!navigator.onLine) return "글자 인식은 인터넷 연결이 필요해요.";
    const res = error && error.context;
    let body = null;
    if (res && typeof res.json === "function") { try { body = await res.clone().json(); } catch { /* 무시 */ } }
    const status = res && res.status;
    if (status === 404) return "아직 구글 인식이 연결되지 않았어요. (Supabase에 ocr 함수 배포 필요)";
    if (status === 401) return "로그인이 풀렸어요. 다시 로그인해 주세요.";
    if (status === 429 || (body && body.error === "daily_limit")) {
      const n = (body && body.limit) || 30;
      return `오늘 인식 한도(${n}회)를 다 썼어요. 내일 다시 쓸 수 있어요. 오늘은 사진 속 글자를 길게 눌러 골라주세요.`;
    }
    if (body && body.error === "usage_not_ready") return "사용량 표가 아직 없어요. (Supabase에서 schema.sql 실행 필요)";
    if (body && body.error === "no_key") return "구글 API 키가 아직 설정되지 않았어요. (Supabase Secrets 확인)";
    if (body && body.message) return "글자 인식에 실패했어요: " + body.message;
    return "글자 인식에 실패했어요. 잠시 후 다시 시도해 주세요.";
  }

  cropReadBtn.addEventListener("click", async () => {
    if (ocrBusy || !photoFile || !cropBox) return;
    ocrBusy = true;
    cropReadBtn.disabled = true;
    const file = photoFile;
    const box = { ...cropBox };
    try {
      setOcrProgress("busy", "구글로 글자를 읽는 중…");
      const { image, crop, cw, ch } = await cropForCloud(file, box);
      const { data, error } = await sb.functions.invoke("ocr", { body: { image } });
      if (photoFile !== file) return; // 그새 다시 찍었거나 창을 닫았으면 무시
      if (error) { setOcrProgress(1, await cloudErrorText(error)); return; }
      const text = cleanOcrText(wordsInBox(toPhotoLines(data.lines || [], crop, cw, ch), box));
      if (!text) {
        setOcrProgress(1, "상자 안에서 글자를 찾지 못했어요. 상자를 조금 넓혀 보세요.");
        return;
      }
      closePhoto();
      insertText(text);
      content.focus();
      const left = typeof data.remaining === "number" && data.remaining <= 10 ? ` (오늘 남은 인식 ${data.remaining}회)` : "";
      toast("골라낸 문장을 넣었어요. 틀린 글자는 고쳐주세요" + left);
    } catch (err) {
      console.error(err);
      if (photoFile === file) setOcrProgress(1, await cloudErrorText(null));
    } finally {
      ocrBusy = false;
      cropReadBtn.disabled = !cropBox;
    }
  });

  // ---------- 책 제목 추천 ----------
  // 책 제목 칸에 몇 글자만 쳐도 예전에 쓴 책을 작가와 함께 보여주고, 고르면 작가도 채워요.
  // 한글은 치는 도중에 글자가 바뀌어서("쓰" → "쓱" → "쓰가") 그 중간 모양으로도 맞춰요.
  const HBASE = 0xac00;
  const CHO = "ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ";
  const JONG = ["", "ㄱ", "ㄲ", "ㄳ", "ㄴ", "ㄵ", "ㄶ", "ㄷ", "ㄹ", "ㄺ", "ㄻ", "ㄼ", "ㄽ", "ㄾ", "ㄿ", "ㅀ", "ㅁ", "ㅂ", "ㅄ", "ㅅ", "ㅆ", "ㅇ", "ㅈ", "ㅊ", "ㅋ", "ㅌ", "ㅍ", "ㅎ"];
  // 겹받침: [남는 받침, 다음 글자로 넘어가는 자음]
  const JONG_SPLIT = { "ㄳ": ["ㄱ", "ㅅ"], "ㄵ": ["ㄴ", "ㅈ"], "ㄶ": ["ㄴ", "ㅎ"], "ㄺ": ["ㄹ", "ㄱ"], "ㄻ": ["ㄹ", "ㅁ"], "ㄼ": ["ㄹ", "ㅂ"], "ㄽ": ["ㄹ", "ㅅ"], "ㄾ": ["ㄹ", "ㅌ"], "ㄿ": ["ㄹ", "ㅍ"], "ㅀ": ["ㄹ", "ㅎ"], "ㅄ": ["ㅂ", "ㅅ"] };
  function hsplit(ch) {
    const c = (ch || "").charCodeAt(0) - HBASE;
    if (!(c >= 0 && c <= 11171)) return null;
    return { cho: Math.floor(c / 588), jung: Math.floor((c % 588) / 28), jong: c % 28 };
  }
  const initialsOf = (s) => [...s].map((ch) => { const h = hsplit(ch); return h ? CHO[h.cho] : ch; }).join("");
  const isCho = (ch) => CHO.includes(ch);

  // 제목이 입력으로 시작하는지: 0 그대로 시작, 1 치는 중인 마지막 글자까지 맞음, 2 초성으로 맞음, -1 아님
  function prefixScore(t, q) {
    if (t.startsWith(q)) return 0;
    const head = q.slice(0, -1), last = q.slice(-1);
    if (t.startsWith(head)) {
      const h = hsplit(last), th = hsplit(t.charAt(head.length));
      if (h && th && th.cho === h.cho && th.jung === h.jung) {
        if (h.jong === 0) return 1; // "쓰" → "쓸쓸한"
        const J = JONG[h.jong];
        if (JONG[th.jong] && JONG_SPLIT[JONG[th.jong]] && JONG_SPLIT[JONG[th.jong]][0] === J) return 1; // "일" → "읽기"
        const [keep, move] = JONG_SPLIT[J] || ["", J];
        if (th.jong === JONG.indexOf(keep)) { // "쓱" → "쓰가루", "읽" → "일곱"
          const nx = hsplit(t.charAt(head.length + 1));
          if (nx && CHO[nx.cho] === move) return 1;
        }
      }
      if (isCho(last)) { const th2 = hsplit(t.charAt(head.length)); if (th2 && CHO[th2.cho] === last) return 1; } // "쓰ㄱ"
    }
    if ([...q].every(isCho) && initialsOf(t).startsWith(q)) return 2; // "ㅆㄱ"
    return -1;
  }
  function matchScore(title, author, q) {
    const t = title.toLowerCase();
    const p = prefixScore(t, q);
    if (p >= 0) return p;
    if (t.includes(q)) return 3;
    // 작가 이름: 앞부분이 맞거나, 두 글자 이상이 들어 있으면 ("무" 한 글자로 "오사무"까지 나오지 않게)
    const a = (author || "").toLowerCase();
    if (a && (a.startsWith(q) || prefixScore(a, q) >= 0 || (q.length >= 2 && a.includes(q)))) return 4;
    return -1;
  }
  // 고를 수 있는 책: 최근에 문장을 쓴 순서, 그 뒤에 감상문·작가만 있는 책
  function bookCandidates() {
    const counts = new Map(bookStats());
    const titles = [...counts.keys()];
    for (const t of [...notes.keys(), ...bookAuthor.keys()]) if (t && !counts.has(t) && !titles.includes(t)) titles.push(t);
    return titles.map((t, i) => ({ t, au: authorOf(t), n: counts.get(t) || 0, i }));
  }

  let suggestSeq = 0;
  // next(c): 고른 뒤 옮겨 갈 칸 (없으면 그대로)
  function attachBookSuggest(input, authorInput, { onPick = () => {}, next = () => null } = {}) {
    input.removeAttribute("list");
    const id = "book-suggest-" + (++suggestSeq);
    const anchor = document.createElement("div");
    anchor.className = "suggest-anchor";
    const ul = document.createElement("ul");
    ul.className = "suggest";
    ul.id = id;
    ul.setAttribute("role", "listbox");
    ul.setAttribute("aria-label", "책 제목 추천");
    ul.hidden = true;
    anchor.append(ul);
    (input.closest("label") || input).after(anchor);
    input.setAttribute("role", "combobox");
    input.setAttribute("aria-autocomplete", "list");
    input.setAttribute("aria-controls", id);
    input.setAttribute("aria-expanded", "false");
    let shown = [], active = -1, blurTimer = null;

    const close = () => {
      ul.hidden = true; shown = []; active = -1;
      input.setAttribute("aria-expanded", "false");
      input.removeAttribute("aria-activedescendant");
    };
    const setActive = (k) => {
      active = k;
      [...ul.children].forEach((li, j) => li.setAttribute("aria-selected", String(j === k)));
      if (k >= 0) input.setAttribute("aria-activedescendant", `${id}-${k}`); else input.removeAttribute("aria-activedescendant");
    };
    const row = (c, k, q) => {
      const li = document.createElement("li");
      li.id = `${id}-${k}`;
      li.className = "suggest-item";
      li.setAttribute("role", "option");
      li.setAttribute("aria-selected", "false");
      li.dataset.k = k;
      const dot = document.createElement("i");
      dot.className = "suggest-dot";
      const col = bookColor(c.t);
      if (col) dot.style.background = col.bg;
      const title = document.createElement("span");
      title.className = "suggest-title";
      // 앞부분이 그대로 맞으면 맞은 부분을 굵게
      if (q && c.t.toLowerCase().startsWith(q)) {
        const b = document.createElement("b");
        b.textContent = c.t.slice(0, q.length);
        title.append("『", b, c.t.slice(q.length), "』");
      } else title.textContent = `『${c.t}』`;
      const au = document.createElement("span");
      au.className = "suggest-author";
      au.textContent = c.au || "";
      li.append(dot, title, au);
      if (c.n) { const n = document.createElement("span"); n.className = "suggest-n"; n.textContent = `문장 ${c.n}`; li.append(n); }
      return li;
    };
    const update = () => {
      clearTimeout(blurTimer);
      const raw = input.value.trim();
      const q = raw.toLowerCase();
      const cands = bookCandidates();
      let list;
      if (!q) list = cands.slice(0, 5);
      else if (cands.some((c) => c.t === raw)) list = []; // 이미 정확히 맞으면 닫기
      else {
        list = cands.map((c) => ({ ...c, s: matchScore(c.t, c.au, q) }))
          .filter((c) => c.s >= 0)
          .sort((a, b) => a.s - b.s || a.i - b.i)
          .slice(0, 6);
      }
      if (!list.length) { close(); return; }
      shown = list;
      ul.replaceChildren(...list.map((c, k) => row(c, k, q)));
      setActive(-1);
      ul.hidden = false;
      input.setAttribute("aria-expanded", "true");
      reveal();
    };
    // 아이폰 키보드나 아래 탭바에 목록이 가리면, 입력칸이 위로 올라가도록 조금 스크롤해요
    const reveal = () => requestAnimationFrame(() => {
      if (ul.hidden) return;
      const vv = window.visualViewport;
      const top = vv ? vv.offsetTop : 0;
      let limit = (vv ? vv.offsetTop + vv.height : window.innerHeight) - 8;
      const bar = $("tabbar");
      if (bar && !bar.hidden && !input.closest("dialog")) limit = Math.min(limit, bar.getBoundingClientRect().top - 8);
      const over = ul.getBoundingClientRect().bottom - limit;
      const room = input.getBoundingClientRect().top - top - 12; // 입력칸이 화면 위로 넘어가지 않을 만큼만
      const delta = Math.min(over, room);
      if (delta <= 0) return;
      const box = input.closest(".full-scroll, dialog");
      if (box && box.scrollHeight > box.clientHeight) box.scrollTop += delta;
      else window.scrollBy(0, delta);
    });
    if (window.visualViewport) window.visualViewport.addEventListener("resize", reveal);
    const pick = (c) => {
      input.value = c.t;
      if (c.au && authorInput) authorInput.value = c.au; // 고른 책의 작가로 채워요
      close();
      input.dispatchEvent(new Event("input", { bubbles: true })); // 책 색 점·자동 채우기 갱신
      close();
      onPick(c);
      const nx = next(c);
      if (nx) nx.focus();
    };

    input.addEventListener("input", update);
    input.addEventListener("compositionend", update);
    input.addEventListener("focus", update);
    input.addEventListener("blur", () => { blurTimer = setTimeout(close, 150); });
    ul.addEventListener("pointerdown", (e) => e.preventDefault()); // 누르는 동안 입력칸이 포커스를 잃지 않게
    ul.addEventListener("mousedown", (e) => e.preventDefault());
    ul.addEventListener("click", (e) => {
      const li = e.target.closest(".suggest-item");
      if (li && shown[+li.dataset.k]) pick(shown[+li.dataset.k]);
    });
    input.addEventListener("keydown", (e) => {
      if (ul.hidden || e.isComposing) return;
      if (e.key === "ArrowDown") { e.preventDefault(); setActive((active + 1) % shown.length); }
      else if (e.key === "ArrowUp") { e.preventDefault(); setActive(active <= 0 ? shown.length - 1 : active - 1); }
      else if (e.key === "Enter" && active >= 0) { e.preventDefault(); pick(shown[active]); }
      else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
    });
    return { close, update };
  }

  // ---------- 화면 전체 창: 열기·닫기 애니메이션, 아래로 쓸어 닫기 ----------
  // 누른 카드 자리에서 화면 전체로 펼쳐지고, 닫을 때는 아래로 내려가요.
  const reducedMotion = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : { matches: false };
  const EASE_OUT = "cubic-bezier(.2,.8,.2,1)";
  const canAnimate = (el) => !reducedMotion.matches && typeof el.animate === "function";

  function openFull(dlg, fromEl) {
    dlg.getAnimations && dlg.getAnimations().forEach((a) => a.cancel());
    delete dlg.dataset.closing;
    dlg.style.transform = "";
    if (!dlg.open) dlg.showModal();
    dlg.querySelectorAll(".full-scroll").forEach((el) => { el.scrollTop = 0; }); // 긴 글도 처음부터
    if (!canAnimate(dlg)) return;
    const W = window.innerWidth, H = dlg.clientHeight || window.innerHeight;
    let from = `inset(${H * 0.35}px 8% ${H * 0.35}px 8% round 14px)`;
    if (fromEl) {
      const r = fromEl.getBoundingClientRect();
      const top = Math.min(Math.max(0, r.top), H - 40), bottom = Math.min(Math.max(0, H - r.bottom), H - top - 40);
      from = `inset(${top}px ${Math.max(0, W - r.right)}px ${bottom}px ${Math.max(0, r.left)}px round 14px)`;
    }
    dlg.animate([{ clipPath: from }, { clipPath: "inset(0px 0px 0px 0px round 0px)" }], { duration: 340, easing: EASE_OUT });
    const content = dlg.querySelector(".is-current .full-content") || dlg.querySelector(".full-content");
    if (content) content.animate([{ opacity: 0, transform: "translateY(14px)" }, { opacity: 1, transform: "none" }],
      { duration: 300, delay: 70, easing: EASE_OUT, fill: "backwards" });
  }

  // from: 손가락으로 이미 끌어내린 거리(px). 거기서부터 마저 내려가요.
  function closeFull(dlg, { instant = false, from = 0 } = {}) {
    if (!dlg.open || dlg.dataset.closing) return;
    const finish = () => {
      dlg.close();
      dlg.style.transform = "";
      dlg.getAnimations && dlg.getAnimations().forEach((a) => a.cancel());
      delete dlg.dataset.closing;
    };
    if (instant || !canAnimate(dlg)) { finish(); return; }
    dlg.dataset.closing = "1";
    const H = dlg.clientHeight || window.innerHeight;
    const left = Math.max(0, 1 - from / H);
    const anim = dlg.animate([{ transform: `translateY(${from}px)` }, { transform: `translateY(${H}px)` }],
      { duration: Math.max(140, 280 * left), easing: "cubic-bezier(.3,0,.8,.4)", fill: "forwards" });
    anim.onfinish = finish;
    anim.oncancel = () => delete dlg.dataset.closing;
  }

  // 위에서 아래로 쓸어내리면 닫혀요. 글이 길어 스크롤을 내린 상태에서는 먼저 스크롤이 올라가요.
  // side 가 있으면 옆으로 끌기를 넘겨줘요: begin() 손을 댈 때, canSide(+1|-1) 넘길 곳이 있는지,
  // move(dx) 끄는 중, end(dx, vel) 손을 뗄 때.
  function attachSwipe(dlg, onClose, side = null) {
    const findScroller = () => dlg.querySelector(".is-current .full-scroll") || dlg.querySelector(".full-scroll");
    let scroller = findScroller();
    let startY = null, startX = 0, dy = 0, dx = 0, mode = null, decided = false, lastY = 0, lastX = 0, lastT = 0, vel = 0, fromScroller = false;
    const selecting = () => { const s = window.getSelection && window.getSelection(); return !!s && !s.isCollapsed; };
    const begin = (x, y, target) => {
      if (dlg.dataset.closing || target.closest("textarea, input, select")) { startY = null; return; }
      if (side && side.begin) side.begin();
      scroller = findScroller();
      startY = y; startX = x; dy = 0; dx = 0; mode = null; decided = false; vel = 0;
      lastY = y; lastX = x; lastT = performance.now();
      fromScroller = scroller.contains(target);
    };
    const move = (x, y, e) => {
      if (startY === null) return;
      if (!decided) {
        const ddy = y - startY, ddx = x - startX;
        if (Math.abs(ddy) < 3 && Math.abs(ddx) < 3) return;
        decided = true;
        const atTop = !fromScroller || scroller.scrollTop <= 0;
        if (selecting()) { startY = null; return; }
        if (side && Math.abs(ddx) > Math.abs(ddy)) { mode = "side"; startX = x; }
        else if (ddy > 0 && Math.abs(ddy) >= Math.abs(ddx) && atTop) { mode = "down"; startY = y; }
        else { startY = null; return; }
      }
      if (!mode) return;
      if (e.cancelable) e.preventDefault(); // 화면이 대신 스크롤되지 않게
      const now = performance.now(), dt = Math.max(1, now - lastT);
      if (mode === "down") {
        vel = (y - lastY) / dt;
        dy = Math.max(0, y - startY);
        dlg.style.transform = `translateY(${dy}px)`;
      } else {
        // 속도는 최근 움직임에 무게를 두고 부드럽게
        vel = vel * 0.4 + ((x - lastX) / dt) * 0.6;
        const raw = x - startX;
        dx = side.canSide(raw < 0 ? 1 : -1) ? raw : raw * 0.3; // 넘길 문장이 없는 쪽은 고무줄처럼
        side.move(dx);
      }
      lastY = y; lastX = x; lastT = now;
    };
    const end = () => {
      if (startY === null) return;
      const m = mode;
      startY = null; mode = null;
      // 손을 멈췄다가 떼면 속도는 0
      if (performance.now() - lastT > 80) vel = 0;
      if (m === "down") {
        if (dy > 110 || (vel > 0.5 && dy > 20)) {
          onClose(dy);
          if (dlg.open && !dlg.dataset.closing) snapBack(); // 닫지 않기로 했으면(저장 안 한 글) 제자리로
        } else snapBack();
      } else if (m === "side") side.end(dx, vel);
    };
    const snapBack = () => {
      const at = dy;
      dlg.style.transform = "";
      if (at > 0 && canAnimate(dlg)) dlg.animate([{ transform: `translateY(${at}px)` }, { transform: "translateY(0)" }], { duration: 200, easing: EASE_OUT });
    };
    dlg.addEventListener("touchstart", (e) => {
      if (e.touches.length !== 1) { startY = null; return; }
      begin(e.touches[0].clientX, e.touches[0].clientY, e.target);
    }, { passive: true });
    dlg.addEventListener("touchmove", (e) => {
      if (e.touches.length !== 1) return;
      move(e.touches[0].clientX, e.touches[0].clientY, e);
    }, { passive: false });
    dlg.addEventListener("touchend", end);
    dlg.addEventListener("touchcancel", end);
    // PC: 맨 위 손잡이를 마우스로 끌어내려도 닫혀요
    dlg.addEventListener("pointerdown", (e) => {
      if (e.pointerType !== "mouse" || e.button !== 0 || !e.target.closest(".grabber")) return;
      begin(e.clientX, e.clientY, e.target);
      const mv = (ev) => move(ev.clientX, ev.clientY, ev);
      const up = () => { window.removeEventListener("pointermove", mv); window.removeEventListener("pointerup", up); end(); };
      window.addEventListener("pointermove", mv);
      window.addEventListener("pointerup", up);
    });
    // Esc 키도 애니메이션으로 닫기
    dlg.addEventListener("cancel", (e) => { e.preventDefault(); onClose(0); });
  }

  // ---------- 문장 보기 ----------
  // 문장을 누르면 화면 전체로 크게 보여주고, [편집하기]를 눌러야 고치기 창이 열려요.
  // 앞·지금·뒤 세 장을 나란히 두고 손가락을 따라 함께 움직여서, 옆 문장이 이어 붙어 딸려 들어와요.
  // 왼쪽으로 밀면 다음(목록 아래 = 더 예전 문장), 오른쪽은 이전.
  const viewDialog = $("view-dialog");
  const viewTrack = $("view-track");
  let viewingId = null;
  let viewList = [];   // 넘길 문장 id 순서
  let viewIndex = 0;
  let slide = null;    // 진행 중인 넘김 { dir, anim }
  const PAGE_IDS = { band: "view-band", book: "view-book", date: "view-date", text: "view-text", memo: "view-memo" };
  const pageOf = (role) => viewTrack.querySelector(".page." + role);
  const itemAt = (i) => (i >= 0 && i < viewList.length ? items.find((x) => x.id === viewList[i]) || null : null);
  const pageGap = () => parseFloat(getComputedStyle(viewTrack.parentElement).getPropertyValue("--gap")) || 24;
  const pageStride = () => (viewTrack.clientWidth || window.innerWidth) + pageGap();

  function fillPage(page, it) {
    page.classList.toggle("empty", !it);
    if (!it) return;
    const q = (k) => page.querySelector(`[data-k="${k}"]`);
    const band = q("band");
    paintBook(band, it.book_title);
    const hasBook = !!(it.book_title || "").trim();
    band.classList.toggle("tappable", hasBook);
    if (hasBook) { band.setAttribute("role", "button"); band.tabIndex = 0; band.setAttribute("aria-label", `『${it.book_title}』 문장 모두 보기`); }
    else { band.removeAttribute("role"); band.removeAttribute("tabindex"); band.removeAttribute("aria-label"); }
    q("book").textContent = bookLine(it);
    q("date").textContent = fmtDate(it.created_at);
    q("date").dateTime = it.created_at;
    q("text").textContent = smartQuotes(it.content);
    const memo = q("memo");
    memo.hidden = !it.memo;
    memo.textContent = it.memo ? smartQuotes(it.memo) : "";
    paintBook(memo, it.book_title);
    page.querySelector(".full-scroll").scrollTop = 0;
  }
  // 지금 장에만 id 를 붙이고, 옆 장은 화면 읽기·탭 이동에서 빼요
  function markCurrent() {
    for (const page of viewTrack.querySelectorAll(".page")) {
      const cur = page.classList.contains("is-current");
      page.inert = !cur;
      page.setAttribute("aria-hidden", String(!cur));
      for (const [k, id] of Object.entries(PAGE_IDS)) {
        const el = page.querySelector(`[data-k="${k}"]`);
        if (cur) el.id = id; else if (el.id === id) el.removeAttribute("id");
      }
    }
  }
  function updateViewNav() {
    const n = viewList.length;
    viewingId = viewList[viewIndex] || null;
    $("view-nav").hidden = n < 2;
    $("view-pos").textContent = `${viewIndex + 1} / ${n}`;
    $("view-prev").disabled = viewIndex <= 0;
    $("view-next").disabled = viewIndex >= n - 1;
  }
  function fillView() {
    fillPage(pageOf("is-current"), itemAt(viewIndex));
    fillPage(pageOf("is-prev"), itemAt(viewIndex - 1));
    fillPage(pageOf("is-next"), itemAt(viewIndex + 1));
    markCurrent();
    updateViewNav();
  }
  function openView(id, fromEl, list) {
    const it = items.find((x) => x.id === id);
    if (!it) return;
    cancelSlide();
    viewList = (list && list.length ? list : items.map((x) => x.id)).filter((x) => items.some((y) => y.id === x));
    viewIndex = Math.max(0, viewList.indexOf(id));
    if (viewList[viewIndex] !== id) { viewList = [id]; viewIndex = 0; }
    fillView();
    openFull(viewDialog, fromEl);
  }
  const canStep = (d) => !!itemAt(viewIndex + d);

  // 넘김이 끝나면 장 역할만 돌리고(요소는 그대로) 새로 빈 옆 장을 채워요
  function settle(dir) {
    const prev = pageOf("is-prev"), cur = pageOf("is-current"), next = pageOf("is-next");
    const role = (el, r) => { el.classList.remove("is-prev", "is-current", "is-next"); el.classList.add(r); };
    if (dir > 0) { role(cur, "is-prev"); role(next, "is-current"); role(prev, "is-next"); }
    else { role(cur, "is-next"); role(prev, "is-current"); role(next, "is-prev"); }
    viewTrack.style.transform = "";
    viewIndex += dir;
    if (dir > 0) fillPage(pageOf("is-next"), itemAt(viewIndex + 1));
    else fillPage(pageOf("is-prev"), itemAt(viewIndex - 1));
    markCurrent();
    updateViewNav();
  }
  // 진행 중인 넘김을 그 자리에서 끝내요 (연달아 넘길 때)
  function finishSlide() {
    if (!slide) return;
    const s = slide; slide = null;
    s.anim.onfinish = null;
    s.anim.cancel();
    if (s.dir) settle(s.dir); else viewTrack.style.transform = "";
  }
  function cancelSlide() {
    if (slide) { slide.anim.onfinish = null; slide.anim.cancel(); slide = null; }
    viewTrack.style.transform = "";
  }
  function animateTrack(from, to, duration, easing, dir) {
    viewTrack.style.transform = `translateX(${to}px)`; // 끝난 모습을 먼저 정해 두고
    const anim = viewTrack.animate([{ transform: `translateX(${from}px)` }, { transform: `translateX(${to}px)` }], { duration, easing });
    slide = { dir, anim };
    anim.onfinish = finishSlide;
  }
  // dir 쪽으로 넘겨요. fromX: 이미 끌어 온 거리, vel: 손을 뗀 속도(px/ms)
  function slideTo(dir, fromX = 0, vel = 0) {
    finishSlide();
    if (!canStep(dir)) { snapTrack(fromX); return; }
    if (!canAnimate(viewTrack)) { viewTrack.style.transform = ""; settle(dir); return; }
    const target = -dir * pageStride();
    const remain = Math.abs(target - fromX);
    // 감속 곡선의 처음 기울기(약 4배)가 손을 뗀 속도와 이어지도록 시간을 정해요
    const v = Math.abs(vel);
    const duration = v > 0.05 ? Math.min(380, Math.max(200, (remain * 4) / v)) : 320;
    animateTrack(fromX, target, duration, "cubic-bezier(.22,.9,.3,1)", dir);
  }
  function snapTrack(fromX) {
    if (!fromX || !canAnimate(viewTrack)) { viewTrack.style.transform = ""; return; }
    animateTrack(fromX, 0, 240, EASE_OUT, 0);
  }
  const viewSide = {
    begin: finishSlide,
    canSide: canStep,
    move: (dx) => { viewTrack.style.transform = `translateX(${dx}px)`; },
    end: (dx, vel) => {
      const dir = dx < 0 ? 1 : -1;
      const W = viewTrack.clientWidth || window.innerWidth;
      const flick = Math.abs(vel) > 0.3 && Math.abs(dx) > 20 && Math.sign(vel) === Math.sign(dx);
      if (canStep(dir) && (Math.abs(dx) > W * 0.25 || flick)) slideTo(dir, dx, flick ? vel : 0);
      else snapTrack(dx);
    },
  };
  const closeView = (from = 0) => { finishSlide(); closeFull(viewDialog, { from }); };
  attachSwipe(viewDialog, closeView, viewSide);
  $("view-close").addEventListener("click", () => closeView());
  $("view-prev").addEventListener("click", () => slideTo(-1));
  $("view-next").addEventListener("click", () => slideTo(1));
  // 넘기면 포커스가 있던 장이 옆으로 빠지므로, 키보드는 문서 전체에서 받아요 (문장 창이 맨 위일 때만)
  document.addEventListener("keydown", (e) => {
    if (!viewDialog.open || [...document.querySelectorAll("dialog[open]")].some((d) => d !== viewDialog && d !== $("book-dialog"))) return;
    if (e.target.closest && e.target.closest("input, textarea, select")) return;
    if (e.key === "ArrowLeft") { e.preventDefault(); slideTo(-1); }
    else if (e.key === "ArrowRight") { e.preventDefault(); slideTo(1); }
  });
  $("view-edit").addEventListener("click", () => {
    finishSlide();
    const id = viewingId;
    closeFull(viewDialog, { instant: true });
    if (id) openEdit(id);
  });
  // 띠(책 제목)를 누르면 그 책의 문장을 모두 모은 책 페이지로
  function viewBandTap() {
    finishSlide();
    const it = items.find((x) => x.id === viewingId);
    const t = it && (it.book_title || "").trim();
    if (!t) return;
    if (bookDialog.open && bookTitle === t) { closeView(); return; } // 책 페이지에서 왔으면 돌아가기
    openBook(t, $("view-band"));
  }
  viewTrack.addEventListener("click", (e) => { if (e.target.closest(".is-current .sentence-band.tappable")) viewBandTap(); });
  viewTrack.addEventListener("keydown", (e) => {
    if ((e.key === "Enter" || e.key === " ") && e.target.closest(".is-current .sentence-band.tappable")) { e.preventDefault(); viewBandTap(); }
  });

  // ---------- 책 페이지: 한 책의 문장을 페이지 순으로 ----------
  const bookDialog = $("book-dialog");
  let bookTitle = null;
  const pageNum = (p) => { const m = String(p || "").match(/\d+/); return m ? parseInt(m[0], 10) : Infinity; };
  function bookItems(t) {
    return items.filter((x) => (x.book_title || "").trim() === t)
      .sort((a, b) => (pageNum(a.page) - pageNum(b.page)) || (a.created_at < b.created_at ? -1 : 1));
  }
  function openBook(t, fromEl) {
    bookTitle = t;
    if (viewDialog.open) closeFull(viewDialog, { instant: true });
    renderBook();
    openFull(bookDialog, fromEl);
  }
  const closeBook = (from = 0) => closeFull(bookDialog, { from });
  attachSwipe(bookDialog, closeBook);
  $("book-close").addEventListener("click", () => closeBook());

  function renderBook() {
    if (!bookTitle) return;
    const t = bookTitle;
    const list = bookItems(t);
    const note = notes.get(t);
    if (bookDialog.open && !list.length && !note) { closeBook(); return; }
    paintBook(bookDialog, t);
    const au = authorOf(t);
    $("book-cover-title").textContent = `『${t}』`;
    $("book-cover-author").textContent = au;
    $("book-cover-author").hidden = !au;
    const dates = list.map((x) => x.created_at).sort();
    const span = dates.length ? (fmtDate(dates[0]) === fmtDate(dates[dates.length - 1]) ? fmtDate(dates[0]) : `${fmtDate(dates[0])} – ${fmtDate(dates[dates.length - 1])}`) : "";
    $("book-cover-meta").textContent = [list.length ? `문장 ${list.length}개` : "아직 담은 문장이 없어요", span].filter(Boolean).join(" · ");
    // 감상문
    $("book-note-text").hidden = !(note && note.body);
    $("book-note-text").textContent = note && note.body ? note.body : "";
    $("book-note-date").hidden = !(note && note.finished_on);
    $("book-note-date").textContent = note && note.finished_on ? fmtDay(note.finished_on) + " 완독" : "";
    $("book-note-btn").textContent = note ? "감상문 보기" : "감상문 쓰기";
    $("book-note").classList.toggle("empty-note", !note);
    // 문장들
    const ids = list.map((x) => x.id);
    $("book-items").replaceChildren(...list.map((it) => {
      const li = document.createElement("li");
      li.className = "book-item";
      li.tabIndex = 0;
      li.dataset.id = it.id;
      const head = document.createElement("div");
      head.className = "book-item-head";
      head.textContent = [it.page ? `p.${it.page}` : "", fmtDate(it.created_at)].filter(Boolean).join(" · ");
      const p = document.createElement("p");
      p.className = "book-item-text";
      p.textContent = smartQuotes(it.content);
      li.append(head, p);
      if (it.memo) {
        const m = document.createElement("p");
        m.className = "sentence-memo";
        m.textContent = smartQuotes(it.memo);
        li.append(m);
      }
      li.addEventListener("click", () => openView(it.id, li, ids));
      li.addEventListener("keydown", (e) => { if (e.key === "Enter") openView(it.id, li, ids); });
      return li;
    }));
  }
  $("book-note-btn").addEventListener("click", () => { if (bookTitle) openNote(bookTitle, $("book-note")); });

  // ---------- 아래 탭바 ----------
  function setTab(name, { scroll = true } = {}) {
    activeTab = name === "notes" ? "notes" : "sentences";
    store.set("tab", activeTab);
    $("tab-sentences").hidden = activeTab !== "sentences";
    $("tab-notes").hidden = activeTab !== "notes";
    document.querySelectorAll(".tab-btn").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === activeTab)));
    if (scroll) window.scrollTo(0, 0);
  }
  document.querySelectorAll(".tab-btn").forEach((b) => b.addEventListener("click", () => setTab(b.dataset.tab)));

  // ---------- 감상문 ----------
  // 책마다 한 편. book_notes 표에 따로 저장하고(PC·아이폰 함께), 오늘의 문장·내보내기·검색에는 섞이지 않아요.
  function isMissingTable(error) { return /book_notes|schema cache|does not exist|relation/i.test((error && error.message) || ""); }
  function loadNoteRows(rows) {
    notes = new Map((rows || [])
      .filter((r) => r && typeof r.book_title === "string" && (r.body != null || r.finished_on != null))
      .map((r) => [r.book_title, { body: r.body || "", finished_on: r.finished_on || null, updated_at: r.updated_at || null }]));
  }
  function saveNotesCache() {
    if (user) store.set("notes:" + user.id, [...notes].map(([book_title, n]) => ({ book_title, ...n })));
  }
  function fmtDay(ymd) { const [y, m, d] = String(ymd).split("-"); return `${y}.${m}.${d}`; }

  function renderNotes() {
    const counts = new Map(bookStats());
    const written = [...notes.entries()]
      .sort((a, b) => ((b[1].updated_at || "") > (a[1].updated_at || "") ? 1 : -1))
      .map(([t]) => t);
    const unwritten = [...counts.entries()].filter(([t]) => !notes.has(t)).sort((a, b) => b[1] - a[1]).map(([t]) => t);
    const titles = [...written, ...unwritten];
    $("note-list").replaceChildren(...titles.map((t) => noteCard(t, counts.get(t) || 0)));
    $("notes-empty").hidden = titles.length > 0;
    $("notes-setup").hidden = !notesMissing;
  }

  function noteCard(title, count) {
    const n = notes.get(title);
    const li = document.createElement("li");
    li.className = "sentence note-card";
    li.tabIndex = 0;
    li.dataset.book = title;
    paintBook(li, title);
    const band = document.createElement("div");
    band.className = "sentence-band";
    const book = document.createElement("span");
    book.className = "sentence-book";
    book.append(`『${title}』`);
    const au = authorOf(title);
    if (au) { const a = document.createElement("span"); a.className = "sentence-author"; a.textContent = au; book.append(" ", a); }
    band.append(book);
    if (n && n.finished_on) {
      const d = document.createElement("time");
      d.className = "sentence-date";
      d.dateTime = n.finished_on;
      d.textContent = fmtDay(n.finished_on) + " 완독";
      band.append(d);
    }
    const body = document.createElement("div");
    body.className = "sentence-body";
    const p = document.createElement("p");
    p.className = "note-snippet";
    if (n && n.body) p.textContent = n.body;
    else { p.classList.add("placeholder"); p.textContent = "아직 감상문이 없어요 · 눌러서 쓰기"; }
    const foot = document.createElement("p");
    foot.className = "note-foot";
    foot.textContent = [count ? `문장 ${count}개` : "", n && n.updated_at ? `${fmtDate(n.updated_at)} 고침` : ""].filter(Boolean).join(" · ");
    body.append(p);
    if (foot.textContent) body.append(foot);
    li.append(band, body);
    li.addEventListener("click", () => openNote(title, li));
    li.addEventListener("keydown", (e) => { if (e.key === "Enter") openNote(title, li); });
    return li;
  }

  const noteDialog = $("note-dialog");
  let noteTitle = null;     // 고르고 연 책 (새 책이면 null)
  let noteSnapshot = "";    // 연 순간의 내용 (바뀌었는지 비교)
  const noteDraftKey = () => "noteDraft:" + (noteTitle || "");
  const noteState = () => JSON.stringify([$("note-title").value.trim(), $("note-author").value.trim(), $("note-finished").value, $("note-body").value]);
  function currentNoteTitle() { return noteTitle || $("note-title").value.trim(); }
  function paintNoteBand() {
    const t = currentNoteTitle();
    const au = noteTitle ? authorOf(noteTitle) : ($("note-author").value.trim() || authorOf(t));
    paintBook($("note-band"), t);
    $("note-book").textContent = t ? `『${t}』${au ? " " + au : ""}` : "새 감상문";
  }
  function openNote(title, fromEl) {
    noteTitle = title || null;
    const n = noteTitle ? notes.get(noteTitle) : null;
    $("note-new-fields").hidden = !!noteTitle;
    $("note-title").value = "";
    $("note-author").value = "";
    $("note-finished").value = (n && n.finished_on) || "";
    $("note-body").value = (n && n.body) || "";
    $("note-delete").hidden = !n;
    $("note-meta").textContent = n && n.updated_at ? fmtLongDate(new Date(n.updated_at)) + "에 고침" : "";
    noteSnapshot = noteState();
    // 쓰다 만 글이 있으면 이어서
    const draft = store.get(noteDraftKey(), null);
    if (Array.isArray(draft) && JSON.stringify(draft) !== noteSnapshot) {
      [$("note-title").value, $("note-author").value, $("note-finished").value, $("note-body").value] = draft;
      setTimeout(() => toast("쓰다 만 글을 불러왔어요"), 350);
    }
    paintNoteBand();
    openFull(noteDialog, fromEl);
  }
  function closeNote(from = 0) {
    if (noteState() !== noteSnapshot) {
      if (!confirm("저장하지 않고 닫을까요? 쓰던 글은 사라져요.")) return;
      store.remove(noteDraftKey());
    }
    closeFull(noteDialog, { from });
  }
  attachSwipe(noteDialog, closeNote);
  $("note-close").addEventListener("click", () => closeNote());
  $("note-new").addEventListener("click", () => openNote(null, $("note-new")));
  $("note-title").addEventListener("input", paintNoteBand);
  $("note-author").addEventListener("input", paintNoteBand);
  $("note-form").addEventListener("input", () => {
    const s = noteState();
    if (s === noteSnapshot) store.remove(noteDraftKey()); else store.set(noteDraftKey(), JSON.parse(s));
  });

  $("note-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const title = currentNoteTitle();
    if (!title) { toast("책 제목을 적어 주세요"); $("note-title").focus(); return; }
    const body = smartQuotes($("note-body").value.trim());
    const finished = $("note-finished").value || null;
    if (!body && !finished) { toast("감상문을 적어 주세요"); $("note-body").focus(); return; }
    if (!noteTitle && notes.has(title) && !confirm(`『${title}』에는 이미 감상문이 있어요. 새 글로 바꿀까요?`)) return;
    const prev = notes.get(title);
    const row = { body, finished_on: finished, updated_at: new Date().toISOString() };
    notes.set(title, row);
    saveNotesCache();
    render();
    const btn = $("note-save");
    btn.disabled = true;
    const { error } = await sb.from("book_notes")
      .upsert({ user_id: user.id, book_title: title, ...row }, { onConflict: "user_id,book_title" });
    btn.disabled = false;
    if (error) {
      if (prev) notes.set(title, prev); else notes.delete(title);
      saveNotesCache();
      if (isMissingTable(error)) notesMissing = true;
      render();
      toast(isMissingTable(error)
        ? "감상문을 저장하려면 Supabase에서 schema.sql을 다시 실행해 주세요."
        : "저장하지 못했어요. 인터넷 연결을 확인해 주세요.");
      return;
    }
    notesMissing = false;
    const draftKey = noteDraftKey();
    if (!noteTitle) {
      const au = $("note-author").value.trim();
      if (au && au !== authorOf(title)) await setBookAuthor(title, au);
    }
    store.remove(draftKey);
    noteSnapshot = noteState();
    render();
    closeFull(noteDialog);
    toast("감상문을 저장했어요");
  });

  $("note-delete").addEventListener("click", async () => {
    const title = noteTitle;
    if (!title || !confirm(`『${title}』 감상문을 지울까요? 되돌릴 수 없어요.`)) return;
    const { error } = await sb.from("book_notes").delete().eq("book_title", title);
    if (error) { toast("지우지 못했어요. 인터넷 연결을 확인해 주세요."); return; }
    notes.delete(title);
    saveNotesCache();
    store.remove(noteDraftKey());
    render();
    noteSnapshot = noteState();
    closeFull(noteDialog);
    toast("감상문을 지웠어요");
  });

  // ---------- 오늘의 문장 · 내보내기 버튼 ----------
  $("today-next").addEventListener("click", () => { todayOffset++; renderToday(); });
  $("today-hide").addEventListener("click", () => { store.set("todayHidden", dayKey()); renderToday(); toast("내일 또 보여드릴게요"); });
  $("today-body").addEventListener("click", () => { const id = $("today-card").dataset.id; if (id) openView(id, $("today-card")); });
  $("export-txt").addEventListener("click", exportText);
  $("export-csv").addEventListener("click", exportCsv);

  // ---------- 검색 ----------

  $("search").addEventListener("input", (e) => {
    query = e.target.value;
    render();
  });

  // ---------- 고치기 / 삭제 ----------

  const dialog = $("edit-dialog");
  let editingId = null;

  function openEdit(id) {
    const it = items.find((x) => x.id === id);
    if (!it) return;
    editingId = id;
    $("edit-content").value = it.content;
    $("edit-book").value = it.book_title || "";
    $("edit-author").value = authorOf(it.book_title);
    $("edit-page").value = it.page || "";
    $("edit-memo").value = it.memo || "";
    $("edit-date").textContent = fmtLongDate(new Date(it.created_at)) + "에 담음";
    renderSwatches();
    dialog.showModal();
  }

  // ---------- 책 색 고르기 ----------
  // 수정 창에서 고르면 같은 책의 모든 문장에 바로 적용되고, PC·아이폰에 함께 저장돼요.
  function renderSwatches() {
    const title = $("edit-book").value.trim();
    $("edit-color").hidden = !title;
    if (!title) return;
    const current = bookCustom.get(title) || null;
    const box = $("color-swatches");
    const mk = (hex, name) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = hex ? "swatch-btn" : "swatch-btn auto";
      b.setAttribute("role", "radio");
      b.setAttribute("aria-checked", String((current || null) === hex));
      b.setAttribute("aria-label", name);
      b.title = name;
      if (hex) { b.style.setProperty("--sw", hex); b.style.setProperty("--sw-ink", inkFor(hex)); }
      else b.textContent = "자동";
      b.addEventListener("click", () => setBookColor(title, hex));
      return b;
    };
    box.replaceChildren(mk(null, "자동으로 정하기"), ...BOOK_COLORS.map(([hex, name]) => mk(hex, name)));
  }
  $("edit-book").addEventListener("input", () => {
    renderSwatches();
    const known = authorOf($("edit-book").value);
    if (known) $("edit-author").value = known; // 이미 아는 책이면 작가도 맞춰요
  });

  async function setBookAuthor(title, author) {
    title = (title || "").trim(); author = (author || "").trim();
    if (!title) return true;
    const prev = bookAuthor.get(title) || "";
    if (prev === author) return true;
    const apply = (v) => { if (v) bookAuthor.set(title, v); else bookAuthor.delete(title); saveBooksCache(); render(); };
    apply(author);
    const { error } = await sb.from("book_colors")
      .upsert({ user_id: user.id, book_title: title, author: author || null }, { onConflict: "user_id,book_title" });
    if (error) {
      apply(prev);
      toast(/author|null value|schema cache|does not exist/i.test(error.message || "")
        ? "작가를 저장하려면 Supabase에서 schema.sql을 다시 실행해 주세요."
        : "작가를 저장하지 못했어요. 인터넷 연결을 확인해 주세요.");
      return false;
    }
    return true;
  }

  async function setBookColor(title, hex) {
    const prev = bookCustom.get(title) || null;
    if (prev === hex) return;
    const apply = (v) => {
      if (v) bookCustom.set(title, v); else bookCustom.delete(title);
      saveBooksCache();
      render();
      renderSwatches();
    };
    apply(hex); // 먼저 화면에 바로 보여주고
    const { error } = hex
      ? await sb.from("book_colors").upsert({ user_id: user.id, book_title: title, color: hex }, { onConflict: "user_id,book_title" })
      : await sb.from("book_colors").delete().eq("book_title", title);
    if (error) {
      apply(prev); // 저장에 실패하면 되돌려요
      toast(/book_colors|schema cache|does not exist/i.test(error.message || "")
        ? "책 색 표가 아직 없어요. (Supabase에서 schema.sql 실행 필요)"
        : "색을 저장하지 못했어요. 인터넷 연결을 확인해 주세요.");
    }
  }

  $("edit-cancel").addEventListener("click", () => dialog.close());
  dialog.addEventListener("click", (e) => { if (e.target === dialog) dialog.close(); });

  $("edit-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = smartQuotes($("edit-content").value.trim());
    if (!text) return;
    const btn = $("edit-save");
    btn.disabled = true;
    const { data, error } = await sb
      .from("sentences")
      .update({
        content: text,
        book_title: $("edit-book").value.trim() || null,
        page: $("edit-page").value.trim() || null,
        memo: smartQuotes($("edit-memo").value.trim()) || null,
      })
      .eq("id", editingId)
      .select()
      .single();
    btn.disabled = false;
    if (error) { toast("저장하지 못했어요. 인터넷 연결을 확인해 주세요."); return; }
    upsertLocal(data);
    const newBook = $("edit-book").value.trim();
    const authorOk = newBook ? await setBookAuthor(newBook, $("edit-author").value) : true;
    render();
    dialog.close();
    if (authorOk) toast("고쳤어요"); // 작가 저장에 실패했으면 그 안내를 남겨둬요
  });

  $("edit-delete").addEventListener("click", async () => {
    if (!confirm("이 문장을 삭제할까요? 되돌릴 수 없어요.")) return;
    const id = editingId;
    const { error } = await sb.from("sentences").delete().eq("id", id);
    if (error) { toast("삭제하지 못했어요. 인터넷 연결을 확인해 주세요."); return; }
    removeLocal(id);
    render();
    dialog.close();
    toast("삭제했어요");
  });

  // 책 제목 칸 세 곳에 추천 목록 달기 (문장 담기 · 고치기 · 감상문 새 책)
  attachBookSuggest($("compose-book"), $("compose-author"), {
    onPick: (c) => { if (c.au) authorAuto = true; },
    next: (c) => (c.au ? $("compose-page") : $("compose-author")),
  });
  attachBookSuggest($("edit-book"), $("edit-author"), { next: (c) => (c.au ? $("edit-page") : $("edit-author")) });
  attachBookSuggest($("note-title"), $("note-author"), { next: (c) => (c.au ? $("note-body") : $("note-author")) });

  // ---------- 빠른 시작 ----------
  // Supabase 는 시작할 때 로그인 토큰을 인터넷으로 새로 받은 뒤에야 알려줘서(오래 안 쓰면 거의 매번),
  // 그동안 흰 화면이 보였어요. 이 기기에 저장된 로그인이 있으면 저장해 둔 문장으로 바로 그리고,
  // 동기화는 토큰이 준비되면 이어서 해요. (토큰이 무효면 onAuthStateChange 가 로그인 화면으로 바꿔요)
  if (!started) {
    try {
      const ref = new URL(cfg.SUPABASE_URL).hostname.split(".")[0];
      const saved = JSON.parse(localStorage.getItem(`sb-${ref}-auth-token`) || "null");
      const savedUser = saved && (saved.user || (saved.currentSession && saved.currentSession.user));
      if (savedUser && savedUser.id) {
        started = true;
        user = savedUser;
        enterMain();
      }
    } catch { /* 저장된 로그인을 못 읽으면 평소처럼 기다려요 */ }
  }
})();
