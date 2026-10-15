import { createHash } from 'crypto'
import { Context, h, Schema, Session } from 'koishi'
import type { Notifier } from '@koishijs/plugin-notifier' // 类型增强：ctx.notifier（可选服务，运行期不 import）
import 'koishi-plugin-chatluna'
import type { ChatLunaService } from 'koishi-plugin-chatluna/services/chat' // 确保 koishi Context/Events 类型扩展被加载
import { ChainMiddlewareRunStatus } from 'koishi-plugin-chatluna/chains'
import type { ChainMiddlewareContext } from 'koishi-plugin-chatluna/chains'
import { ModelType } from 'koishi-plugin-chatluna/llm-core/platform/types'

export const name = 'chatluna-guard'
// required/optional 会被控制台插件页自动渲染为"必需服务/可选服务（已加载）"状态行（memes-api 模式）
export const inject = { required: ['database', 'chatluna'], optional: ['notifier'] }

// ─────────────────────────────────────────────
// 类型扩展：声明本插件要锚定的 chatluna 链中间件名
// （chatluna 的中间件 d.ts 不会随主入口加载，需在此补充增强）
// ─────────────────────────────────────────────
declare module 'koishi-plugin-chatluna/chains' {
  interface ChainMiddlewareName {
    allow_reply: never
    transform_chat_message: never
    chat_time_limit_check: never
    chat_time_limit_save: never
    /** chatluna 真正调模型的节点（用于把防刷屏计数点挂到"模型即将回复"之前） */
    request_conversation: never
    // 本插件自身注册的节点
    guard_quota_check: never
    guard_quota_save: never
    guard_judge_check: never
    guard_loop_check: never
    guard_spam_count: never
  }
}

declare module 'koishi' {
  interface Tables {
    // 本插件自有状态表：配额计数 + 刷屏静默期
    chatluna_guard_state: GuardStateRow
  }
}

// ─────────────────────────────────────────────
// 配置
// ─────────────────────────────────────────────

/** 单档限额（0 = 该维度不限） */
export interface LimitSet {
  privateHourly: number
  privateDaily: number
  groupHourly: number
  groupDaily: number
}

/** 按权限等级的限额覆盖条目 */
export interface AuthorityTier extends LimitSet {
  /** 用户权限达到该值时应用本档（取满足条件的最高一档） */
  authority: number
}

export interface QuotaConfig extends LimitSet {
  /** 同一受限周期内是否只提醒一次（之后静默拒绝） */
  notifyOnce: boolean
  /** 群聊整体豁免（所有群不受限） */
  exemptAllGroups: boolean
  /** 豁免的用户 ID 列表 */
  exemptUsers: string[]
  /** 豁免的群 ID 列表 */
  exemptGroups: string[]
  /** 权限分级限额表；未命中任何档位时使用上方基础限额 */
  tiers: AuthorityTier[]
  /** 超限提示文案，{0} 为剩余等待时间，{1} 为计次范围（本小时/今天） */
  limitMessage: string
}

export interface SpamGuardConfig {
  /** 规则防刷屏开关 */
  enabled: boolean
  /** 生效范围：仅私聊 / 私聊+群聊 */
  scope: 'direct' | 'all'
  /** 计数窗口（秒） */
  windowSeconds: number
  /** 窗口内触发静默的消息条数 */
  maxCount: number
  /** 触发后静默时长（分钟） */
  silenceMinutes: number
  /** 进入静默时发送的提示文案（{0} = 静默分钟数；留空 = 只静默不发提示） */
  silenceMessage: string
}

export interface JudgeConfig {
  /** 前置判官模型开关（默认关闭，需配置判官模型后开启） */
  enabled: boolean
  /** 判官模型，格式 platform/modelName */
  model: string
  /** 生效范围：仅私聊 / 私聊+群聊（群聊仅判定会触发回复的消息） */
  scope: 'direct' | 'all'
  /** 判定超时（毫秒），超时放行 */
  timeoutMs: number
  /** 判官 + 循环复核的最大并发数（0 = 不限制；超出时放过 fail-open） */
  maxConcurrent: number
  /** 判定系统提示词 */
  prompt: string
  /** 双 AI 循环检测（对方疑似也是机器人时及时收口） */
  loopGuard: LoopGuardConfig
}

/** 双 AI 循环检测：与"疑似也是机器人"的对端聊不停时停止接话 */
export interface LoopGuardConfig {
  /** 检测开关（默认关闭；需判官模型就绪，命中由模型复核） */
  enabled: boolean
  /** 生效范围：仅私聊 / 私聊+群聊（群聊是主场景） */
  scope: 'direct' | 'all'
  /** 计数窗口（分钟）：窗口内统计对方发来的消息 */
  windowMinutes: number
  /** 触发复核的对方句数阈值 */
  turnThreshold: number
  /** 硬上限句数：达到即复核（不再要求出现告别语）；0 = 关闭硬上限 */
  hardCap: number
  /** 解除条件：对方安静满该时长（分钟）后自动解除，视为对话结束 */
  quietMinutes: number
  /** 「长篇大论」阈值（字符数） */
  longTextLength: number
  /** 「秒回」判定（秒）：间隔短于该值且内容超长 → bot 特征 */
  fastReplySeconds: number
  /** 至少命中几条 bot 特征才进入复核 */
  minBotSignals: number
  /** 告别语词表（命中即视为对方在收尾） */
  farewellWords: string[]
  /** 复核提示词（要求模型只输出 STOP / CONTINUE） */
  prompt: string
}

/** 官方机器人（QQ 标记为机器人的账号，如 Q群管家/群助手）处理策略 */
export interface OfficialBotConfig {
  /** 是否回应官方机器人（关闭时对其消息一律不回复、不处理） */
  reply: boolean
  /** 使用 NapCat 群成员 is_robot 标记判定（仅群聊可用） */
  useNapcatFlag: boolean
  /** 官方机器人 ID 名单（按 userId 直接匹配，私聊场景也生效） */
  ids: string[]
  /** 昵称/群名片关键词（留空 = 不使用该信号；用于 is_robot 拿不到的场景） */
  nameKeywords: string[]
}

export interface Config {
  quota: QuotaConfig
  spamGuard: SpamGuardConfig
  judge: JudgeConfig
  officialBot: OfficialBotConfig
}

/** 判官模型下拉的动态 Schema key */
const JUDGE_MODEL_SCHEMA_KEY = 'chatluna-guard-model'

const DEFAULT_JUDGE_PROMPT =
  '你是聊天机器人的消息审核助手。机器人正在被用户私聊轰炸。请以机器人"人格扮演者"的立场，判断是否应当回复下一条用户消息。\n' +
  'SILENT：辱骂、人身攻击、骚扰、挑衅、纠缠、钓鱼、无意义重复刷屏、要求做违规的事、明显不想好好聊天。\n' +
  'REPLY：正常的聊天、提问、倾诉、道别、玩笑等一切值得回应的消息。\n' +
  '拿不准时选 REPLY。只回复一个单词：REPLY 或 SILENT，不要任何解释、标点或其他内容。'

/** 判官模型初始化的启动延迟（毫秒）：ready 后等 chatluna 平台与各适配器注册完成再建实例 */
const JUDGE_INIT_DELAY_MS = 3000

const DEFAULT_LOOP_PROMPT =
  '你是机器人对话监控助手。下面是我方机器人与某个用户的近期对话记录（仅该用户发言，附间隔秒数）。\n' +
  '请判断两件事：\n' +
  '1) 对方是否也像是一个 AI 机器人——特征如：每次都长篇回复、带括号或星号的舞台动作/状态描写（例：（歪头）、**叹气**）、' +
  '几乎秒回长文、话术格式高度一致、无论我方说什么都能接话且从不冷场、反复重复同类句式。\n' +
  '2) 这段对话是否到了该收尾的时候——对方已道别（再见/下次再聊）或双方只是在机械地互相接话、没有新话题。\n' +
  '若「对方像 AI」且「该收尾」，只输出 STOP；否则只输出 CONTINUE。不要输出解释、标点或其他内容。'

