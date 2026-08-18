/**
 * CGV 용산아이파크몰 - 오디세이 IMAX 예매 오픈 감시
 *
 * 동작 원리
 *   CGV 예매 페이지는 Cloudflare로 보호돼 있어 일반 HTTP 요청(requests 등)은 403입니다.
 *   그래서 헤드리스 Chrome으로 실제 페이지를 열고, 그 페이지가 내부적으로 호출하는
 *   searchMovScnInfo API의 응답을 가로채서 JSON을 직접 읽습니다.
 *   HTML 파싱이 아니라 API 응답이라 사이트 디자인이 바뀌어도 잘 견딥니다.
 *
 * 알림
 *   · 텔레그램 (즉시)
 *   · GitHub Issue (멘션 알림 + 중복 방지 기록)
 *
 * 참고: 공개 저장소 lsy0034-sketch/cgv-centum-odyssey-alert 의 접근 방식을 참고했습니다.
 */

const puppeteer = require("puppeteer-core");

// ═══════════════════════════════════════════════════════════
// 설정 - 여기만 확인하면 됩니다
// ═══════════════════════════════════════════════════════════

// ⚠️ 용산아이파크몰의 siteNo 를 반드시 확인하세요 (README 1단계 참고)
//    센텀시티가 0089 이고, 용산은 아래 값이 맞는지 검증이 필요합니다.
const THEATER = {
  siteNo: process.env.SITE_NO || "0013",
  siteNm: process.env.SITE_NM || "용산아이파크몰",
};

const TARGET_DATES = (process.env.TARGET_DATES || "20260828").split(",");
const MOVIE_KEYWORDS = ["오디세이", "ODYSSEY"];
const IMAX_GRADE_CODE = "03";              // 특별관 등급코드: IMAX
const BASE_URL = "https://cgv.co.kr/cnm/movieBook/cinema";

// IMAX가 아니어도 해당 영화 회차가 뜨면 알릴지 여부.
// 오픈 자체를 놓치지 않는 게 중요하므로 기본 true 를 권장합니다.
const ALERT_ON_ANY_HALL = String(process.env.ALERT_ON_ANY_HALL || "true") === "true";

// ── 환경변수
const REPO = process.env.GITHUB_REPOSITORY || "";
const TOKEN = process.env.GITHUB_TOKEN || "";
const ASSIGNEE = process.env.ASSIGNEE || (REPO ? REPO.split("/")[0] : "");
const TG_TOKEN = process.env.TELEGRAM_TOKEN || "";
const TG_CHAT = process.env.TELEGRAM_CHAT_ID || "";

// 진단 모드: 이미 예매가 열린 날짜로 파서가 살아있는지 확인 (알림 안 보냄)
const DIAGNOSTIC_ONLY = String(process.env.DIAGNOSTIC_ONLY || "").toLowerCase() === "true";
const DIAGNOSTIC_DATE = String(process.env.DIAGNOSTIC_DATE || "").trim();

// 하루 한 번 생존 신고
const HEARTBEAT = String(process.env.HEARTBEAT || "").toLowerCase() === "true";

// ═══════════════════════════════════════════════════════════
// 유틸
// ═══════════════════════════════════════════════════════════

const norm = (s) => String(s || "").toUpperCase().replace(/\s+/g, "");

/** 영화 제목이 감시 대상인지 */
function isTargetMovie(name) {
  if (MOVIE_KEYWORDS.length === 0) return true;
  return MOVIE_KEYWORDS.some((k) => norm(name).includes(norm(k)));
}

/** "1420" -> "14:20" */
function fmtTime(s) {
  const x = String(s || "").replace(/\D/g, "");
  return x.length >= 4 ? `${x.slice(0, 2)}:${x.slice(2, 4)}` : String(s || "");
}

/** "20260828" -> "2026-08-28" */
function fmtDate(d) {
  return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
}

/** 내일 날짜. 파서 생존 확인용 대조군으로 씁니다. */
function controlDate() {
  const kst = new Date(Date.now() + 9 * 3600 * 1000 + 24 * 3600 * 1000);
  return kst.toISOString().slice(0, 10).replace(/-/g, "");
}

/** API 응답 항목에서 필요한 필드만 추립니다. */
function simplify(x) {
  return {
    movNm: x.movNm || x.movieNm || "",          // 영화명
    scnsNm: x.scnsNm || x.screenNm || "",       // 상영관명
    scnStrtTm: x.scnStrtTm || x.playStartTm || "", // 시작시각
    tcscnsGradCd: x.tcscnsGradCd || "",         // 특별관 등급코드
    rmnSeatCnt: x.rmnSeatCnt ?? x.remainSeatCnt ?? null, // 잔여좌석
  };
}

