# 看视频

当前正式版：**v0.3.0**。声音转写尚未实现；QQ 联动需要配套补丁且仍待端到端验证。

让 N.E.K.O 实际读取视频关键帧，再根据画面回复你。0.2.0 直接调用 dsh-see-now 的原始 JavaScript 视频处理核心，替代 0.1.0 的简化 Python 实现。使用 N.E.K.O 官方 SDK 的 `@llm_tool`、`@plugin_entry` 和宿主图片通道；默认复用宿主现有视觉能力，包括免费版，无需单独配置插件模型。

## 使用

1. 安装 Node.js 20 或以上，使 `node` 在 PATH 上可用；也可在插件配置中设置 `video.node_path` 为可执行文件绝对路径。还需要系统里有 FFmpeg：市场规则不允许插件包携带二进制，所以请把 `ffmpeg` 装到 PATH，或把 `video.ffmpeg_path` 指向可执行文件。然后在插件中心启用「看视频」。默认 `video.analysis_backend = "host"`，不需要找模型配置入口，也不读取或复制主模型密钥。图片能否最终生成回复仍取决于宿主当前对话连接和视觉服务是否可用。
2. 发消息：`帮我看看这个视频，讲讲发生了什么：https://www.bilibili.com/video/BV...`，支持 `b23.tv` 短链接和 yt-dlp 支持的 HTTP 视频。
3. 配套 N.E.K.O 宿主的桌面页面可把 MP4/MKV/WebM/MOV 等视频拖到角色上；也可以在消息里提供本机视频绝对路径。视频附件上传上限 256 MiB，存于本机临时目录，24 小时后在下一次上传时清理，缓存上限 1 GiB。
4. 主模型可调用 `watch_video`；Agent 插件通道可调用 `video_reader.analyze`。结果返回当前对话，由角色自然表达。插件入口也可手动测试：

```json
{"source":"D:/videos/demo.mp4","question":"总结内容，告诉我你的看法","start_seconds":0,"seconds":120}
```

默认看前 300 秒（短于此范围的视频读至结尾），单次默认上限 300 秒（设置可调至 600 秒）。为控制单次模型请求，默认生成 24 张拼图后停止继续解码，并让上游完成已读帧的未来确认与尾部拼图；因此最终可能略多于 24 张，但不会丢弃已生成的图。长视频或触及拼图预算时，从返回的 `next_start_seconds` 继续看。返回明确的起止时间、总时长、采样帧数和 `partial`；Agent 详细结果还包含 `sheet_limit_reached`，不会声称逐帧完整观看。网站目前需要可下载的 HTTP(S) 视频流；直播、仅 HLS、DRM 和无法访问的视频不支持。B 站可能需要配置用户自己导出的 Netscape cookies 文件；不会读取浏览器 cookies。下载上限默认 256 MiB，临时下载在调用结束后删除。

### Steam 打包版运行

插件支持 Steam 打包宿主，不需要 N.E.K.O 源码或开发虚拟环境。下载网页视频时使用独立的 **Python 3.11+** 进程，绝不把 `projectneko_server.exe` 当成 Python 运行。安装系统 Python 后，插件自动从 PATH、Windows `py -3` 和 Python 安装注册表查找并验证解释器；也可设置 `video.python_path` 为真实 `python.exe` 的绝对路径。显式配置错误会直接报错，不会偷偷使用其他解释器。Python 仅用于网站下载；本地视频不需要这个额外解释器。

下载依赖从插件自带的 `vendor/` 加载，采用 Python 隔离模式，无需给系统 Python 安装宿主 SDK 或 yt-dlp。Node.js 20+ 和 FFmpeg 仍是抽帧必需的外部依赖，可用 `video.node_path`、`video.ffmpeg_path` 指定。未找到解释器、缺少插件依赖和平台拒绝下载分别返回明确错误。

可以直接发送「标题＋链接」或 `[标题](https://www.bilibili.com/video/BV...)`。Markdown 里的 `\&` 会还原，B 站跟踪参数会移除，分 P 等有意义参数保留。修改插件代码后请重启「看视频」插件（或重启 N.E.K.O）再测试。

### 免费版：处理完成后一次性概括

