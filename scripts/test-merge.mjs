// 合并逻辑测试：把 src/sync.ts 及其依赖打成 ESM 后在 Node 中执行。
// 运行：node scripts/test-merge.mjs
import { rolldown } from "rolldown";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";

const tmpDir = join(process.cwd(), "node_modules", ".cache", "sync-tests");
await mkdir(tmpDir, { recursive: true });
const entry = join(tmpDir, "entry.ts");
await writeFile(
  entry,
  `export * from "../../../src/sync.ts";
   export { createSeedProject } from "../../../src/data.ts";`,
);
const bundle = await rolldown({ input: entry, platform: "node" });
const result = await bundle.generate({ format: "esm" });
const outFile = join(tmpDir, "bundle.mjs");
await writeFile(outFile, result.output[0].code);
await bundle.close();
const sync = await import(outFile);

let passed = 0;
let failed = 0;
const assert = (condition, message) => {
  if (condition) {
    passed++;
  } else {
    failed++;
    console.error(`✗ ${message}`);
  }
};
const eq = (a, b, message) => assert(JSON.stringify(a) === JSON.stringify(b), `${message}（期望 ${JSON.stringify(b)}，实得 ${JSON.stringify(a)}）`);

// ---------- 构造测试项目 ----------
const makeSegment = (id, overrides = {}) => ({
  id,
  start: 1,
  end: 5,
  speakerId: "sp-a",
  text: `原文-${id}`,
  confidence: 3,
  reviewed: false,
  flags: { lowConfidence: false, dialect: false, properNoun: false },
  tagIds: [],
  comments: [],
  ...overrides,
});
const makeProject = (segments) => ({
  id: "proj",
  title: "测试项目",
  interviewee: "甲",
  recordingDate: "2026-09-01",
  activeTrackId: "t1",
  speakers: [{ id: "sp-a", name: "甲", role: "口述人", color: "#000" }],
  tags: [],
  tracks: [{ id: "t1", name: "主轨", language: "普通话", status: "校对中", segments }],
  updatedAt: "2026-09-01T00:00:00.000Z",
});

// 基于 base 造采集包，mutate(field/base) 分别修改现场稿与基准稿
const makePackage = (baseSegments, mutateField, mutateBase) => {
  const base = makeProject(structuredCloneLike(baseSegments));
  const field = structuredCloneLike(base);
  mutateField?.(field);
  mutateBase?.(base);
  return {
    schema: 1,
    packageId: `pkg-${Math.random().toString(36).slice(2, 7)}`,
    baseRevision: 1,
    exportedAt: "2026-09-20T00:00:00.000Z",
    collectorName: "测试采集员",
    base,
    field,
  };
};
// 深拷贝（Node 18+ 全局 structuredClone 可用，这里兜底）
function structuredCloneLike(value) {
  return globalThis.structuredClone ? globalThis.structuredClone(value) : JSON.parse(JSON.stringify(value));
}
const segById = (project, id) => project.tracks[0].segments.find((s) => s.id === id);

// 1. 现场只改正文 → 听现场
{
  const base = [makeSegment("s1"), makeSegment("s2")];
  const pkg = makePackage(base, (field) => { segById(field, "s1").text = "现场改正文"; });
  const local = makeProject(structuredCloneLike(base));
  const plan = sync.planMerge(local, pkg);
  eq(segById(plan.merged, "s1").text, "现场改正文", "1. 现场改正文应听现场");
  eq(plan.counts.mergedField, 1, "1. 计数 mergedField=1");
  eq(plan.counts.deferred, 0, "1. 无搁置");
}

// 2. 编目室只改正文、现场没动 → 留编目室
{
  const base = [makeSegment("s1")];
  const pkg = makePackage(base);
  const local = makeProject(structuredCloneLike(base));
  segById(local, "s1").text = "编目室改正文";
  const plan = sync.planMerge(local, pkg);
  eq(segById(plan.merged, "s1").text, "编目室改正文", "2. 编目室改正文应保留");
  eq(plan.counts.mergedCatalog, 1, "2. 计数 mergedCatalog=1");
}

// 3. 现场改正文（编目室没动正文），编目室改主题关联（现场没动关联）→ 自动合流
{
  const base = [makeSegment("s1")];
  const pkg = makePackage(base, (field) => {
    segById(field, "s1").text = "现场正文";
  });
  const local = makeProject(structuredCloneLike(base));
  segById(local, "s1").tagIds = ["tag-catalog"];
  const plan = sync.planMerge(local, pkg);
  eq(segById(plan.merged, "s1").text, "现场正文", "3. 正文听现场");
  eq(segById(plan.merged, "s1").tagIds, ["tag-catalog"], "3. 主题关联以编目室为准");
  eq(plan.counts.mergedBoth, 1, "3. 计数 mergedBoth=1");
}

