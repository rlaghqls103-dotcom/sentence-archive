-- 문장 수집창고 — Supabase 데이터베이스 설정
-- Supabase 대시보드 → SQL Editor → New query 에 전체를 붙여넣고 [Run] 을 누르세요.

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

-- PC ↔ 아이폰 실시간 동기화를 위해 Realtime 켜기
alter publication supabase_realtime add table public.sentences;
