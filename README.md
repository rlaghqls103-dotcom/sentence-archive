# 문장 수집창고

책 속에서 만난 문장을 모아두는 나만의 창고예요. 아이폰과 PC에서 같은 문장을 볼 수 있어요.

- **📷**으로 책 페이지를 찍고, 라이브 텍스트로 고르거나 **자동 인식**으로 문장을 가져와요.
- 책 제목과 페이지를 함께 기록하고, 날짜는 자동으로 남아요.
- 문장 검색, 책별 모아보기, 나의 생각(메모)을 지원해요.
- PC에서 담은 문장이 아이폰에 바로 나타나요(실시간 동기화).
- 다크모드를 지원해요.

## 사진 속 문장 가져오기
**📷 버튼으로 (추천)**
1. 문장 담기 화면의 **📷**을 눌러 책 페이지를 찍어요.
2. 사진 속 글자를 **길게 눌러**(라이브 텍스트) 원하는 문장만 고르고 **복사**한 뒤, **붙여넣고 닫기**를 눌러요.
3. 고르기 번거로우면 **자동 인식**을 눌러요.
   - 사진 속 글자가 전부 들어오니, 필요 없는 부분만 지우면 돼요.
   - 처음 한 번은 인식 데이터를 받느라 조금 걸려요.

찍은 사진은 화면에만 잠깐 보여주고, 어디에도 올리거나 저장하지 않아요.

**아이폰 카메라 앱으로**
1. 카메라 앱으로 책 페이지를 비추고, 오른쪽 아래 **텍스트 인식 버튼**을 눌러요.
2. 원하는 문장을 길게 눌러 **복사**해요.
3. 문장 수집창고에서 **붙여넣기**를 눌러요.
   - 줄마다 끊겨 있으면 **줄 합치기**를 누르세요.

## 아이폰 홈 화면에 설치
1. **Safari**에서 앱 주소를 열어요.
2. 아래쪽 **공유 버튼(□↑)** → **홈 화면에 추가**를 눌러요.
3. 홈 화면의 아이콘을 누르면 앱처럼 전체화면으로 열려요.

## 처음 설정 (한 번만)

### 1. Supabase 준비
1. <https://supabase.com> 에서 **GitHub로 가입**하고 **New project**를 만들어요.
   - 지역은 Northeast Asia (Seoul)를 고르세요.
2. **SQL Editor → New query**에 [`supabase/schema.sql`](supabase/schema.sql) 내용을 붙여넣고 **Run**을 눌러요.
3. **Authentication → Sign In / Providers → Email**에서 **Confirm email**을 꺼요.
   - 이렇게 하면 가입하자마자 바로 로그인할 수 있어요.
4. 아래 두 값을 복사해 [`config.js`](config.js)에 넣어요.
   - **Project URL**: 위쪽 초록색 **Connect** 버튼, 또는 **Settings → Data API**에 있어요.
   - **Publishable key** (`sb_publishable_...`): **Settings → API Keys**에 있어요.
   - ⚠️ **secret 키**(`sb_secret_...`)는 절대 넣거나 공유하지 마세요.

### 2. GitHub Pages로 공개
저장소의 **Settings → Pages → Build and deployment**로 가서 아래처럼 설정해요.
- Source: **Deploy from a branch**
- Branch: **main / (root)**

몇 분 뒤 `https://<GitHub아이디>.github.io/sentence-archive/` 에서 열려요.

### 3. 계정 만들고 잠그기
1. 앱에서 **계정 만들기**로 가입해요.
2. 다른 사람이 가입하지 못하게 **Authentication → Sign In / Providers**에서 **Allow new users to sign up**을 꺼요.

## 보안 메모
- `config.js`의 publishable 키는 공개되어도 괜찮도록 만들어진 키예요.
- 문장 데이터는 Row Level Security로 **로그인한 본인만** 읽고 쓸 수 있어요.

## 구성
빌드 도구 없이 HTML/CSS/JS만으로 만들었어요.

| 파일 | 역할 |
|---|---|
| `index.html` | 화면 |
| `styles.css` | 종이 느낌 테마 |
| `app.js` | 로그인, 저장, 검색, 동기화 |
| `sw.js` | 오프라인에서도 화면을 띄우는 서비스워커 |
| `supabase/schema.sql` | 데이터베이스 설정 |

> 앱 파일을 고친 뒤에는 `sw.js`의 `CACHE` 버전을 올려주세요(예: `v1` → `v2`).
