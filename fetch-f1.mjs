// GitHub Actions 定时预取 OpenF1 数据 → 打包成一个静态 JSON
//
// 为什么这么做（而不是抓官方源）：
//   2026-10-03 实测，GitHub runner 请求 F1 官方 live timing 返回 HTTP 403
//   —— Akamai 屏蔽了云服务器 IP。F1 官网虽然能连（457KB），但页面是前端渲染的
//   空壳，里面一个车手名都没有，扒它等于要逆向内部 API，太脆。
//   而 OpenF1 从 GitHub 完全可达（实测 200），所以改成"预取 OpenF1"。
//
// 好处：
//   1) 浏览器只读一个静态文件，秒开，不再打 6 个请求
//   2) 限流只落在 Actions 这一个 IP 上，用户完全避开 429
//   3) 每 10 分钟跑一次，数据最多滞后十几分钟
//
// 产出：data/f1.json

import fs from "node:fs";
import path from "node:path";

const YEAR = Number(process.env.F1_YEAR || 2026);
const OF1 = "https://api.openf1.org/v1";
const OUT_FILE = process.env.F1_OUT || "data/f1.json";
const UA = { "User-Agent": "Mozilla/5.0 (compatible; f1-prefetch/1.0)" };

// 带重试、带超时、失败原因一定打印出来
let lastStatus = 0;      // 最近一次 HTTP 状态码，用来区分"锁站"和"真故障"
async function of1(url, tries = 3) {
  let lastErr = "未知错误";
  for (let i = 1; i <= tries; i++) {
    try {
      const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(30000) });
      lastStatus = r.status;
      if (r.status === 200) return await r.json();
      lastErr = "HTTP " + r.status;
      // 401 = 比赛进行中锁站；404 = 这个端点没有该参数的数据。重试都没用。
      if (r.status === 401 || r.status === 403 || r.status === 404) {
        console.log(`  [${i}/${tries}] ${lastErr}  ${url}`);
        return null;
      }
    } catch (e) {
      lastErr = (e && e.cause ? (e.cause.code || e.cause.message) : e && e.message) || String(e);
    }
    console.log(`  [${i}/${tries}] 失败: ${lastErr}  ${url}`);
    if (i < tries) await new Promise(x => setTimeout(x, 2500 * i));
  }
  return null;
}

const step = (t) => console.log(`\n── ${t} ──`);

// ---------- 1) 赛程 ----------
step("赛程");
const meetings = await of1(`${OF1}/meetings?year=${YEAR}`);
const sessions = await of1(`${OF1}/sessions?year=${YEAR}`);
if (!Array.isArray(meetings) || !Array.isArray(sessions)) {
  if (lastStatus === 401) {
    // 比赛进行中 OpenF1 会锁掉整个 API（返回 401），这是它的正常行为，
    // 不是我们的故障 —— 这种情况不算失败，免得每个比赛周末刷一屏红叉。
    console.log("");
    console.log("⏸  OpenF1 正在锁站（HTTP 401）—— 比赛进行中是正常的，本轮跳过。");
    console.log("   仓库里已有的 data/f1.json 保持不变，等比赛结束下一轮会自动更新。");
    process.exit(0);
  }
  console.error("❌ 拿不到赛程（上面有失败原因）。仓库里已有的 data/f1.json 不会被改动。");
  process.exit(1);
}
console.log(`  meetings ${meetings.length} 站，sessions ${sessions.length} 场`);

// 复刻前端的赛程组装：排除取消的、必须有 Race，按开始时间排序
const byMeeting = {};
for (const s of sessions) (byMeeting[s.meeting_key] = byMeeting[s.meeting_key] || []).push(s);
const realRaces = meetings
  .filter(m => !m.is_cancelled)
  .filter(m => (byMeeting[m.meeting_key] || []).some(s => s.session_name === "Race"))
  .sort((a, b) => new Date(a.date_start) - new Date(b.date_start));

const now = Date.now();
const past = realRaces.filter(m => {
  const rc = (byMeeting[m.meeting_key] || []).find(s => s.session_name === "Race");
  return rc && rc.date_end && new Date(rc.date_end).getTime() < now;
});
console.log(`  有效分站 ${realRaces.length}，其中已完赛 ${past.length}`);

// 需要的 key 范围
const minMk = realRaces.length ? Math.min(...realRaces.map(m => m.meeting_key)) : null;
const pastKeys = [];
for (const m of past) {
  for (const s of (byMeeting[m.meeting_key] || [])) {
    if (["Race", "Qualifying", "Sprint", "Sprint Qualifying"].includes(s.session_name)) pastKeys.push(s.session_key);
  }
}
const minKey = pastKeys.length ? Math.min(...pastKeys) : null;
const lastPast = past.length ? past[past.length - 1] : null;
const champKey = lastPast ? ((byMeeting[lastPast.meeting_key] || []).find(s => s.session_name === "Race") || {}).session_key : null;
console.log(`  minMk=${minMk}  minKey=${minKey}  champKey=${champKey}`);

// ---------- 2) 车手 ----------
step("车手");
let drivers = [];
if (minMk !== null) {
  const raw = await of1(`${OF1}/drivers?meeting_key>=${minMk}`);
  if (Array.isArray(raw)) {
    // 只留本赛季分站 + 同一分站同一车手只留一条（原始响应 1.1 MB，过滤后小很多）
    const mkSet = new Set(realRaces.map(m => m.meeting_key));
    const seen = new Set();
    for (const d of raw) {
      if (!mkSet.has(d.meeting_key)) continue;
      const k = d.meeting_key + ":" + d.driver_number;
      if (seen.has(k)) continue;
      seen.add(k);
      drivers.push(d);
    }
    console.log(`  原始 ${raw.length} 条 → 过滤后 ${drivers.length} 条`);
  } else console.log("  ❌ 车手拿不到");
}

// ---------- 3) 成绩 ----------
step("成绩");
let results = [];
if (minKey !== null) {
  const r = await of1(`${OF1}/session_result?session_key>=${minKey}`);
  if (Array.isArray(r)) { results = r; console.log(`  ${r.length} 行`); }
  else console.log("  ❌ 成绩拿不到");
} else console.log("  （还没有已完赛的分站）");

// ---------- 4) 积分榜 ----------
step("积分榜");
let champDrivers = [], champTeams = [];
if (champKey) {
  const [cd, ct] = await Promise.all([
    of1(`${OF1}/championship_drivers?session_key=${champKey}`),
    of1(`${OF1}/championship_teams?session_key=${champKey}`),
  ]);
  if (Array.isArray(cd)) champDrivers = cd;
  if (Array.isArray(ct)) champTeams = ct;
  console.log(`  车手积分榜 ${champDrivers.length} 行，车队积分榜 ${champTeams.length} 行`);
}

// ---------- 5) 写出 ----------
step("写出");
const out = {
  updated: new Date().toISOString(),
  source: "OpenF1（由 GitHub Actions 预取，非官方项目）",
  year: YEAR,
  minKey, minMk, champKey,
  meetings, sessions, drivers, results, champDrivers, champTeams,
};

fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
const body = JSON.stringify(out);
fs.writeFileSync(OUT_FILE, body, "utf8");
console.log(`  已写入 ${OUT_FILE}`);
console.log(`  大小 ${(body.length / 1024).toFixed(0)} KB`);
console.log(`  meetings ${meetings.length} / sessions ${sessions.length} / drivers ${drivers.length} / results ${results.length} / 积分榜 ${champDrivers.length}+${champTeams.length}`);
