// GitHub Actions 定时抓取 F1 官方 live timing 数据 → 生成精简 JSON
//
// 为什么要这么绕：
//   F1 官方 live timing（livetiming.formula1.com）数据最全、无限流，
//   但它【没有 CORS】—— 浏览器里的静态页面（GitHub Pages）调不到。
//   而 GitHub Actions 是服务端环境，没有 CORS 限制。
//   所以：Actions 抓 → 存成仓库里的静态 JSON → 前端从 raw.githubusercontent.com 读（raw 有 CORS）。
//
// 产出：data/f1.json
//
// 只抓「排位赛 / 冲刺排位」的成绩表（Position + BestLapTime 正好是页面要显示的）。
// 正赛的官方数据没有积分字段、状态码还要另做映射，继续交给 OpenF1/Jolpica。

import fs from "node:fs";
import path from "node:path";

const YEAR = Number(process.env.F1_YEAR || 2026);
const BASE = "https://livetiming.formula1.com/static/";
const OUT_FILE = process.env.F1_OUT || "data/f1.json";
const MAX_SESSIONS = Number(process.env.F1_MAX_SESSIONS || 40);   // 最多保留多少场
const WANT_TYPES = new Set(["Qualifying", "Sprint Qualifying"]);

const UA = { "User-Agent": "Mozilla/5.0 (compatible; f1-data-relay/1.0)" };

// 带重试和超时的 GET（官方 CDN 偶尔会连不上，实测过）
async function get(url, tries = 3) {
  for (let i = 1; i <= tries; i++) {
    try {
      const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(25000) });
      if (r.status === 200) return await r.text();
      if (r.status === 403 || r.status === 404) return null;   // 确实没有，别重试
    } catch (e) {
      // 网络层失败，重试
    }
    if (i < tries) await new Promise(x => setTimeout(x, 1500 * i));
  }
  return null;
}

const json = async (url) => {
  const t = await get(url);
  if (!t) return null;
  try { return JSON.parse(t); } catch { return null; }
};

// "1:35.130" -> 95.13
function lapToSec(v) {
  if (!v) return null;
  const m = /^(\d+):(\d+\.\d+)$/.exec(String(v).trim());
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  const s = Number(v);
  return Number.isFinite(s) ? s : null;
}

console.log(`年份 ${YEAR}，输出 ${OUT_FILE}`);

// ---------- 1) 年度索引 ----------
const index = await json(`${BASE}${YEAR}/Index.json`);
if (!index || !Array.isArray(index.Meetings)) {
  console.error("拿不到年度索引，退出（保留上一次的数据文件）");
  process.exit(0);   // 不要 fail 掉 workflow，避免把已有数据搞没
}

// ---------- 2) 挑出要抓的 session：已结束的排位类 ----------
const now = Date.now();
const wanted = [];
for (const m of index.Meetings) {
  for (const s of m.Sessions || []) {
    if (!s.Path || !WANT_TYPES.has(s.Type)) continue;
    if (!s.EndDate || new Date(s.EndDate).getTime() >= now) continue;   // 还没结束
    wanted.push({ meeting: m, session: s });
  }
}
// 按结束时间倒序，只取最近 MAX_SESSIONS 场
wanted.sort((a, b) => new Date(b.session.EndDate) - new Date(a.session.EndDate));
const picked = wanted.slice(0, MAX_SESSIONS);
console.log(`已结束的排位类 session 共 ${wanted.length} 场，本次处理 ${picked.length} 场`);

// ---------- 3) 逐场抓取 ----------
const sessions = {};
let ok = 0, fail = 0;

for (const { session: s } of picked) {
  const dir = BASE + s.Path;
  const info = await json(dir + "SessionInfo.json");
  const drivers = await json(dir + "DriverList.json");
  const timing = await json(dir + "TimingData.json");

  const lines = timing && timing.Lines;
  if (!info || !lines) { fail++; console.log(`  跳过 ${s.Path}（info=${!!info} lines=${!!lines}）`); continue; }

  const results = [];
  for (const num of Object.keys(lines)) {
    const L = lines[num] || {};
    const pos = parseInt(L.Position, 10);
    const best = L.BestLapTime && L.BestLapTime.Value ? L.BestLapTime.Value : null;
    const D = (drivers && drivers[num]) || {};
    if (!Number.isFinite(pos)) continue;
    results.push({
      position: pos,
      number: parseInt(num, 10),
      name: D.FullName || L.RacingNumber || String(num),
      tla: D.Tla || null,
      team: D.TeamName || null,
      colour: D.TeamColour || null,
      photo: D.HeadshotUrl || null,
      bestLap: best,
      bestLapSec: lapToSec(best),
      laps: Number.isFinite(L.NumberOfLaps) ? L.NumberOfLaps : null,
    });
  }
  results.sort((a, b) => a.position - b.position);
  if (!results.length) { fail++; continue; }

  sessions[String(s.Key)] = {
    key: s.Key,
    type: s.Type,
    name: s.Name || s.Type,
    round: (info.Meeting && info.Meeting.Number) || null,
    meetingName: (info.Meeting && info.Meeting.Name) || null,
    officialName: (info.Meeting && info.Meeting.OfficialName) || null,
    location: (info.Meeting && info.Meeting.Location) || null,
    circuit: (info.Meeting && info.Meeting.Circuit && info.Meeting.Circuit.ShortName) || null,
    startDate: info.StartDate || s.StartDate || null,
    endDate: info.EndDate || s.EndDate || null,
    gmtOffset: info.GmtOffset || null,
    status: info.SessionStatus || null,
    results,
  };
  ok++;
  console.log(`  ✓ ${s.Type} @ ${info.Meeting?.Location || "?"}  key=${s.Key}  ${results.length} 条  P1=#${results[0].number} ${results[0].bestLap || ""}`);
}

console.log(`完成：成功 ${ok} 场，失败 ${fail} 场`);

// ---------- 4) 写出 ----------
const out = {
  updated: new Date().toISOString(),
  source: "livetiming.formula1.com（F1 官方计时静态数据）",
  year: YEAR,
  count: Object.keys(sessions).length,
  sessions,
};

fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
fs.writeFileSync(OUT_FILE, JSON.stringify(out, null, 1), "utf8");
console.log(`已写入 ${OUT_FILE}  ${(JSON.stringify(out).length / 1024).toFixed(1)} KB  ${out.count} 场`);
