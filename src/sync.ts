import { uid } from "./data";
import type {
  CollectionPackage,
  MergeReport,
  PackageDeferReason,
  PackageSegmentOutcome,
  PackageSegmentReport,
  ProjectData,
  Segment,
  SegmentConflict,
  TranscriptTrack,
} from "./types";

/**
 * 采集包合并规则（口述史项目）
 *
 * 三向比对：base=下发采集包时的共同基准，field=平板现场记录，local=编目室当前稿。
 *
 * 字段按归属分两组：
 * - 现场组（听现场记录）：正文、发言人、起止时间，以及置信度与低置信/方言/专名等听辨校对标记。
 * - 编目组（以编目室为准）：主题关联 tagIds、批注 comments、已校对 reviewed。
 *
 * 两边都改了同一归属组里的同名字段且取值不一致时，不替人取舍：两版都留下（conflict），
 * 由编目室在列表里逐条重挑。两组各改各的字段则按归属自动合流。
 */
export const FIELD_GROUP_KEYS = ["text", "speakerId", "start", "end", "confidence", "flags"] as const;
export const CATALOG_GROUP_KEYS = ["tagIds", "comments", "reviewed"] as const;
export type FieldGroupKey = (typeof FIELD_GROUP_KEYS)[number];
export type CatalogGroupKey = (typeof CATALOG_GROUP_KEYS)[number];

export const FIELD_LABELS: Record<string, string> = {
  text: "正文",
  speakerId: "发言人",
  start: "开始时间",
  end: "结束时间",
  confidence: "置信度",
  flags: "校对标记",
  tagIds: "主题关联",
  comments: "批注",
  reviewed: "已校对",
};

export class MergeValidationError extends Error {}

const clone = <T>(value: T): T => structuredClone(value);

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

// ---------- 采集包 ----------

export function createCollectionPackage(project: ProjectData, revision: number, collectorName: string): CollectionPackage {
  const snapshot = clone(project);
  return {
    schema: 1,
    packageId: uid("pkg"),
    baseRevision: revision,
    exportedAt: new Date().toISOString(),
    collectorName: collectorName.trim() || "现场采集员",
    base: snapshot,
    field: clone(snapshot),
  };
}

export function parseCollectionPackage(raw: string): CollectionPackage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new MergeValidationError("采集包不是合法的 JSON 文件");
  }
  const pkg = parsed as Partial<CollectionPackage> | null;
  if (!pkg || pkg.schema !== 1) throw new MergeValidationError("缺少 schema=1，不是本系统的采集包");
  if (!pkg.packageId || !pkg.exportedAt) throw new MergeValidationError("采集包缺少编号或导出时间");
  const validProject = (value: unknown): value is ProjectData => {
    const data = value as ProjectData | null | undefined;
    return !!data && Array.isArray(data.tracks) && Array.isArray(data.speakers) && Array.isArray(data.tags);
  };
  if (!validProject(pkg.base) || !validProject(pkg.field)) {
    throw new MergeValidationError("采集包内缺少基准稿或现场稿数据");
  }
  return pkg as CollectionPackage;
}

// ---------- 血缘：识别“已拆开 / 已并入 / 整段不见” ----------

const findTrack = (project: ProjectData, trackId: string): TranscriptTrack | undefined =>
  project.tracks.find((track) => track.id === trackId);

/** 沿 splitFromId 血缘向下找到所有现存后代片段（含 originId 与基准段相同的拆分半段） */
function splitDescendants(local: ProjectData, trackId: string, baseSegmentId: string): Segment[] {
  const track = findTrack(local, trackId);
  if (!track) return [];
  const result: Segment[] = [];
  const visited = new Set<string>([baseSegmentId]);
  const walk = (parentId: string) => {
    for (const seg of track.segments) {
      if (visited.has(seg.id)) continue;
      // 直接子片段：从 parent 拆出；或共享基准 originId（拆分后第一半保留原 id 的情形）
      if (seg.splitFromId === parentId || (parentId === baseSegmentId && seg.originId === baseSegmentId)) {
        visited.add(seg.id);
        result.push(seg);
        walk(seg.id);
      }
    }
  };
  walk(baseSegmentId);
  return result;
}

/** 找通过合并吞并了基准片段的现存片段 */
function mergedSurvivor(local: ProjectData, trackId: string, baseSegmentId: string): Segment | undefined {
  const track = findTrack(local, trackId);
  return track?.segments.find((seg) => seg.mergedFromIds?.includes(baseSegmentId));
}

// ---------- 合并规划 ----------

