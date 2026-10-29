/**
 * 时间窗口工具：所有「HH:mm 时段 / 跨零点 / 自然日」判断都走这里。
 *
 * 设计取舍：
 * - 只处理「本地墙钟时间」的分钟数，不把时区偏移写死，避免 Asia/Shanghai 之外的部署出错；
 * - 通过 Intl.DateTimeFormat 取指定 IANA 时区的年月日时分秒，DST 极端场景只影响边界秒级误差，
 *   对我们的小时/时段配额足够；
 * - 跨零点窗口统一按 [start, end) 处理：start > end 表示跨天，start === end 视为无效窗口。
 */

export interface ZonedParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

const formatterCache = new Map<string, Intl.DateTimeFormat>()

function formatter(timeZone: string): Intl.DateTimeFormat {
  let fmt = formatterCache.get(timeZone)
  if (fmt) return fmt
  fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
  formatterCache.set(timeZone, fmt)
  return fmt
}

/** 校验并返回可用的 IANA 时区；空串/非法值回退到服务器本地时区 */
export function resolveTimeZone(input?: string): string {
  const local = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  const value = (input ?? '').trim()
  if (!value) return local
  try {
    formatter(value).format(new Date())
    return value
  } catch {
    return local
  }
}

export function getZonedParts(ms: number, timeZone: string): ZonedParts {
  const map: Record<string, string> = {}
  for (const part of formatter(timeZone).formatToParts(new Date(ms))) {
    if (part.type !== 'literal') map[part.type] = part.value
  }
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour) % 24,
    minute: Number(map.minute),
    second: Number(map.second),
  }
}

/** 本地自然日 key，形如 2026-10-29 */
export function dayKey(ms: number, timeZone: string): string {
  const p = getZonedParts(ms, timeZone)
  return `${p.year}-${p.month}-${p.day}`
}

export function minutesOfDay(ms: number, timeZone: string): number {
  const p = getZonedParts(ms, timeZone)
  return p.hour * 60 + p.minute
}

/** HH:mm -> 当天分钟数；非法返回 null */
export function parseClock(text: string): number | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec((text ?? '').trim())
  if (!match) return null
  return Number(match[1]) * 60 + Number(match[2])
}

export function formatClock(minutes: number): string {
  const total = ((Math.round(minutes) % 1440) + 1440) % 1440
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}

/** 当前是否落在 [start, end) 内；start > end 自动按跨零点处理 */
export function inTimeWindow(ms: number, start: string, end: string, timeZone: string): boolean {
  const s = parseClock(start)
  const e = parseClock(end)
  if (s == null || e == null || s === e) return false
  const now = minutesOfDay(ms, timeZone)
  if (s < e) return now >= s && now < e
  return now >= s || now < e
}

/**
 * 当前所在窗口的结束时刻（毫秒时间戳）。
 * 只精确到秒级别；跨零点窗口按「现在到结束还有多少分钟」计算。
 */
export function windowEndAt(ms: number, start: string, end: string, timeZone: string): number {
  const s = parseClock(start)
  const e = parseClock(end)
  if (s == null || e == null || s === e) return ms
  const p = getZonedParts(ms, timeZone)
  const nowMin = p.hour * 60 + p.minute
  let deltaMin: number
  if (s < e) {
    deltaMin = nowMin < e ? e - nowMin : 24 * 60 - nowMin + e
  } else {
    deltaMin = nowMin >= s ? 24 * 60 - nowMin + e : e - nowMin
  }
  return ms + deltaMin * 60_000 - p.second * 1000
}

/**
 * 窗口所属的「夜次」key：跨零点窗口在凌晨仍算前一天。
 * 例：23:00-07:00，10-29 01:00 的 key 是 2026-10-28。
 */
export function windowKey(ms: number, start: string, end: string, timeZone: string): string {
  const s = parseClock(start)
  const e = parseClock(end)
  if (s != null && e != null && s > e && minutesOfDay(ms, timeZone) < e) {
    return dayKey(ms - 24 * 60 * 60 * 1000, timeZone)
  }
  return dayKey(ms, timeZone)
}

/** 下一个本地 0 点（毫秒时间戳） */
export function nextMidnightAt(ms: number, timeZone: string): number {
  const p = getZonedParts(ms, timeZone)
  const leftMin = 24 * 60 - (p.hour * 60 + p.minute)
  return ms + leftMin * 60_000 - p.second * 1000
}

/**
 * 未来 24 小时内的所有 HH:mm 边界（用于「时段切换后额度是否恢复」扫描）。
 * 返回升序、去重后的毫秒时间戳；只保留 > now 的项。
 */
export function futureClockBoundaries(ms: number, clocks: string[], timeZone: string): number[] {
  const p = getZonedParts(ms, timeZone)
  const nowMin = p.hour * 60 + p.minute
  const out = new Set<number>()
  for (const clock of clocks) {
    const target = parseClock(clock)
    if (target == null) continue
    let delta = target - nowMin
    if (delta <= 0) delta += 24 * 60
    const first = ms + delta * 60_000 - p.second * 1000
    out.add(first)
    out.add(first + 24 * 60 * 60 * 1000)
  }
  return [...out].filter((t) => t > ms).sort((a, b) => a - b)
}