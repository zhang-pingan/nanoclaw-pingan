# Assistant Quaternius Sci-Fi Scene

## 背景

桌面个人助手最早的虚拟形象是临时形态：在线机器人模型、手绘/procedural 兜底形象，以及一个独立的 online/offline 文本标签。这类实现能表达“有一个助手”，但在聊天窗口展开时缺少完整环境，也让连接状态、待处理事项、回复中等状态分散在多个 UI 层。

本次改动把助手升级为本地 Three.js 科幻小场景。默认形象从手绘/占位机器人转为 Quaternius Sci-Fi Essentials Kit 里的 EyeDrone，并在展开聊天时显示控制台、墙板、屏幕、箱子和设备。状态表达统一交给场景灯光、屏幕、状态环和模型动画，不再依赖独立 online/offline 标签。

## 目标

- 默认使用本地模型资源，不依赖在线 `RobotExpressive.glb`。
- compact 状态保持清晰的助手主体，适合 150px 左右的桌面悬浮入口。
- chat open / expanded 状态切到完整小场景：助手主体、控制台、墙板屏幕、箱子、柜子和设备同时进入构图。
- 新事项、回复中、离线等状态通过场景本身表达。
- 模型加载失败时不回退到手绘/procedural 机器人，只保留 Three.js 场景环境或外层静态 fallback。
- 仓库只提交运行所需的精选模型和贴图，不提交完整 ZIP 或临时解压目录。

## 资源方案
https://quaternius.com/packs/scifiessentialskit.html 
本地完整资源包:/tmp/nanoclaw-quaternius

本地资源位于：

```text
assistant/renderer/assets/scifi/
```

资源来源：

```text
Quaternius Sci-Fi Essentials Kit
license: CC0
```

当前精选资源包括：

- 助手主体：`Enemy_EyeDrone.gltf`、`Enemy_EyeDrone.bin`
- 控制台/桌面：`Prop_Desk_Medium.gltf`
- 场景道具：`Prop_Crate.gltf`、`Prop_Chest.gltf`、`Prop_Locker.gltf`、`Prop_Shelves_ThinTall.gltf`、`Prop_SatelliteDish.gltf`
- 对应贴图：`T_Enemies_*`、`T_Props_*`、`T_Trim_*`

贴图已缩放到 512px 级别，资源目录约 4.8MB。这样在桌面助手的小窗口里能保持足够观感，同时避免把原始大贴图直接打进仓库。

## Manifest

场景配置在：

```text
assistant/renderer/assets/scifi-scene.manifest.json
```

核心字段：

- `robotModel`: 本地 EyeDrone glTF 路径。
- `animations`: 将助手状态映射到 EyeDrone 动画。
- `palette`: 将助手状态映射到屏幕、状态环和灯光颜色。
- `props`: expanded 小场景里的本地 glTF 道具及位置、旋转、缩放。

当前动画映射：

```json
{
  "idle": "Idle",
  "attention": "Hit",
  "typing": "Charging",
  "offline": "Idle"
}
```

## Renderer 实现

主要实现文件：

```text
assistant/renderer/assistant-scene.ts
assistant/renderer/app.ts
assistant/renderer/index.html
assistant/renderer/styles.css
```

`AssistantScene` 负责：

- 用 `GLTFLoader` 加载 `robotModel`。
- 用同一个 `GLTFLoader` 加载 manifest 里的 `props`。
- 在重新加载 manifest 时清理旧模型和旧 props。
- 给 glTF mesh 设置 `castShadow` / `receiveShadow`。
- 创建程序化平台、状态环、控制台屏幕、背景墙板和提示条。
- 在 compact / expanded 之间平滑调整 camera、root scale 和位置。
- 在状态变化时切换动画、颜色、灯光强度和屏幕闪烁。

`app.ts` 仍把应用状态同步给场景：

```ts
scene?.update({
  connected: shell.classList.contains('connected'),
  attention: shell.classList.contains('attention'),
  chatOpen,
  typing: chatTyping,
});
```

其中 `connected` 只作为内部状态使用，不再渲染独立 online/offline 标签。

## 状态表达

状态优先级：

```text
offline > typing > attention > idle
```

状态行为：

- `idle`: 绿色状态环和屏幕光，EyeDrone 播放 `Idle`。
- `attention`: 橙色状态，屏幕和状态灯闪烁更明显，EyeDrone 播放 `Hit`，提示有新事项。
- `typing`: 蓝色状态，屏幕脉冲，提示条扫描，EyeDrone 播放 `Charging`，同时增加轻微 hover / tilt。
- `offline`: 灰色状态，屏幕 emissive 降低，主光、环境光和边缘光整体变暗，EyeDrone 仍保持 `Idle`。

原先独立的 online/offline 标签已经移除，因为离线/在线可由场景灯光和状态色表达。

## Compact 与 Expanded 构图

compact：

- 聚焦助手主体。
- 隐藏控制台、墙板、道具组。
- camera 更近，适配桌面悬浮入口的小尺寸。

expanded：

- 展示完整小场景。
- 显示控制台、背景墙板、屏幕提示条和所有 props。
- camera 拉远，root scale 调整，让助手和环境同时进入 156px 展开区域。

聊天面板打开状态由 `chatOpen` 驱动，`app.ts` 在打开/收起聊天时调用 `syncScene()`，`AssistantScene.update()` 将其映射为 `compact` 或 `expanded`。

## 回退策略

当前不再使用手绘/procedural robot 兜底。模型或 manifest 加载失败时：

- 清理已经加载的机器人模型和 props。
- 保留 Three.js 程序化场景环境。
- 构造 `AssistantScene` 失败时，外层仍可显示静态图片 fallback。

这样可以避免在本地资源异常时又出现旧的手绘机器人形象。

## 验证

修改场景实现或资源清单后至少运行：

```bash
npm run build:assistant
npx tsc --noEmit --target ES2022 --module NodeNext --moduleResolution NodeNext --lib ES2022,DOM --skipLibCheck assistant/renderer/app.ts assistant/renderer/assistant-scene.ts
npm run typecheck
```

资源引用检查：

```bash
node -e "const fs=require('fs'); const path=require('path'); const dir='assistant/renderer/assets/scifi'; const missing=[]; for (const file of fs.readdirSync(dir).filter(f=>f.endsWith('.gltf'))) { const j=JSON.parse(fs.readFileSync(path.join(dir,file),'utf8')); const uris=[]; for (const image of j.images||[]) if (image.uri) uris.push(image.uri); for (const buffer of j.buffers||[]) if (buffer.uri) uris.push(buffer.uri); for (const uri of uris) if (!fs.existsSync(path.join(dir,uri))) missing.push(file+' -> '+uri); } if (missing.length) { console.error(missing.join('\n')); process.exit(1); } console.log('all glTF dependencies present');"
```

最终验收还应包含一次真实 Electron 渲染检查，确认 compact 和 expanded 下 canvas 非空、本地资产可加载、场景没有明显遮挡或空白。