export interface MergePlan {
  /** 在深拷贝的编目稿上完成全部改动；apply 阶段整体提交，保证不会只并一半 */
  merged: ProjectData;
  rows: PackageSegmentReport[];
  deferred: Array<{ trackId: string; segmentId: string; reason: PackageDeferReason; detail: string }>;
  counts: MergeReport["counts"];
  /** 重试时跳过（此前已并入或已生成冲突）的基准片段数 */
  skipped: number;
}

const emptyCounts = (): MergeReport["counts"] => ({
  mergedField: 0,
  mergedCatalog: 0,
  mergedBoth: 0,
  conflicts: 0,
  unchanged: 0,
  added: 0,
  deferred: 0,
});

export function planMerge(
  local: ProjectData,
  pkg: CollectionPackage,
  retryOnlyIds?: ReadonlySet<string>,
): MergePlan {
  const merged = clone(local);
  const rows: PackageSegmentReport[] = [];
  const deferred: MergePlan["deferred"] = [];
  const counts = emptyCounts();
  let skipped = 0;

  // 现场补录的发言人/主题实体：编目稿没有的按 id 补入，有的保留编目室名称
  const ensureSpeaker = (speakerId: string) => {
    if (merged.speakers.some((speaker) => speaker.id === speakerId)) return;
    const fieldSpeaker = pkg.field.speakers.find((speaker) => speaker.id === speakerId);
    if (fieldSpeaker) merged.speakers.push(clone(fieldSpeaker));
  };
  const ensureTag = (tagId: string) => {
    if (merged.tags.some((tag) => tag.id === tagId)) return;
    const fieldTag = pkg.field.tags.find((tag) => tag.id === tagId);
    if (fieldTag) merged.tags.push(clone(fieldTag));
  };

  for (const fieldTrack of pkg.field.tracks) {
    const localTrack = findTrack(merged, fieldTrack.id);

    for (const fieldSeg of fieldTrack.segments) {
      const baseSeg = findTrack(pkg.base, fieldTrack.id)?.segments.find((item) => item.id === fieldSeg.id) ?? null;

      // —— 现场新增片段（基准里没有）：整段采纳现场稿 ——
      if (!baseSeg) {
        if (!localTrack) {
          deferred.push({ trackId: fieldTrack.id, segmentId: fieldSeg.id, reason: "missing", detail: `现场新增片段，但轨道「${fieldTrack.name}」在编目稿已不存在` });
          counts.deferred++;
          rows.push(row(fieldTrack.id, fieldSeg.id, "missing", "整段不见：对应轨道在编目稿中已不存在"));
          continue;
        }
        const added = clone(fieldSeg);
        added.sourcePackageId = pkg.packageId;
        added.conflict = undefined;
        localTrack.segments.push(added);
        added.speakerId && ensureSpeaker(added.speakerId);
        added.tagIds.forEach(ensureTag);
        counts.added++;
        rows.push(row(fieldTrack.id, fieldSeg.id, "added", "现场新增片段，已整段并入"));
        continue;
      }

      // 重试时，此前已经处理（已并入 / 已生成冲突 / 本就无改动）的片段不再重复合并
      if (retryOnlyIds && !retryOnlyIds.has(baseSeg.id)) {
        skipped++;
        rows.push({ ...row(fieldTrack.id, baseSeg.id, "unchanged", "重试时跳过：非搁置片段，此前已处理"), skippedOnRetry: true });
        continue;
      }

      // —— 采集包片段在编目室已拆开 / 已并入 / 整段不见：先搁着 ——
      if (!localTrack) {
        pushDeferred(fieldTrack.id, baseSeg.id, "missing", `轨道「${fieldTrack.name}」在编目稿已不存在`);
        continue;
      }
      // 拆分后第一半常保留原 id，因此无论原 id 是否还在，都要先查血缘后代
      const children = splitDescendants(merged, fieldTrack.id, baseSeg.id);
      const fieldTouched = [...FIELD_GROUP_KEYS, ...CATALOG_GROUP_KEYS].some(
        (key) => !deepEqual(fieldSeg[key as keyof Segment], baseSeg[key as keyof Segment]),
      );
      const localSeg = localTrack.segments.find((item) => item.id === baseSeg.id);
      if (children.length && fieldTouched) {
        pushDeferred(fieldTrack.id, baseSeg.id, "split", `编目室已将该片段拆分为 ${children.length} 段（${children.map((item) => item.id).join("、")}），现场改动暂不并入`);
        continue;
      }
      if (!localSeg) {
        if (children.length) {
          pushDeferred(fieldTrack.id, baseSeg.id, "split", `编目室已将该片段拆分为 ${children.length} 段（${children.map((item) => item.id).join("、")}），现场改动暂不并入`);
          continue;
        }
        const survivor = mergedSurvivor(merged, fieldTrack.id, baseSeg.id);
        if (survivor) {
          pushDeferred(fieldTrack.id, baseSeg.id, "split", `编目室已把该片段并入「${survivor.id}」，现场改动暂不并入`);
          continue;
        }
        pushDeferred(fieldTrack.id, baseSeg.id, "missing", "编目稿中已找不到该片段");
        continue;
      }

      const changedInField = (key: string) => !deepEqual(fieldSeg[key as keyof Segment], baseSeg[key as keyof Segment]);
      const changedInLocal = (key: string) => !deepEqual(localSeg[key as keyof Segment], baseSeg[key as keyof Segment]);

      // 现场补录的发言人/主题实体先保证存在，避免引用悬空
      ensureSpeaker(fieldSeg.speakerId);
      fieldSeg.tagIds.forEach(ensureTag);

      const fieldClash = FIELD_GROUP_KEYS.filter((key) => changedInField(key) && changedInLocal(key) && !deepEqual(fieldSeg[key], localSeg[key]));
      const catalogClash = CATALOG_GROUP_KEYS.filter((key) => changedInField(key) && changedInLocal(key) && !deepEqual(fieldSeg[key], localSeg[key]));
      const fieldEdited = FIELD_GROUP_KEYS.some(changedInField);
      const catalogEdited = CATALOG_GROUP_KEYS.some(changedInField);
      const localEdited = [...FIELD_GROUP_KEYS, ...CATALOG_GROUP_KEYS].some(changedInLocal);

      // —— 两边同改同组字段：两版都留下，等人重挑 ——
      if (fieldClash.length || catalogClash.length) {
        const clashKeys = [...fieldClash, ...catalogClash];
        const now = new Date().toISOString();

        ensureSpeaker(fieldSeg.speakerId);
        fieldSeg.tagIds.forEach(ensureTag);

        const fieldClone = clone(fieldSeg);
        fieldClone.id = uid("seg-fork");
        fieldClone.sourcePackageId = pkg.packageId;
        fieldClone.reviewed = false;
        fieldClone.originId = localSeg.originId ?? localSeg.id;
        fieldClone.conflict = conflictMeta(pkg.packageId, "field", fieldClone.id, localSeg.id, clashKeys, fieldSeg, localSeg, baseSeg, now);

        // 编目室版原样保留（含其已校对状态、关联与批注），仅挂上冲突标记
        localSeg.conflict = conflictMeta(pkg.packageId, "catalog", localSeg.id, fieldClone.id, clashKeys, fieldSeg, localSeg, baseSeg, now);

        const at = localTrack.segments.findIndex((item) => item.id === localSeg.id);
        localTrack.segments.splice(at + 1, 0, fieldClone);
        counts.conflicts++;
        rows.push(row(fieldTrack.id, baseSeg.id, "conflict", `两边都改了${clashKeys.map((key) => FIELD_LABELS[key]).join("、")}，已保留编目室版与现场版两版待重挑`, [localSeg.id, fieldClone.id]));
        continue;
      }

      // —— 无冲突，按字段归属自动合流 ——
      const localFieldKeys = FIELD_GROUP_KEYS.filter((key) => changedInLocal(key) && !changedInField(key));
      const localCatalogKeys = CATALOG_GROUP_KEYS.filter((key) => changedInLocal(key) && !changedInField(key));
      // 现场组：现场改过就听现场记录，否则编目室不动
      for (const key of FIELD_GROUP_KEYS) {
        if (changedInField(key)) {
          (localSeg as unknown as Record<string, unknown>)[key] = clone(fieldSeg[key]);
        }
      }
      localSeg.sourcePackageId = pkg.packageId;
      // 编目组（tagIds/comments/reviewed）：始终保留编目室版本，现场的同名改动不覆盖

      let outcome: PackageSegmentOutcome;
      let detail: string;
      if (fieldEdited && localEdited) {
        outcome = "merged-both";
        const localBits = [...localFieldKeys, ...localCatalogKeys].map((key) => FIELD_LABELS[key]);
        detail = `两边改了不同归属的字段：听辨项听现场，编目室保留项（${localBits.join("、") || "主题关联/批注/校对状态"}）维持原样`;
        counts.mergedBoth++;
      } else if (fieldEdited || catalogEdited) {
        outcome = "merged-field";
        const keys = [...FIELD_GROUP_KEYS.filter(changedInField), ...CATALOG_GROUP_KEYS.filter(changedInField)];
        detail = `现场改动已合入（${keys.map((key) => FIELD_LABELS[key]).join("、")}）；主题关联/批注/校对状态仍以编目室为准`;
        counts.mergedField++;
      } else if (localEdited) {
        outcome = "merged-catalog";
        detail = "只有编目室改动，现场未改，保留编目室版本";
        counts.mergedCatalog++;
      } else {
        outcome = "unchanged";
        detail = "两边均未改动";
        counts.unchanged++;
      }
      rows.push(row(fieldTrack.id, baseSeg.id, outcome, detail));
    }
  }

  return { merged, rows, deferred, counts, skipped };

  function pushDeferred(trackId: string, segmentId: string, reason: PackageDeferReason, detail: string) {
    deferred.push({ trackId, segmentId, reason, detail });
    counts.deferred++;
    rows.push(row(trackId, segmentId, reason, reason === "split" ? `已拆开/已并入：${detail}` : `整段不见：${detail}`));
  }
}