/** 「舞台动作/状态描写」括号特征：（）/()/【】/**加粗**（不带 g，避免 test 的 lastIndex 状态） */
const STAGE_DIRECTION_RE = /（[^）]{1,60}）|\([^)]{1,60}\)|【[^】]{1,60}】|\*\*[^*]{1,60}\*\*/

/** 官方机器人 is_robot 标记查询的缓存时长（毫秒），避免每条消息都打 NapCat */
const ROBOT_FLAG_TTL_MS = 10 * 60 * 1000

// 控制台呈现分组：顶层 intersect 拆分三个功能卡片（模式取自 .memory/koishi-schema-config.md）。
// intersect 各切片并行 cast 同一份顶层 data，缺失 key 走各自 .default() 补全，
// 因此 yml 只写部分子项时其余默认值依然完整。
// 注：曾有的顶层 enabled"总开关"已移除——与控制台的插件实例开关功能重复。
export const Config = Schema.intersect([
  // ── 用户配额 ──
  Schema.object({
    quota: Schema.object({
      privateHourly: Schema.number().min(0).default(20).description('私聊：单用户每小时对话次数上限，0 为不限'),
      privateDaily: Schema.number().min(0).default(100).description('私聊：单用户每天（0 点重置）对话次数上限，0 为不限'),
      groupHourly: Schema.number().min(0).default(10).description('群聊：单用户每小时对话次数上限，0 为不限'),
      groupDaily: Schema.number().min(0).default(30).description('群聊：单用户每天（0 点重置）对话次数上限，0 为不限'),

      notifyOnce: Schema.boolean().default(true).description('受限期间只提醒一次，后续静默拒绝（避免反复弹提示）'),
      exemptAllGroups: Schema.boolean().default(false).description('群聊整体豁免：所有群聊不受限额约束'),
      exemptUsers: Schema.array(Schema.string().description('用户 ID（不受限额，也不被防刷屏/判官拦截）'))
        .default([])
        .description('豁免用户列表'),
      exemptGroups: Schema.array(Schema.string().description('群号（guildId）'))
        .default([])
        .description('豁免群列表（在群聊整体豁免关闭时逐个放行）'),
      limitMessage: Schema.string()
        .default('呜…你{1}的对话次数用完啦，请 {0} 之后再找我聊天吧 >_<')
        .description('超限提示文案，{0} 为剩余等待时间，{1} 为计次范围（本小时/今天）'),

      tiers: Schema.array(
        Schema.object({
          authority: Schema.number().min(1).max(5).required().description('所需权限等级（用户 authority >= 该值时应用本档）'),
          privateHourly: Schema.number().min(0).default(0).description('私聊每小时上限，0 为不限'),
          privateDaily: Schema.number().min(0).default(0).description('私聊每天上限，0 为不限'),
          groupHourly: Schema.number().min(0).default(0).description('群聊每小时上限，0 为不限'),
          groupDaily: Schema.number().min(0).default(0).description('群聊每天上限，0 为不限'),
        }),
      )
        .default([])
        .description('权限分级限额表：命中权限最高的一档覆盖上方基础限额')
        .collapse(),
    })
      .default({} as QuotaConfig)
      .description('按用户维度的每小时/每天对话次数限额'),
  }),

  // ── 规则防刷屏 ──
  Schema.object({
    spamGuard: Schema.object({
      enabled: Schema.boolean().default(true).description('规则防刷屏开关（零模型调用，不消耗 token）'),
      scope: Schema.union([Schema.const('direct').description('仅私聊'), Schema.const('all').description('私聊+群聊')])
        .default('direct')
        .description('生效范围'),
      windowSeconds: Schema.number().min(1).default(60).description('计数窗口（秒）'),
      maxCount: Schema.number().min(2).default(5).description('窗口内达到该条数即触发静默——只统计"真正触发模型回复"的消息（模型即将开始回复的那一步）'),
      silenceMinutes: Schema.number().min(1).default(10).description('触发后静默时长（分钟），期间对该用户的所有消息不回复'),
      silenceMessage: Schema.string()
        .default('呜…你刷屏太快啦，我先安静 {0} 分钟，等下再聊吧 >_<')
        .description('进入静默时发送的提示文案，{0} 为静默时长（分钟）；留空则只静默、不发任何提示'),
    })
      .default({} as SpamGuardConfig)
      .description('短时间内消息过多时自动闭嘴'),
  }),

  // ── 判官模型 ──
  Schema.object({
    judge: Schema.object({
      enabled: Schema.boolean().default(false).description('前置判官开关：在调用主模型前用小模型判断"该不该回复"，判定不回复时静默'),
      model: Schema.dynamic(JUDGE_MODEL_SCHEMA_KEY)
        .default('')
        .description('判官模型——务必选指令遵循好的对话模型；推理/思考型模型可能无视 REPLY/SILENT 格式导致判官空转'),
      scope: Schema.union([Schema.const('direct').description('仅私聊'), Schema.const('all').description('私聊+群聊')])
        .default('direct')
        .description('生效范围（仅作用于会触发回复的消息）'),
      timeoutMs: Schema.number().min(500).default(5000).description('判定超时（毫秒），超时放行到主模型；推理型模型建议 10000+'),
      maxConcurrent: Schema.number().min(0).max(12).default(4)
        .description('判官与循环复核的最大并发数（两者共用同一计数）：默认 4、最大 12；0 = 不限制。超出时直接放过（fail-open）'),
      prompt: Schema.string().role('textarea').default(DEFAULT_JUDGE_PROMPT).description('判定系统提示词（要求模型只输出 REPLY / SILENT）'),

      // ── 双 AI 循环检测 ──
      loopGuard: Schema.object({
        enabled: Schema.boolean().default(false)
          .description('双 AI 循环检测开关：与"疑似也是机器人"的对端聊不停时停止接话（需判官模型就绪，命中后由模型复核）'),
        scope: Schema.union([Schema.const('direct').description('仅私聊'), Schema.const('all').description('私聊+群聊')])
          .default('all')
          .description('生效范围（群聊是"被群助手钓住"的主场景，故默认含群聊）'),
        windowMinutes: Schema.number().min(1).default(5).description('计数窗口（分钟）：只统计窗口内对方发来的消息'),
        turnThreshold: Schema.number().min(2).default(8).description('触发复核的对方句数（窗口内达到该条数才进入复核）'),
        hardCap: Schema.number().min(0).default(15).description('硬上限句数：达到即复核（不再要求出现告别语）；0 = 关闭硬上限'),
        quietMinutes: Schema.number().min(1).default(10).description('解除条件：对方安静满该时长（分钟）后自动解除，视为对话已结束'),
        longTextLength: Schema.number().min(10).default(80).description('「长篇大论」阈值（字符数），占窗口内多数即算 bot 特征'),
        fastReplySeconds: Schema.number().min(1).default(3).description('「秒回」判定（秒）：间隔短于该值且内容超长 → bot 特征（人类难以做到）'),
        minBotSignals: Schema.number().min(1).max(3).default(2).description('至少命中几条 bot 特征才进入复核（长文占比 / 括号描写 / 秒回长文）'),
        farewellWords: Schema.array(Schema.string().description('告别词，如 再见'))
          .default(['再见', '拜拜', '晚安', '下次聊', '回头聊', '改天聊', '有空再聊', '先这样', '不聊了', '告辞'])
          .description('告别语词表：窗口内对方消息命中即视为在收尾'),
        prompt: Schema.string().role('textarea').default(DEFAULT_LOOP_PROMPT)
          .description('复核提示词（要求模型只输出 STOP / CONTINUE）'),
      })
        .default({} as LoopGuardConfig)
        .description('双 AI 循环检测：防止两只 AI 互相接话停不下来')
        .collapse(),
    })
      .default({} as JudgeConfig)
      .description('可选：用小模型判断该不该回复 / 是否该停止接话'),
  }),

  // ── 官方机器人 ──
  Schema.object({
    officialBot: Schema.object({
      reply: Schema.boolean().default(false)
        .description('是否回应官方机器人（QQ 标记为机器人的账号，如 Q群管家/群助手）：关闭时对其消息一律不回复、不处理'),
      useNapcatFlag: Schema.boolean().default(true)
        .description('用 NapCat 群成员 is_robot 标记判定（仅群聊可用；这是一手信号，建议保持开启）'),
      ids: Schema.array(Schema.string().description('用户 ID'))
        .default([])
        .description('官方机器人 ID 名单：按 userId 直接匹配（私聊/群聊都生效），用于标记没被 QQ 打标记的机器人'),
      nameKeywords: Schema.array(Schema.string().description('关键词'))
        .default(['Q群管家', '群管家', '群助手'])
        .description('昵称/群名片关键词：命中即视为官方机器人（留空 = 不使用；napcat 标记失效时的兜底）'),
    })
      .default({} as OfficialBotConfig)
      .description('官方机器人（入群就被群助手钓住的场景）'),
  }),
]) as unknown as Schema<Config>

