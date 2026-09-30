export type Confidence = 1 | 2 | 3 | 4 | 5;

export interface Reply {
  id: string;
  author: string;
  body: string;
  createdAt: string;
}

export interface ReviewComment {
  id: string;
  author: string;
  body: string;
  createdAt: string;
  resolved: boolean;
  replies: Reply[];
}

export interface Speaker {
  id: string;
  name: string;
  role: string;
  color: string;
}

export interface Tag {
  id: string;
  label: string;
  type: "topic" | "event" | "person";
  color: string;
}

export interface SegmentConflict {
  /** 触发冲突的采集包 */
  packageId: string;
  /** 本条留存的是哪一版：catalog=编目室版，field=现场版 */
  role: "catalog" | "field";
  /** 两边都改动且取值不同的字段中文名 */
  fields: string[];
  /** 另一版姊妹片段 id，重挑后会被删除 */
  pairedSegmentId: string;
  fieldVersion: Segment;
  catalogVersion: Segment;
  baseVersion: Segment | null;
  createdAt: string;
}

export interface Segment {
  id: string;
  start: number;
  end: number;
  speakerId: string;
  text: string;
  confidence: Confidence;
  reviewed: boolean;
  flags: {
    lowConfidence: boolean;
    dialect: boolean;
    properNoun: boolean;
  };
  tagIds: string[];
  comments: ReviewComment[];
  /** 血缘：最初由哪个片段拆分/继承而来，用于识别“编目室已拆开” */
  originId?: string;
  /** 血缘：直接由哪个片段拆分而来 */
  splitFromId?: string;
  /** 血缘：合并时并入本段的其他片段 id */
  mergedFromIds?: string[];
  /** 由哪个现场采集包合并产生 */
  sourcePackageId?: string;
  /** 两边同改、两版并存等待人工重挑时存在 */
  conflict?: SegmentConflict;
}

export interface TranscriptTrack {
  id: string;
  name: string;
  language: string;
  status: "待校对" | "校对中" | "已完成";
  segments: Segment[];
}

export interface ProjectData {
  id: string;
  title: string;
  interviewee: string;
  recordingDate: string;
  activeTrackId: string;
  speakers: Speaker[];
  tags: Tag[];
  tracks: TranscriptTrack[];
  updatedAt: string;
}

export interface PersistedEnvelope {
  schema: 1;
  revision: number;
  tabId: string;
  savedAt: number;
  project: ProjectData;
}

export type PackageSegmentOutcome =
  | "merged-field"      // 现场版听辨字段有改动，已按现场记录合入
  | "merged-catalog"    // 只有编目室改动，保留编目室版本
  | "merged-both"       // 两边改的是不同权限组字段，已按规则自动合流
  | "conflict"          // 两边同改同组字段，两版均保留待重挑
  | "unchanged"         // 两边都没动
  | "added";            // 现场新增片段

export type PackageDeferReason = "split" | "missing";

export interface PackageSegmentReport {
  trackId: string;
  segmentId: string;
  outcome: PackageSegmentOutcome | PackageDeferReason;
  detail: string;
  conflictPair?: [string, string];
  skippedOnRetry?: boolean;
}

export interface MergeReport {
  appliedAt: string;
  counts: {
    mergedField: number;
    mergedCatalog: number;
    mergedBoth: number;
    conflicts: number;
    unchanged: number;
    added: number;
    deferred: number;
  };
  rows: PackageSegmentReport[];
}

/** 下发给平板的离线采集包：base=共同基准，field=平板离线校对稿 */
export interface CollectionPackage {
  schema: 1;
  packageId: string;
  baseRevision: number;
  exportedAt: string;
  collectorName: string;
  base: ProjectData;
  field: ProjectData;
}

export interface InboxPackage {
  pkg: CollectionPackage;
  receivedAt: string;
  status: "pending" | "merged";
  /** 每次执行（含重试）的完整报告，最新一条在末尾 */
  reports: MergeReport[];
  /** 尚未并入的片段 id（已拆开或整段不见而搁置），重试时只处理这些 */
  deferred: Array<{ trackId: string; segmentId: string; reason: PackageDeferReason; detail: string }>;
}
