/**
 * HTTP 路由 barrel（2026-11-06 P16）：server.js 从这里一次拿齐所有 handler。
 * 新增路由时在这里登记；tests/contract/route-behavior.test.js 会校验分支清单。
 * 2026-11-21 / 0.10.0：删掉 handleGetDiaryPrivate、handlePostDiaryToToday（功能已删）。
 */
export { handleGetAttestation, handleGetState, handlePostConfig, handlePostMaintain, handlePostOpen, handlePostRegister, handlePostSecret } from './system.js'
export { handleGetPersona, handlePostPersona } from './persona.js'
export { handleGetMemory, handlePostGoal, handlePostMemory } from './memory.js'
export { handleGetMood, handlePostMoodDecay, handlePostMoodReset } from './mood.js'
export { handleGetDiaryList, handleGetDiaryRead, handleGetDiarySessions, handlePostDiary, handlePostDiaryBind, handlePostDiaryUnbind } from './diary.js'
export { handleGetNotesList, handleGetNotesRead, handlePostNotesDelete, handlePostNotesRename, handlePostNotesSave } from './notes.js'
