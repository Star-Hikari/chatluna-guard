# koishi-plugin-chatluna-guard

[![npm](https://img.shields.io/npm/v/koishi-plugin-chatluna-guard?style=flat-square)](https://www.npmjs.com/package/koishi-plugin-chatluna-guard)

ChatLuna 辅助插件：按用户维度的对话配额，以及选择性不回复（规则防刷屏 + 可选判官小模型）。

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

### ② 规则防刷屏（零模型调用）
- 计数点挂在 `request_conversation`（chatluna 真正调模型）**之前**：只统计**真正触发模型回复**的消息，
  群聊里没 @ 机器人、纯闲聊的消息不计数（`scope: all` 才覆盖群聊，默认 `direct` 只管私聊）
- 窗口内达到阈值 → 发一条可自定义提示，然后对该用户**静默一段时间**（经 `chatluna/before-check-sender` 拒答）
- 触发阈值的那条消息同样不再回复（STOP 在调模型之前）；静默只作用于 chatluna 的 AI 回复，
  **其他插件的 koishi 指令不受影响**（详见"已知行为与设计取舍"）

### ③ 判官小模型（可选，默认关闭）
- 在调用主模型前，用一个小模型判断这条消息"该不该回复"（输出 REPLY / SILENT）
- 判定 SILENT 时整条链静默中止，不消耗主模型额度；提示词可自定义（骚扰/辱骂/无意义纠缠等）
- **fail-open**：判定超时、模型过载、输出无法解析时一律放行到主模型，绝不误杀正常聊天
- 并发上限 `maxConcurrent`（默认 4、最大 12，0 = 不限）与双 AI 循环复核共用，超出直接放行

所有状态（配额计数、静默期、冷却标记）持久化在自管表 `chatluna_guard_state`，**重启不丢**，
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
| 用户配额 | `privateHourly` / `privateDaily` | `20` / `100` | 私聊每小时/每天上限（0 不限） |
| | `groupHourly` / `groupDaily` | `10` / `30` | 群聊每小时/每天上限（0 不限） |
| | `notifyOnce` | `true` | 受限期间只提醒一次，后续静默 |
| | `exemptAllGroups` | `false` | 所有群不受限额约束 |
| | `exemptUsers` / `exemptGroups` | `[]` | 豁免的用户 ID / 群号（guildId）列表 |
| | `limitMessage` | 见下 | 超限提示文案 |
| | `tiers` | `[]` | 权限分级限额表（authority 命中最高档覆盖基础限额） |
| 规则防刷屏 | `enabled` | `true` | 规则防刷屏开关 |
| | `scope` | `direct` | 仅私聊 / 私聊+群聊 |
| | `windowSeconds` | `60` | 计数窗口（秒） |
| | `maxCount` | `5` | 窗口内触发静默的**回复**条数（只算真正触发模型回复的消息） |
| | `silenceMinutes` | `10` | 触发后静默时长（分钟） |
| | `silenceMessage` | 见下 | 进入静默时发送的提示文案（留空 = 不发提示） |
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

`limitMessage` 占位符：`{0}` = 剩余等待时间，`{1}` = 计次范围（自动填入"本小时/今天"，
按先到达的重置维度）。

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
- 防刷屏计数点是 `guard_spam_count`（锚在 `request_conversation` 之前）：**只统计真正触发模型回复的消息**，
  群内未 @ 机器人/纯闲聊的消息不计数；触发阈值的那条本身 STOP 掉、不调模型
- 配额超限的拦截发生在指令处理之前，提示文案同样会挡掉指令消息
- 高并发下同一用户的多条消息可能同时通过检查各自计数，存在轻微超卖的边角（与主插件
  `chat_time_limit` 同语义）
- 与主插件共存互不干扰：本插件链节点（`guard_quota_check` / `guard_judge_check` /
  `guard_loop_check` / `guard_spam_count` / `guard_quota_save`）锚定在 `transform_chat_message`、
  `chat_time_limit_check` 与 `request_conversation` 之间，save 在 `chat_time_limit_save` 之后，
  对齐主插件"调用发出即计次"的语义
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
