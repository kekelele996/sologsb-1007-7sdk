import type { ProjectData, Segment, TranscriptTrack } from "./types";

/**
 * 现场采集包：平板离线校对后导出的项目快照。
 * base 是上次同步时的基线（两边共同的祖先），project 是现场侧改后的状态。
 * 合并时用 base 判断「同一片段两边是否都改过」。
 */
export const FIELD_PACKAGE_KIND = "oral-history-field-package";
export const FIELD_PACKAGE_SCHEMA = 1;

export interface FieldPackage {
  schema: 1;
  kind: typeof FIELD_PACKAGE_KIND;
  app: string;
  exportedAt: string;
  device?: string;
  /** 上次同步基线（共同祖先），用于三段合并判断双方改动 */
  base: ProjectData;
  /** 现场侧（平板）当前项目状态 */
  project: ProjectData;
}

/** 现场记录负责的字段：正文、发言人、起止时间、置信度 */
const FIELD_OWNED_FIELDS = ["text", "speakerId", "start", "end", "confidence"] as const;
/** 编目室负责的字段：主题关联、批注、已校对状态、校对标记 */
const CATALOG_OWNED_FIELDS = ["tagIds", "comments", "reviewed", "flags"] as const;

export type SetAsideReason = "missing" | "split" | "track-missing" | "duplicate";

export interface SegmentMerge {
  trackId: string;
  segmentId: string;
  kind: "clean" | "conflict" | "added";
  fieldSegment: Segment;
  catalogSegment: Segment | null;
  /** 按规则合并出的片段（现场字段听现场，编目字段留编目室） */
  mergedSegment: Segment;
  /** 现场侧相对基线是否改过 */
  fieldChanged: boolean;
  /** 编目室侧相对基线是否改过 */
  catalogChanged: boolean;
  /** 现场侧改了编目室负责的字段（批注/关联等），合并时按规则保留编目室 */
  fieldTouchedCatalogFields: boolean;
  /** 冲突时用户的重挑选择 */
  choice: "merged" | "field" | "catalog";
}

export interface SetAside {
  trackId: string;
  segmentId: string;
  reason: SetAsideReason;
  fieldSegment: Segment;
  detail: string;
}

export interface MergeResult {
  pkg: FieldPackage;
  catalogProject: ProjectData;
  segments: SegmentMerge[];
  setAsides: SetAside[];
}

export const reasonText: Record<SetAsideReason, string> = {
  missing: "整段不见",
  split: "已拆开",
  "track-missing": "轨道缺失",
  duplicate: "可能重复",
};

const pickFields = <T extends object, K extends readonly (keyof T)[]>(obj: T, keys: K): Partial<T> => {
  const out: Partial<T> = {};
  for (const key of keys) out[key] = obj[key];
  return out;
};

const changed = (a: Segment, b: Segment, keys: readonly (keyof Segment)[]) =>
  JSON.stringify(pickFields(a, keys)) !== JSON.stringify(pickFields(b, keys));

const changedAny = (a: Segment, b: Segment) =>
  JSON.stringify(a) !== JSON.stringify(b);

/** 归一化文本后判断两个片段是否一方为另一方的开头/结尾（拆分或合并留下的痕迹） */
const textOverlaps = (a: Segment, b: Segment) => {
  const na = a.text.replace(/\s+/g, "");
  const nb = b.text.replace(/\s+/g, "");
  if (!na || !nb || na === nb) return false;
  if (Math.min(na.length, nb.length) < 3) return false;
  return (
    na.startsWith(nb) ||
    nb.startsWith(na) ||
    na.endsWith(nb) ||
    nb.endsWith(na)
  );
};

