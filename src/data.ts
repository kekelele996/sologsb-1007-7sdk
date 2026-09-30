import type { Confidence, ProjectData, Segment, Tag } from "./types";

export const uid = (prefix = "id") =>
  `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export const makeTag = (label: string, type: Tag["type"], color: string): Tag => ({
  id: uid("tag"),
  label,
  type,
  color,
});

const segment = (
  id: string,
  start: number,
  end: number,
  speakerId: string,
  text: string,
  confidence: Confidence,
  flags: Partial<Segment["flags"]> = {},
  tagIds: string[] = [],
  reviewed = false,
): Segment => ({
  id,
  start,
  end,
  speakerId,
  text,
  confidence,
  reviewed,
  flags: {
    lowConfidence: confidence <= 2,
    dialect: false,
    properNoun: false,
    ...flags,
  },
  tagIds,
  comments: [],
});

export const createSeedProject = (): ProjectData => {
  const topics = [
    makeTag("码头生活", "topic", "#2563eb"),
    makeTag("家族迁徙", "topic", "#7c3aed"),
    makeTag("抗战记忆", "event", "#dc2626"),
    makeTag("民间戏曲", "topic", "#0f766e"),
  ];
  const events = [
    makeTag("1938 年逃难", "event", "#b45309"),
    makeTag("1949 年返乡", "event", "#b45309"),
    makeTag("1956 年文艺汇演", "event", "#b45309"),
  ];
  const people = [
    makeTag("林阿婆", "person", "#be185d"),
    makeTag("陈师傅", "person", "#be185d"),
    makeTag("林有德", "person", "#be185d"),
  ];
  const tags = [...topics, ...events, ...people];
  const byLabel = (label: string) => tags.find((tag) => tag.label === label)?.id ?? "";

  return {
    id: "oral-history-1007",
    title: "榕城码头记忆：林阿婆访谈",
    interviewee: "林阿婆",
    recordingDate: "2026-08-18",
    activeTrackId: "track-zh",
    speakers: [
      { id: "sp-interviewer", name: "采访者", role: "研究者", color: "#2563eb" },
      { id: "sp-lin", name: "林阿婆", role: "口述人", color: "#be185d" },
      { id: "sp-chen", name: "陈师傅", role: "旁述人", color: "#0f766e" },
    ],
    tags,
    tracks: [
      {
        id: "track-zh",
        name: "普通话校订轨",
        language: "普通话",
        status: "校对中",
        segments: [
          segment(
            "seg-1",
            7.2,
            15.8,
            "sp-interviewer",
            "阿婆，您还记得小时候住在码头边，每天最早听见的是什么声音吗？",
            5,
            {},
            [byLabel("码头生活")],
            true,
          ),
          segment(
            "seg-2",
            16.4,
            32.9,
            "sp-lin",
            "天没亮就有拖板车的声音，咯吱咯吱。那时大家讲“起水”，就是趁潮水把货卸下来。",
            3,
            { dialect: true, properNoun: true },
            [byLabel("码头生活")],
          ),
          segment(
            "seg-3",
            33.8,
            49.6,
            "sp-lin",
            "我爸爸叫林有德，他原来在宁绍帮的船上做账房，后来日本飞机来了，全家坐小船往闽江上游走。",
            2,
            { lowConfidence: true, properNoun: true },
            [byLabel("家族迁徙"), byLabel("1938 年逃难"), byLabel("林有德")],
            true,
          ),
          segment(
            "seg-4",
            50.4,
            65.9,
            "sp-interviewer",
            "您说的“宁绍帮”，是来自宁波、绍兴一带的船帮吗？",
            5,
            {},
            [byLabel("家族迁徙")],
          ),
          segment(
            "seg-5",
            66.7,
            85.2,
            "sp-lin",
            "是咧。船上人讲的话我听得半懂，只记得他们会唱一种调子，后来才知道叫“甬剧”。",
            3,
            { dialect: true, properNoun: true },
            [byLabel("民间戏曲"), byLabel("码头生活")],
          ),
          segment(
            "seg-6",
            86.0,
            106.5,
            "sp-lin",
            "1949 年以后我们又回来，父亲不再跑船，在小学旁边修钟表。钟摆滴答滴答，比潮水准。",
            4,
            { dialect: true },
            [byLabel("家族迁徙"), byLabel("1949 年返乡")],
          ),
          segment(
            "seg-7",
            107.4,
            127.8,
            "sp-chen",
            "我补充一下，林师傅当年还替街坊修过一台德国座钟，后来这台钟捐给了区文化馆。",
            2,
            { lowConfidence: true, properNoun: true },
            [byLabel("林有德"), byLabel("码头生活")],
          ),
          segment(
            "seg-8",
            128.6,
            148.2,
            "sp-lin",
            "对，1956 年码头办文艺汇演，我穿蓝布衫上台唱《打猪草》。台下好多人，我紧张得忘了一句。",
            4,
            { dialect: true },
            [byLabel("民间戏曲"), byLabel("1956 年文艺汇演")],
          ),
        ],
      },
      {
        id: "track-fangyan",
        name: "方言原音轨",
        language: "福州话转写",
        status: "待校对",
        segments: [
          segment("fy-1", 16.4, 31.5, "sp-lin", "天未光就有拖车声，吱呀吱呀。彼时讲“起水”，趁潮水卸货。", 2, {
            dialect: true,
            lowConfidence: true,
          }, [byLabel("码头生活")]),
          segment("fy-2", 66.7, 84.1, "sp-lin", "是啦。船帮人讲的话我半听半猜，只记着伊侬唱调，后尾才知叫“甬剧”。", 3, {
            dialect: true,
            properNoun: true,
          }, [byLabel("民间戏曲"), byLabel("码头生活")]),
        ],
      },
      {
        id: "track-en",
        name: "英文字幕轨",
        language: "English",
        status: "待校对",
        segments: [
          segment("en-1", 7.2, 15.8, "sp-interviewer", "Grandma, what was the earliest sound you heard by the docks when you were a child?", 5, {}, [byLabel("码头生活")]),
          segment("en-2", 16.4, 32.9, "sp-lin", "Before dawn, carts creaked along the quay. People said “qi shui”, meaning unloading with the tide.", 4, {}, [byLabel("码头生活")]),
        ],
      },
    ],
    updatedAt: new Date().toISOString(),
  };
};
