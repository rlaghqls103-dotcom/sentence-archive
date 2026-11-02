# 문장 수집창고

책 속에서 만난 문장을 모아두는 나만의 창고예요. 아이폰과 PC에서 같은 문장을 볼 수 있어요.

- **📷**으로 책 페이지를 찍고, 라이브 텍스트로 고르거나 **골라서 인식**으로 원하는 문장만 가져와요.
- 책 제목과 페이지를 함께 기록하고, 날짜는 자동으로 남아요.
- 문장 검색, 책별 모아보기, 나의 생각(메모)을 지원해요.
- PC에서 담은 문장이 아이폰에 바로 나타나요(실시간 동기화).
- 다크모드를 지원해요.

## 사진 속 문장 가져오기
**📷 버튼으로 (추천)**
1. 문장 담기 화면의 **📷**을 눌러 책 페이지를 찍어요.
2. 사진 속 글자를 **길게 눌러**(라이브 텍스트) 원하는 문장만 고르고 **복사**한 뒤, **붙여넣고 닫기**를 눌러요.
3. 또는 **✂︎ 골라서 인식**을 눌러요.
   - 원하는 문장을 손가락으로 쓸어 **상자로 감싸고** **이 부분 읽기**를 누르면, 그 부분 글자만 입력칸에 들어와요.
   - 상자는 모서리를 끌어 크기를, 안쪽을 끌어 위치를 바꿀 수 있어요.
   - 글자는 **구글 Cloud Vision**이 읽어요. 아래 "구글 글자 인식 연결"을 한 번 해두어야 해요.

찍은 사진은 화면에만 보여주고 저장하지 않아요. **골라서 인식**을 쓸 때만, 고른 부분(과 주변 약간)의 사진이 구글로 전송돼요.

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

### 4. 구글 글자 인식 연결 (골라서 인식용, 한 번만)
구글 API 키는 앱 코드에 넣지 않고 **Supabase 중간 서버(Edge Function)** 에만 보관해요.

**Google Cloud**
1. <https://console.cloud.google.com> 에서 새 프로젝트를 만들어요.
2. **결제** 메뉴에서 결제 계정(카드)을 연결해요. Cloud Vision은 월 1,000회까지 무료예요.
3. **API 및 서비스 → 라이브러리**에서 **Cloud Vision API**를 찾아 **사용**을 눌러요.
4. **API 및 서비스 → 사용자 인증 정보 → 사용자 인증 정보 만들기 → API 키**를 만들어요.
   - 키 수정 화면의 **API 제한사항**에서 **키 제한 → Cloud Vision API**만 골라 저장해요.
5. (권장) **결제 → 예산 및 알림**에서 작은 예산(예: 1,000원) 알림을 걸어요.

**Supabase**
1. **Edge Functions → Secrets**에서 `GOOGLE_VISION_API_KEY` 이름으로 위의 API 키를 저장해요.
2. **Edge Functions → Deploy a new function → Via Editor**를 열어요.
   - 이름을 `ocr`로 하고, [`supabase/functions/ocr/index.ts`](supabase/functions/ocr/index.ts) 내용을 붙여넣은 뒤 **Deploy**를 눌러요.

## 보안 메모
- `config.js`의 publishable 키는 공개되어도 괜찮도록 만들어진 키예요.
- 문장 데이터는 Row Level Security로 **로그인한 본인만** 읽고 쓸 수 있어요.
- 구글 API 키는 Supabase Secrets에만 있어요. 중간 서버(`ocr`)는 **로그인한 사용자 요청만** 받아요.

## 구성
빌드 도구 없이 HTML/CSS/JS만으로 만들었어요.

| 파일 | 역할 |
|---|---|
| `index.html` | 화면 |
| `styles.css` | 종이 느낌 테마 |
| `app.js` | 로그인, 저장, 검색, 동기화 |
| `sw.js` | 오프라인에서도 화면을 띄우는 서비스워커 |
| `supabase/schema.sql` | 데이터베이스 설정 |
| `supabase/functions/ocr/index.ts` | 구글 글자 인식 중간 서버 |

> 앱 파일을 고친 뒤에는 `sw.js`의 `CACHE` 버전을 올려주세요(예: `v1` → `v2`).