/** 生成现场采集包：base 为同步基线，project 为当前状态 */
export function createFieldPackage(project: ProjectData, base?: ProjectData, device = "现场采集平板"): FieldPackage {
  return {
    schema: FIELD_PACKAGE_SCHEMA,
    kind: FIELD_PACKAGE_KIND,
    app: "sologsb-1007",
    exportedAt: new Date().toISOString(),
    device,
    base: structuredClone(base ?? project),
    project: structuredClone(project),
  };
}

export function parseFieldPackage(text: string): { ok: true; pkg: FieldPackage } | { ok: false; error: string } {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, error: "文件不是有效的 JSON，请重新选择采集包文件。" };
  }
  if (typeof data !== "object" || data === null) {
    return { ok: false, error: "采集包内容为空或已损坏，请重新选择文件。" };
  }
  const pkg = data as Partial<FieldPackage>;
  if (pkg.kind !== FIELD_PACKAGE_KIND) {
    return { ok: false, error: "该文件不是采集包（kind 不符）。请从现场平板导出采集包后再合并。" };
  }
  if (pkg.schema !== FIELD_PACKAGE_SCHEMA) {
    return { ok: false, error: "采集包 schema 版本不受支持，请用配套版本重新导出。" };
  }
  if (!pkg.base || !pkg.project) {
    return { ok: false, error: "采集包缺少基线或项目快照，无法判断两边是否同时修改，请重新导出采集包。" };
  }
  for (const label of ["base", "project"] as const) {
    const side = pkg[label];
    if (!Array.isArray(side?.tracks)) {
      return { ok: false, error: `采集包${label === "base" ? "基线" : "项目"}结构不完整（缺少轨道数据）。` };
    }
    for (const track of side.tracks) {
      if (!Array.isArray(track.segments)) {
        return { ok: false, error: `采集包${label === "base" ? "基线" : "项目"}轨道「${track.name ?? "未命名"}」缺少片段数据。` };
      }
      for (const seg of track.segments) {
        if (typeof seg?.id !== "string" || typeof seg?.text !== "string") {
          return { ok: false, error: `采集包${label === "base" ? "基线" : "项目"}中存在无法识别的片段，请重新导出。` };
        }
      }
    }
  }
  return { ok: true, pkg: pkg as FieldPackage };
}

/**
 * 计算合并结果（纯函数，不触碰任何存储）。
 * 规则：
 *  - 正文、发言人、起止时间、置信度听现场记录；
 *  - 主题关联、批注、已校对状态、校对标记以编目室为准；
 *  - 同一片段两边都改过 → 标记冲突，保留两版让人重挑；
 *  - 现场片段在编目室被拆开、整段不见或轨道缺失 → 先搁着，并不进结果。
 */