// 控制台「使用说明」页。控制台用 k-markdown 的 unsafe 模式渲染 usage
// （@koishijs/plugin-config dist: V(q,{unsafe:"",class:"usage",...})），因此可内嵌 <style> 与自定义 class。
// 控制台默认样式为 .markdown p{margin:0}、.markdown code{color:var(--k-text-normal);background:var(--k-page-bg)}
// —— 正文挤、行内代码发灰，这里统一覆盖（选择器 .markdown .guard-usage xxx 提升优先级）。
// 行内代码统一写 <code>…</code> 而不是 markdown 反引号：模板字符串里不用转义，避免漏转义把字符串截断。
export const usage = `
<style>
.markdown .guard-usage { line-height: 1.85; color: var(--fg1); }
.markdown .guard-usage .lead { font-size: 1.06em; margin: .2em 0 .9em; }
.markdown .guard-usage p { margin: .55em 0; }
.markdown .guard-usage h3 { margin: 1.7em 0 .5em; padding-left: .6em; font-size: 1.12em; border-left: 3px solid var(--k-color-primary); }
.markdown .guard-usage ul { margin: .35em 0 .7em; padding-left: 1.4em; }
.markdown .guard-usage li { margin: .4em 0; }
.markdown .guard-usage li::marker { color: var(--k-color-primary); }
.markdown .guard-usage strong { color: var(--fg1); font-weight: 600; }
.markdown .guard-usage code { color: var(--fg1); font-weight: 600; font-size: 1.02em; padding: .12em .45em; background: var(--k-color-primary-fade); border-radius: 4px; }
.markdown .guard-usage blockquote { margin: .9em 0; padding: .6em .95em; border-left: 3px solid var(--k-color-primary); background: var(--k-color-primary-fade); border-radius: 0 6px 6px 0; }
.markdown .guard-usage blockquote p { margin: 0; }
.markdown .guard-usage .pills { display: flex; flex-wrap: wrap; gap: .45em; margin: .9em 0 1.3em; }
.markdown .guard-usage .pill { padding: .2em .75em; font-size: .92em; border-radius: 999px; background: var(--k-hover-bg); color: var(--fg1); }
.markdown .guard-usage .warn { margin: .9em 0; padding: .65em .95em; border-left: 3px solid #e6a23c; background: rgba(230, 162, 60, .13); border-radius: 0 6px 6px 0; }
.markdown .guard-usage table { width: 100%; margin: .8em 0 1.1em; border-collapse: collapse; font-size: .97em; }
.markdown .guard-usage th, .markdown .guard-usage td { padding: .4em .65em; text-align: left; border: 1px solid var(--k-color-divider); }
.markdown .guard-usage th { font-weight: 600; background: var(--k-hover-bg); }
</style>

<div class="guard-usage">

<p class="lead"><strong>ChatLuna 护栏插件</strong>：给 AI 对话装上五道闸门 —— <strong>用户配额</strong>、<strong>规则防刷屏</strong>、<strong>前置判官</strong>、<strong>双 AI 循环检测</strong>、<strong>官方机器人闸门</strong>。所有拦截都发生在 chatluna 的对话链内部，<strong>不影响其他插件的 koishi 指令</strong>；页面顶部状态卡片实时显示各项配置的生效情况。</p>

<div class="pills"><span class="pill">用户配额</span><span class="pill">规则防刷屏</span><span class="pill">前置判官</span><span class="pill">双 AI 循环检测</span><span class="pill">官方机器人</span></div>

### 生效范围速查（最容易踩的坑）

| 功能 | 默认生效范围 | 想覆盖群聊要怎么做 |
| --- | --- | --- |
| 用户配额 | 私聊 + 群聊（两套独立限额） | 默认已覆盖；<code>groupHourly</code> / <code>groupDaily</code> 设 <code>0</code> 则群聊不限 |
| 规则防刷屏 | **仅私聊**（<code>scope</code> 默认 <code>direct</code>） | 把 <code>spamGuard.scope</code> 改成 <code>all</code> |
| 前置判官 | **仅私聊**（<code>scope</code> 默认 <code>direct</code>） | 把 <code>judge.scope</code> 改成 <code>all</code> |
| 双 AI 循环检测 | 私聊 + 群聊（<code>scope</code> 默认 <code>all</code>） | 默认已覆盖（群聊是主场景） |
| 官方机器人闸门 | 全平台 | 默认已覆盖；想回应就把 <code>officialBot.reply</code> 打开 |

### 用户配额
- 按用户维度限制每小时 / 每天对话次数（私聊、群聊独立），**<code>0</code> = 不限**
- 权限分级表 <code>tiers</code>：用户 authority 命中最高一档时，整档覆盖基础限额
- 豁免：<code>exemptAllGroups</code> 群聊整体豁免；<code>exemptUsers</code> / <code>exemptGroups</code> 逐个放行
  —— 豁免用户同时不受防刷屏、判官与循环检测影响
- 超限回复 <code>limitMessage</code>（<code>{0}</code> 剩余等待时间、<code>{1}</code> 本小时/今天）；
  <code>notifyOnce</code> 开启时同一受限周期只提醒一次，之后静默拒绝

### 规则防刷屏（零模型调用）
- 窗口 <code>windowSeconds</code> 秒内，同一用户触发 <code>maxCount</code> 次回复 → **先发一条提示**
  （<code>silenceMessage</code>，<code>{0}</code> 为静默分钟数，**留空则不发**），且**触发的那条不再回复**
- 随后静默 <code>silenceMinutes</code> 分钟：静默期内该用户消息**整条忽略**（不回复、不处理、不计配额），
  且**不会延长**，到点自动恢复并重新计数

> **计数点是 <code>request_conversation</code>**——chatluna 真正要调模型的那一刻。只统计"真正触发模型回复"的消息，
> 群聊里没 @ 机器人、纯闲聊的消息**不计数**，不会把人误送进静默。

### 前置判官（可选）
- 调用主模型前，用小模型判断这条该不该回：判 <code>SILENT</code> 直接静默；超时 / 出错一律放行（fail-open）
- **并发上限** <code>maxConcurrent</code>（默认 4、最大 12，<code>0</code> = 不限制）：判官与双 AI 循环复核**共用**
  同一个在飞计数，超出时该条直接放行（fail-open，不排队、不报错，只记一条 info 日志）
- 判官模型在插件 <code>ready</code> 后**延迟 3 秒**创建（等 chatluna 平台与适配器注册就绪）；
  延迟期间判官尚未生效，消息正常放行到主模型
- 模型创建失败时状态卡片会显示红色告警，错误详情见日志

<div class="warn">⚠️ <strong>判官务必选“指令遵循好”的对话模型</strong>：推理 / 思考型模型可能无视 <code>REPLY</code> / <code>SILENT</code> 的格式约束，直接回一段聊天内容 —— 判官<strong>看似正常实则空转</strong>（不报错，全部 fail-open）。</div>

### 双 AI 循环检测（<code>judge.loopGuard</code>，需判官模型）
防止"对方其实也是 AI"时两只机器人互相接话停不下来：
- **计数**：窗口 <code>windowMinutes</code>（默认 5 分钟）内**对方发来的**消息条数
- **规则初筛**（零成本，不满足则完全不调模型）：bot 特征命中 <code>minBotSignals</code> 条（默认 2，共 3 条可选）
  —— ① 长篇大论占比（≥<code>longTextLength</code> 字）② 括号 / 舞台动作描写（<code>（）</code> <code>()</code> <code>【】</code> <code>**</code>，≥2 条）
  ③ 秒回长文（间隔 &lt;<code>fastReplySeconds</code> 秒且内容超长，人类打字做不到）
- **触发复核**：达到 <code>turnThreshold</code>（默认 8 句）**且对方已道别**（命中 <code>farewellWords</code>），
  或达到 <code>hardCap</code>（默认 15 句）硬上限（不再要求告别语）
- **模型复核**：把窗口内对方发言（含每条间隔秒数）交给判官模型，只认明确的 <code>STOP</code>
- **收口方式**：**本条照常回复**（把对方的告别回完），从对方下一条消息起不再接话；
  直到对方**安静满 <code>quietMinutes</code> 分钟**（默认 10）自动解除，视为对话已结束
- 循环静默期内对方消息在链首被拦：不回复、不处理、不消耗配额

### 官方机器人闸门（<code>officialBot</code>）
入群时常被 QQ 官方机器人（Q群管家 / 群助手这类只会重复几句的账号）搭话，原有行为会把它当普通用户聊起来。
- <code>reply</code>（默认**关闭**）：是否回应官方机器人 —— 关闭时对其消息一律不回复、不处理
- 识别信号按优先级：NapCat 群成员 <code>is_robot</code> 标记（<code>useNapcatFlag</code>，群聊一手信号，结果缓存 10 分钟）
  → <code>ids</code> 名单（私聊也生效）→ 昵称 / 群名片关键词 <code>nameKeywords</code>（默认 <code>Q群管家</code> / <code>群管家</code> / <code>群助手</code>）
- 想让某个机器人重新被回应：把它加进配额的 <code>exemptUsers</code>（豁免优先于本闸门）

> 仅统计"真正会调用模型"的对话消息；指令流与后台任务不计数、不判定。静默只堵 chatluna 的 AI 回复，
> 其他插件的指令照常可用（chatluna 自身的指令除外，需要时用 <code>exemptUsers</code> 放行）。

</div>
`.trim()