// 3b. 两边都改正文且不同，同时编目室还改了关联 → 仍是两版并存（同字段冲突优先）
{
  const base = [makeSegment("s1")];
  const pkg = makePackage(base, (field) => { segById(field, "s1").text = "现场正文"; });
  const local = makeProject(structuredCloneLike(base));
  segById(local, "s1").text = "编目室正文";
  segById(local, "s1").tagIds = ["tag-catalog"];
  const plan = sync.planMerge(local, pkg);
  eq(plan.counts.conflicts, 1, "3b. 正文两边都改 → 两版并存");
  const catalog = plan.merged.tracks[0].segments.find((s) => s.conflict?.role === "catalog");
  eq(catalog.tagIds, ["tag-catalog"], "3b. 编目室版自带编目关联，供重挑时参考");
}

// 4. 两边同时改正文且不同 → 两版并存
{
  const base = [makeSegment("s1")];
  const pkg = makePackage(base, (field) => { segById(field, "s1").text = "现场正文"; });
  const local = makeProject(structuredCloneLike(base));
  segById(local, "s1").text = "编目室正文";
  const plan = sync.planMerge(local, pkg);
  const segments = plan.merged.tracks[0].segments;
  eq(segments.length, 2, "4. 应保留两版片段");
  const catalog = segments.find((s) => s.conflict?.role === "catalog");
  const fieldFork = segments.find((s) => s.conflict?.role === "field");
  assert(!!catalog && !!fieldFork, "4. 两版都带冲突角色");
  eq(catalog.text, "编目室正文", "4. 编目室版保留编目室正文");
  eq(fieldFork.text, "现场正文", "4. 现场版保留现场正文");
  eq(catalog.conflict.pairedSegmentId, fieldFork.id, "4. 姊妹 id 互相指向");
  eq(fieldFork.conflict.pairedSegmentId, catalog.id, "4. 姊妹 id 互相指向");
  eq(catalog.conflict.fields, ["正文"], "4. 冲突字段记录为正文");
  assert(catalog.reviewed === false && fieldFork.reviewed === false, "4. 两版都置为未校对");
}

// 5. 两边同时改正文但改成相同内容 → 不算冲突
{
  const base = [makeSegment("s1")];
  const pkg = makePackage(base, (field) => { segById(field, "s1").text = "同一个结果"; });
  const local = makeProject(structuredCloneLike(base));
  segById(local, "s1").text = "同一个结果";
  const plan = sync.planMerge(local, pkg);
  eq(plan.merged.tracks[0].segments.length, 1, "5. 相同结果不应 fork");
  eq(plan.counts.conflicts, 0, "5. 冲突数为 0");
}

// 5b. fork 时编目室版的已校对状态保留（以编目室为准），现场版置未校对
{
  const base = [makeSegment("s1", { reviewed: true })];
  const pkg = makePackage(base, (field) => { segById(field, "s1").text = "现场正文"; });
  const local = makeProject(structuredCloneLike(base));
  segById(local, "s1").text = "编目室正文";
  const plan = sync.planMerge(local, pkg);
  const catalog = plan.merged.tracks[0].segments.find((s) => s.conflict?.role === "catalog");
  const fieldFork = plan.merged.tracks[0].segments.find((s) => s.conflict?.role === "field");
  eq(catalog.reviewed, true, "5b. 编目室版保留已校对状态");
  eq(fieldFork.reviewed, false, "5b. 现场版标记未校对");
}

// 5c. fork 的现场版若带编目室没有的发言人，实体仍被补入，引用不悬空
{
  const base = [makeSegment("s1", { speakerId: "sp-a" })];
  const pkg = makePackage(base, (field) => {
    segById(field, "s1").speakerId = "sp-x";
    segById(field, "s1").text = "现场正文";
    field.speakers.push({ id: "sp-x", name: "现场新人", role: "旁述", color: "#999" });
  });
  const local = makeProject(structuredCloneLike(base));
  segById(local, "s1").text = "编目室正文";
  const plan = sync.planMerge(local, pkg);
  assert(plan.merged.speakers.some((s) => s.id === "sp-x"), "5c. fork 现场版的发言人已补入");
  const fieldFork = plan.merged.tracks[0].segments.find((s) => s.conflict?.role === "field");
  eq(fieldFork.speakerId, "sp-x", "5c. 现场版保留现场发言人");
}

// 6. 编目室已拆开（splitFromId 血缘）→ 搁置 split
{
  const base = [makeSegment("s1")];
  const pkg = makePackage(base, (field) => { segById(field, "s1").text = "现场改了"; });
  const local = makeProject([]);
  local.tracks[0].segments = [
    makeSegment("s1a", { originId: "s1", splitFromId: "s1", text: "前半" }),
    makeSegment("s1b", { originId: "s1", splitFromId: "s1a", text: "后半" }),
  ];
  const plan = sync.planMerge(local, pkg);
  eq(plan.counts.deferred, 1, "6. 已拆对应搁置 1 段");
  eq(plan.deferred[0].reason, "split", "6. 搁置原因 split");
  eq(plan.merged.tracks[0].segments.length, 2, "6. 编目稿不被改动");
}

