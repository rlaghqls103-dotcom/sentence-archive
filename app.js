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

  // 사진에서 복사한 문장은 줄 끝마다 줄바꿈이 들어가요. 문단(빈 줄)은 남기고 나머지는 한 줄로 합쳐요.
  function joinLines(text) {
    return text
      .replace(/\r\n?/g, "\n")
      .split(/\n\s*\n/)
      .map((p) => p
        .replace(/([A-Za-z])-\n(?=[a-z])/g, "$1") // 영어 하이픈 줄바꿈
        .replace(/\s*\n\s*/g, " ")
        .replace(/[ \t]{2,}/g, " ")
        .trim())
      .filter(Boolean)
      .join("\n\n");
  }

  // ---------- 화면 전환 ----------

  const views = { setup: $("view-setup"), auth: $("view-auth"), main: $("view-main") };
  function show(name) {
    for (const key of Object.keys(views)) views[key].hidden = key !== name;
  }

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("sw.js").catch(() => {});
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
  let lastLoad = 0;

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

  function enterAuth() {
    if (channel) { sb.removeChannel(channel); channel = null; }
    items = [];
    bookFilter = null;
    query = "";
    $("sentence-list").replaceChildren();
    setAuthMode(false);
    show("auth");
  }

  function enterMain() {
    show("main");
    items = store.get("cache:" + user.id, []);
    const lastBook = store.get("lastBook", "");
    if (lastBook && !$("compose-book").value) $("compose-book").value = lastBook;
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

  function render() {
    const books = bookStats();
    if (bookFilter && !books.some(([t]) => t === bookFilter)) bookFilter = null;

    $("count-line").textContent = items.length
      ? `문장 ${items.length}개 · 책 ${books.length}권`
      : "첫 문장을 기다리고 있어요";

    // 책 제목 자동완성
    const dl = $("book-list");
    dl.replaceChildren(...books.map(([t]) => Object.assign(document.createElement("option"), { value: t })));

    // 책별 보기 칩
    const chips = $("book-chips");
    chips.hidden = books.length === 0;
    const mkChip = (label, value, n) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "chip";
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
      return [it.content, it.book_title, it.memo].some((s) => s && s.toLowerCase().includes(q));
    });

    const list = $("sentence-list");
    list.replaceChildren(...shown.map((it) => card(it, q)));
    $("empty-state").hidden = items.length > 0;
    $("no-result").hidden = items.length === 0 || shown.length > 0;
  }

  function card(it, q) {
    const li = document.createElement("li");
    li.className = "sentence";
    li.tabIndex = 0;
    li.dataset.id = it.id;

    const p = document.createElement("p");
    p.className = "sentence-text";
    highlight(p, it.content, q);
    li.append(p);

    if (it.memo) {
      const m = document.createElement("p");
      m.className = "sentence-memo";
      highlight(m, it.memo, q);
      li.append(m);
    }

    const meta = document.createElement("div");
    meta.className = "sentence-meta";
    const book = document.createElement("span");
    book.className = "sentence-book";
    if (it.book_title) {
      book.append("『");
      highlight(book, it.book_title, q);
      book.append("』");
    }
    if (it.page) book.append(`${it.book_title ? " · " : ""}p.${it.page}`);
    const date = document.createElement("time");
    date.className = "sentence-date";
    date.dateTime = it.created_at;
    date.textContent = fmtDate(it.created_at);
    meta.append(book, date);
    li.append(meta);

    li.addEventListener("click", () => openEdit(it.id));
    li.addEventListener("keydown", (e) => { if (e.key === "Enter") openEdit(it.id); });
    return li;
  }

  // ---------- 문장 담기 ----------

  const content = $("compose-content");
  const bookInput = $("compose-book");
  const pageInput = $("compose-page");

  function updateToday() {
    const d = new Date();
    $("today-label").textContent = `오늘 · ${fmtDate(d)} (${WEEK[d.getDay()]})`;
  }
  updateToday();
  setInterval(updateToday, 60 * 1000);

  // 카메라 앱을 다녀오는 사이 앱이 새로고침돼도 쓰던 내용이 남도록
  content.addEventListener("input", () => store.set("draft", content.value));

  function insertText(text) {
    const cur = content.value;
    if (!cur.trim()) content.value = text;
    else {
      const start = content.selectionStart ?? cur.length;
      const end = content.selectionEnd ?? cur.length;
      content.value = cur.slice(0, start) + text + cur.slice(end);
    }
    store.set("draft", content.value);
  }

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
    content.value = joinLines(content.value);
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
    const text = content.value.trim();
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
    store.set("lastBook", book);
    store.remove("draft");
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
  const photoImg = $("photo-img");
  const ocrBtn = $("photo-ocr");
  let photoFile = null;
  let photoUrl = null;
  let ocrBusy = false;

  // 📷·다시 찍기는 <label for> 로 연결돼 있어서, 누르면 기기가 직접 카메라를 열어요.
  // (아이폰 홈 화면 앱은 스크립트로 여는 input.click() 을 막을 때가 있어요)
  // 키보드(Enter/Space)로 눌렀을 때만 스크립트로 열어줘요.
  for (const label of [$("camera-btn"), $("photo-retake")]) {
    label.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        $(label.htmlFor).click();
      }
    });
  }

  function onPhotoPicked(e) {
    const input = e.target;
    const file = input.files && input.files[0];
    input.value = ""; // 같은 사진을 다시 골라도 change 가 일어나도록
    if (!file) return;
    photoFile = file;
    if (photoUrl) URL.revokeObjectURL(photoUrl);
    photoUrl = URL.createObjectURL(file);
    photoImg.src = photoUrl;
    setOcrProgress(null);
    if (!photoDialog.open) photoDialog.showModal();
  }
  for (const input of photoInputs) input.addEventListener("change", onPhotoPicked);

  function closePhoto() {
    if (photoDialog.open) photoDialog.close();
  }
  photoDialog.addEventListener("close", () => {
    photoImg.removeAttribute("src");
    if (photoUrl) URL.revokeObjectURL(photoUrl);
    photoUrl = null;
    photoFile = null;
    setOcrProgress(null);
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

  function setOcrProgress(p, label) {
    const box = $("ocr-progress");
    if (p == null) { box.hidden = true; return; }
    box.hidden = false;
    $("ocr-bar-fill").style.width = Math.round(p * 100) + "%";
    $("ocr-label").textContent = label || `글자를 읽는 중… ${Math.round(p * 100)}%`;
  }

  // 글자 인식 라이브러리는 [자동 인식]을 처음 누를 때만 받아요 (앱이 가볍게 열리도록)
  const TESSERACT_URL = "https://cdn.jsdelivr.net/npm/tesseract.js@7.0.0/dist/tesseract.min.js";
  let tesseractLoading = null;
  function loadTesseract() {
    if (window.Tesseract) return Promise.resolve(window.Tesseract);
    if (!tesseractLoading) {
      tesseractLoading = new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = TESSERACT_URL;
        s.onload = () => resolve(window.Tesseract);
        s.onerror = () => { tesseractLoading = null; reject(new Error("load failed")); };
        document.head.append(s);
      });
    }
    return tesseractLoading;
  }

  // 큰 사진은 줄여서 인식해요 (아이폰 메모리·속도). 사진 방향(EXIF)은 브라우저가 맞춰줘요.
  async function shrinkForOcr(file, maxSide = 2000) {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext("2d").drawImage(bmp, 0, 0, canvas.width, canvas.height);
    if (bmp.close) bmp.close();
    return canvas;
  }

  function cleanOcrText(text) {
    return joinLines(
      text
        .replace(/[|¦]/g, "")                      // 줄·테두리를 글자로 잘못 읽은 것
        .replace(/[ \t]+([.,!?…」』”’)])/g, "$1")  // 문장부호 앞의 불필요한 공백
    );
  }

  ocrBtn.addEventListener("click", async () => {
    if (ocrBusy || !photoFile) return;
    ocrBusy = true;
    ocrBtn.disabled = true;
    const file = photoFile;
    let worker = null;
    try {
      setOcrProgress(0.02, "글자 인식 도구를 준비하는 중… (처음 한 번은 조금 걸려요)");
      const Tesseract = await loadTesseract();
      const image = await shrinkForOcr(file);
      worker = await Tesseract.createWorker("kor", 1, {
        logger: (m) => {
          if (m.status === "recognizing text") setOcrProgress(0.3 + m.progress * 0.7);
          else if (m.status && m.status.includes("loading")) {
            setOcrProgress(0.05 + (m.progress || 0) * 0.25, "글자 인식 도구를 준비하는 중… (처음 한 번은 조금 걸려요)");
          }
        },
      });
      const { data } = await worker.recognize(image);
      const text = cleanOcrText(data.text || "");
      if (photoFile !== file) return; // 그새 다시 찍었으면 무시
      if (!text) {
        setOcrProgress(1, "글자를 찾지 못했어요. 더 밝고 가까이 다시 찍어 보세요.");
        return;
      }
      closePhoto();
      insertText(text);
      content.focus();
      toast("사진 속 글자를 넣었어요. 필요 없는 부분은 지워주세요");
    } catch (err) {
      console.error(err);
      setOcrProgress(1, navigator.onLine
        ? "글자 인식에 실패했어요. 다시 시도해 주세요."
        : "글자 인식은 인터넷 연결이 필요해요.");
    } finally {
      if (worker) worker.terminate();
      ocrBusy = false;
      ocrBtn.disabled = false;
    }
  });

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
    $("edit-page").value = it.page || "";
    $("edit-memo").value = it.memo || "";
    $("edit-date").textContent = fmtLongDate(new Date(it.created_at)) + "에 담음";
    dialog.showModal();
  }

  $("edit-cancel").addEventListener("click", () => dialog.close());
  dialog.addEventListener("click", (e) => { if (e.target === dialog) dialog.close(); });

  $("edit-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = $("edit-content").value.trim();
    if (!text) return;
    const btn = $("edit-save");
    btn.disabled = true;
    const { data, error } = await sb
      .from("sentences")
      .update({
        content: text,
        book_title: $("edit-book").value.trim() || null,
        page: $("edit-page").value.trim() || null,
        memo: $("edit-memo").value.trim() || null,
      })
      .eq("id", editingId)
      .select()
      .single();
    btn.disabled = false;
    if (error) { toast("저장하지 못했어요. 인터넷 연결을 확인해 주세요."); return; }
    upsertLocal(data);
    render();
    dialog.close();
    toast("고쳤어요");
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
})();
