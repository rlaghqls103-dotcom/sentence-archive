// 문장 수집창고 — 글자 인식 중간 서버 (Supabase Edge Function "ocr")
//
// 앱 ──(고른 부분 사진, 로그인 토큰)──▶ 이 함수 ──(비밀 키)──▶ Google Cloud Vision
// 구글 API 키는 Supabase Secrets(GOOGLE_VISION_API_KEY)에만 있고, 앱 코드에는 드러나지 않아요.
//
// 배포: Supabase 대시보드 → Edge Functions → Deploy a new function → Via Editor
//       이름을 "ocr"로 하고 이 파일 내용을 그대로 붙여넣은 뒤 Deploy.

import { createClient } from "npm:@supabase/supabase-js@2.117.3";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const MAX_BASE64 = 6_000_000; // 약 4.5MB 이미지
// 하루 인식 한도 (Supabase Secrets 에 OCR_DAILY_LIMIT 을 넣으면 바꿀 수 있어요). 30회 × 31일 = 930회 < 무료 1,000회
const DAILY_LIMIT = Number(Deno.env.get("OCR_DAILY_LIMIT") ?? 30) || 30;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

type Word = { t: string; sp: boolean; x0: number; y0: number; x1: number; y1: number };

// Vision 의 fullTextAnnotation 을 "줄 → 단어" 목록으로 정리해요.
// sp: 이 단어 뒤에 띄어쓰기가 있는지 (Vision 이 알려주는 detectedBreak 기준, 문단 끝도 띄어쓰기로)
// 줄 끝 단어의 sp 가 false 면 다음 줄과 붙여 써요 (한글은 단어 중간에서 줄이 바뀌기도 해요)
// deno-lint-ignore no-explicit-any
export function toLines(annotation: any): Word[][] {
  const lines: Word[][] = [];
  let line: Word[] = [];
  const endLine = () => {
    if (line.length) lines.push(line);
    line = [];
  };
  for (const page of annotation?.pages ?? []) {
    for (const block of page.blocks ?? []) {
      for (const para of block.paragraphs ?? []) {
        for (const word of para.words ?? []) {
          const symbols = word.symbols ?? [];
          const t = symbols.map((s: { text: string }) => s.text).join("");
          if (!t) continue;
          const vs = word.boundingBox?.vertices ?? [];
          const xs = vs.map((v: { x?: number }) => v.x ?? 0);
          const ys = vs.map((v: { y?: number }) => v.y ?? 0);
          const brk = symbols[symbols.length - 1]?.property?.detectedBreak?.type ?? "";
          line.push({
            t,
            sp: brk === "SPACE" || brk === "SURE_SPACE" || brk === "EOL_SURE_SPACE" || brk === "LINE_BREAK",
            x0: Math.min(...xs), y0: Math.min(...ys),
            x1: Math.max(...xs), y1: Math.max(...ys),
          });
          if (brk === "EOL_SURE_SPACE" || brk === "LINE_BREAK" || brk === "HYPHEN") endLine();
        }
        endLine(); // 문단이 끝나면 줄도 끝
      }
    }
  }
  endLine();
  return lines;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  // 1) 로그인한 사용자만 (anon 키만 가진 요청은 거절)
  const auth = req.headers.get("Authorization") ?? "";
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: auth } } },
  );
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return json({ error: "unauthorized", message: "로그인이 필요해요." }, 401);

  // 2) 입력 확인
  let image = "";
  try {
    ({ image } = await req.json());
  } catch {
    return json({ error: "bad_request", message: "사진을 받지 못했어요." }, 400);
  }
  if (typeof image !== "string" || !image) return json({ error: "bad_request", message: "사진을 받지 못했어요." }, 400);
  image = image.replace(/^data:image\/\w+;base64,/, "");
  if (image.length > MAX_BASE64) return json({ error: "too_large", message: "사진이 너무 커요." }, 413);

  const key = Deno.env.get("GOOGLE_VISION_API_KEY");
  if (!key) return json({ error: "no_key", message: "구글 API 키가 아직 설정되지 않았어요." }, 500);

  // 3) 하루 사용 한도 (구글 무료 범위 월 1,000회를 넘지 않도록, 전체 합계 기준)
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: used, error: usageError } = await admin.rpc("ocr_take", { max_per_day: DAILY_LIMIT });
  if (usageError) {
    return json({ error: "usage_not_ready", message: "사용량 표가 아직 없어요. (schema.sql 실행 필요)" }, 500);
  }
  if (used === null) {
    return json({ error: "daily_limit", limit: DAILY_LIMIT, message: `오늘 인식 한도(${DAILY_LIMIT}회)를 다 썼어요.` }, 429);
  }

  // 4) 구글 Cloud Vision 으로 읽기
  const res = await fetch(`https://vision.googleapis.com/v1/images:annotate?key=${key}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      requests: [{
        image: { content: image },
        features: [{ type: "DOCUMENT_TEXT_DETECTION" }],
        imageContext: { languageHints: ["ko"] },
      }],
    }),
  });
  const data = await res.json().catch(() => ({}));
  const r = data?.responses?.[0];
  if (!res.ok || r?.error) {
    const message = r?.error?.message ?? data?.error?.message ?? `구글 오류 (${res.status})`;
    return json({ error: "vision_error", message }, 502);
  }

  const page = r?.fullTextAnnotation?.pages?.[0];
  return json({
    width: page?.width ?? 0,
    height: page?.height ?? 0,
    lines: toLines(r?.fullTextAnnotation),
    remaining: Math.max(0, DAILY_LIMIT - used),
  });
});