- 默认 `host` 模式：先下载并抽取当前范围内的关键帧，期间不向猫娘推送逐帧消息。所有已生成拼图按时间顺序合成，没有静默丢弃尾部拼图。
- Agent 入口 `analyze`：图片先通过 SDK 静默上传，全部成功后只发送一次 `respond` 请求，任务完成使用 `delivery="silent"`，不再触发第二次完成播报。结果中的 `status="submitted"` 只代表已提交宿主，不冒充模型生成成功。
- 主模型工具 `watch_video`：通过宿主工具返回值的图片通道续接当前回复，不另发主动消息。宿主工具通道最多接收 2 张合成图；Agent 通道最多 8 张。图片缩放可能影响小字辨识，不保证逐帧/字幕精确识别。使用宿主自带的 Pillow 图像处理能力，不下载二进制依赖。
- 不分析声音；超过时长或拼图预算会明确返回 `partial` 和续看位置。一次概括针对实际采样范围，不是假装看完任意长度视频。
- 可选独立模型模式：设置 `video.analysis_backend = "plugin_model"`，再在「插件 API」创建支持 `text` 和 `image_input` 的模型槽并绑定 `vision`。这仅供有独立模型需求的用户使用，不是免费版必需步骤。旧配置未写 `analysis_backend` 时自动使用宿主模式。

### 网络安全与模型请求预算

- 下载器仅使用受校验的 HTTP(S) 直连传输。每次实际连接（包括重定向、网页提取的媒体请求）都先解析、检查全部目标 IP，再连接同一次解析得到的数值地址；不会二次解析后连接未校验的地址。
- 禁止回环、内网、链路本地、多播和其他非公网目标，也拒绝带账号密码的 URL。下载进程不继承系统/环境代理；TUN fake-IP（如 `198.18.0.0/15`）无法验证真实目标，因此拒绝下载。遇到这种情况请使用返回真实公网 DNS 的直连网络，或上传本地视频；不能靠放开地址校验解决。
- 可选独立模型模式的视觉请求按完整 JSON 字节数分批，每批预算 12 MiB，低于宿主网关的 16 MiB 上限。每张已生成拼图都会被分析，多批结果再通过文本请求汇总；`vision_batches` 返回实际图片批次数。单张拼图超预算会明确提示降低 `video.quality`，不会静默丢图。任意批次失败或整体超时，不会把部分观察冒充为完整结论。

**当前分析画面，不转写音频。** 字幕只在画面清晰可见时由视觉模型理解。讲课、对白等依赖声音的内容可能无法完整总结。模型可能仍会识别错误，图片内的小字和快速瞬间也可能因缩放/采样丢失。

## 与 dsh-see-now 的关系

固定上游提交：`8a5490885d23feec8aff6b035af95465d172c1f2`。

`third_party/dsh-see-now/` 保存该提交的原始 `src/`、`test/`、包说明和许可证；92 个文件逐字节保存，SHA-256 记录于 `UPSTREAM.json`；唯一例外是 `src/indicator.py` 的一处 import 排版，见下文「本地补丁」。`upstream_bridge.mjs` 直接导入 `src/pipeline.js` 的 `createPipeline`，完整运行其依赖链：

- HSV 打分、运动补偿、相似构图弱切点与运动中切机位判断；
- 稳定背景/前景运动抑制，以及高分、低分候选的未来帧确认；
- 暗场亮度归一、黑边补偿、运动积分、去重和静态兜底；
- 自适应档位、尺寸分配、装箱、拆箱防重叠与原版 PNG 编码。

不改写上游算法源码，不覆写算法阈值（唯一例外是一处 import 排版，见「本地补丁」）。离线模式设置上游公开选项 `queueDepth: 0` 并持续取出拼图，避免实时模式丢掉旧图。FFmpeg 解码由宿主适配器管理，以支持时间范围、协议限制、超时和取消。默认与上游一致，每秒检查 12 帧、`low` 画布 798×450；可配置 `video.fps` 和 `video.quality`（low/standard/high/ultra）。图中编号由上游绘制，每张图的编号/原视频时间映射作为文字一同送给视觉模型。

此次完整复用的是视频识别、筛帧、拼图核心。DSH 的屏幕/摄像头采集界面、悬浮窗、常驻陪看和 ASR/TTS 宿主集成不由此插件启用；对话与反馈仍由 N.E.K.O 提供。

0.1.0 的 `max_frames` 已不再使用；升级后建议把旧配置 `fps = 3` 改为 `fps = 12`，新增 `max_sheets = 24`。未改配置时旧的低采样率仍会被尊重。费用取决于绑定的模型，不沿用上游特定模型的 token 估算。

许可证与改动说明见 `THIRD-PARTY-NOTICES.md`，上游原始 LICENSE/NOTICE 随包保留。