export function computeMerge(pkg: FieldPackage, catalogProject: ProjectData): MergeResult {
  const segments: SegmentMerge[] = [];
  const setAsides: SetAside[] = [];

  for (const ft of pkg.project.tracks) {
    const ct = catalogProject.tracks.find((track) => track.id === ft.id);
    for (const fs of ft.segments) {
      const bs = pkg.base.tracks.find((track) => track.id === ft.id)?.segments.find((seg) => seg.id === fs.id);

      if (!ct) {
        setAsides.push({
          trackId: ft.id,
          segmentId: fs.id,
          reason: "track-missing",
          fieldSegment: fs,
          detail: `采集包轨道「${ft.name}」在编目室不存在`,
        });
        continue;
      }

      const cs = ct.segments.find((seg) => seg.id === fs.id) ?? null;

      if (!bs) {
        // 基线中没有：现场侧新增片段
        if (cs) {
          setAsides.push({
            trackId: ft.id,
            segmentId: fs.id,
            reason: "duplicate",
            fieldSegment: fs,
            detail: "现场新增片段与编目室片段 id 相同，可能重复",
          });
        } else {
          segments.push({
            trackId: ft.id,
            segmentId: fs.id,
            kind: "added",
            fieldSegment: fs,
            catalogSegment: null,
            mergedSegment: structuredClone(fs),
            fieldChanged: true,
            catalogChanged: false,
            fieldTouchedCatalogFields: false,
            choice: "merged",
          });
        }
        continue;
      }

      if (!cs) {
        // 基线有、编目室没有：整段不见，或被拆/并后找不到原片段
        const splitOff = ct.segments.some((seg) => seg.id !== fs.id && textOverlaps(fs, seg));
        setAsides.push({
          trackId: ft.id,
          segmentId: fs.id,
          reason: splitOff ? "split" : "missing",
          fieldSegment: fs,
          detail: splitOff ? "编目室已拆开或合并，原片段无法对应" : "编目室整段不见",
        });
        continue;
      }

      // 两边都有该片段
      const fieldTouchedTranscription = changed(fs, bs, FIELD_OWNED_FIELDS);
      const fieldChangedAny = changedAny(fs, bs);
      const catalogChanged = changedAny(cs, bs);
      const fieldTouchedCatalog = changed(fs, bs, CATALOG_OWNED_FIELDS);
      const split = textOverlaps(fs, cs) && fs.text.replace(/\s+/g, "") !== cs.text.replace(/\s+/g, "");

      if (split) {
        setAsides.push({
          trackId: ft.id,
          segmentId: fs.id,
          reason: "split",
          fieldSegment: fs,
          detail: "编目室已拆分该片段，两侧结构不一致",
        });
        continue;
      }

      const merged = structuredClone(cs);
      if (fieldTouchedTranscription) {
        merged.text = fs.text;
        merged.speakerId = fs.speakerId;
        merged.start = fs.start;
        merged.end = fs.end;
        merged.confidence = fs.confidence;
      }

      segments.push({
        trackId: ft.id,
        segmentId: fs.id,
        kind: fieldChangedAny && catalogChanged ? "conflict" : "clean",
        fieldSegment: fs,
        catalogSegment: cs,
        mergedSegment: merged,
        fieldChanged: fieldTouchedTranscription,
        catalogChanged,
        fieldTouchedCatalogFields: fieldTouchedCatalog && !catalogChanged,
        choice: "merged",
      });
    }
  }

  return { pkg, catalogProject, segments, setAsides };
}

/** 更新冲突片段的重挑选择，返回新的结果（不可变） */
export function setConflictChoice(result: MergeResult, segmentId: string, choice: SegmentMerge["choice"]): MergeResult {
  return {
    ...result,
    segments: result.segments.map((sm) => (sm.segmentId === segmentId ? { ...sm, choice } : sm)),
  };
}

const insertSegmentByTime = (track: TranscriptTrack, segment: Segment) => {
  const index = track.segments.findIndex((item) => item.start > segment.start);
  if (index < 0) track.segments.push(segment);
  else track.segments.splice(index, 0, segment);
};

/**
 * 按重挑选择生成最终项目。整段不见/已拆开/轨道缺失的片段不在结果里，
 * 编目室未被采集包涉及的片段原样保留。
 */
export function buildMergedProject(result: MergeResult): ProjectData {
  const out = structuredClone(result.catalogProject);
  for (const sm of result.segments) {
    if (sm.kind === "added") {
      const track = out.tracks.find((item) => item.id === sm.trackId);
      if (track) insertSegmentByTime(track, structuredClone(sm.fieldSegment));
      continue;
    }
    const track = out.tracks.find((item) => item.id === sm.trackId);
    if (!track) continue;
    const index = track.segments.findIndex((item) => item.id === sm.segmentId);
    if (index < 0) continue;
    const choice = sm.kind === "conflict" ? sm.choice : "merged";
    if (choice === "field") {
      track.segments[index] = structuredClone(sm.fieldSegment);
    } else if (choice === "catalog" && sm.catalogSegment) {
      track.segments[index] = structuredClone(sm.catalogSegment);
    } else {
      track.segments[index] = structuredClone(sm.mergedSegment);
    }
  }
  return out;
}
