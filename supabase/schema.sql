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

-- ───────────────────────────────────────────────
-- 내 폰트 보관함 (비공개). 로그인한 사용자만 내려받을 수 있어요.
-- 폰트 파일은 대시보드 → Storage → fonts 에 직접 올려요. (공개 GitHub 에는 올리지 않아요)
insert into storage.buckets (id, name, public)
values ('fonts', 'fonts', false)
on conflict (id) do nothing;

drop policy if exists "fonts: signed-in can read" on storage.objects;
create policy "fonts: signed-in can read" on storage.objects
  for select to authenticated
  using (bucket_id = 'fonts');

-- ───────────────────────────────────────────────
-- 책마다 직접 고른 색 (PC ↔ 아이폰 함께 보기). 고르지 않은 책은 앱이 자동으로 색을 정해요.
create table if not exists public.book_colors (
  user_id    uuid not null default auth.uid() references auth.users on delete cascade,
  book_title text not null,
  color      text not null check (color ~ '^#[0-9a-fA-F]{6}$'),
  updated_at timestamptz not null default now(),
  primary key (user_id, book_title)
);
alter table public.book_colors enable row level security;

drop policy if exists "own book colors" on public.book_colors;
create policy "own book colors" on public.book_colors
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'book_colors'
  ) then
    alter publication supabase_realtime add table public.book_colors;
  end if;
end $$;

-- ───────────────────────────────────────────────
-- 책 정보: 작가 이름도 책마다 한 번만 저장해요 (책 색과 같은 표)
alter table public.book_colors add column if not exists author text;
alter table public.book_colors alter column color drop not null;  -- 색은 안 고르고 작가만 적어도 되게