### 本地补丁（唯一一处）

插件市场的源码校验用 `ruff --isolated` 运行，`ruff.toml` 完全不生效，`extend-exclude` 里的 `third_party` 也就挡不住检查；而上游 `src/indicator.py` 的 import 排版不符合 I001。这是本仓库对上游源码的唯一改动：只把那 3 行 import 折成 1 行（116 列，未超 120），语义不变，且本插件运行时不加载该文件。改动前后的文本逐字记录在 `third_party/dsh-see-now/LOCAL-PATCHES.json`。

完整性测试会把本地文件套回 `upstream` 文本，再和 `UPSTREAM.json` 里那份上游哈希比对，因此补丁之外的任何改动都会失败。`tools/update_upstream.py` 每次抓取新提交后都会重放该补丁；上游原文一旦对不上就直接报错，不会悄悄产出一份哈希失配的文件。

## 构建与检查

```powershell
.venv/Scripts/python.exe -m plugin.neko_plugin_cli sync video_reader --clean
.venv/Scripts/python.exe -m pytest plugin/plugins/video_reader/tests
node --test --test-isolation=none plugin/plugins/video_reader/tests/upstream_bridge.test.mjs
.venv/Scripts/python.exe -m plugin.neko_plugin_cli check video_reader
.venv/Scripts/python.exe -m plugin.neko_plugin_cli build video_reader
```

`sync` 把 Python 依赖放入插件 `vendor/`，其中只有纯 Python 的 yt-dlp。FFmpeg 不随包（市场拒绝含二进制的包），运行时取 PATH 上的 `ffmpeg`，或配置 `video.ffmpeg_path`。Node.js 使用系统安装，不在插件包内捆绑。独立插件包包含视频分析功能；角色拖入视频的上传入口还需要 N.E.K.O 宿主对应的视频上传改动。QQ 等第三方渠道须把视频下载地址或文件路径提供给工具，仅有“一个视频”的文字计数不足以分析。

更新上游时使用 `python tools/update_upstream.py <完整提交SHA>`，再跑校验和、桥接一致性和上游回归测试。桥接一致性测试将同一批帧分别传给直接调用的上游核心和 N.E.K.O 适配器，比较每一张 PNG 的 SHA-256、关键帧决定、位置和统计；不是只检查代码是否导入了模块。该 Node 测试命令使用新版 Node 的 `--test-isolation=none`；较旧的 Node 20 可去掉该测试参数。

## Development / 独立仓库开发

插件源码由独立仓库 `n.e.k.o_plugin_video_reader` 管理，不属于 N.E.K.O 宿主 Git 仓库。推荐并列目录：

```text
NekoClaw/
├── N.E.K.O/                         # 宿主 / SDK
└── n.e.k.o_plugin_video_reader/      # 本仓库
```

当前本机源码路径：`D:\NekoClaw\n.e.k.o_plugin_video_reader`。
宿主的 `plugin/plugins/video_reader` 仅是指向本仓库的 Windows 目录联接，并在宿主 `.gitignore` 中忽略；不是源码副本，也不是 Git submodule。

在其他 Windows 开发机上，确认宿主目标路径**尚不存在**后，在本仓库根目录创建联接：

```powershell
New-Item -ItemType Junction -Path ../N.E.K.O/plugin/plugins/video_reader -Target (Get-Location).Path
```

不要使用宿主插件卸载/覆盖安装来管理这个开发联接；请从独立仓库维护源码。普通用户安装 `.neko-plugin` 包即可，不需要目录联接。

### 从独立仓库运行测试

需要已经安装依赖的 N.E.K.O 宿主 Python 环境，以及 Node.js 20+：

```powershell
& ../N.E.K.O/.venv/Scripts/python.exe -m pytest tests -q
& ../N.E.K.O/.venv/Scripts/python.exe -m ruff check .
node --test tests/upstream_bridge.test.mjs
```

测试会显式加载本仓库源码，不会误测宿主中安装的旧副本，也不要求已创建目录联接。宿主不在上述并列位置时，设置 `$env:NEKO_HOST_ROOT` 为宿主仓库绝对路径。宿主 SDK 和依赖不会复制进本仓库。

视频拖拽上传的路由、前端适配和上传测试属于宿主；独立插件包包含下载、抽帧、视觉分析及其测试。网络实测的临时产物、`vendor/`、缓存和构建包不提交。

When publishing to the plugin market, use this GitHub repository name:

发布到插件市场时，请使用以下 GitHub 仓库名：