// ═══════════════════════════════════════════════════════════
// 알림
// ═══════════════════════════════════════════════════════════

/** 텔레그램 발송. 실패해도 전체를 중단시키지 않습니다. */
async function sendTelegram(text) {
  if (!TG_TOKEN || !TG_CHAT) {
    console.log("[TG] 미설정 - 발송 생략");
    return;
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TG_CHAT, text }),
    });
    console.log(`[TG] HTTP ${res.status}`);
  } catch (e) {
    console.log(`[TG] 발송 실패: ${e.message}`);
  }
}

async function githubApi(path, method = "GET", body = null) {
  if (!TOKEN) throw new Error("GITHUB_TOKEN 없음");
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${TOKEN}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "cgv-yongsan-alert",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status}: ${await res.text()}`);
  return await res.json();
}

/**
 * 같은 제목의 이슈가 이미 있는지 확인합니다.
 * 5분마다 도는 워크플로가 같은 알림을 반복 생성하지 않게 하는 장치입니다.
 * 별도 상태 파일 없이 이슈 자체를 기록으로 쓰는 방식입니다.
 */
async function issueExists(titlePrefix) {
  if (!TOKEN || !REPO) return false;
  try {
    const q = encodeURIComponent(`repo:${REPO} is:issue in:title "${titlePrefix}"`);
    const data = await githubApi(`/search/issues?q=${q}`);
    return (data.total_count || 0) > 0;
  } catch (e) {
    console.log(`[GH] 중복 확인 실패(계속 진행): ${e.message}`);
    return false;
  }
}

async function createIssue(title, body) {
  if (!TOKEN || !REPO) {
    console.log("[GH] 토큰/저장소 없음 - 이슈 생성 생략");
    return;
  }
  try {
    const issue = await githubApi(`/repos/${REPO}/issues`, "POST", {
      title,
      body: ASSIGNEE ? `@${ASSIGNEE}\n\n${body}` : body,
      assignees: ASSIGNEE ? [ASSIGNEE] : [],
    });
    console.log(`[GH] 이슈 생성: ${issue.html_url}`);
  } catch (e) {
    console.log(`[GH] 이슈 생성 실패: ${e.message}`);
  }
}

// ═══════════════════════════════════════════════════════════
// CGV 조회
// ═══════════════════════════════════════════════════════════

function chromePath() {
  return process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/bin/google-chrome";
}

/**
 * 한 날짜의 상영 일정을 조회합니다.
 * 페이지를 열고, 그 페이지가 호출하는 searchMovScnInfo 응답을 가로챕니다.
 */
async function fetchDate(browser, date) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1365, height: 900 });
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
  );

  const url =
    `${BASE_URL}?siteNo=${THEATER.siteNo}` +
    `&siteNm=${encodeURIComponent(THEATER.siteNm)}&scnYmd=${date}`;

  try {
    // 리스너를 goto 이전에 등록해야 빠른 응답을 놓치지 않습니다.
    const waiter = page.waitForResponse(
      (res) => {
        try {
          if (!res.url().includes("searchMovScnInfo")) return false;
          const u = new URL(res.url());
          return (
            u.searchParams.get("scnYmd") === date &&
            u.searchParams.get("siteNo") === THEATER.siteNo
          );
        } catch {
          return false;
        }
      },
      { timeout: 30000 }
    );

    const nav = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    console.log(`[DIAG] ${date}: page=${nav ? nav.status() : 0} final=${page.url()}`);

    const apiRes = await waiter;
    console.log(`[DIAG] ${date}: API=${apiRes.status()}`);
    if (!apiRes.ok()) throw new Error(`searchMovScnInfo HTTP ${apiRes.status()}`);

    const body = await apiRes.json();
    const items = (Array.isArray(body?.data) ? body.data : []).map(simplify);

    const movie = items.filter((x) => isTargetMovie(x.movNm));
    const imax = movie.filter((x) => x.tcscnsGradCd === IMAX_GRADE_CODE);

    console.log(
      `[DIAG] ${date}: 전체=${items.length} 대상영화=${movie.length} IMAX=${imax.length}`
    );
    if (items.length > 0) {
      console.log(`[DIAG] ${date}: 샘플=${JSON.stringify(items.slice(0, 5))}`);
    }

    return { date, total: items.length, movie, imax, error: null };
  } catch (e) {
    console.log(`[ERR] ${date}: ${e.message}`);
    return { date, total: 0, movie: [], imax: [], error: e.message };
  } finally {
    await page.close();
  }
}

// ═══════════════════════════════════════════════════════════
// 메시지
// ═══════════════════════════════════════════════════════════

function showLines(list) {
  return list
    .map((x) => {
      const seat = x.rmnSeatCnt != null ? ` (잔여 ${x.rmnSeatCnt})` : "";
      return `  · ${x.movNm} / ${x.scnsNm} / ${fmtTime(x.scnStrtTm)}${seat}`;
    })
    .join("\n");
}

function openMessage(r) {
  const list = r.imax.length > 0 ? r.imax : r.movie;
  const head = r.imax.length > 0 ? "IMAX 회차" : "회차 (IMAX 아님)";
  return [
    `🚨 예매 오픈!  ${fmtDate(r.date)}`,
    `${THEATER.siteNm}`,
    "",
    head,
    showLines(list),
    "",
    `https://cgv.co.kr/cnm/movieBook/cinema?siteNo=${THEATER.siteNo}&scnYmd=${r.date}`,
  ].join("\n");
}