function conflictMeta(
  packageId: string,
  role: SegmentConflict["role"],
  selfId: string,
  pairedId: string,
  fields: string[],
  fieldSeg: Segment,
  localSeg: Segment,
  baseSeg: Segment,
  now: string,
): SegmentConflict {
  void selfId;
  return {
    packageId,
    role,
    fields: fields.map((key) => FIELD_LABELS[key] ?? key),
    pairedSegmentId: pairedId,
    fieldVersion: clone(fieldSeg),
    catalogVersion: clone(localSeg),
    baseVersion: clone(baseSeg),
    createdAt: now,
  };
}

function row(trackId: string, segmentId: string, outcome: PackageSegmentReport["outcome"], detail: string, conflictPair?: [string, string]): PackageSegmentReport {
  return { trackId, segmentId, outcome, detail, conflictPair };
}

// ---------- 重挑：在编目室版/现场版之间选定一版 ----------

export type ForkChoice = "catalog" | "field";

/**
 * 在姊妹片段之间重挑：保留 chosen 那一版（原样采用，包括它带来的编目/现场字段），
 * 删除另一版，清除冲突标记。segmentId 传两版中任意一版的 id 均可。
 * 返回一个可直接整体提交的新 project 拷贝。
 */
export function resolveSegmentFork(project: ProjectData, segmentId: string, choice: ForkChoice): ProjectData {
  const next = clone(project);
  let touched: { catalog?: Segment; field?: Segment } = {};
  for (const track of next.tracks) {
    for (const seg of track.segments) {
      if (!seg.conflict) continue;
      if (seg.id === segmentId || seg.conflict.pairedSegmentId === segmentId) {
        touched[seg.conflict.role] = seg;
      }
    }
  }
  const keeper = choice === "catalog" ? touched.catalog : touched.field;
  const discard = choice === "catalog" ? touched.field : touched.catalog;
  if (!keeper || !discard) throw new MergeValidationError("该片段没有待重挑的两版冲突");

  for (const track of next.tracks) {
    const index = track.segments.findIndex((seg) => seg.id === discard!.id);
    if (index >= 0) {
      track.segments.splice(index, 1);
      break;
    }
  }
  // 被选中的版本原样保留（含它自带的正文、关联与批注），仅清除冲突标记
  delete keeper.conflict;
  next.updatedAt = new Date().toISOString();
  return next;
}

export const pendingForks = (project: ProjectData): number =>
  project.tracks.flatMap((track) => track.segments).filter((seg) => seg.conflict).length / 2;

// ---------- 报告 ----------

export function buildReport(plan: MergePlan, appliedAt = new Date().toISOString()): MergeReport {
  return { appliedAt, counts: { ...plan.counts }, rows: plan.rows };
}

export function summarizeReport(report: MergeReport): string {
  const c = report.counts;
  const parts = [
    c.mergedField && `现场合入 ${c.mergedField}`,
    c.mergedBoth && `两边合流 ${c.mergedBoth}`,
    c.mergedCatalog && `仅编目室改动 ${c.mergedCatalog}`,
    c.added && `现场新增 ${c.added}`,
    c.conflicts && `待重挑 ${c.conflicts}`,
    c.unchanged && `未改动 ${c.unchanged}`,
    c.deferred && `搁置 ${c.deferred}`,
  ].filter(Boolean);
  return parts.join(" · ") || "没有需要并入的改动";
}
