/**
 * HTTP 路由 · notes.js（2026-11-06 P16）。
 * 由 lib/http/server.js 的 registerApi 分支体经 P15 提取后整体搬来，函数体逐字未改。
 * 分派逻辑仍在 server.js；本文件只负责「某个路由具体做什么」。
 */

import { deleteNote, listNotes, readNote, renameNote, writeNote } from '../../notes.js'
import { json, readBody } from '../middleware.js'
import { note } from '../../env.js'


export async function handleGetNotesList(ctx, req, res, query, route) {
          return json(res, 200, { ok: true, notes: listNotes() })
}

export async function handleGetNotesRead(ctx, req, res, query, route) {
          const got = readNote(String(query.get('title') ?? '').trim())
          if (got.ok !== true) return json(res, 404, { ok: false, error: got.reason })
          return json(res, 200, { ok: true, note: got.note, text: got.text })
}

export async function handlePostNotesSave(ctx, req, res, query, route) {
          const body = await readBody(req)
          const result = writeNote({
            title: String(body?.title ?? '').trim(),
            content: body?.content,
            // 2026-11-04 修 B8：默认**不覆盖**，跟 soul_note 工具口径一致。
            // 原来写的是 `body.overwrite !== false`（缺省 true），设置页点保存就把同名笔记整篇替换掉，
            // 而工具那边同一个动作是必须显式 overwrite 的 —— 同一个概念两个默认值，早晚出事。
            overwrite: body?.overwrite === true
          })
          if (result.ok !== true) return json(res, 400, { ok: false, error: result.reason })
          return json(res, 200, { ok: true, slug: result.slug, created: result.created })
}

export async function handlePostNotesRename(ctx, req, res, query, route) {
          const body = await readBody(req)
          const result = renameNote(String(body?.title ?? '').trim(), String(body?.newTitle ?? '').trim())
          if (result.ok !== true) return json(res, 400, { ok: false, error: result.reason })
          return json(res, 200, { ok: true, slug: result.slug })
}

export async function handlePostNotesDelete(ctx, req, res, query, route) {
          const body = await readBody(req)
          const result = deleteNote(String(body?.title ?? '').trim())
          if (result.ok !== true) return json(res, 400, { ok: false, error: result.reason })
          return json(res, 200, { ok: true, slug: result.slug })
}