// 6b. 拆分后第一半保留原 id（现场有改）→ 仍应识别为已拆开并搁置
{
  const base = [makeSegment("s1")];
  const pkg = makePackage(base, (field) => { segById(field, "s1").text = "现场改了"; });
  const local = makeProject([]);
  local.tracks[0].segments = [
    makeSegment("s1", { originId: "s1", text: "前半（保留原id）" }),
    makeSegment("s1b", { originId: "s1", splitFromId: "s1", text: "后半" }),
  ];
  const plan = sync.planMerge(local, pkg);
  eq(plan.deferred.find((d) => d.segmentId === "s1")?.reason, "split", "6b. 保留原 id 的拆分也被识别");
  eq(plan.merged.tracks[0].segments.length, 2, "6b. 编目稿不被改动");
}

// 6c. 已拆开但现场没改该段 → 不搁置，编目稿维持拆分结果
{
  const base = [makeSegment("s1")];
  const pkg = makePackage(base);
  const local = makeProject([]);
  local.tracks[0].segments = [
    makeSegment("s1", { originId: "s1", text: "前半" }),
    makeSegment("s1b", { originId: "s1", splitFromId: "s1", text: "后半" }),
  ];
  const plan = sync.planMerge(local, pkg);
  eq(plan.deferred.length, 0, "6c. 现场未改则不搁置");
  eq(plan.merged.tracks[0].segments.length, 2, "6c. 拆分结果保留");
}

// 7. 编目室已合并掉（mergedFromIds 血缘）→ 搁置 split
{
  const base = [makeSegment("s1"), makeSegment("s2")];
  const pkg = makePackage(base, (field) => { segById(field, "s2").text = "现场改 s2"; });
  const local = makeProject([
    makeSegment("s1", { text: "合并后", mergedFromIds: ["s2"] }),
  ]);
  const plan = sync.planMerge(local, pkg);
  eq(plan.deferred.find((d) => d.segmentId === "s2")?.reason, "split", "7. 被并入的片段按拆开/重组搁置");
}

// 8. 整段不见（无血缘后代）→ 搁置 missing
{
  const base = [makeSegment("s1"), makeSegment("s2")];
  const pkg = makePackage(base, (field) => { segById(field, "s2").text = "现场改 s2"; });
  const local = makeProject([makeSegment("s1")]);
  const plan = sync.planMerge(local, pkg);
  eq(plan.deferred.find((d) => d.segmentId === "s2")?.reason, "missing", "8. 缺失片段原因 missing");
}

// 9. 搁置后重试：只处理搁置段，已并入的不重复
{
  const base = [makeSegment("s1"), makeSegment("s2")];
  const pkg = makePackage(base, (field) => {
    segById(field, "s1").text = "现场 s1";
    segById(field, "s2").text = "现场 s2";
  });
  // 第一次：s2 在编目室缺失被搁置，s1 正常并入
  const localFirst = makeProject([makeSegment("s1")]);
  const plan1 = sync.planMerge(localFirst, pkg);
  eq(plan1.deferred.map((d) => d.segmentId), ["s2"], "9. 首次 s2 搁置");
  eq(segById(plan1.merged, "s1").text, "现场 s1", "9. s1 已并入现场版");
  // 编目室补回 s2 后重试：retryOnlyIds 只含 s2
  const recovered = structuredCloneLike(plan1.merged);
  recovered.tracks[0].segments.push(makeSegment("s2", { text: "原文-s2" }));
  const retrySet = new Set(plan1.deferred.map((d) => d.segmentId));
  const plan2 = sync.planMerge(recovered, pkg, retrySet);
  eq(segById(plan2.merged, "s2").text, "现场 s2", "9. 重试后 s2 并入");
  eq(segById(plan2.merged, "s1").text, "现场 s1", "9. s1 不被重复处理");
  eq(plan2.skipped, 1, "9. s1 记为重试跳过");
  eq(plan2.deferred.length, 0, "9. 重试后无搁置");
}

// 10. 现场改正文，两边都改了起止时间且不同 → 冲突包含正文? 不：正文只现场改，时间两边改 → fork，字段含起止时间
{
  const base = [makeSegment("s1", { start: 0, end: 10 })];
  const pkg = makePackage(base, (field) => {
    segById(field, "s1").text = "现场正文";
    segById(field, "s1").start = 2;
  });
  const local = makeProject(structuredCloneLike(base));
  segById(local, "s1").start = 3;
  const plan = sync.planMerge(local, pkg);
  eq(plan.counts.conflicts, 1, "10. 开始时间两边不同 → 冲突");
  const fieldFork = plan.merged.tracks[0].segments.find((s) => s.conflict?.role === "field");
  eq(fieldFork.text, "现场正文", "10. 现场版带现场正文");
  eq(fieldFork.start, 2, "10. 现场版开始时间 2");
}