// ─────────────────────────────────────────────
// 内部状态类型
// ─────────────────────────────────────────────

interface GuardStateRow {
  key: string
  value: string
  expire?: Date
}

/** 控制台状态卡片快照（notifier 为可选服务，晚到时用最近快照补渲染） */
interface StatusSnapshot {
  type: 'primary' | 'success' | 'warning' | 'danger'
  lines: string[]
}

/** 配额状态（序列化存 chatluna_guard_state） */
interface QuotaState {
  /** 小时窗口起点 ms */
  ws: number
  /** 本小时窗口内已用次数 */
  hc: number
  /** 当前自然日 yyyy-m-d */
  d: string
  /** 当日已用次数 */
  dc: number
  /** 最近一次提醒时间 ms */
  nt: number
  /** 最近一次拒绝对应的解除时间（notifyOnce 判定用） */
  br: number
}

interface SilenceState {
  until: number
}

/** 双 AI 循环检测：窗口内对端单条消息 */
interface PeerMsg {
  at: number
  len: number
  text: string
}

/** 双 AI 循环检测：对端消息追踪（进程级滑窗，无需持久化） */
interface PeerTrack {
  msgs: PeerMsg[]
}

/** 循环静默状态（落盘）：muted 期间不再接话，直到对方安静满 quietMinutes */
interface LoopMuteState {
  muted: boolean
  /** 对方最后一次发言时间 ms */
  lastMsgAt: number
}

const HOUR_MS = 60 * 60 * 1000
const DAY_KEY_MAX_AGE = 48 * HOUR_MS

const md5 = (s: string) => createHash('md5').update(s).digest('hex')
const dayKey = (t = Date.now()) => {
  const d = new Date(t)
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
}

/** 距离下一次重置的剩余时间可读文本 */
function formatRemain(msLeft: number): string {
  const totalMin = Math.max(1, Math.ceil(msLeft / 60000))
  const days = Math.floor(totalMin / 1440)
  const hours = Math.floor((totalMin % 1440) / 60)
  const minutes = totalMin % 60
  if (days > 0) return `${days} 天 ${hours} 小时`
  if (hours > 0) return `${hours} 小时 ${minutes} 分`
  return `${minutes} 分钟`
}

/** 从判官/复核模型返回里抽出纯文本（兼容 string 与 content-part 数组） */
function modelText(result: any): string {
  const c = result?.content
  if (typeof c === 'string') return c
  if (Array.isArray(c)) return c.map((x: any) => (typeof x === 'string' ? x : (x?.text ?? ''))).join('')
  return String(c ?? '')
}

// ─────────────────────────────────────────────
// 主入口
// ─────────────────────────────────────────────

