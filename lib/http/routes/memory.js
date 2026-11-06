/**
 * HTTP 路由 · memory.js（2026-11-06 P16）。
 * 由 lib/http/server.js 的 registerApi 分支体经 P15 提取后整体搬来，函数体逐字未改。
 * 分派逻辑仍在 server.js；本文件只负责「某个路由具体做什么」。
 */

import { globalCard, loadConfig, projectCard, purposeState, saveGlobalCard, saveProjectCard, savePurposeState } from '../../store.js'
import { addRecord, forgetRecord, makeArchiver, setPinned } from '../../memory.js'
import { archivePath } from '../../paths.js'
import { closeGoal, openGoals } from '../../purpose.js'
import { resolveCwd } from '../sessions.js'
import { json, readBody } from '../middleware.js'
import { note } from '../../env.js'


export async function handleGetMemory(ctx, req, res, query, route) {
          const scope = query.get('scope') === 'project' ? 'project' : 'global'
          // 列记忆也要跟着当前工作区走，否则「项目记忆」会永远显示空
          const { cwd } = resolveCwd(ctx, query)
          const keyword = (query.get('query') ?? '').trim().toLowerCase()
          const card = scope === 'project' && cwd !== '' ? projectCard(cwd) : globalCard()
          let records = [...card.records].sort((a, b) => (b.importance ?? 0) - (a.importance ?? 0))
          if (keyword !== '') {
            records = records.filter((record) => `${record.text} ${record.title}`.toLowerCase().includes(keyword))
          }
          return json(res, 200, {
            ok: true,
            scope,
            total: card.records.length,
            lastDecayDate: card.lastDecayDate,
            records: records.slice(0, 300).map((record) => ({
              id: record.id,
              text: record.text,
              title: record.title,
              importance: record.importance,
              clarity: record.clarity,
              tags: record.tags,
              pinned: record.pinned,
              createdAt: record.createdAt,
              lastSeenAt: record.lastSeenAt,
              recallCount: record.recallCount,
              source: record.source
            }))
          })
}

export async function handlePostMemory(ctx, req, res, query, route) {
          const body = await readBody(req)
          const scope = body?.scope === 'project' ? 'project' : 'global'
          // 必须和 GET /memory 用同一套兜底。
          // 原来这里直接 String(body?.cwd ?? '')：设置页拿不到会话 cwd 时，
          // 列表走兜底读到项目卡、显示得出来，删除却按空 cwd 去查全局卡 ——
          // 全局卡是空的，于是永远「没找到这条记忆」。删 / 固定 / 编辑都一样。
          const given = String(body?.cwd ?? '').trim()
          const cwd = given !== '' ? given : resolveCwd(ctx, query).cwd
          const card = scope === 'project' && cwd !== '' ? projectCard(cwd) : globalCard()
          const action = String(body?.action ?? '')
          const id = String(body?.id ?? '')

          if (action === 'delete') {
            // 传 archive：设置页点删除也算「遗忘」，要能在 archive.jsonl 里查回来
            const removed = forgetRecord(card, id, makeArchiver(archivePath()))
            if (removed?.ok !== true) {
              // R01：归档写不进去时记录还在卡里，不能当「没找到」回 404，
              // 更不能继续往下 save 后回 200 说删掉了。
              if (removed?.error === 'archive-failed') {
                note('api', `删除未执行：归档写盘失败，记录仍在卡里（id=${id}）`)
                return json(res, 500, { ok: false, error: '归档失败，这条记忆没有被删除（仍在卡里），请检查磁盘与权限后重试' })
              }
              note('api', `删除落空：scope=${scope} cwd=「${cwd}」卡里 ${card.records.length} 条，找不到 id=${id}`)
              return json(res, 404, { ok: false, error: '没找到这条记忆' })
            }
          } else if (action === 'pin') {
            if (!setPinned(card, id, body?.pinned !== false)) {
              note('api', `固定落空：scope=${scope} cwd=「${cwd}」卡里 ${card.records.length} 条，找不到 id=${id}`)
              return json(res, 404, { ok: false, error: '没找到这条记忆' })
            }
          } else if (action === 'write') {
            // 设置页手动新增。走 addRecord 才能拿到打分、去重、脱敏那一套。
            const text = String(body?.text ?? '').trim()
            if (text === '') return json(res, 400, { ok: false, error: '内容不能为空' })
            const result = addRecord(card, { text, source: 'manual', isOwner: true, isPrivate: true }, loadConfig(), Date.now())
            if (result.ok !== true) return json(res, 400, { ok: false, error: result.reason ?? '写入失败' })
          } else if (action === 'edit') {
            const record = card.records.find((item) => item.id === id)
            if (record === undefined) return json(res, 404, { ok: false, error: '没找到这条记忆' })
            if (typeof body?.text === 'string' && body.text.trim() !== '') record.text = body.text.trim().slice(0, 600)
            if (typeof body?.title === 'string') record.title = body.title.trim().slice(0, 60)
          } else {
            return json(res, 400, { ok: false, error: `不认识的 action：${action}` })
          }

          // 2026-11-05 修 P0-4：设置页原来忽略保存结果，删/改/新增写盘失败也回 200。
          const saved = scope === 'project' && cwd !== '' ? saveProjectCard(cwd, card) : saveGlobalCard(card)
          if (saved?.ok !== true) {
            return json(res, 500, { ok: false, error: `记忆保存失败：${saved?.error ?? '未知原因'}` })
          }
          return json(res, 200, { ok: true, total: card.records.length })
}

export async function handlePostGoal(ctx, req, res, query, route) {
          const body = await readBody(req)
          const state = purposeState()
          const id = String(body?.id ?? '')
          const ok = closeGoal(state, id)
          if (!ok) return json(res, 404, { ok: false, goals: openGoals(state, { limit: 20 }) })
          // 2026-11-05：写盘失败必须回 500，不能让设置页显示「已放下」却没落盘。
          const saved = savePurposeState(state)
          if (saved.ok !== true) return json(res, 500, { ok: false, error: saved.error })
          return json(res, 200, { ok: true, goals: openGoals(state, { limit: 20 }) })
}
