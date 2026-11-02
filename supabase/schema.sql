-- 문장 수집창고 — Supabase 데이터베이스 설정
-- Supabase 대시보드 → SQL Editor → New query 에 전체를 붙여넣고 [Run] 을 누르세요.
-- 여러 번 실행해도 괜찮아요 (이미 있는 것은 건너뛰어요).

create table if not exists public.sentences (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users on delete cascade,
  content     text not null,
  book_title  text,
  page        text,
  memo        text,
  created_at  timestamptz not null default now()
);

create index if not exists sentences_user_created_idx
  on public.sentences (user_id, created_at desc);

-- 본인 문장만 읽고 쓸 수 있도록 잠금 (Row Level Security)
alter table public.sentences enable row level security;

drop policy if exists "own rows" on public.sentences;
create policy "own rows" on public.sentences
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- PC ↔ 아이폰 실시간 동기화를 위해 Realtime 켜기 (이미 켜져 있으면 건너뜀)
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'sentences'
  ) then
    alter publication supabase_realtime add table public.sentences;
  end if;
end $$;

-- ───────────────────────────────────────────────
-- 구글 글자 인식 하루 사용량 (무료 범위 월 1,000회를 넘지 않도록)
-- 중간 서버(ocr 함수)만 쓸 수 있고, 앱에서는 보거나 바꿀 수 없어요.
create table if not exists public.ocr_usage (
  day   date primary key,        -- 한국 날짜
  count int  not null default 0
);
alter table public.ocr_usage enable row level security;  -- 정책이 없으므로 API로는 아무도 접근 못 함

-- 오늘 사용량을 1 늘리고 새 값을 돌려줘요. 이미 한도에 닿았으면 null.
create or replace function public.ocr_take(max_per_day int)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  d date := (now() at time zone 'Asia/Seoul')::date;
  c int;
begin
  insert into ocr_usage (day, count) values (d, 1)
  on conflict (day) do update
    set count = ocr_usage.count + 1
    where ocr_usage.count < max_per_day
  returning count into c;
  return c;
end $$;

revoke all on function public.ocr_take(int) from public, anon, authenticated;
grant execute on function public.ocr_take(int) to service_role;
