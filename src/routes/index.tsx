import { Checkbox } from "@kobalte/core/checkbox";
import { Dialog } from "@kobalte/core/dialog";
import { Tabs } from "@kobalte/core/tabs";
import {
  For,
  Show,
  batch,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  untrack,
} from "solid-js";
import { createSeedProject, uid } from "../data";
import {
  downloadText,
  formatTime,
  loadInbox,
  loadProject,
  parseTime,
  saveInbox,
  saveProject,
} from "../persistence";
import {
  MergeValidationError,
  buildReport,
  createCollectionPackage,
  parseCollectionPackage,
  planMerge,
  resolveSegmentFork,
  summarizeReport,
  type MergePlan,
} from "../sync";
import type {
  Confidence,
  InboxPackage,
  PackageSegmentReport,
  PersistedEnvelope,
  ProjectData,
  Segment,
  TranscriptTrack,
} from "../types";

const CHANNEL_NAME = "sologsb-1007-editor";
const TAB_ID = uid("tab");

const OUTCOME_LABELS: Record<PackageSegmentReport["outcome"], string> = {
  "merged-field": "听现场",
  "merged-catalog": "留编目室",
  "merged-both": "两边合流",
  conflict: "两版待挑",
  unchanged: "未改动",
  added: "现场新增",
  split: "已搁置·拆开",
  missing: "已搁置·不见",
};

function statusText(status: "saved" | "saving" | "offline") {
  if (status === "saving") return "正在保存";
  if (status === "offline") return "离线草稿";
  return "已自动保存";
}

function parseTimedTranscript(input: string, trackName: string): TranscriptTrack {
  const blocks = input.trim().split(/\n\s*\n/);
  const segments: Segment[] = [];
  const srtPattern = /(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})/;
  const bracketPattern = /^\[?(\d{1,2}:\d{2}(?::\d{2})?)\]?\s*[-–]?\s*(.*)$/;

  for (const rawBlock of blocks) {
    const lines = rawBlock.split("\n").map((line) => line.trim()).filter(Boolean);
    if (!lines.length) continue;
    const srtIndex = lines.findIndex((line) => srtPattern.test(line));
    if (srtIndex >= 0) {
      const match = srtPattern.exec(lines[srtIndex]);
      const text = lines.slice(srtIndex + 1).join(" ");
      const speakerName = text.match(/^([^：:]{1,10})[：:]/)?.[1];
      segments.push({
        id: uid("seg"),
        start: parseTime(match?.[1] ?? "0"),
        end: parseTime(match?.[2] ?? "1"),
        speakerId: speakerName ? "sp-custom" : "sp-interviewer",
        text: text.replace(/^[^：:]{1,10}[：:]\s*/, ""),
        confidence: 3,
        reviewed: false,
        flags: { lowConfidence: false, dialect: false, properNoun: false },
        tagIds: [],
        comments: [],
      });
      continue;
    }
    for (const line of lines) {
      const match = bracketPattern.exec(line);
      if (!match) continue;
      const start = parseTime(match[1]);
      const text = match[2];
      const speakerName = text.match(/^([^：:]{1,10})[：:]/)?.[1];
      segments.push({
        id: uid("seg"),
        start,
        end: start + Math.max(3, text.length / 5),
        speakerId: speakerName ? "sp-custom" : "sp-interviewer",
        text: text.replace(/^[^：:]{1,10}[：:]\s*/, ""),
        confidence: 3,
        reviewed: false,
        flags: { lowConfidence: false, dialect: false, properNoun: false },
        tagIds: [],
        comments: [],
      });
    }
  }

  if (!segments.length && input.trim()) {
    input.split("\n").map((line) => line.trim()).filter(Boolean).forEach((text, index) => {
      segments.push({
        id: uid("seg"),
        start: index * 6,
        end: index * 6 + 5.4,
        speakerId: "sp-interviewer",
        text,
        confidence: 3,
        reviewed: false,
        flags: { lowConfidence: false, dialect: false, properNoun: false },
        tagIds: [],
        comments: [],
      });
    });
  }

  return {
    id: uid("track"),
    name: trackName || "导入轨",
    language: "待识别",
    status: "待校对",
    segments,
  };
}

