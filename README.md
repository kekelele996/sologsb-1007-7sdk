# 口述历史转写与标注编辑器

面向口述史项目的本地优先校对工作台。应用预置普通话校订轨、方言原音轨和英文字幕轨示例，可不依赖后端完成完整编辑闭环。

## 功能

- 导入 SRT、VTT 或每行 `[00:12] 文本` 格式的带时间码文本。
- 在多个转写轨之间切换，校正发言人、开始/结束时间、正文和 1—5 级置信度。
- 标记低置信词句、方言表达和专有名词；按文本光标比例拆分片段，或与下一片段合并。
- 把片段关联到主题、事件和人物，重复关联自动去重。
- 添加审校批注、逐条回复并标记解决状态。
- 支持 50 步撤销/重做，`Ctrl/Cmd+Z`、`Ctrl/Cmd+Shift+Z` 快捷键。
- 自动保存到 `localStorage`，刷新、关闭页面或断网后可继续编辑；`Ctrl/Cmd+S` 可立即保存。
- 使用 `BroadcastChannel` 与 `storage` 事件检测多标签页并发修改，不静默覆盖，由用户选择保留本页或载入另一标签页版本。
- 键盘校对：`J`/`↓` 下一片段，`K`/`↑` 上一片段，`R` 标记已校对，`M` 合并下一片段，`?` 打开快捷键帮助。
- 按当前轨道导出 SRT 字幕。

## 技术栈

- SolidStart 2 + SolidJS + TypeScript
- Kobalte（对话框、Tabs、Checkbox 等无障碍基础组件）
- Vite 8
- 浏览器 `localStorage`、`BroadcastChannel`
- nginx 静态部署

## 开发

需要 Node.js 24 或更高版本。

```bash
npm install
npm run dev
```

开发服务器地址以 Vite 输出为准。

## 构建与预览

```bash
npm run build
npm run preview
```

生产构建输出到 `dist/client`，其中包含可直接部署的 `index.html` 和静态资源。

## Docker

容器内由 nginx 监听 `80`，宿主端口按根端口表映射为 `10007`。

```bash
docker build -t sologsb-1007 .
docker run --rm -p 10007:80 sologsb-1007
```

访问 `http://localhost:10007`。

## 数据说明

项目、轨道、片段、批注和词条均保存在当前浏览器的 `localStorage` 中。只读预览或本地数据不会上传到服务器；清理浏览器站点数据会清除草稿。多标签冲突不会自动合并，以避免覆盖人工校对结果。