export function apply(ctx: Context, config: Config) {
  const logger = ctx.logger('chatluna-guard')

  // ── 控制台状态卡片（memes-api 模式：notifier 可选注入 + 初始化/运行状态摘要） ──
  let notifier: Notifier | undefined
  let lastStatus: StatusSnapshot = { type: 'primary', lines: ['chatluna-guard 初始化中……'] }
  const setStatus = (type: StatusSnapshot['type'], ...lines: string[]) => {
    lastStatus = { type, lines }
    notifier?.update({ type, content: lines.map((l) => h('p', l)) })
  }
  // notifier 服务可能晚于 apply 就绪：就绪时用最近一次快照补渲染
  ctx.inject(['notifier'], () => {
    notifier = ctx.notifier.create({ type: lastStatus.type, content: lastStatus.lines.map((l) => h('p', l)) })
  })

  const fmtLimit = (hourly: number, daily: number) =>
    `${hourly > 0 ? hourly + '/h' : '∞'} · ${daily > 0 ? daily + '/d' : '∞'}`
  /** 汇总三组配置的当前状态（配额 / 防刷屏 / 判官各一行） */
  const summaryLines = (judgeText: string) => {
    const q = config.quota
    const sg = config.spamGuard
    return [
      `配额：私聊 ${fmtLimit(q.privateHourly, q.privateDaily)}，群聊 ${fmtLimit(q.groupHourly, q.groupDaily)}`,
      `防刷屏：${
        sg.enabled
          ? `开（${sg.windowSeconds} 秒 ${sg.maxCount} 条 → 静默 ${sg.silenceMinutes} 分钟，${sg.scope === 'all' ? '私聊+群聊' : '仅私聊'}，静默提示${sg.silenceMessage.trim() ? '开' : '关'}）`
          : '关'
      }`,
      judgeText,
      `官方机器人：${config.officialBot.reply ? '回应' : '不回应'}（${
        [
          config.officialBot.useNapcatFlag ? 'NapCat 标记' : null,
          config.officialBot.ids.length ? `名单 ${config.officialBot.ids.length} 个` : null,
          config.officialBot.nameKeywords.length ? `关键词 ${config.officialBot.nameKeywords.length} 个` : null,
        ]
          .filter(Boolean)
          .join(' + ') || '无识别信号'
      }）`,
      `双 AI 循环检测：${
        config.judge.loopGuard.enabled
          ? `开（≥${config.judge.loopGuard.turnThreshold} 句 + bot 特征 → 复核后停止接话；硬上限 ${config.judge.loopGuard.hardCap}；对方安静 ${config.judge.loopGuard.quietMinutes} 分钟解除）`
          : '关'
      }`,
    ]
  }

  // 自有状态表（与主插件 cache 隔离，重启不丢）
  ctx.model.extend(
    'chatluna_guard_state',
    {
      key: 'string(63)',
      value: 'text',
      expire: 'timestamp',
    },
    { primary: 'key' },
  )

  const store = {
    async get<T>(key: string): Promise<T | undefined> {
      const [row] = await ctx.database.get('chatluna_guard_state', { key }, ['value', 'expire'])
      if (!row) return
      if (row.expire && +row.expire < Date.now()) return
      try {
        return JSON.parse(row.value) as T
      } catch {
        return
      }
    },
    async set(key: string, value: unknown, maxAgeMs = DAY_KEY_MAX_AGE) {
      await ctx.database.upsert('chatluna_guard_state', [
        { key, value: JSON.stringify(value), expire: new Date(Date.now() + maxAgeMs) },
      ])
    },
  }

  // 定期清理过期行
  ctx.setInterval(async () => {
    await ctx.database
      .remove('chatluna_guard_state', { expire: { $lt: new Date() } })
      .catch(() => {})
  }, 30 * 60 * 1000)

  // ── 豁免判定 ──

  const isUserExempt = (userId?: string) => !!userId && config.quota.exemptUsers.includes(userId)
  const isGroupExempt = (session: Session) =>
    !session.isDirect &&
    (config.quota.exemptAllGroups || (!!session.guildId && config.quota.exemptGroups.includes(session.guildId)))

  // ── 官方机器人判定（"是否回应官方机器人"闸门） ──

  /** NapCat is_robot 标记缓存：key = platform:userId（避免每条消息都打一次接口） */
  const robotFlagCache = new Map<string, { robot: boolean; at: number }>()

  /** 取群成员的 NapCat is_robot 标记（带缓存；拿不到或非群聊返回 undefined） */
  async function fetchRobotFlag(session: Session): Promise<boolean | undefined> {
    if (!config.officialBot.useNapcatFlag) return undefined
    if (session.isDirect || !session.guildId) return undefined
    const key = `${session.platform}:${session.userId}`
    const now = Date.now()
    const cached = robotFlagCache.get(key)
    if (cached && now - cached.at < ROBOT_FLAG_TTL_MS) return cached.robot
    // 裸调 adapter 的 getGroupMemberInfo（decodeGuildMember 会丢掉 is_robot，必须取原始返回）
    const internal = (session.bot as any)?.internal
    if (typeof internal?.getGroupMemberInfo !== 'function') return undefined
    try {
      const data: any = await internal.getGroupMemberInfo(session.guildId, session.userId)
      const robot = data?.is_robot === true
      robotFlagCache.set(key, { robot, at: now })
      return robot
    } catch (e: any) {
      logger.debug(`[guard] 读取群成员 is_robot 失败（${session.userId}）：${e?.message ?? e}`)
      return undefined
    }
  }

  /** 对端是否官方机器人：ID 名单 → NapCat 标记 → 昵称/群名片关键词 */
  async function isOfficialBotPeer(session: Session): Promise<boolean> {
    const ob = config.officialBot
    if (ob.ids.includes(session.userId)) return true
    if (await fetchRobotFlag(session)) return true
    if (ob.nameKeywords.length) {
      const anySession = session as any
      const names = [
        session.author?.name,
        session.author?.nick,
        anySession.event?.member?.nick,
        anySession.event?.member?.name,
        anySession.event?.user?.nick,
      ].filter((x): x is string => typeof x === 'string' && !!x)
      if (names.some((n) => ob.nameKeywords.some((kw) => kw && n.includes(kw)))) return true
    }
    return false
  }

  // ── 双 AI 循环检测：对端消息追踪 ──

  /** 对端消息滑窗：key = 'l:'+md5(platform:userId) */
  const peerTracks = new Map<string, PeerTrack>()

  const loopKey = (session: { platform: string; userId?: string }) => 'l:' + md5(`${session.platform}:${session.userId ?? ''}`)

  /** 从窗口内对端消息提取「疑似 bot」特征与告别信号 */
  function evaluateLoopSignals(session: Session) {
    const lg = config.judge.loopGuard
    const msgs = peerTracks.get(loopKey(session))?.msgs ?? []
    const n = msgs.length
    const longCount = msgs.filter((m) => m.len >= lg.longTextLength).length
    const stageCount = msgs.filter((m) => STAGE_DIRECTION_RE.test(m.text)).length
    const fastLong = msgs.some(
      (m, i) => i > 0 && m.at - msgs[i - 1].at < lg.fastReplySeconds * 1000 && m.len >= lg.longTextLength,
    )
    const signals = [n > 0 && longCount / n >= 0.5, stageCount >= 2, fastLong]
    const botScore = signals.filter(Boolean).length
    const farewell =
      lg.farewellWords.length > 0 && msgs.some((m) => lg.farewellWords.some((w) => !!w && m.text.includes(w)))
    return { n, botScore, botLike: botScore >= lg.minBotSignals, farewell, msgs }
  }

  async function getUserAuthority(session: Session): Promise<number> {
    const fromAuthor = (session.author as { authority?: number } | undefined)?.authority
    if (fromAuthor != null) return fromAuthor
    try {
      const user = await session.getUser(session.userId, ['authority'])
      return ((user as { authority?: number } | undefined)?.authority) ?? 0
    } catch {
      return 0
    }
  }

  /** 按 权限档位 + 私聊/群聊 解析出本条消息适用的限额 */
  async function resolveLimits(session: Session, isDirect: boolean): Promise<{ hourly: number; daily: number }> {
    const q = config.quota
    let hourly = isDirect ? q.privateHourly : q.groupHourly
    let daily = isDirect ? q.privateDaily : q.groupDaily
    if (q.tiers.length) {
      const authority = await getUserAuthority(session)
      const sorted = [...q.tiers].sort((a, b) => a.authority - b.authority)
      for (const t of sorted) {
        if (authority >= t.authority) {
          hourly = isDirect ? t.privateHourly : t.groupHourly
          daily = isDirect ? t.privateDaily : t.groupDaily
        }
      }
    }
    return { hourly, daily }
  }

  // ── 功能 1：用户配额（check + save 两个链中间件，语义对齐主插件 chat_time_limit_*） ──

  const chatluna: ChatLunaService = ctx.chatluna
  const chain = chatluna.chatChain

  chain
    .middleware(
      'guard_quota_check',
      async (session, context: ChainMiddlewareContext) => {
        // 仅拦截"真正会调用模型"的消息：后台 agent 任务 / 角色调用 / 纯指令流不计数
        if (context.options?.invocation != null) return ChainMiddlewareRunStatus.SKIPPED
        if (context.options?.inputMessage == null) return ChainMiddlewareRunStatus.SKIPPED
        if (isUserExempt(session.userId) || isGroupExempt(session)) return ChainMiddlewareRunStatus.CONTINUE

        const { hourly, daily } = await resolveLimits(session, session.isDirect)
        if (hourly <= 0 && daily <= 0) return ChainMiddlewareRunStatus.CONTINUE

        const key = 'q:' + md5(`${session.platform}:${session.userId}`)
        const now = Date.now()
        const st: QuotaState = (await store.get<QuotaState>(key)) ?? {
          ws: now,
          hc: 0,
          d: dayKey(),
          dc: 0,
          nt: 0,
          br: 0,
        }
        if (now - st.ws >= HOUR_MS) {
          st.ws = now
          st.hc = 0
        }
        const today = dayKey()
        if (st.d !== today) {
          st.d = today
          st.dc = 0
        }

        const blockedHour = hourly > 0 && st.hc >= hourly
        const blockedDay = daily > 0 && st.dc >= daily
        if (!blockedHour && !blockedDay) {
          // 把状态挂到链上下文，由 guard_quota_save 在调用发出后落盘
          context.options!.guardQuota = { st, key }
          return ChainMiddlewareRunStatus.CONTINUE
        }

        // 受限：计算解除时间，按 notifyOnce 决定是否回提示
        const hourReset = blockedHour ? st.ws + HOUR_MS : Infinity
        const dayReset = blockedDay
          ? new Date(new Date().setHours(24, 0, 0, 0)).getTime()
          : Infinity
        const resetAt = Math.min(hourReset, dayReset)
        // 提示语中的计次范围词：取先到达重置点的那个维度
        const scopeLabel = hourReset <= dayReset ? '本小时' : '今天'
        const alreadyNotified = config.quota.notifyOnce && st.br === resetAt && st.nt > 0
        if (!alreadyNotified) {
          context.message = config.quota.limitMessage
            .replace('{0}', formatRemain(resetAt - now))
            .replace(/\{1\}/g, scopeLabel)
          st.nt = now
          st.br = resetAt
          await store.set(key, st)
          logger.info(
            `[guard] 用户 ${session.userId} 配额超限（${session.isDirect ? '私聊' : '群聊'} hc=${st.hc}/dc=${st.dc}，` +
              `限 ${hourly > 0 ? hourly + '/h' : '∞'}${daily > 0 ? '、' + daily + '/d' : ''}），已发提示`,
          )
        } else {
          logger.debug(`[guard] 用户 ${session.userId} 配额超限，冷却期内静默`)
        }
        return ChainMiddlewareRunStatus.STOP
      },
      ctx,
    )
    .after('transform_chat_message')
    .before('chat_time_limit_check')

  chain
    .middleware(
      'guard_quota_save',
      async (session, context: ChainMiddlewareContext) => {
        void session
        const attached = context.options?.guardQuota as { st: QuotaState; key: string } | undefined
        if (!attached) return ChainMiddlewareRunStatus.SKIPPED
        attached.st.hc++
        attached.st.dc++
        await store.set(attached.key, attached.st)
        return ChainMiddlewareRunStatus.CONTINUE
      },
      ctx,
    )
    .after('chat_time_limit_save')

  // ── 功能 2 · C：规则防刷屏（request_conversation 前计数 + before-check-sender 拦截） ──

  /** 内存滑窗：key -> 最近「模型开始回复」的时间戳列表（进程级，无需持久化） */
  const recent = new Map<string, number[]>()

  /** 进入静默时发送自定义提示（文案留空则不发送；发送失败只记日志，不影响静默本身生效） */
  async function sendSilenceNotice(session: Session, sg: SpamGuardConfig) {
    const text = sg.silenceMessage.trim()
    if (!text) return
    try {
      await session.send(text.replace(/\{0\}/g, String(sg.silenceMinutes)))
      logger.info(`[guard] 已向用户 ${session.userId} 发送静默提示`)
    } catch (e: any) {
      logger.warn(`[guard] 静默提示发送失败：${e?.message ?? e}`)
    }
  }

  // 计数点挂在 request_conversation（chatluna 真正调模型的节点）之前：只有"通过全部前置检查、
  // 模型即将开始回复"的消息才计数。因此群聊里没触发对话的消息（没 @ 机器人、纯闲聊）不会计数，
  // 只有真正把机器人叫起来回复的消息才会把人推进静默。
  if (config.spamGuard.enabled) {
    chain
      .middleware(
        'guard_spam_count',
        async (session) => {
          const sg = config.spamGuard
          if (sg.scope !== 'all' && !session.isDirect) return ChainMiddlewareRunStatus.CONTINUE
          // 群豁免统一按 guildId（群号）匹配，与 before-check-sender 的判定保持一致
          if (isUserExempt(session.userId) || isGroupExempt(session)) return ChainMiddlewareRunStatus.CONTINUE

          const key = 's:' + md5(`${session.platform}:${session.userId}`)
          const now = Date.now()
          const winMs = sg.windowSeconds * 1000
          const arr = (recent.get(key) ?? []).filter((t) => now - t < winMs)
          arr.push(now)
          if (arr.length < sg.maxCount) {
            recent.set(key, arr)
            return ChainMiddlewareRunStatus.CONTINUE
          }

          // 触发静默：清计数；时长固定为配置值，到点自动恢复（静默期内不会再被延长）
          recent.delete(key)
          const until = now + sg.silenceMinutes * 60 * 1000
          // 先落盘静默再发提示：即使发送失败/缓慢，后续消息也已被拦住
          await store.set(key, { until }, sg.silenceMinutes * 60 * 1000 + HOUR_MS)
          logger.info(
            `[guard] 用户 ${session.userId} 在 ${sg.windowSeconds} 秒内触发 ${sg.maxCount} 次回复，` +
              `进入静默至 ${new Date(until).toLocaleTimeString()}（到点自动恢复）`,
          )
          await sendSilenceNotice(session, sg)
          // 本条不再回复（静默从这一条生效）；后续消息由 before-check-sender 在链首拦掉
          return ChainMiddlewareRunStatus.STOP
        },
        ctx,
      )
      .before('request_conversation')
  }

  ctx.on('chatluna/before-check-sender', async (session) => {
    // 1) 官方机器人闸门：开关关闭时对其消息一律不回应（豁免用户可放行，作为白名单逃生口）
    const exempt = isUserExempt(session.userId)
    if (!exempt && !config.officialBot.reply && (await isOfficialBotPeer(session))) {
      logger.debug(`[guard] 官方机器人不回应：${session.userId}`)
      return true
    }

    // 2) 双 AI 循环静默：命中后不再接话（解除由 message-observed 按"对方安静满 N 分钟"处理）
    if (!exempt && config.judge.loopGuard.enabled) {
      const mute = await store.get<LoopMuteState>(loopKey(session))
      if (mute?.muted) return true
    }

    // 3) 规则防刷屏静默
    const sg = config.spamGuard
    if (!sg.enabled) return false
    if (sg.scope !== 'all' && !session.isDirect) return false
    if (exempt || isGroupExempt(session)) return false
    const st = await store.get<SilenceState>('s:' + md5(`${session.platform}:${session.userId}`))
    // 静默期内（未到点）：在 allow_reply（链首）直接 STOP —— 不回复、不进入后续任何处理，
    // 也不消耗配额；提示已在进入静默时发过一次。到点后本判定自然失效、恢复正常。
    if (st && st.until > Date.now()) return true
    return false
  })

  // ── 功能 3：双 AI 循环检测 —— 对端消息追踪 + 静默解除 ──

  ctx.on('chatluna/message-observed', async (msg) => {
    const lg = config.judge.loopGuard
    if (!lg.enabled) return
    if (isUserExempt(msg.userId)) return
    const key = loopKey(msg)
    const now = Date.now()

    // 循环静默中：只有对方安静满 quietMinutes 才解除（视为对话已结束）；
    // 否则刷新"最后发言时刻"继续保持静默——静默期内不跟踪、不计数。
    const mute = await store.get<LoopMuteState>(key)
    if (mute?.muted) {
      const keepMs = lg.quietMinutes * 60 * 1000 + HOUR_MS
      if (now - mute.lastMsgAt >= lg.quietMinutes * 60 * 1000) {
        await store.set(key, { muted: false, lastMsgAt: now }, keepMs)
        peerTracks.delete(key)
        logger.info(`[guard] 双 AI 循环静默解除（对方已安静 ${lg.quietMinutes} 分钟）：${msg.userId}`)
      } else {
        await store.set(key, { muted: true, lastMsgAt: now }, keepMs)
        return
      }
    }

    const track = peerTracks.get(key) ?? { msgs: [] }
    const winMs = lg.windowMinutes * 60 * 1000
    track.msgs = track.msgs.filter((m) => now - m.at < winMs)
    track.msgs.push({ at: now, len: (msg.content ?? '').length, text: msg.content ?? '' })
    peerTracks.set(key, track)
  })

  // 对端滑窗内存回收
  ctx.setInterval(() => {
    const winMs = config.judge.loopGuard.windowMinutes * 60 * 1000
    const now = Date.now()
    for (const [key, track] of peerTracks) {
      const kept = track.msgs.filter((m) => now - m.at < winMs)
      if (kept.length) track.msgs = kept
      else peerTracks.delete(key)
    }
  }, 5 * 60 * 1000)

  // 滑窗内存回收
  ctx.setInterval(() => {
    const winMs = config.spamGuard.windowSeconds * 1000
    const now = Date.now()
    for (const [key, arr] of recent) {
      const kept = arr.filter((t) => now - t < winMs)
      if (kept.length) recent.set(key, kept)
      else recent.delete(key)
    }
  }, 60 * 1000)

  // ── 功能 2 · A：前置判官模型（可选） ──

  // 无条件注册模型下拉（对齐 sticker 模式）：Schema.dynamic 仅影响控制台渲染、
  // 不参与 cast 校验，判官关闭时注册也无副作用，且用户打开开关后可直接看到下拉
  registerJudgeModelSchema(ctx)

  let judgeModelRef: { value?: any } | undefined
  let judgeRunning = 0
  let judgeInitRunning = false

  ctx.on('ready', async () => {
    const j = config.judge
    // 判官与双 AI 循环检测共用同一个模型实例
    if (!j.enabled && !j.loopGuard.enabled) return
    if (!j.model) {
      setStatus('warning', ...summaryLines('判官/循环检测：已启用但**未选择模型**，不生效'))
      return
    }
    // ready 可能重复触发：已有实例、或已有一次初始化在途时，不重复创建
    if (judgeModelRef || judgeInitRunning) return
    judgeInitRunning = true
    try {
      // 启动延迟：ready 时 chatluna 平台与各适配器可能仍在注册（此时建模型实例易失败），
      // 先等一拍；定时器挂在插件 scope 上，热重载/停服时自动取消
      await new Promise<void>((resolve) => ctx.setTimeout(resolve, JUDGE_INIT_DELAY_MS))
      judgeModelRef = await chatluna.createChatModel(j.model)
      logger.info(`[guard] 判官模型已就绪（启动延迟 ${JUDGE_INIT_DELAY_MS}ms 后创建）：${j.model}`)
      setStatus(
        'success',
        ...summaryLines(
          `判官：开（${j.model}，超时 ${j.timeoutMs}ms，并发${
            j.maxConcurrent > 0 ? ` ≤${j.maxConcurrent}` : '不限'
          }）`,
        ),
      )
    } catch (e: any) {
      logger.warn(`[guard] 判官模型 ${j.model} 创建失败（判官不生效）：${e?.message ?? e}`)
      setStatus(
        'danger',
        ...summaryLines(`判官：模型 ${j.model} 创建失败，不生效！请检查模型名与平台配置，错误详情见日志`),
      )
    } finally {
      judgeInitRunning = false
    }
  })

  let judgeInvokeWarned = false

  async function askJudge(session: Session): Promise<'REPLY' | 'SILENT' | 'PASS'> {
    const j = config.judge
    if (!judgeModelRef?.value) return 'PASS'
    // maxConcurrent = 0 表示不限制；判官与循环复核共用同一个在飞计数
    if (j.maxConcurrent > 0 && judgeRunning >= j.maxConcurrent) {
      logger.info(`[guard] 判官过载（并发 >= ${j.maxConcurrent}），本条放行`)
      return 'PASS' // 过载放行（fail-open）
    }
    judgeRunning++
    try {
      const content = (session.content ?? '').slice(0, 500)
      const botName = (session.bot as { selfName?: string }).selfName || session.bot.selfId || '未知'
      // invoke 失败也参与 race：把真实错误单独记录，避免被后到的 timeout 掩盖根因
      const invoke = judgeModelRef!.value
        .invoke([
          { role: 'system', content: j.prompt },
          {
            role: 'user',
            content: `【机器人昵称：${botName}】【用户消息】\n${content}`,
          },
        ])
        .then(
          (r: any) => ({ ok: true as const, result: r }),
          (err: any) => {
            logger.info(`[guard] 判官模型真实调用错误：${err?.message ?? err}`)
            return { ok: false as const, result: undefined as any }
          },
        )
      const raced = await Promise.race([
        invoke,
        new Promise<'TIMEOUT'>((resolve) => ctx.setTimeout(() => resolve('TIMEOUT'), j.timeoutMs)),
      ])
      if (raced === 'TIMEOUT') throw new Error(`判官超时（${j.timeoutMs}ms，真实结果可能稍后记录）`)
      if (!raced.ok) throw new Error('判官调用失败')
      const result: any = raced.result
      const upper = modelText(result).toUpperCase()
      return upper.includes('SILENT') && !upper.includes('REPLY') ? 'SILENT' : 'REPLY'
    } catch (e: any) {
      // 首次失败必须可见（否则判官整条链路可能静默失效），之后降为 debug 防刷屏
      if (!judgeInvokeWarned) {
        judgeInvokeWarned = true
        logger.warn(`[guard] 判官放行（首次失败详情见上方记录）：${e?.message ?? e}`)
      } else {
        logger.debug(`[guard] 判官放行（${e?.message ?? e}）`)
      }
      return 'PASS'
    } finally {
      judgeRunning--
    }
  }

  if (config.judge.enabled) {
    chain
      .middleware(
        'guard_judge_check',
        async (session, context: ChainMiddlewareContext) => {
          const j = config.judge
          if (!j.enabled || !judgeModelRef) return ChainMiddlewareRunStatus.SKIPPED
          // 只判定"会被回复"的消息；指令流与后台任务不判
          if (context.options?.invocation != null) return ChainMiddlewareRunStatus.SKIPPED
          if (context.options?.inputMessage == null) return ChainMiddlewareRunStatus.SKIPPED
          if (context.command != null) return ChainMiddlewareRunStatus.SKIPPED
          if (context.options?.reply_status !== true) return ChainMiddlewareRunStatus.SKIPPED
          if (j.scope !== 'all' && !session.isDirect) return ChainMiddlewareRunStatus.CONTINUE
          if (isUserExempt(session.userId)) return ChainMiddlewareRunStatus.CONTINUE

          const verdict = await askJudge(session)
          if (verdict === 'SILENT') {
            logger.info(`[guard] 判官拒答（用户 ${session.userId}）：${(session.content ?? '').slice(0, 50)}`)
            return ChainMiddlewareRunStatus.STOP // 静默，不发任何提示
          }
          return ChainMiddlewareRunStatus.CONTINUE
        },
        ctx,
      )
      .after('guard_quota_check')
      .before('chat_time_limit_check')
  }

  // ── 功能 3：双 AI 循环检测 —— 复核（模型判定"对方也是 AI 且该收尾"） ──

  /** 循环复核：把窗口内对端发言交给判官模型，判定是否 STOP（失败/超时/过载一律 CONTINUE 放行） */
  async function askLoopJudge(session: Session, signals: ReturnType<typeof evaluateLoopSignals>) {
    const lg = config.judge.loopGuard
    if (!judgeModelRef?.value) return 'CONTINUE'
    if (config.judge.maxConcurrent > 0 && judgeRunning >= config.judge.maxConcurrent) {
      logger.info(`[guard] 循环复核过载（并发 >= ${config.judge.maxConcurrent}），本次放行`)
      return 'CONTINUE'
    }
    judgeRunning++
    try {
      const recentMsgs = signals.msgs.slice(-8)
      const transcript = recentMsgs
        .map((m, i) => {
          const gap = i > 0 ? Math.round((m.at - recentMsgs[i - 1].at) / 1000) : 0
          return `[间隔 ${gap}s] ${m.text.slice(0, 200)}`
        })
        .join('\n')
      const hint =
        `【统计】窗口内对方共 ${signals.n} 条消息；bot 特征命中 ${signals.botScore} 条；` +
        `${signals.farewell ? '检测到告别语' : '未检测到告别语'}。`
      const invoke = judgeModelRef!.value
        .invoke([
          { role: 'system', content: lg.prompt },
          { role: 'user', content: `${hint}\n【对方近期发言】\n${transcript}` },
        ])
        .then(
          (r: any) => ({ ok: true as const, result: r }),
          (err: any) => {
            logger.info(`[guard] 循环复核模型真实调用错误：${err?.message ?? err}`)
            return { ok: false as const, result: undefined as any }
          },
        )
      const raced = await Promise.race([
        invoke,
        new Promise<'TIMEOUT'>((resolve) => ctx.setTimeout(() => resolve('TIMEOUT'), config.judge.timeoutMs)),
      ])
      if (raced === 'TIMEOUT') throw new Error(`循环复核超时（${config.judge.timeoutMs}ms）`)
      if (!raced.ok) throw new Error('循环复核调用失败')
      const upper = modelText((raced as { result: any }).result).toUpperCase()
      // 只在明确给出 STOP 时才收口；其余（含模型跑偏输出）一律继续
      return upper.includes('STOP') && !upper.includes('CONTINUE') ? 'STOP' : 'CONTINUE'
    } catch (e: any) {
      logger.warn(`[guard] 循环复核放行（${e?.message ?? e}）`)
      return 'CONTINUE'
    } finally {
      judgeRunning--
    }
  }

  if (config.judge.loopGuard.enabled) {
    chain
      .middleware(
        'guard_loop_check',
        async (session, context: ChainMiddlewareContext) => {
          const lg = config.judge.loopGuard
          // 复核依赖判官模型；模型没就绪则不动作（规则初筛 + 模型复核，两者缺一不可）
          if (!judgeModelRef?.value) return ChainMiddlewareRunStatus.SKIPPED
          if (context.options?.invocation != null) return ChainMiddlewareRunStatus.SKIPPED
          if (context.options?.inputMessage == null) return ChainMiddlewareRunStatus.SKIPPED
          if (context.command != null) return ChainMiddlewareRunStatus.SKIPPED
          if (context.options?.reply_status !== true) return ChainMiddlewareRunStatus.SKIPPED
          if (lg.scope !== 'all' && !session.isDirect) return ChainMiddlewareRunStatus.CONTINUE
          if (isUserExempt(session.userId)) return ChainMiddlewareRunStatus.CONTINUE

          const signals = evaluateLoopSignals(session)
          // 规则初筛：必须有 bot 特征，且（达到硬上限）或（达到句数阈值且对方已道别）
          if (!signals.botLike) return ChainMiddlewareRunStatus.CONTINUE
          const enoughTurn = signals.n >= lg.turnThreshold
          const hitCap = lg.hardCap > 0 && signals.n >= lg.hardCap
          if (!hitCap && !(enoughTurn && signals.farewell)) return ChainMiddlewareRunStatus.CONTINUE

          const verdict = await askLoopJudge(session, signals)
          if (verdict === 'STOP') {
            // 「照常回完这条」：本条继续走主模型，从对方下一条消息起不再接话
            const key = loopKey(session)
            await store.set(
              key,
              { muted: true, lastMsgAt: Date.now() },
              lg.quietMinutes * 60 * 1000 + HOUR_MS,
            )
            logger.info(
              `[guard] 判定为双 AI 循环对话并停止接话（对方 ${signals.n} 条 / bot 特征 ${signals.botScore} 条` +
                `${signals.farewell ? ' / 已道别' : ' / 无告别语'}）：本条回复后不再接话，` +
                `直到对方安静 ${lg.quietMinutes} 分钟`,
            )
          }
          return ChainMiddlewareRunStatus.CONTINUE
        },
        ctx,
      )
      .after('guard_quota_check')
      .before('chat_time_limit_check')
  }

  logger.info(
    `[guard] 已启用（配额：私聊 ${config.quota.privateHourly}/h、${config.quota.privateDaily}/d，` +
      `群聊 ${config.quota.groupHourly}/h、${config.quota.groupDaily}/d；防刷屏：${config.spamGuard.enabled ? '开' : '关'}；` +
      `判官：${config.judge.enabled ? config.judge.model || '未配置模型' : '关'}；` +
      `双 AI 循环检测：${config.judge.loopGuard.enabled ? `开（≥${config.judge.loopGuard.turnThreshold} 句 / 硬上限 ${config.judge.loopGuard.hardCap}）` : '关'}；` +
      `官方机器人：${config.officialBot.reply ? '回应' : '不回应'}）`,
  )

  // 判官/循环检测都关闭 → 立即定格 success；否则保持"初始化中"直到 ready 探测出结果
  if (!config.judge.enabled && !config.judge.loopGuard.enabled) setStatus('success', ...summaryLines('判官：关'))
  else setStatus('primary', ...summaryLines(`判官：等待模型初始化（启动延迟 ${JUDGE_INIT_DELAY_MS / 1000} 秒）……`))
}