// 11. 批注与 reviewed 始终以编目室为准，即使两边都改
{
  const base = [makeSegment("s1", { reviewed: false })];
  const pkg = makePackage(base, (field) => {
    const seg = segById(field, "s1");
    seg.reviewed = true;
    seg.comments = [{ id: "c1", author: "现场", body: "现场批注", createdAt: "x", resolved: false, replies: [] }];
    seg.tagIds = ["t-field"];
  });
  const local = makeProject(structuredCloneLike(base));
  const seg = segById(local, "s1");
  seg.reviewed = false;
  seg.comments = [{ id: "c2", author: "编目", body: "编目批注", createdAt: "y", resolved: false, replies: [] }];
  seg.tagIds = ["t-catalog"];
  const plan = sync.planMerge(local, pkg);
  // 编目组两边都改且不同 → 触发 fork（两版都留），因为同组同字段冲突
  eq(plan.counts.conflicts, 1, "11. 编目组两边同改 → 两版并存");
  const catalog = plan.merged.tracks[0].segments.find((s) => s.conflict?.role === "catalog");
  eq(catalog.comments[0].body, "编目批注", "11. 编目室版带编目批注");
  eq(catalog.tagIds, ["t-catalog"], "11. 编目室版带编目关联");
}

// 12. 重挑：采用现场版后只剩一版且无冲突标记
{
  const base = [makeSegment("s1")];
  const pkg = makePackage(base, (field) => { segById(field, "s1").text = "现场正文"; });
  const local = makeProject(structuredCloneLike(base));
  segById(local, "s1").text = "编目室正文";
  const merged = sync.planMerge(local, pkg).merged;
  const fieldFork = merged.tracks[0].segments.find((s) => s.conflict?.role === "field");
  const after = sync.resolveSegmentFork(merged, fieldFork.id, "field");
  eq(after.tracks[0].segments.length, 1, "12. 重挑后只剩一版");
  eq(after.tracks[0].segments[0].text, "现场正文", "12. 留下的是现场版");
  assert(after.tracks[0].segments[0].conflict === undefined, "12. 冲突标记已清除");
  // 传编目室版 id 选编目室版也能正确工作
  const localBoth = makeProject(structuredCloneLike(base));
  segById(localBoth, "s1").text = "编目室正文";
  const merged3 = sync.planMerge(localBoth, sync.parseCollectionPackage(JSON.stringify(pkg))).merged;
  const catalog = merged3.tracks[0].segments.find((s) => s.conflict?.role === "catalog");
  const afterCatalog = sync.resolveSegmentFork(merged3, catalog.id, "catalog");
  eq(afterCatalog.tracks[0].segments[0].text, "编目室正文", "12. 选编目室版正确");
}

// 13. 现场新增片段 → added 整段并入
{
  const base = [makeSegment("s1")];
  const pkg = makePackage(base, (field) => {
    field.tracks[0].segments.push(makeSegment("s99", { text: "新增段", sourcePackageId: undefined }));
  });
  const local = makeProject(structuredCloneLike(base));
  const plan = sync.planMerge(local, pkg);
  eq(plan.counts.added, 1, "13. 计数 added=1");
  eq(segById(plan.merged, "s99").text, "新增段", "13. 新增段已并入");
  assert(segById(plan.merged, "s99").sourcePackageId === pkg.packageId, "13. 标记来源采集包");
}

// 14. 现场补录的发言人实体自动带入
{
  const baseSeg = makeSegment("s1", { speakerId: "sp-a" });
  const base = [baseSeg];
  const pkg = makePackage(base, (field) => {
    segById(field, "s1").speakerId = "sp-new";
    field.speakers.push({ id: "sp-new", name: "新人", role: "旁述", color: "#123" });
  });
  const local = makeProject(structuredCloneLike(base));
  const plan = sync.planMerge(local, pkg);
  assert(plan.merged.speakers.some((s) => s.id === "sp-new"), "14. 新发言人已补入");
}

// 15. 坏采集包被拒绝
{
  let threw = false;
  try { sync.parseCollectionPackage("{not json"); } catch (e) { threw = e instanceof sync.MergeValidationError; }
  assert(threw, "15. 非法 JSON 抛 MergeValidationError");
  let threw2 = false;
  try { sync.parseCollectionPackage(JSON.stringify({ schema: 2 })); } catch (e) { threw2 = e instanceof sync.MergeValidationError; }
  assert(threw2, "15. schema 错误被拒绝");
}

await rm(tmpDir, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