プラグインマーケットへ公開する際は、次の GitHub リポジトリ名を使用してください：

```text
n.e.k.o_plugin_video_reader
```

From this plugin repository root:

```bash
uvx ruff==0.12.4 check --ignore-noqa --isolated --no-respect-gitignore --target-version py311 --line-length 120 --select E4,E7,E9,F,I --exclude vendor .
```

这是插件市场源码校验实际执行的命令，本地请原样照跑来复现。`--isolated` 让 `ruff.toml` 完全不生效（`vendor/` 之外的 `third_party/` 也要过），`--ignore-noqa` 让 `# noqa` 失效（所以不能用 noqa 压 E402）。日常开发可以改用 `--config ruff.toml`，那样 `vendor` 和 `third_party` 会被跳过，但发布前请按上面这条完整跑一遍。

From the N.E.K.O repository root / 在 N.E.K.O 仓库根目录中 / N.E.K.O リポジトリのルートで：

```bash
uv run neko-plugin sync video_reader --clean
uv run neko-plugin check video_reader
uv run neko-plugin check -r video_reader
```

Python runtime dependencies are declared in `pyproject.toml` and synced into
`vendor/` for packaging. The generated `vendor/` directory is not committed;
local builds and CI recreate it before release checks.

Python 运行时依赖声明在 `pyproject.toml` 中，并在打包时同步到 `vendor/`。
生成的 `vendor/` 不提交；本地构建和 CI 会在发布检查前重新生成它。

Python ランタイム依存関係は `pyproject.toml` に宣言し、パッケージ化時に
`vendor/` へ同期します。生成された `vendor/` はコミットせず、ローカルビルドと
CI が公開前チェックで再生成します。

## Market release / Market 发布 / Market 公開

Publish the version declared in `plugin.toml`. By default this pushes the Git
tag, waits for the standard GitHub Release, and notifies the plugin market.

发布 `plugin.toml` 中声明的版本。默认会推送 Git tag、等待标准 GitHub
Release，然后通知插件市场。

`plugin.toml` で宣言されたバージョンを公開します。既定では Git tag を
push し、標準 GitHub Release を待ってからプラグインマーケットへ通知します。

```bash
uv run neko-plugin publish video_reader
```

To run only one half explicitly / 如需仅执行一部分 / 一方のみを実行する場合:

```bash
uv run neko-plugin publish github video_reader
uv run neko-plugin publish market https://github.com/owner/repo/releases/tag/v0.1.0
```

The generated `.github/workflows/release.yml` builds and uploads
`video_reader.neko-plugin`. The market independently verifies that Release
before publishing it.

生成的 `.github/workflows/release.yml` 会构建并上传插件包；Market 会独立验证
该 Release 后再发布。

生成された `.github/workflows/release.yml` がプラグインパッケージをビルドして
アップロードし、Market はその Release を独立検証してから公開します。

## Entry

```toml
entry = "plugin.plugins.video_reader:VideoReaderPlugin"
```

## QQ 联动（Steam 打包版也适用）

QQ 集成插件需同时安装支持 `prepare_for_qq` 的视频适配器。本仓库 `integrations/qq_auto_reply/` 提供独立兼容补丁和基线说明，视频插件包不会自动修改 QQ 插件。**QQ 联动仍待真实端到端验证，不作为本版已验证的稳定能力承诺。**管理员在 QQ 中发送
“帮我看这个视频并总结：B站链接”后，流程为：公开视频链接下载/抽帧 → 宿主视觉配置分析 → 原 QQ 会话一次性回复概况。
不向桌面猫娘推送图片或进度；普通 QQ 图片、表情包的模型选择不受影响。

- 复用宿主视觉配置，免费版不需要另绑插件模型槽；宿主视觉服务不可用时明确报失败，不凭标题猜测。
- 沿用 QQ 插件工具白名单和实时会话权限，不自动扩大到所有人；每轮最多一个视频。
- QQ 专用入口只接受公开 HTTP(S) 链接（含 B 站标题分享文本、Markdown 链接），拒绝本地文件和 `neko-video:` 附件标识。
- 默认分析最多 300 秒的抽样画面（受配置上限限制），不分析声音；较长视频会说明观看范围，可下一轮指定 `start_seconds` 继续。
- 下载/抽帧最多等待 300 秒，独立画面分析最多 65 秒；取消或权限撤销后不主动补发。
- `prepare_for_qq` 返回图片数据用于插件间联动，不是桌面聊天入口；桌面仍用 `watch_video` / `analyze`。