export default function OralHistoryEditor() {
  const loaded = loadProject();
  const [project, setProject] = createSignal<ProjectData>(loaded.project);
  const [revision, setRevision] = createSignal(loaded.revision);
  const [past, setPast] = createSignal<ProjectData[]>([]);
  const [future, setFuture] = createSignal<ProjectData[]>([]);
  const [selectedId, setSelectedId] = createSignal(loaded.project.tracks[0]?.segments[0]?.id ?? "");
  const [saveStatus, setSaveStatus] = createSignal<"saved" | "saving" | "offline">("saved");
  const [lastAction, setLastAction] = createSignal("示例项目已就绪");
  const [conflict, setConflict] = createSignal<PersistedEnvelope | null>(null);
  const [online, setOnline] = createSignal(true);
  const [helpOpen, setHelpOpen] = createSignal(false);
  const [commentDraft, setCommentDraft] = createSignal("");
  const [replyDrafts, setReplyDrafts] = createSignal<Record<string, string>>({});
  const [trackFilter, setTrackFilter] = createSignal<"all" | "unreviewed" | "low" | "forks">("all");
  const [inbox, setInbox] = createSignal<InboxPackage[]>([]);
  const [mergeTarget, setMergeTarget] = createSignal<InboxPackage | null>(null);
  const [mergePlan, setMergePlan] = createSignal<MergePlan | null>(null);
  const [mergeError, setMergeError] = createSignal("");
  const [exportOpen, setExportOpen] = createSignal(false);
  const [collectorName, setCollectorName] = createSignal("");
  const [lastMergeSummary, setLastMergeSummary] = createSignal("");
  let editorRef: HTMLTextAreaElement | undefined;
  let fileInputRef: HTMLInputElement | undefined;
  let packageInputRef: HTMLInputElement | undefined;
  let saveTimer: number | undefined;
  let hydrated = false;
  let dirty = false;

  const channel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel(CHANNEL_NAME) : null;
  const activeTrack = createMemo(() => {
    const data = project();
    return data.tracks.find((track) => track.id === data.activeTrackId) ?? data.tracks[0];
  });
  const activeSegment = createMemo(() => activeTrack()?.segments.find((item) => item.id === selectedId()) ?? null);
  const visibleSegments = createMemo(() => {
    const segments = activeTrack()?.segments ?? [];
    if (trackFilter() === "unreviewed") return segments.filter((segment) => !segment.reviewed);
    if (trackFilter() === "low") return segments.filter((segment) => segment.confidence <= 2 || segment.flags.lowConfidence);
    if (trackFilter() === "forks") return segments.filter((segment) => segment.conflict);
    return segments;
  });
  const completedPercent = createMemo(() => {
    const segments = project().tracks.flatMap((track) => track.segments);
    if (!segments.length) return 0;
    return Math.round((segments.filter((segment) => segment.reviewed).length / segments.length) * 100);
  });
  const speakerById = (speakerId: string) =>
    project().speakers.find((speaker) => speaker.id === speakerId) ?? project().speakers[0];
  const tagById = (tagId: string) => project().tags.find((tag) => tag.id === tagId);

  const commit = (label: string, mutate: (draft: ProjectData) => void, baseOverride?: ProjectData) => {
    const current = structuredClone(project());
    const next = structuredClone(baseOverride ?? current);
    if (!baseOverride) mutate(next);
    next.updatedAt = new Date().toISOString();
    batch(() => {
      setPast((items) => [...items.slice(-49), current]);
      setFuture([]);
      setProject(next);
      setRevision((value) => value + 1);
      setLastAction(label);
    });
    dirty = true;
  };

  const commitSegment = (label: string, mutate: (segment: Segment, draft: ProjectData) => void) => {
    const id = selectedId();
    commit(label, (draft) => {
      const track = draft.tracks.find((item) => item.id === draft.activeTrackId);
      const segment = track?.segments.find((item) => item.id === id);
      if (segment) mutate(segment, draft);
    });
  };

  const undo = () => {
    const stack = past();
    if (!stack.length) return;
    const previous = stack[stack.length - 1];
    setFuture((items) => [structuredClone(project()), ...items].slice(0, 50));
    setPast(stack.slice(0, -1));
    setProject(previous);
    setRevision((value) => value + 1);
    setLastAction("已撤销上一步");
    dirty = true;
  };

  const redo = () => {
    const stack = future();
    if (!stack.length) return;
    const next = stack[0];
    setPast((items) => [...items.slice(-49), structuredClone(project())]);
    setFuture(stack.slice(1));
    setProject(next);
    setRevision((value) => value + 1);
    setLastAction("已重做");
    dirty = true;
  };

  const switchTrack = (trackId: string) => {
    commit("切换文本轨", (draft) => {
      draft.activeTrackId = trackId;
      selectedIdSet(draft.tracks.find((track) => track.id === trackId)?.segments[0]?.id ?? "");
    });
  };

  const selectedIdSet = (id: string) => setSelectedId(id);

  const moveSelection = (direction: 1 | -1) => {
    const segments = activeTrack()?.segments ?? [];
    if (!segments.length) return;
    const index = Math.max(0, segments.findIndex((segment) => segment.id === selectedId()));
    const nextIndex = (index + direction + segments.length) % segments.length;
    setSelectedId(segments[nextIndex].id);
    document.getElementById(`segment-${segments[nextIndex].id}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  };

  const splitSelection = () => {
    const segment = activeSegment();
    if (!segment || segment.text.trim().length < 2) return;
    const cursor = editorRef?.selectionStart ?? Math.floor(segment.text.length / 2);
    const safeCursor = Math.max(1, Math.min(cursor, segment.text.length - 1));
    const firstText = segment.text.slice(0, safeCursor).trim();
    const secondText = segment.text.slice(safeCursor).trim();
    if (!firstText || !secondText) return;
    const ratio = firstText.length / segment.text.length;
    const boundary = segment.start + (segment.end - segment.start) * ratio;
    const secondId = uid("seg");
    commitSegment("拆分片段", (current, draft) => {
      const original = structuredClone(current);
      current.text = firstText;
      current.end = Number(boundary.toFixed(1));
      // 血缘：两半共享 originId，供采集包合并时识别“编目室已拆开”
      const originId = current.originId ?? current.id;
      current.originId = originId;
      const trackIndex = draft.tracks.findIndex((track) => track.id === draft.activeTrackId);
      if (trackIndex >= 0) {
        const segmentIndex = draft.tracks[trackIndex].segments.findIndex((item) => item.id === current.id);
        draft.tracks[trackIndex].segments.splice(segmentIndex + 1, 0, {
          ...original,
          id: secondId,
          start: Number(boundary.toFixed(1)),
          text: secondText,
          reviewed: false,
          comments: [],
          originId,
          splitFromId: current.id,
          conflict: undefined,
        });
      }
      setSelectedId(secondId);
    });
  };

  const mergeWithNext = () => {
    const track = activeTrack();
    const segment = activeSegment();
    if (!track || !segment) return;
    const index = track.segments.findIndex((item) => item.id === segment.id);
    const next = track.segments[index + 1];
    if (!next) return;
    commitSegment("合并下一片段", (current, draft) => {
      current.text = `${current.text.trim()} ${next.text.trim()}`;
      current.end = next.end;
      current.tagIds = [...new Set([...current.tagIds, ...next.tagIds])];
      current.comments.push(...next.comments);
      current.confidence = Math.min(current.confidence, next.confidence) as Confidence;
      // 血缘：记录被吞并的片段（含其全部前身），供采集包合并时识别“已并入”
      current.mergedFromIds = [
        ...new Set([...(current.mergedFromIds ?? []), next.id, ...(next.mergedFromIds ?? [])]),
      ];
      if (next.originId) current.originId = current.originId ?? next.originId;
      const sourceTrack = draft.tracks.find((item) => item.id === draft.activeTrackId);
      sourceTrack?.segments.splice(index + 1, 1);
      current.reviewed = false;
      current.conflict = undefined;
    });
  };

  const toggleFlag = (flag: keyof Segment["flags"]) => {
    commitSegment("修改校对标记", (segment) => {
      segment.flags[flag] = !segment.flags[flag];
      segment.reviewed = false;
    });
  };

  const setConfidence = (confidence: Confidence) => {
    commitSegment("校正置信度", (segment) => {
      segment.confidence = confidence;
      segment.flags.lowConfidence = confidence <= 2;
      segment.reviewed = false;
    });
  };

  const addComment = () => {
    const body = commentDraft().trim();
    if (!body) return;
    commitSegment("添加批注", (segment) => {
      segment.comments.unshift({
        id: uid("comment"),
        author: "当前校对员",
        body,
        createdAt: new Date().toISOString(),
        resolved: false,
        replies: [],
      });
      segment.reviewed = false;
    });
    setCommentDraft("");
  };

  const addReply = (commentId: string) => {
    const body = (replyDrafts()[commentId] ?? "").trim();
    if (!body) return;
    commitSegment("回复批注", (segment) => {
      const comment = segment.comments.find((item) => item.id === commentId);
      comment?.replies.push({
        id: uid("reply"),
        author: "当前校对员",
        body,
        createdAt: new Date().toISOString(),
      });
    });
    setReplyDrafts((drafts) => ({ ...drafts, [commentId]: "" }));
  };

  const toggleComment = (commentId: string) => {
    commitSegment("更新批注状态", (segment) => {
      const comment = segment.comments.find((item) => item.id === commentId);
      if (comment) comment.resolved = !comment.resolved;
    });
  };

  const toggleTag = (tagId: string) => {
    commitSegment("更新主题关联", (segment) => {
      segment.tagIds = segment.tagIds.includes(tagId)
        ? segment.tagIds.filter((id) => id !== tagId)
        : [...segment.tagIds, tagId];
      segment.reviewed = false;
    });
  };

  const exportSrt = () => {
    const lines = activeTrack().segments.map((segment, index) => {
      const speaker = speakerById(segment.speakerId)?.name ?? "未知";
      return `${index + 1}\n${formatTime(segment.start)} --> ${formatTime(segment.end)}\n${speaker}：${segment.text}\n`;
    });
    downloadText(`${project().title}-${activeTrack().name}.srt`, lines.join("\n"), "application/x-subrip;charset=utf-8");
  };

  const importFile = async (file: File) => {
    const text = await file.text();
    const imported = parseTimedTranscript(text, file.name.replace(/\.[^.]+$/, ""));
    if (!imported.segments.length) {
      setLastAction("未识别到带时间码的文本");
      return;
    }
    commit("导入转写文本", (draft) => {
      draft.tracks.push(imported);
      draft.activeTrackId = imported.id;
      setSelectedId(imported.segments[0].id);
    });
  };

  const resolveConflict = (useIncoming: boolean) => {
    const incoming = conflict();
    if (!incoming) return;
    if (useIncoming) {
      setPast((items) => [...items.slice(-49), structuredClone(project())]);
      setProject(structuredClone(incoming.project));
      setRevision(incoming.revision + 1);
      setSelectedId(incoming.project.tracks.find((track) => track.id === incoming.project.activeTrackId)?.segments[0]?.id ?? "");
      setLastAction("已采用其他标签页的版本");
      dirty = true;
    } else {
      setRevision((value) => value + 1);
      setLastAction("已保留本页并覆盖冲突版本");
      dirty = true;
    }
    setConflict(null);
  };

  // ---------- 平板采集包：下发 / 收件箱 / 合并 ----------

  const refreshInbox = () => setInbox(loadInbox());

  const exportPackage = () => {
    const pkg = createCollectionPackage(project(), revision(), collectorName());
    downloadText(
      `采集包-${project().title}-${pkg.packageId}.json`,
      JSON.stringify(pkg, null, 2),
      "application/json;charset=utf-8",
    );
    setExportOpen(false);
    setCollectorName("");
    setLastAction("已生成采集包，平板可离线校对后再带回合并");
  };

  const importPackage = async (file: File) => {
    try {
      const pkg = parseCollectionPackage(await file.text());
      const current = loadInbox();
      if (!current.some((item) => item.pkg.packageId === pkg.packageId)) {
        // 两边改动各自先存着：进入收件箱暂存，不触碰编目稿
        const entry: InboxPackage = {
          pkg,
          receivedAt: new Date().toISOString(),
          status: "pending",
          reports: [],
          deferred: [],
        };
        saveInbox([...current, entry]);
        refreshInbox();
        setLastAction(`已暂存采集员「${pkg.collectorName}」的采集包，待编目室合并`);
      } else {
        setLastAction("该采集包已在收件箱中，未重复导入");
      }
    } catch (error) {
      setLastAction(error instanceof MergeValidationError ? error.message : "采集包读取失败");
    }
  };

  const planFor = (entry: InboxPackage): MergePlan =>
    planMerge(project(), entry.pkg, entry.status === "merged" ? new Set(entry.deferred.map((item) => item.segmentId)) : undefined);

  const openMergeDialog = (entry: InboxPackage) => {
    setMergeError("");
    try {
      setMergePlan(planFor(entry));
      setMergeTarget(entry);
    } catch (error) {
      setMergeError(error instanceof Error ? error.message : "合并规划失败");
    }
  };

  /**
   * 原子提交：先在内存里完成整份规划（planMerge 不产生副作用），
   * 再依次写收件箱与编目稿；任一步失败就回滚收件箱、不更新草稿，绝不只并一半。
   */
  const applyMerge = () => {
    const entry = mergeTarget();
    const plan = mergePlan();
    if (!entry || !plan) return;
    const previousInbox = loadInbox();
    let committedProject: ProjectData;
    try {
      const report = buildReport(plan);
      const nextEntry: InboxPackage = {
        ...entry,
        status: "merged",
        reports: [...entry.reports, report],
        deferred: plan.deferred,
      };
      const otherEntries = previousInbox.filter((item) => item.pkg.packageId !== entry.pkg.packageId);
      committedProject = structuredClone(plan.merged);
      committedProject.updatedAt = new Date().toISOString();
      saveInbox([...otherEntries, nextEntry]);
      saveProject(committedProject, revision() + 1, TAB_ID);
    } catch (error) {
      // 编目稿保存失败时回滚收件箱，两边状态回到合并之前，可原样重试
      saveInbox(previousInbox);
      setMergeError(error instanceof Error ? `合并失败，未改动草稿：${error.message}` : "合并失败，未改动草稿");
      return;
    }
    setPast((items) => [...items.slice(-49), structuredClone(project())]);
    setFuture([]);
    setProject(committedProject);
    setRevision((value) => value + 1);
    setInbox(loadInbox());
    setLastMergeSummary(`「${entry.pkg.collectorName}」采集包：${summarizeReport(buildReport(plan))}`);
    setLastAction(`已合并采集包：${summarizeReport(buildReport(plan))}`);
    dirty = false;
    setMergeTarget(null);
    setMergePlan(null);
  };

  const chooseForkVersion = (segmentId: string, choice: "catalog" | "field") => {
    try {
      const next = resolveSegmentFork(project(), segmentId, choice);
      commit(
        choice === "catalog" ? "采用编目室版，现场版已移除" : "采用现场版，编目室版已移除",
        () => {},
        next,
      );
    } catch (error) {
      setLastAction(error instanceof Error ? error.message : "重挑失败");
    }
  };

  const removeInboxEntry = (packageId: string) => {
    const next = loadInbox().filter((item) => item.pkg.packageId !== packageId);
    saveInbox(next);
    setInbox(next);
    if (mergeTarget()?.pkg.packageId === packageId) {
      setMergeTarget(null);
      setMergePlan(null);
    }
    setLastAction("已从收件箱移除采集包（编目稿未受影响）");
  };

  onMount(() => {
    hydrated = true;
    refreshInbox();
    const handleOnline = () => setOnline(true);
    const handleOffline = () => setOnline(false);
    const handleStorage = (event: StorageEvent) => {
      if (event.key !== "sologsb-1007-project-v1" || !event.newValue) return;
      try {
        const incoming = JSON.parse(event.newValue) as PersistedEnvelope;
        if (incoming.tabId !== TAB_ID && incoming.revision > revision()) setConflict(incoming);
      } catch {
        // Ignore unrelated or malformed storage events.
      }
    };
    const handleKeydown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const editing = target?.matches("input, textarea, select, [contenteditable='true']");
      const command = event.metaKey || event.ctrlKey;
      if (command && event.key.toLowerCase() === "z") {
        event.preventDefault();
        event.shiftKey ? redo() : undo();
        return;
      }
      if (command && event.key.toLowerCase() === "s") {
        event.preventDefault();
        const envelope = saveProject(project(), revision(), TAB_ID);
        setSaveStatus("saved");
        setLastAction("已保存本地草稿");
        channel?.postMessage(envelope);
        return;
      }
      if (editing) return;
      if (event.key === "j" || event.key === "ArrowDown") {
        event.preventDefault();
        moveSelection(1);
      } else if (event.key === "k" || event.key === "ArrowUp") {
        event.preventDefault();
        moveSelection(-1);
      } else if (event.key.toLowerCase() === "m") {
        event.preventDefault();
        mergeWithNext();
      } else if (event.key.toLowerCase() === "r" && activeSegment()) {
        event.preventDefault();
        commitSegment("标记片段已校对", (segment) => { segment.reviewed = true; });
      } else if (event.key === "?" || (event.shiftKey && event.key === "/")) {
        event.preventDefault();
        setHelpOpen(true);
      }
    };
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    window.addEventListener("storage", handleStorage);
    window.addEventListener("keydown", handleKeydown);
    setOnline(navigator.onLine);
    onCleanup(() => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
      window.removeEventListener("storage", handleStorage);
      window.removeEventListener("keydown", handleKeydown);
    });
  });

  channel?.addEventListener("message", (event: MessageEvent<PersistedEnvelope>) => {
    if (event.data.tabId !== TAB_ID && event.data.revision > revision()) setConflict(event.data);
  });

  createEffect(() => {
    const current = project();
    const currentRevision = revision();
    if (!hydrated) return;
    setSaveStatus(online() ? "saving" : "offline");
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      const envelope = saveProject(current, currentRevision, TAB_ID);
      setSaveStatus(online() ? "saved" : "offline");
      if (dirty) {
        channel?.postMessage(envelope);
        dirty = false;
      }
    }, 420);
  });

  onCleanup(() => {
    window.clearTimeout(saveTimer);
    channel?.close();
  });

  const clickSegment = (id: string) => {
    setSelectedId(id);
    queueMicrotask(() => editorRef?.focus());
  };

  const MergePreview = () => {
    const entry = mergeTarget();
    const plan = mergePlan();
    if (!entry || !plan) return <Dialog.Title>正在规划合并…</Dialog.Title>;
    const c = plan.counts;
    const trackName = (trackId: string) =>
      entry.pkg.field.tracks.find((track) => track.id === trackId)?.name ??
      project().tracks.find((track) => track.id === trackId)?.name ??
      trackId;
    return (
      <>
        <Dialog.Title>合并采集包 · {entry.pkg.collectorName}</Dialog.Title>
        <Dialog.Description>
          以下发基准（{new Date(entry.pkg.exportedAt).toLocaleDateString()}）逐条三向比对；确认后整包原子合入，失败可重试，不会只并一半。
        </Dialog.Description>
        <div class="merge-counts">
          <span class="mc-field">听现场 {c.mergedField + c.mergedBoth}</span>
          <span class="mc-add">新增 {c.added}</span>
          <span class="mc-catalog">留编目室 {c.mergedCatalog}</span>
          <span class="mc-conflict">两版待挑 {c.conflicts}</span>
          <span class="mc-defer">搁置 {c.deferred}</span>
          <span class="mc-skip">未动 {c.unchanged}{plan.skipped ? `（重试跳过 ${plan.skipped}）` : ""}</span>
        </div>
        <div class="merge-rows">
          <For each={plan.rows}>
            {(r) => (
              <div class={`merge-row merge-${r.outcome}`}>
                <span class="merge-badge">{OUTCOME_LABELS[r.outcome]}</span>
                <span class="merge-track">{trackName(r.trackId)} · {r.segmentId}</span>
                <span class="merge-detail">{r.detail}</span>
              </div>
            )}
          </For>
        </div>
        <Show when={plan.deferred.length}>
          <p class="merge-defer-note">
            {plan.deferred.length} 段因编目室已拆开 / 整段不见而搁置，保留在本采集包中；待编目稿处理后点「重试搁置段」即可再并。
          </p>
        </Show>
        <Show when={mergeError()}><p class="merge-error">{mergeError()}</p></Show>
        <div class="dialog-footer">
          <button class="btn btn-quiet" onClick={() => { setMergeTarget(null); setMergePlan(null); setMergeError(""); }}>
            {entry.status === "merged" && !plan.deferred.length ? "关闭" : "取消"}
          </button>
          <button
            class="btn btn-primary"
            disabled={entry.status === "merged" && !plan.deferred.length}
            onClick={applyMerge}
          >
            {entry.status === "merged"
              ? plan.deferred.length
                ? `重试合并 ${plan.deferred.length} 个搁置段`
                : "已全部并入"
              : `确认合并（${c.conflicts ? "冲突两版并存" : "自动合流"}）`}
          </button>
        </div>
      </>
    );
  };

  return (
    <div class="app-shell">
      <Show when={conflict()}>
        {(incoming) => (
          <div class="conflict-banner" role="alert">
            <div>
              <strong>检测到另一个标签页修改了同一草稿</strong>
              <span>
                对方版本保存于 {new Date(incoming().savedAt).toLocaleTimeString()}。为避免静默覆盖，请选择要保留的版本。
              </span>
            </div>
            <div class="conflict-actions">
              <button class="btn btn-quiet" onClick={() => resolveConflict(false)}>保留本页</button>
              <button class="btn btn-danger" onClick={() => resolveConflict(true)}>载入对方版本</button>
            </div>
          </div>
        )}
      </Show>

      <header class="topbar">
        <div class="brand-mark" aria-hidden="true"><span>口述</span><b>1007</b></div>
        <div class="project-heading">
          <input
            aria-label="项目标题"
            value={project().title}
            onChange={(event) => commit("修改项目标题", (draft) => { draft.title = event.currentTarget.value; })}
          />
          <div class="project-meta">
            <span>{project().interviewee}</span>
            <span>{project().recordingDate}</span>
            <span class={`save-state ${saveStatus()}`}>{statusText(saveStatus())}</span>
          </div>
        </div>
        <div class="top-actions">
          <span class={`network-chip ${online() ? "online" : "offline"}`}>{online() ? "在线" : "离线可编辑"}</span>
          <button class="icon-btn" title="撤销 Ctrl/Cmd+Z" disabled={!past().length} onClick={undo}>↶</button>
          <button class="icon-btn" title="重做 Ctrl/Cmd+Shift+Z" disabled={!future().length} onClick={redo}>↷</button>
          <button class="btn btn-quiet" onClick={() => setHelpOpen(true)}>快捷键 <kbd>?</kbd></button>
          <button class="btn btn-primary" onClick={exportSrt}>导出 SRT</button>
        </div>
      </header>

      <div class="workspace">
        <aside class="left-panel">
          <section class="panel-section overview-card">
            <div class="eyebrow">校对进度</div>
            <div class="progress-row">
              <strong>{completedPercent()}%</strong>
              <span>{project().tracks.flatMap((track) => track.segments).filter((segment) => segment.reviewed).length} / {project().tracks.flatMap((track) => track.segments).length} 片段</span>
            </div>
            <div class="progress-track"><i style={{ width: `${completedPercent()}%` }} /></div>
            <p>修改会自动保存在本机；断网后仍可继续校对。</p>
          </section>

          <section class="panel-section">
            <div class="section-title"><h2>文本轨道</h2><span>{project().tracks.length}</span></div>
            <div class="track-list">
              <For each={project().tracks}>
                {(track) => (
                  <button class={`track-card ${track.id === project().activeTrackId ? "active" : ""}`} onClick={() => switchTrack(track.id)}>
                    <span class="track-icon">{track.language === "English" ? "EN" : track.language === "福州话转写" ? "方" : "普"}</span>
                    <span class="track-info"><strong>{track.name}</strong><small>{track.segments.length} 段 · {track.status}</small></span>
                    <span class="track-dot" style={{ background: track.status === "已完成" ? "#15803d" : track.status === "校对中" ? "#d97706" : "#94a3b8" }} />
                  </button>
                )}
              </For>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept=".srt,.txt,.vtt"
              hidden
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                if (file) void importFile(file);
                event.currentTarget.value = "";
              }}
            />
            <button class="wide-action" onClick={() => fileInputRef?.click()}><span>＋</span> 导入带时间码文本</button>
            <div class="hint">支持 SRT / VTT / 每行 `[00:12] 文本`</div>
          </section>

          <section class="panel-section inbox-section">
            <div class="section-title"><h2>平板采集包</h2><span>{inbox().length}</span></div>
            <div class="inbox-actions">
              <button class="wide-action" onClick={() => setExportOpen(true)}><span>⇪</span> 下发采集包给平板</button>
              <button class="wide-action" onClick={() => packageInputRef?.click()}><span>⇩</span> 接入平板校对稿</button>
            </div>
            <input
              ref={packageInputRef}
              type="file"
              accept=".json,application/json"
              hidden
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                if (file) void importPackage(file);
                event.currentTarget.value = "";
              }}
            />
            <div class="inbox-list">
              <For each={inbox()} fallback={<div class="mini-empty">收件箱为空。平板接上网后，把校对稿采集包接入这里。</div>}>
                {(entry) => {
                  const last = () => entry.reports[entry.reports.length - 1];
                  return (
                    <article class={`inbox-card ${entry.status === "pending" ? "pending" : ""}`}>
                      <header>
                        <strong>{entry.pkg.collectorName}</strong>
                        <span class={`inbox-state ${entry.status}`}>{entry.status === "pending" ? "待合并" : entry.deferred.length ? "部分搁置" : "已合并"}</span>
                      </header>
                      <small>下发 {new Date(entry.pkg.exportedAt).toLocaleString()}</small>
                      <small>接入 {new Date(entry.receivedAt).toLocaleString()}</small>
                      <Show when={last()}>
                        {(report) => (
                          <p class="inbox-summary">
                            {summarizeReport(report())}
                            <Show when={entry.deferred.length}>
                              <em>（{entry.deferred.length} 段搁置，可重试）</em>
                            </Show>
                          </p>
                        )}
                      </Show>
                      <div class="inbox-buttons">
                        <button class="btn btn-primary" onClick={() => openMergeDialog(entry)}>
                          {entry.status === "pending"
                            ? "查看并合并"
                            : entry.deferred.length
                              ? `重试搁置段（${entry.deferred.length}）`
                              : "查看上次合并报告"}
                        </button>
                        <button class="btn btn-quiet" title="移出收件箱（不影响编目稿）" onClick={() => removeInboxEntry(entry.pkg.packageId)}>移除</button>
                      </div>
                    </article>
                  );
                }}
              </For>
            </div>
            <div class="hint">导入先进收件箱暂存，两边改动都不丢；确认后才原子合并。</div>
          </section>

          <section class="panel-section tag-summary">
            <div class="section-title"><h2>标注实体</h2><span>{project().tags.length}</span></div>
            <div class="legend">
              <span><i style={{ background: "#2563eb" }} />主题</span>
              <span><i style={{ background: "#b45309" }} />事件</span>
              <span><i style={{ background: "#be185d" }} />人物</span>
            </div>
            <p>在右侧“标注”页把当前片段关联到主题、事件和人物。</p>
          </section>
        </aside>

        <main class="transcript-panel">
          <div class="panel-toolbar">
            <div>
              <div class="eyebrow">当前轨道</div>
              <h1>{activeTrack().name}</h1>
            </div>
            <div class="filters" role="group" aria-label="片段筛选">
              <button class={trackFilter() === "all" ? "active" : ""} onClick={() => setTrackFilter("all")}>全部</button>
              <button class={trackFilter() === "unreviewed" ? "active" : ""} onClick={() => setTrackFilter("unreviewed")}>未校对</button>
              <button class={trackFilter() === "low" ? "active" : ""} onClick={() => setTrackFilter("low")}>低置信</button>
              <button class={trackFilter() === "forks" ? "active" : ""} onClick={() => setTrackFilter("forks")}>待重挑</button>
            </div>
          </div>

          <div class="transcript-list" role="listbox" aria-label="转写片段">
            <For each={visibleSegments()}>
              {(segment, index) => (
                <article
                  id={`segment-${segment.id}`}
                  role="option"
                  aria-selected={segment.id === selectedId()}
                  class={`segment-card ${segment.id === selectedId() ? "selected" : ""} ${segment.reviewed ? "reviewed" : ""} ${segment.conflict ? "forked" : ""}`}
                  onClick={() => clickSegment(segment.id)}
                >
                  <div class="segment-rail" style={{ background: speakerById(segment.speakerId)?.color ?? "#64748b" }} />
                  <div class="segment-time">
                    <span>{formatTime(segment.start, false)}</span>
                    <small>{formatTime(segment.end, false)}</small>
                  </div>
                  <div class="segment-body">
                    <div class="segment-meta">
                      <b>{speakerById(segment.speakerId)?.name ?? "未知发言人"}</b>
                      <span class={`confidence c${segment.confidence}`}>置信 {segment.confidence}/5</span>
                      <Show when={segment.flags.lowConfidence}><span class="pill alert">低置信</span></Show>
                      <Show when={segment.flags.dialect}><span class="pill dialect">方言</span></Show>
                      <Show when={segment.flags.properNoun}><span class="pill proper">专名</span></Show>
                      <Show when={segment.reviewed}><span class="pill done">✓ 已校对</span></Show>
                      <Show when={segment.conflict}>
                        <span class="pill fork">{segment.conflict!.role === "catalog" ? "编目室版" : "现场版"} · 待重挑</span>
                      </Show>
                    </div>
                    <p>{segment.text}</p>
                    <Show when={segment.conflict}>
                      <div class="fork-strip" onClick={(event) => event.stopPropagation()}>
                        <span>两边都改了：{segment.conflict!.fields.join("、")}，两版并存</span>
                        <div class="fork-actions">
                          <button
                            class={`fork-pick ${segment.conflict!.role === "catalog" ? "chosen" : ""}`}
                            onClick={() => chooseForkVersion(segment.id, "catalog")}
                          >
                            采用编目室版
                          </button>
                          <button
                            class={`fork-pick field ${segment.conflict!.role === "field" ? "chosen" : ""}`}
                            onClick={() => chooseForkVersion(segment.id, "field")}
                          >
                            采用现场版
                          </button>
                        </div>
                      </div>
                    </Show>
                    <div class="segment-tags">
                      <For each={segment.tagIds.map(tagById).filter(Boolean)}>
                        {(tag) => <span style={{ "--tag-color": tag!.color } as any}>#{tag!.label}</span>}
                      </For>
                    </div>
                  </div>
                  <span class="segment-index">{index() + 1}</span>
                </article>
              )}
            </For>
            <Show when={!visibleSegments().length}>
              <div class="empty-state"><b>没有符合筛选条件的片段</b><span>切换到“全部”继续校对。</span></div>
            </Show>
          </div>
        </main>

        <aside class="inspector">
          <Show when={activeSegment()} fallback={<div class="empty-inspector"><b>选择一个片段</b><p>在中间列表点击片段后即可校正发言人、置信度、标记和批注。</p></div>}>
            {(segment) => (
              <Tabs defaultValue="correct" class="inspector-tabs">
                <Tabs.List class="tab-list">
                  <Tabs.Trigger value="correct">校对</Tabs.Trigger>
                  <Tabs.Trigger value="annotate">标注</Tabs.Trigger>
                  <Tabs.Trigger value="comments">批注 <span>{segment().comments.length}</span></Tabs.Trigger>
                </Tabs.List>

                <Tabs.Content value="correct" class="tab-content">
                  <Show when={segment().conflict}>
                    <div class="inspector-fork">
                      <header>
                        <strong>两版待重挑 · {segment().conflict!.fields.join("、")}</strong>
                        <span>当前这版是{segment().conflict!.role === "catalog" ? "编目室版" : "现场版"}，姊妹片段就在列表相邻位置</span>
                      </header>
                      <div class="fork-compare">
                        <div class={segment().conflict!.role === "catalog" ? "is-self" : ""}>
                          <i>编目室版</i>
                          <b>{speakerById(segment().conflict!.catalogVersion.speakerId)?.name ?? "未知发言人"}</b>
                          <time>{formatTime(segment().conflict!.catalogVersion.start, false)} – {formatTime(segment().conflict!.catalogVersion.end, false)}</time>
                          <p>{segment().conflict!.catalogVersion.text}</p>
                        </div>
                        <div class={segment().conflict!.role === "field" ? "is-self" : ""}>
                          <i>现场版</i>
                          <b>{speakerById(segment().conflict!.fieldVersion.speakerId)?.name ?? "未知发言人"}</b>
                          <time>{formatTime(segment().conflict!.fieldVersion.start, false)} – {formatTime(segment().conflict!.fieldVersion.end, false)}</time>
                          <p>{segment().conflict!.fieldVersion.text}</p>
                        </div>
                      </div>
                      <div class="fork-actions">
                        <button class="btn btn-quiet" onClick={() => chooseForkVersion(segment().id, "catalog")}>采用编目室版</button>
                        <button class="btn btn-primary" onClick={() => chooseForkVersion(segment().id, "field")}>采用现场版</button>
                      </div>
                    </div>
                  </Show>
                  <div class="inspector-heading">
                    <div><span>片段 {activeTrack().segments.findIndex((item) => item.id === segment().id) + 1}</span><strong>{formatTime(segment().start, false)} — {formatTime(segment().end, false)}</strong></div>
                    <button class={`review-button ${segment().reviewed ? "done" : ""}`} onClick={() => commitSegment("标记片段已校对", (item) => { item.reviewed = true; })}>
                      {segment().reviewed ? "✓ 已校对" : "标记已校对"}
                    </button>
                  </div>

                  <label class="field-label" for="speaker-select">发言人</label>
                  <select
                    id="speaker-select"
                    value={segment().speakerId}
                    onChange={(event) => commitSegment("校正发言人", (item) => { item.speakerId = event.currentTarget.value; item.reviewed = false; })}
                  >
                    <For each={project().speakers}>{(speaker) => <option value={speaker.id}>{speaker.name} · {speaker.role}</option>}</For>
                  </select>

                  <div class="time-grid">
                    <label>开始<input type="text" value={formatTime(segment().start)} onChange={(event) => commitSegment("修改开始时间", (item) => { item.start = parseTime(event.currentTarget.value); })} /></label>
                    <label>结束<input type="text" value={formatTime(segment().end)} onChange={(event) => commitSegment("修改结束时间", (item) => { item.end = parseTime(event.currentTarget.value); })} /></label>
                  </div>

                  <label class="field-label" for="transcript-editor">转写文本</label>
                  <textarea
                    id="transcript-editor"
                    ref={editorRef}
                    rows="7"
                    value={segment().text}
                    onChange={(event) => commitSegment("校正转写文本", (item) => { item.text = event.currentTarget.value; item.reviewed = false; })}
                  />
                  <div class="textarea-help">光标停在句中后点击“拆分”，系统会保留两侧时间码比例。</div>

                  <div class="field-label">置信度</div>
                  <div class="confidence-picker" role="radiogroup" aria-label="置信度">
                    <For each={[1, 2, 3, 4, 5] as Confidence[]}>
                      {(value) => <button class={segment().confidence === value ? "active" : ""} onClick={() => setConfidence(value)}>{value}</button>}
                    </For>
                  </div>

                  <div class="field-label">校对标记</div>
                  <div class="flag-list">
                    <Checkbox checked={segment().flags.lowConfidence} onChange={() => toggleFlag("lowConfidence")} class="flag-row">
                      <Checkbox.Input />
                      <Checkbox.Control><Checkbox.Indicator>✓</Checkbox.Indicator></Checkbox.Control>
                      <Checkbox.Label>低置信词或句</Checkbox.Label>
                    </Checkbox>
                    <Checkbox checked={segment().flags.dialect} onChange={() => toggleFlag("dialect")} class="flag-row">
                      <Checkbox.Input />
                      <Checkbox.Control><Checkbox.Indicator>✓</Checkbox.Indicator></Checkbox.Control>
                      <Checkbox.Label>方言表达</Checkbox.Label>
                    </Checkbox>
                    <Checkbox checked={segment().flags.properNoun} onChange={() => toggleFlag("properNoun")} class="flag-row">
                      <Checkbox.Input />
                      <Checkbox.Control><Checkbox.Indicator>✓</Checkbox.Indicator></Checkbox.Control>
                      <Checkbox.Label>专有名词</Checkbox.Label>
                    </Checkbox>
                  </div>

                  <div class="split-actions">
                    <button onClick={splitSelection}>⌁ 按光标拆分</button>
                    <button disabled={activeTrack().segments.at(-1)?.id === segment().id} onClick={mergeWithNext}>合 合并下一段</button>
                  </div>
                </Tabs.Content>

                <Tabs.Content value="annotate" class="tab-content">
                  <div class="content-title"><h3>关联主题、事件与人物</h3><p>一个片段可关联多个实体，复核后颜色会显示在列表中。</p></div>
                  <For each={project().tags}>
                    {(tag) => (
                      <button class={`tag-option ${segment().tagIds.includes(tag.id) ? "selected" : ""}`} onClick={() => toggleTag(tag.id)}>
                        <i style={{ background: tag.color }} />
                        <span><strong>#{tag.label}</strong><small>{tag.type === "topic" ? "主题" : tag.type === "event" ? "事件" : "人物"}</small></span>
                        <b>{segment().tagIds.includes(tag.id) ? "✓" : "＋"}</b>
                      </button>
                    )}
                  </For>
                </Tabs.Content>

                <Tabs.Content value="comments" class="tab-content comments-content">
                  <div class="content-title"><h3>批注与回复</h3><p>批注不会改写原文，可保留校对依据并继续讨论。</p></div>
                  <div class="comment-compose">
                    <textarea rows="3" placeholder="记录读音、词义或专名依据…" value={commentDraft()} onInput={(event) => setCommentDraft(event.currentTarget.value)} />
                    <button class="btn btn-primary" onClick={addComment}>添加批注</button>
                  </div>
                  <For each={segment().comments} fallback={<div class="mini-empty">当前片段还没有批注。</div>}>
                    {(comment) => (
                      <article class={`comment-card ${comment.resolved ? "resolved" : ""}`}>
                        <header><strong>{comment.author}</strong><time>{new Date(comment.createdAt).toLocaleString()}</time></header>
                        <p>{comment.body}</p>
                        <For each={comment.replies}>
                          {(reply) => <div class="reply"><b>{reply.author}</b><span>{reply.body}</span></div>}
                        </For>
                        <div class="reply-row">
                          <input
                            value={replyDrafts()[comment.id] ?? ""}
                            placeholder="回复…"
                            onInput={(event) => setReplyDrafts((drafts) => ({ ...drafts, [comment.id]: event.currentTarget.value }))}
                            onKeyDown={(event) => { if (event.key === "Enter") addReply(comment.id); }}
                          />
                          <button onClick={() => addReply(comment.id)}>回复</button>
                        </div>
                        <button class="resolve-link" onClick={() => toggleComment(comment.id)}>{comment.resolved ? "重新打开" : "标记已解决"}</button>
                      </article>
                    )}
                  </For>
                </Tabs.Content>
              </Tabs>
            )}
          </Show>
        </aside>
      </div>

      <footer class="statusbar">
        <span>最近操作：{lastAction()}</span>
        <Show when={lastMergeSummary()}><span class="merge-summary">{lastMergeSummary()}</span></Show>
        <span>版本 {revision() + 1} · 本地草稿</span>
        <span class="status-shortcuts">J/K 浏览　R 已校对　M 合并　? 帮助</span>
      </footer>

      <Dialog open={exportOpen()} onOpenChange={setExportOpen}>
        <Dialog.Portal>
          <Dialog.Overlay class="dialog-overlay" />
          <Dialog.Content class="dialog-content">
            <Dialog.Title>下发采集包给平板</Dialog.Title>
            <Dialog.Description>
              采集包内置当前编目稿作为共同基准，平板可完全离线校对；接回网络后从「接入平板校对稿」导入合并。
            </Dialog.Description>
            <label class="field-label" for="collector-name">现场采集员</label>
            <input
              id="collector-name"
              value={collectorName()}
              placeholder="如：小林（码头组）"
              onInput={(event) => setCollectorName(event.currentTarget.value)}
            />
            <p class="dialog-note">包内含当前修订号 {revision() + 1} 与全部 {project().tracks.length} 条轨道的快照。</p>
            <div class="dialog-footer">
              <button class="btn btn-quiet" onClick={() => setExportOpen(false)}>取消</button>
              <button class="btn btn-primary" onClick={exportPackage}>生成并下载采集包</button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog>

      <Dialog open={!!mergeTarget()} onOpenChange={(open) => !open && (setMergeTarget(null), setMergePlan(null), setMergeError(""))}>
        <Dialog.Portal>
          <Dialog.Overlay class="dialog-overlay" />
          <Dialog.Content class="dialog-content merge-dialog">
            {mergeTarget() ? <MergePreview /> : <Dialog.Title>正在规划合并…</Dialog.Title>}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog>

      <Dialog open={helpOpen()} onOpenChange={setHelpOpen}>
        <Dialog.Portal>
          <Dialog.Overlay class="dialog-overlay" />
          <Dialog.Content class="dialog-content">
            <Dialog.Title>键盘校对</Dialog.Title>
            <Dialog.Description>光标在输入框中时，单键快捷键不会抢占文字输入。</Dialog.Description>
            <div class="shortcut-grid">
              <span><kbd>J</kbd><kbd>↓</kbd> 下一片段</span>
              <span><kbd>K</kbd><kbd>↑</kbd> 上一片段</span>
              <span><kbd>R</kbd> 标记已校对</span>
              <span><kbd>M</kbd> 合并下一片段</span>
              <span><kbd>Ctrl/⌘ Z</kbd> 撤销</span>
              <span><kbd>Ctrl/⌘ ⇧ Z</kbd> 重做</span>
              <span><kbd>Ctrl/⌘ S</kbd> 立即保存</span>
              <span><kbd>?</kbd> 显示本帮助</span>
            </div>
            <div class="dialog-footer"><button class="btn btn-primary" onClick={() => setHelpOpen(false)}>开始校对</button></div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog>
    </div>
  );
}