// ─────────────────────────────────────────────
// 判官模型下拉注册（参考 chatluna-sticker 的重试策略）
// ─────────────────────────────────────────────

function registerJudgeModelSchema(ctx: Context) {
  let registeredCount = -1
  let settled = false

  const tryRegister = async (): Promise<boolean> => {
    try {
      const list = ctx.chatluna?.platform?.listAllModels(ModelType.llm)?.value ?? []
      const names = [...new Set(list.map((m: any) => m.toModelName()).filter(Boolean))].sort()
      if (!names.length) return false
      if (names.length === registeredCount) return true
      registeredCount = names.length
      ctx.schema.set(JUDGE_MODEL_SCHEMA_KEY, Schema.union(names.map((n) => Schema.const(n).description(n))))
      if (!settled) ctx.logger('chatluna-guard').info(`[guard] 判官模型下拉已注册，共 ${names.length} 个模型`)
      settled = true
      return true
    } catch {
      return false
    }
  }

  const ensureFallback = () => {
    if (settled) return
    // 拿不到列表时至少让字段可渲染（空串 = 未选择）
    ctx.schema.set(
      JUDGE_MODEL_SCHEMA_KEY,
      Schema.union([Schema.const('').description('（暂未获取到 chatluna 模型列表）')]),
    )
    ctx.logger('chatluna-guard').warn('[guard] 暂未获取到 chatluna 模型列表，判官模型下拉回退（空串 = 未选择）')
  }

  tryRegister().then((ok) => {
    if (!ok) ensureFallback()
  })
  ctx.on('ready', () => {
    tryRegister().catch(() => {})
  })
  let tries = 0
  const timer = ctx.setInterval(() => {
    tries++
    tryRegister()
      .catch(() => false)
      .then((ok) => {
        if (ok || tries >= 10) {
          if (!ok) ensureFallback()
          timer()
        }
      })
  }, 3000)
}
