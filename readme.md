# koishi-plugin-chatluna-guard

[![npm](https://img.shields.io/npm/v/koishi-plugin-chatluna-guard?style=flat-square)](https://www.npmjs.com/package/koishi-plugin-chatluna-guard)

ChatLuna 辅助插件：按用户维度的对话配额（支持峰谷时段）、选择性不回复（规则防刷屏 + 可选判官小模型）、夜间防护与分段发送随机延迟。

与主插件的 `chat_time_limit`（按会话计次）互补：本插件按 **platform + userId 跨会话计数**，
并能在"轰炸"场景下让机器人**闭嘴**——无论是硬规则（短时间内消息过多）还是软判断（小模型审核）。

## 功能

### ① 用户配额（链中间件，精确计次）
- 每小时 / 每天两级限额，私聊与群聊独立配置，`0` 为不限
- 小时窗口为**固定滑动窗口**：距窗口起点满 1 小时清零；天窗口为 **0 点自然日**
- 只统计**真正进入对话链**的消息：被防刷屏/其他插件拒掉的、后台 agent/角色调用（invocation）
  均不计数，也不消耗 token；纯指令流会计数（与主插件 `chat_time_limit` 同口径），但不参与判官
- **豁免**：指定用户、指定群、所有群整体豁免；豁免用户同时不受防刷屏与判官约束
- **权限分级限额**（tiers）：按用户 authority 命中最高一档覆盖基础限额
- **超限提示且只提示一次**（notifyOnce）：受限期间首次收到文案提示，之后静默拒绝，不反复弹
- **峰谷时段**（`timeQuota`）：按 HH:mm 时段覆盖配额，支持跨零点；未填 `-1` 的维度继续使用权限档/基础配额
- **配额按模型请求计**：消息队列把多条消息合并成一次请求时只算 1 次

### ② 规则防刷屏（零模型调用）
- 计数点是 `guard_spam_count`（`transform_chat_message` 之后、`message_delay` **之前**）：只统计**会触发回复的单条消息**，
  群聊里没 @ 机器人、纯闲聊的消息不计数（`scope: all` 才覆盖群聊，默认 `direct` 只管私聊）
- **消息队列合并前的每条都算**：5 条合并成 1 次模型请求时，配额只算 1 次，但防刷屏算 5 条
- `message_delay` 之后还有 `guard_spam_gate` 再查一次静默，防止已进入合并队列的消息在触发静默后继续回复
- 窗口内达到阈值 → 发一条可自定义提示，然后对该用户**静默一段时间**（经 `chatluna/before-check-sender` 拒答）
- 触发阈值的那条消息同样不再回复（STOP 在调模型之前）；静默只作用于 chatluna 的 AI 回复，
  **其他插件的 koishi 指令不受影响**（详见"已知行为与设计取舍"）

### ③ 判官小模型（可选，默认关闭）
- 在调用主模型前，用一个小模型判断这条消息"该不该回复"（输出 REPLY / SILENT）
- 判定 SILENT 时整条链静默中止，不消耗主模型额度；提示词可自定义（骚扰/辱骂/无意义纠缠等）
- **fail-open**：判定超时、模型过载、输出无法解析时一律放行到主模型，绝不误杀正常聊天
- 并发上限 `maxConcurrent`（默认 4、最大 12，0 = 不限）与双 AI 循环复核共用，超出直接放行

### ④ 夜间防护
- 默认 `02:00-07:00`，支持跨零点；三态 `silent / once / normal`
- `silent`：夜间所有会触发回复的消息直接静默，不调模型、不计配额
- `once`：每个夜次允许一次正常对话；在用户输入前注入 SystemMessage 提示词，让模型用人设提醒"该睡觉了"，
  回复后直到时段结束都静默
- `onceScope` 可选按会话（默认，群聊=群/频道）或按用户；一次性提醒不参与 guard 配额/判官/防刷屏/循环检测

### ⑤ 分段发送随机延迟
- 当一次回复会拆成多条发送（一次发送中包含多个 `message` 元素）时，相邻两条之间随机等待 `minMs`~`maxMs`
- 单条消息、实际以合并转发（`isForwardMsg`）发出时**不延迟**

### ⑥ 发送前图片 / GIF 压缩
- 静态图：体积 ≥ `minSizeMB`（默认 2.5MB）**或**长边 ≥ `minEdge`（默认 1920）时，
  缩到 `maxEdge`（默认 1920）并转 JPEG（默认质量 88）
- GIF：`gifEnabled` 开启且体积 ≥ `gifMinSizeMB`（默认 2.5MB）时自适应处理——
  均匀抽 `gifSampleFrames` 帧算帧差；低于 `gifMotionThreshold`（默认 0.04）只取中间帧，
  高于则拼成 2×2 采样图（每格 `gifCellSize`，默认 512，JPEG `gifQuality`，默认 82），
  并在消息里补一句采样顺序说明
- 目标：避免 4K PNG / 大 GIF 转 base64 后触发视觉模型接口的 `413 Request Entity Too Large`
- 压缩失败自动回退原图；`gifEnabled` 关闭时 GIF 原样发送

所有状态（配额计数、静默期、冷却标记、夜间已提醒标记）持久化在自管表 `chatluna_guard_state`，**重启不丢**，
过期行每 30 分钟自动清理。

## 安装

```bash
npm install koishi-plugin-chatluna-guard
```

要求：`koishi >= 4.18.7`，并已安装启用 `koishi-plugin-chatluna`（>= 1.4.0）。
插件依赖 `database` 与 `chatluna` 服务，控制台会按依赖顺序自动挂载，无需关心加载顺序。

## 使用

1. 安装后在控制台的 ChatLuna 系列分组下找到 `chatluna-guard` 并启用
2. 按需调整各组配置（默认开箱即用：私聊 20/h、100/d，群聊 10/h、30/d，防刷屏开、判官关）
3. 判官功能：打开 `判官小模型` 分组开关，在"判官模型"下拉中选择模型后保存

### 主要配置项

| 分组 | 配置项 | 默认 | 说明 |
|---|---|---|---|
| 时间设置 | `timezone` | `Asia/Shanghai` | IANA 时区；峰谷、夜间、自然日重置共用 |
| 用户配额 | `privateHourly` / `privateDaily` | `20` / `100` | 私聊每小时/每天上限（0 不限） |
| | `groupHourly` / `groupDaily` | `10` / `30` | 群聊每小时/每天上限（0 不限） |
| | `notifyOnce` | `true` | 受限期间只提醒一次，后续静默 |
| | `exemptAllGroups` | `false` | 所有群不受限额约束 |
| | `exemptUsers` / `exemptGroups` | `[]` | 豁免的用户 ID / 群号（guildId）列表 |
| | `limitMessage` | 见下 | 超限提示文案 |
| | `tiers` | `[]` | 权限分级限额表（authority 命中最高档覆盖基础限额） |
| 峰谷时段 | `enabled` | `false` | 峰谷时段限额开关 |
| | `periods[].name/start/end` | — | 时段名 / 开始 HH:mm / 结束 HH:mm（支持跨零点） |
| | `periods[].privateHourly` 等 | `-1` | `-1` = 继承权限配额组，`0` = 不限，`>0` = 覆盖 |
| 规则防刷屏 | `enabled` | `true` | 规则防刷屏开关 |
| | `scope` | `direct` | 仅私聊 / 私聊+群聊 |
| | `windowSeconds` | `60` | 计数窗口（秒） |
| | `maxCount` | `5` | 窗口内触发静默的**单条消息**数（消息队列合并前的每条都算） |
| | `silenceMinutes` | `10` | 触发后静默时长（分钟） |
| | `silenceMessage` | 见下 | 进入静默时发送的提示文案（留空 = 不发提示） |
| 夜间防护 | `enabled` | `false` | 夜间防护开关 |
| | `start` / `end` | `02:00` / `07:00` | 夜间时段（支持跨零点） |
| | `mode` | `silent` | `silent` 静默 / `once` 一次提醒后静默 / `normal` 正常回复 |
| | `scope` | `all` | 仅私聊 / 私聊+群聊 |
| | `onceScope` | `conversation` | 一次提醒按会话（私聊=用户，群聊=群/频道）或按用户 |
| | `prompt` | 内置 | 插入用户输入前的系统提示词，支持 `{time}` `{date}` `{window}` `{user}` `{bot}` |
| 分段延迟 | `enabled` | `false` | 多消息发送时相邻两条随机等待 |
| | `minMs` / `maxMs` | `400` / `1200` | 随机间隔范围（毫秒） |
| 图片/GIF 压缩 | `enabled` | `true` | 发送前压缩总开关 |
| | `minSizeMB` / `minEdge` | `0.75` / `1600` | 静态图触发体积（MB）/ 触发长边（像素）；0 = 总是压缩 |
| | `maxEdge` / `quality` | `1920` / `88` | 静态图压缩后最长边 / JPEG 质量 |
| | `gifEnabled` | `true` | 是否压缩超大 GIF |
| | `gifMinSizeMB` | `0.5` | GIF 触发体积（MB）；0 = 总是压缩 |
| | `gifSampleFrames` / `gifMotionThreshold` | `4` / `0.04` | 采样帧数 / 帧差阈值（低于取中间帧，高于做拼图） |
| | `gifCellSize` / `gifQuality` | `512` / `82` | 拼图每格边长 / GIF 输出 JPEG 质量 |
| 判官小模型 | `enabled` | `false` | 判官开关 |
| | `model` | （空） | 判官模型（platform/model，控制台下拉） |
| | `scope` | `direct` | 仅判定会触发回复的消息 |
| | `timeoutMs` | `5000` | 判定超时，超时放行到主模型 |
| | `maxConcurrent` | `4` | 判官与循环复核的最大并发数（最大 12，0 = 不限；超出直接放行） |
| | `prompt` | 内置 | 判定系统提示词（要求只输出 REPLY / SILENT） |
| 双 AI 循环检测 | `enabled` | `false` | 防止与"疑似也是 AI"的对端聊不停（需判官模型） |
| | `scope` | `all` | 生效范围（群聊是主场景，故默认含群聊） |
| | `windowMinutes` | `5` | 计数窗口（分钟），只统计对方发来的消息 |
| | `turnThreshold` | `8` | 触发复核的对方句数 |
| | `hardCap` | `15` | 硬上限句数：达到即复核（不再要求告别语）；0 = 关闭 |
| | `quietMinutes` | `10` | 解除条件：对方安静满该时长后自动解除 |
| | `longTextLength` / `fastReplySeconds` / `minBotSignals` | `80` / `3` / `2` | bot 特征参数：长文阈值 / 秒回判定 / 至少命中几条 |
| | `farewellWords` | 内置 10 词 | 告别语词表（再见/拜拜/晚安/下次聊…） |
| | `prompt` | 内置 | 复核提示词（要求只输出 STOP / CONTINUE） |
| 官方机器人 | `reply` | `false` | 是否回应官方机器人（关闭 = 对其不回复不处理） |
| | `useNapcatFlag` | `true` | 用 NapCat 群成员 `is_robot` 标记判定（群聊一手信号） |
| | `ids` | `[]` | 官方机器人 ID 名单（私聊/群聊都生效） |
| | `nameKeywords` | 内置 3 词 | 昵称/群名片关键词（Q群管家/群管家/群助手） |

`limitMessage` 占位符：`{0}` = 剩余等待时间，`{1}` = 计次范围（自动填入“本小时/今天/本时段”，
取实际恢复的那个维度），`{2}` = 当前峰谷时段名。

`silenceMessage` 默认：`呜…你刷屏太快啦，我先安静 {0} 分钟，等下再聊吧 >_<`（`{0}` = 静默时长，分钟）。
该文案在触发静默时发送一次；静默期内该用户的消息被**整条忽略**（不回复、不处理、不计数），
静默时长固定为 `silenceMinutes`、**不会因继续刷屏而延长**，到点自动恢复。留空则完全不发提示。
群聊场景下提示会发在触发消息所在的群/会话里（`scope` 设为 `direct` 可只对私聊生效）。

## 判官模型选型建议

判官是**分类任务**而非聊天任务，对指令遵循要求高：

- ✅ 推荐：指令遵循好的轻量对话模型
- ❌ 避免：推理/思考型模型——实测有模型会无视"只输出 REPLY/SILENT"的格式约束，直接
  把用户消息当聊天回复，导致判官**看似正常实则空转**（不报错，全部 fail-open）
- 若必须用较慢的模型，请上调 `timeoutMs`；判官首次调用失败会在日志打
  `warn`（`[guard] 判官…`），但整体被掩盖的风险请结合"从未出现 `[guard] 判官拒答` 日志"自查
- **启动延迟 3 秒**：判官模型实例在插件 `ready` 之后延迟 3 秒才创建（`JUDGE_INIT_DELAY_MS`），
  避免 chatluna 平台/适配器尚未注册完就建实例导致失败；延迟期间判官未生效，消息正常放行到主模型，
  状态卡片显示"等待模型初始化（启动延迟 3 秒）"

## 双 AI 循环检测（judge.loopGuard）

场景：对方其实也是个 AI 机器人（或自动化脚本），两边都被"必须回复"的逻辑驱动，
**互相接话停不下来**。开启后按下面四步收口：

1. **计数**：只统计窗口（`windowMinutes`，默认 5 分钟）内**对方发来的**消息条数
2. **规则初筛**（零模型调用，不满足就直接放行）：
   - bot 特征需命中 ≥ `minBotSignals` 条（默认 2 条，共 3 条可选）：
     ① 长篇大论（≥ `longTextLength` 字的消息占窗口内多数）
     ② 括号/舞台动作描写（`（）` `()` `【】` `**`，至少 2 条）
     ③ 秒回长文（间隔 < `fastReplySeconds` 秒且内容超长——人类打字做不到）
   - 且满足其一：达到 `turnThreshold`（默认 8 句）**且对方已道别**（命中 `farewellWords`），
     或达到 `hardCap`（默认 15 句）硬上限（不再要求告别语）
3. **模型复核**：把窗口内对方发言（含每条间隔秒数）+ 统计摘要交给判官模型，只认明确的 `STOP`；
   超时/报错/过载一律 `CONTINUE`（fail-open）
4. **收口**：**本条照常回复**（把对方的告别回完），从对方下一条消息起不再接话；
   直到对方**安静满 `quietMinutes` 分钟**（默认 10）自动解除，视为这段对话已经结束。
   解除后从头计数，若又聊成循环会再次收口

循环静默期内对方的消息在链首被拦：不回复、不处理、不消耗配额。

## 官方机器人（officialBot）

入群时常会被 QQ 官方机器人（Q群管家 / 群助手这类只会重复几句的账号）搭话，
原有行为会把它当普通用户聊起来。识别信号按优先级：

1. **NapCat 群成员 `is_robot` 标记**（`useNapcatFlag`，群聊一手信号，结果缓存 10 分钟）——
   注意 adapter 的 `decodeGuildMember` 会丢掉该字段，本插件走原始 `getGroupMemberInfo` 取
2. **`ids` 名单**：按 userId 直接匹配（私聊/群聊都生效），用于补漏
3. **`nameKeywords` 关键词**：匹配昵称/群名片（默认 `Q群管家` / `群管家` / `群助手`）

`reply` 默认**关闭**（即不回应官方机器人），命中后在该用户消息的链首直接 STOP：
不回复、不处理、不消耗配额。想让某个机器人重新被回应，把它加进配额的 `exemptUsers` 即可
（豁免优先于本闸门）。

## 已知行为与设计取舍

- **私聊与群聊共享同一个用户计数**（platform+userId 维度）：先命中的限额生效
- 防刷屏提示（`silenceMessage`）走 `session.send()` **直接发送**，不经 chatluna 链，
  因此不会被自身静默拦截、也不消耗 token；发送失败只记 warn，静默依旧生效
- 防刷屏静默期经 `before-check-sender` 在 `allow_reply`（链首）生效，直接 **STOP**：该用户的
  消息不回复、不再进入 chatluna 后续中间件（包括配额计数），因此静默期刷屏**不消耗配额**
- **静默只作用于 chatluna 的 AI 对话**（已核实）：
  - 本插件**不注册任何 koishi middleware**，只挂 chatluna 链节点与 chatluna 事件，无法从 koishi 管道里拿走消息
  - chatluna 的全局 middleware 用 `next(cb)` 把整条链 **defer 到 koishi 管道最末端**执行，
    其他插件的中间件/指令**先**执行（指令命中时链接本不会被调用）
  - 链 STOP 时 `receiveMessage` 返回 `false`（`_runMiddleware` 的 stop 分支），chatluna 随即调用
    `nextMiddleware()` 让管道继续 → 消息不会被吞
  - 结论：静默期间 `koishi 其他插件的指令照常触发`；被拦的只有 chatluna 的 AI 回复，以及
    **chatluna 自己的指令**（它们内部走同一条链）。想放行某个用户/机器人，加进 `exemptUsers` 即可
- 静默时长固定为 `silenceMinutes`：静默期内继续刷屏**不会延长**、也不会重新计时，
  到点后自动恢复，并从此前的计数中清零重新开始（与配额 `notifyOnce` 的"只提醒一次"思路一致）
- 防刷屏计数点是 `guard_spam_count`（`transform_chat_message` 之后、`message_delay` 之前）：
  **只统计会触发回复的单条消息**，群内未 @ 机器人/纯闲聊的消息不计数；触发阈值的那条本身 STOP 掉、不调模型
- `message_delay` 之后还有 `guard_spam_gate` 再查一次静默，防止已进入合并队列的消息在触发静默后继续回复
- **消息队列口径**：`messageQueueDelay > 0` 时多条消息合并成 1 次模型请求，**配额只算 1 次**；
  防刷屏在合并前按单条消息计数，**5 条合并仍算 5 条**，不会成为绕过口子
- 配额超限的拦截发生在指令处理之前，提示文案同样会挡掉指令消息
- 高并发下同一用户的多条消息可能同时通过检查各自计数，存在轻微超卖的边角（与主插件
  `chat_time_limit` 同语义）
- 与主插件共存互不干扰：本插件链节点（`guard_night_check` / `guard_spam_count` / `guard_quota_check` /
  `guard_judge_check` / `guard_loop_check` / `guard_spam_gate` / `guard_segment_delay_start` /
  `guard_segment_delay_end` / `guard_night_save` / `guard_quota_save`）锚定在 `transform_chat_message`、
  `message_delay`、`chat_time_limit_check` 与 `request_conversation` 之间，save 在 `chat_time_limit_save` 之后，
  对齐主插件"调用发出即计次"的语义
- **峰谷/夜间/自然日重置共用顶层 `timezone`**；时段切换不重置小时/天计数，只改变当前适用的额度上限
- 夜间一次性提醒注入的是 `SystemMessage`（prompt 管线 `injections` 阶段、用户输入之前），
  不会写进用户消息历史；回复本身仍走正常对话链
- 分段延迟在 Koishi 的 `before-send` 阶段拦截 ChatLuna 一次发送中的多个 `message` 元素；单条消息、
  实际合并转发、编辑模式（如 Discord 编辑流）不会触发延迟。不要改为包装 `session.sendQueued`：
  它由 Koishi 通过 `ctx.mixin` 注入，实例赋值 / `defineProperty` 都不会真正覆盖
- 双 AI 循环检测与判官共用同一个模型实例与并发上限 `maxConcurrent`（默认 4、最大 12、0 = 不限；
  同时最多这么多判定在飞，超出直接放行）：
  **只开 `loopGuard` 而不开 `judge` 时，模型仍会被创建**（`ready` 后延迟 3 秒）
- 循环静默与防刷屏静默是两套独立状态（`l:` / `s:`），互不影响；两者都在链首拦截
- 官方机器人闸门只在 `reply=false` 时才去查 `is_robot`（`reply=true` 时零开销）；
  查询按 `platform:userId` 缓存 10 分钟，接口失败降级为"非机器人"（fail-open，不影响正常聊天）
- 日志前缀 `[guard]`（logger 名 `chatluna-guard`）：启用摘要、刷屏触发、配额拦截、
  判官拒答/失败均为 info/warn 级，可直接观察

## 依赖

- peer: `koishi` ^4.18.7、`koishi-plugin-chatluna` ^1.4.0
- dependency: `@langchain/core` ^0.3.80（用于夜间提示词的 `SystemMessage` 注入）
- dependency: `jimp` ^1.6.0（图片 / GIF 转码）、`omggif` ^1.0.10（GIF 抽帧）

## 更新日志

### 1.2.0（2026-10-29）

- **修复分段发送延迟不生效**：Koishi 的 `session.sendQueued` 由 `ctx.mixin` 注入，实例赋值 /
  `defineProperty` 都无法真正覆盖，旧实现从未生效。改为在 `before-send` 阶段拦截一次发送中的多个
  `message` 元素，取消整包后逐段发送并插入随机延迟；嵌套的单段发送不再重复等待。
- **新增发送前图片压缩**（`imageCompress`）：体积 ≥ `minSizeMB`（默认 0.75MB）或长边 ≥ `minEdge`
  （默认 1600）的静态图，缩到 `maxEdge`（默认 1920）并转 JPEG（默认 q88），解决 4K PNG 转 base64
  导致的 `413 Request Entity Too Large`；压缩器 priority `-200`，早于 ChatLuna 默认图片处理器。
- **新增 GIF 自适应压缩**：`gifEnabled` 控制开关；GIF 超过 `gifMinSizeMB`（默认 0.5MB）时均匀抽
  `gifSampleFrames` 帧算帧差——低于 `gifMotionThreshold`（默认 0.04）取中间帧，高于则拼成 2×2
  采样图（`gifCellSize` / `gifQuality`），并在消息中补采样顺序说明，避免 413 与“只看首帧”。
- **配置合并**：图片与 GIF 字段统一到 `imageCompress` 单卡片，新增 `minSizeMB`、`minEdge`、
  `gifEnabled`、`gifMinSizeMB` 等可调项。
- 依赖新增 `jimp` ^1.6.0、`omggif` ^1.0.10。

### 1.1.0（2026-10-29）

- 新增**峰谷时段限流**（`timeQuota`）：按 HH:mm 时段覆盖配额，支持跨零点；`-1` 继承权限配额组、`0` 不限、`>0` 覆盖；超限提示会按实际恢复的时段边界显示“本时段/本小时/今天”。
- 新增**夜间防护**（`nightGuard`）：默认 `02:00-07:00`，支持 `silent` / `once` / `normal` 三态；`once` 可注入睡眠提示词并正常回复一次，之后静默到时段结束；状态持久化，支持按会话或按用户计数。
- 新增**分段发送随机延迟**（`segmentDelay`）：分割或流式多消息之间随机等待；单条消息、实际合并转发不延迟。
- 新增顶层 **`timezone`** 设置，峰谷、夜间与自然日重置共用。
- 修复**防刷屏计数锚点**：从链首 L0 移到 `transform_chat_message` 之后、`message_delay` 之前，只统计会触发回复的单条消息；新增 `guard_spam_gate` 防止已进入消息队列的合并 turn 在触发静默后继续回复。
- 明确**消息队列口径**：多条消息合并成一次模型请求时，配额只算 1 次，防刷屏仍按合并前的单条消息计数。
- 简化控制台「使用说明」文本；新增 `@langchain/core` 依赖。
