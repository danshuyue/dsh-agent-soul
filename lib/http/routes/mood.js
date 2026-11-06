/**
 * HTTP 路由 · mood.js（2026-11-06 P16）。
 * 由 lib/http/server.js 的 registerApi 分支体经 P15 提取后整体搬来，函数体逐字未改。
 * 分派逻辑仍在 server.js；本文件只负责「某个路由具体做什么」。
 */

import { decayMoodFor, loadConfig, moodState, resetMood } from '../../store.js'
import { resolveCwd } from '../sessions.js'
import { secretInfo } from '../../core/secrets.js'
import { displayDimPercents, displayDims, moodFace, moodLabel, topDims } from '../../mood.js'
import { json, readBody } from '../middleware.js'
import { note } from '../../env.js'


export async function handleGetMood(ctx, req, res, query, route) {
          // 必须和 /state 用同一套兜底，否则详情页和概览页读的是两份文件
          const { cwd } = resolveCwd(ctx, query)
          const cfg = loadConfig()
          const s = moodState(cwd)
          return json(res, 200, {
            ok: true,
            cwd,
            config: cfg,
            // 密钥只报状态，绝不回显明文（2026-11-01）
            secrets: { siliconflow: secretInfo('siliconflow') },
            state: {
              mood: Math.round(s.mood),
              rawMood: s.mood,
              label: moodLabel(s.mood),
              face: moodFace(s.mood),
              dims: displayDims(s),
              dimsPercent: displayDimPercents(s),
              top: topDims(s),
              lastReason: s.lastReason,
              lastConfidence: s.lastConfidence,
              minor: s.minor,
              kind: s.kind,
              updatedAt: s.updatedAt,
              timelineCount: s.timeline.length,
              // 时间线倒序 60 条（页面再截 40）；t.dims 也一并给，方便 tooltip
              timeline: s.timeline.slice(-60).reverse().map((t) => ({
                at: t.at,
                mood: t.mood,
                delta: t.delta,
                reason: t.reason,
                conf: t.conf,
                minor: t.minor === true,
                kind: t.kind || '',
                dims: t.dims || null
              }))
            }
          })
}

export async function handlePostMoodReset(ctx, req, res, query, route) {
          const body = await readBody(req)
          const given = String(body?.cwd ?? '').trim()
          // 页面没给 cwd 就按当前工作区兜底：不然会把心情重置到一个从没用过的作用域上，
          // 页面还看不见自己刚重置的那份（表现为「点了重置却没反应」）
          const cwd = given !== '' ? given : resolveCwd(ctx, query).cwd
          const s = resetMood(cwd)
          note('api', `心情已重置（cwd=${cwd || '全局'}）→ ${Math.round(s.mood)}`)
          return json(res, 200, { ok: true, mood: Math.round(s.mood) })
}

export async function handlePostMoodDecay(ctx, req, res, query, route) {
          const body = await readBody(req)
          const given = String(body?.cwd ?? '').trim()
          const cwd = given !== '' ? given : resolveCwd(ctx, query).cwd
          const s = decayMoodFor(cwd)
          return json(res, 200, {
            ok: true,
            mood: Math.round(s.mood),
            dims: displayDims(s),
            dimsPercent: displayDimPercents(s),
            lastReason: s.lastReason,
            updatedAt: s.updatedAt
          })
}