// ═══════════════════════════════════════════════════════════
// 메인
// ═══════════════════════════════════════════════════════════

async function main() {
  const browser = await puppeteer.launch({
    executablePath: chromePath(),
    headless: "new",
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--lang=ko-KR"],
  });

  try {
    // ── 진단 모드: 이미 열린 날짜로 파서 검증만 하고 종료
    if (DIAGNOSTIC_ONLY) {
      const d = DIAGNOSTIC_DATE || controlDate();
      console.log(`=== 진단 모드: ${fmtDate(d)} ===`);
      const r = await fetchDate(browser, d);
      console.log(
        r.total > 0
          ? `✅ 정상 - 전체 ${r.total}개 회차 수신. siteNo=${THEATER.siteNo} 유효합니다.`
          : `❌ 0개 - siteNo가 틀렸거나 접근이 막혔습니다. README 1단계를 확인하세요.`
      );
      return;
    }

    // ── 대조군 먼저: 파서가 살아있는지 확인
    const ctrl = await fetchDate(browser, controlDate());

    // ── 감시 대상 날짜들
    let anyOpen = false;
    for (const date of TARGET_DATES) {
      const r = await fetchDate(browser, date);
      const hit = r.imax.length > 0 || (ALERT_ON_ANY_HALL && r.movie.length > 0);

      if (hit) {
        anyOpen = true;
        const prefix = `[CGV OPEN ${date}]`;
        if (await issueExists(prefix)) {
          console.log(`[INFO] ${date}: 이미 알림 발송됨 - 중복 생략`);
          continue;
        }
        const msg = openMessage(r);
        await sendTelegram(msg);
        await createIssue(`${prefix} 🚨 ${THEATER.siteNm} 예매 오픈`, msg);
      }
    }

    // ── 파서 고장 감지: 대조군까지 0개면 미오픈이 아니라 고장입니다
    if (!anyOpen && ctrl.total === 0) {
      const prefix = `[CGV BROKEN ${controlDate()}]`;
      if (!(await issueExists(prefix))) {
        const msg = [
          "⚠️ 감시기 이상 - 확인 필요",
          "",
          `대조군(${fmtDate(ctrl.date)})에서도 회차가 0개입니다.`,
          "예매 미오픈이 아니라 siteNo 오류, 사이트 변경, 또는 차단일 가능성이 큽니다.",
          "",
          `오류: ${ctrl.error || "없음"}`,
        ].join("\n");
        await sendTelegram(msg);
        await createIssue(`${prefix} ⚠️ 감시기 이상`, msg);
      }
      return;
    }

    // ── 하루 한 번 생존 신고
    if (!anyOpen && HEARTBEAT) {
      const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10).replace(/-/g, "");
      const prefix = `[CGV STATUS ${today}]`;
      if (!(await issueExists(prefix))) {
        const msg = [
          "✅ 감시기 정상 작동",
          "",
          `극장: ${THEATER.siteNm} (siteNo ${THEATER.siteNo})`,
          `감시 대상: ${TARGET_DATES.map(fmtDate).join(", ")}`,
          `대조군(${fmtDate(ctrl.date)}) 전체 회차: ${ctrl.total}개 ← 조회 경로 정상`,
          "",
          "아직 미오픈. 열리는 즉시 긴급 알림이 갑니다.",
        ].join("\n");
        await sendTelegram(msg);
        await createIssue(`${prefix} ✅ 감시기 정상 작동`, msg);
      }
    }
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
