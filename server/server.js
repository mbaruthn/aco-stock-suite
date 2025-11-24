import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import path from 'path'
import { fileURLToPath } from 'url'
import fs from 'fs'
import axios from 'axios'

dotenv.config()

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const app = express()
app.use(express.json({ limit: '4mb' }))

// CORS
const allowed = process.env.ALLOWED_ORIGIN || '*'
if (allowed !== '*') app.use(cors({ origin: allowed }))
else app.use(cors())

// Config
const PORT = process.env.PORT || 8080
const API = 'https://api.monday.com/v2'
const API_VERSION = '2023-10'

// ---- logging ----
const logsDir = path.join(__dirname, '..', 'logs')
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true })
const outPath = path.join(logsDir, 'server.log')
function log(line) {
  const s = `[${new Date().toISOString()}] ${line}`
  console.log(s)
  if ((process.env.LOG_TO_FILE || 'true') === 'true') fs.appendFileSync(outPath, s + '\n')
}

// HTTP headers
function headers(token, useApiVersion = true) {
  const h = { 'Content-Type': 'application/json', 'Authorization': token }
  if (useApiVersion && API_VERSION) h['API-Version'] = API_VERSION
  return h
}

// GraphQL helper
async function gql(query, variables, token, useApiVersion = true) {
  const res = await axios.post(API, { query, variables }, { headers: headers(token, useApiVersion) })
  if (res.data.errors) throw new Error(JSON.stringify(res.data.errors))
  return res.data.data
}






// Barkod gibi mi? (boşluk yok, en az 3 char, harf/rakam/-_.)
function looksLikeBarcode(s) {
  if (!s) return false;
  const t = String(s).trim();
  return /^[A-Za-z0-9._-]{3,}$/.test(t);
}

// Item içine update (yorum) bırak
async function createUpdateOnItem(itemId, body, token) {
  const q = `
    mutation($id: ID!, $body: String!) {
      create_update(item_id: $id, body: $body) { id }
    }
  `;
  await gql(q, { id: String(itemId), body }, token, false);
}

// Bildirim gönder (ID! string olarak)
async function notifyUsersAboutItem(itemId, userIds, message, token) {
  const q = `
    mutation($uid: ID!, $tid: ID!, $text: String!) {
      create_notification(
        user_id: $uid,
        target_id: $tid,
        text: $text,
        target_type: Project
      ) { id }
    }
  `;
  for (const uid of (userIds || [])) {
    try {
      await gql(q, { uid: String(uid), tid: String(itemId), text: message }, token, false);
    } catch (e) {
      log(`notify warn uid=${uid} err=${String(e)}`);
    }
  }
}

// (opsiyonel) People kolonuna atama
async function assignPeopleToItem(itemId, boardId, peopleColumnId, userIds, token) {
  if (!peopleColumnId || !userIds?.length) return;
  const cols = {
    [peopleColumnId]: { personsAndTeams: userIds.map(id => ({ id: Number(id), kind: "person" })) }
  };
  const q = `
    mutation($iid: ID!, $bid: ID!, $cols: JSON!) {
      change_multiple_column_values(item_id:$iid, board_id:$bid, column_values:$cols) { id }
    }
  `;
  await gql(q, { iid: Number(itemId), bid: Number(boardId), cols: JSON.stringify(cols) }, token, false);
}

function getAlertUserIdsFromEnv() {
  const raw = (process.env.QC_ALERT_USER_IDS || '').trim();
  if (!raw) return [];
  return raw.split(',').map(s => Number(s.trim())).filter(n => Number.isFinite(n));
}

function isChecked(cv) {
  if (!cv) return false;

  // 1) JSON value içinden oku (tercihli yol)
  if (typeof cv.value === 'string' && cv.value.trim() !== '') {
    try {
      const v = JSON.parse(cv.value);
      if (typeof v?.checked === 'boolean') return v.checked;            // true / false
      if (typeof v?.checked === 'string') return v.checked.toLowerCase() === 'true';
    } catch (_) { /* yut */ }
  }

  // 2) text fallback (bazı UI’larda işaretli olduğunda "v" geliyor)
  const t = String(cv.text || '').trim().toLowerCase();
  if (t === 'v' || t === 'true' || t === 'evet' || t === 'checked') return true;

  return false;
}






async function postAlertUpdateWithMentions(itemId, token, message, userIds = []) {
  // userIds -> [20531090, 20700001] gibi
  const mentions = userIds.map(uid => `[@${uid}]`).join(' ')
  const body = `${message}\n\n${mentions}`

  const q = `
    mutation($id:ID!, $body:String!){
      create_update(item_id:$id, body:$body){
        id
        text_body
      }
    }
  `
  const d = await gql(q, { id: Number(itemId), body }, token, false)
  return d?.create_update?.id || null
}
// Item'a update yaz + o update'e bildirim gönder (mention etkisi)
// userIds: ping atılacak Monday kullanıcı ID'leri (örn: [20531090, 53817857])
async function postAlertUpdateAndNotify(itemId, token, bodyText, userIds = []) {
  // 1) Update
  const qUpdate = `
    mutation($id:ID!, $body:String!){
      create_update(item_id:$id, body:$body){ id }
    }
  `;
  const d = await gql(qUpdate, { id: Number(itemId), body: bodyText }, token, /*useApiVersion*/ false);
  const updateId = d?.create_update?.id;
  if (!updateId) {
    log(`batch alert: updateId alınamadı (item ${itemId})`);
    return;
  }

  // 2) Notification (target_type: "Update")
  const qNotify = `
    mutation($user_id: ID!, $target_id: ID!, $text: String!, $target_type: NotificationTargetType!){
      create_notification(user_id:$user_id, target_id:$target_id, text:$text, target_type:$target_type){ id }
    }
  `;
  const text = bodyText; // dilersen "(Update #12345)" vs. ekleyebilirsin

  for (const uid of userIds) {
    try {
      await gql(qNotify, {
        user_id: Number(uid),
        target_id: Number(updateId),
        text,
        target_type: "Update"
      }, token, /*useApiVersion*/ false);
    } catch (e) {
      log(`notify error uid=${uid} err=${e?.message || String(e)}`);
    }
  }
}

// --- mention'lı update at (API-Version: 2025-07 ile) ---
async function createUpdateWithMentions({ itemId, body, userIds = [], teamIds = [] }, token) {
  // mentions_list: [{ id: 123, type: User }, { id: 456, type: Team }]
  const mentions = [
    ...userIds.map(id => ({ id: Number(id), type: "User" })),
    ...teamIds.map(id => ({ id: Number(id), type: "Team" })),
  ];

  const q = `
    mutation($itemId: ID!, $body: String!, $mentions: [UpdateMention!]) {
      create_update(item_id: $itemId, body: $body, mentions_list: $mentions) { id }
    }
  `;

  // ÖNEMLİ: Bu çağrıda yeni API versiyonunu AÇ (useApiVersion=true)
  return await gql(q, { itemId: Number(itemId), body, mentions }, token, /*useApiVersion*/ true);
}





function parseNumber(cv) {
  if (!cv) return 0
  if (cv.text && cv.text.trim() !== '') {
    const n = parseFloat(cv.text.replace(',', '.'))
    return isNaN(n) ? 0 : n
  }
  if (cv.value) {
    try {
      const v = JSON.parse(cv.value)
      const raw = v?.number ?? v?.value ?? v?.text ?? v
      const n = parseFloat(String(raw))
      return isNaN(n) ? 0 : n
    } catch { return 0 }
  }
  return 0
}
function safeText(cv) {
  if (!cv) return ''
  if (cv.text && cv.text.trim() !== '') return cv.text.trim()
  if (cv.value) {
    try {
      const v = JSON.parse(cv.value)
      if (typeof v === 'string') return v.trim()
      if (v?.display_value) return String(v.display_value).trim()
      if (v?.text) return String(v.text).trim()
      if (v?.value) return String(v.value).trim()
      return JSON.stringify(v)
    } catch { return String(cv.value || '').trim() }
  }
  return ''
}
function pickBarcode(item, entryBarcodeSource) {
  if (entryBarcodeSource === 'name') return item.name?.trim() || ''
  const cv = (item.column_values || []).find(c => c.id === entryBarcodeSource)
  return safeText(cv).trim()
}
function pickQty(item, qtyColumnId) {
  const cv = (item.column_values || []).find(c => c.id === qtyColumnId)
  return parseNumber(cv)
}
function j(v) { try { return JSON.stringify(v) } catch { return '' } }
function tryParse(v) { if (typeof v !== 'string') return v; try { return JSON.parse(v) } catch { return v } }
function normTitle(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .trim()
}
function isCopyableType(t) {
  const tt = String(t || '').toLowerCase()
  const deny = ['mirror', 'formula', 'auto', 'creation_log', 'last_updated', 'file', 'subtasks', 'subitems']
  return !deny.includes(tt)
}
function rawValueForType(cv, targetType) {
  if (!cv) return null
  if (typeof cv.value === 'string' && cv.value.trim() !== '') return cv.value
  const txt = (cv.text || '').trim()
  if (!txt) return null
  const tt = String(targetType || '').toLowerCase()
  if (['text', 'long_text', 'name', 'short_text'].includes(tt)) return JSON.stringify(txt)
  if (['numeric', 'numbers'].includes(tt)) {
    const n = parseFloat(txt.replace(',', '.')); if (isNaN(n)) return null; return String(n)
  }
  if (tt === 'status' || tt === 'dropdown' || tt === 'date' || tt === 'checkbox') return JSON.stringify(txt)
  if (tt === 'board_relation' || tt === 'board-relation' || tt === 'board_relation_column') return null
  return JSON.stringify(txt)
}

// --- utility: create/change/group ---
async function createItem(boardId, groupId, name, columnsJson, token) {
  const q = `
    mutation($bid:ID!, $gid:String, $name:String!, $cols: JSON) {
      create_item(board_id:$bid, group_id:$gid, item_name:$name, column_values:$cols) { id }
    }
  `
  const d = await gql(q, { bid: Number(boardId), gid: groupId || null, name, cols: columnsJson ? JSON.stringify(columnsJson) : null }, token, false)
  return d?.create_item?.id || null
}
async function changeMultipleColumns(itemId, boardId, cols, token) {
  const q = `
    mutation($iid:ID!, $bid:ID!, $cols: JSON!) {
      change_multiple_column_values(item_id:$iid, board_id:$bid, column_values:$cols) { id }
    }
  `
  await gql(q, { iid: Number(itemId), bid: Number(boardId), cols: JSON.stringify(cols) }, token, false)
}
async function createGroup(boardId, name, token) {
  const q = `mutation($boardId:ID!, $name:String!){
    create_group(board_id:$boardId, group_name:$name){ id }
  }`
  const d = await gql(q, { boardId: Number(boardId), name }, token)
  return d?.create_group?.id || null
}

// Relation CV içinden linkedPulseIds
function extractLinkedPulseIds(cv) {
  try {
    if (!cv || typeof cv.value !== 'string' || !cv.value.trim()) return []
    const v = JSON.parse(cv.value)
    const arr = Array.isArray(v?.linkedPulseIds) ? v.linkedPulseIds : []
    return arr
      .map(x => Number(x?.linkedPulseId))
      .filter(n => Number.isFinite(n))
  } catch {
    return []
  }
}

// Panoda adıyla item bul (tam eşleşme)
async function findItemByExactName(boardId, name, token) {
  const target = String(name || '').trim()
  if (!target) return null

  const q = `
    query($boardId:[ID!], $limit:Int, $cursor:String) {
      boards(ids:$boardId){
        id
        items_page(limit:$limit, cursor:$cursor){
          items { id name }
          cursor
        }
      }
    }
  `
  let cursor = null, page = 0
  while (page < 30) {
    const d = await gql(q, { boardId: [Number(boardId)], limit: 200, cursor }, token, false)
    const pageData = d?.boards?.[0]?.items_page
    const items = pageData?.items || []
    const hit = items.find(it => String(it.name || '').trim() === target)
    if (hit) return hit
    if (!pageData?.cursor) break
    cursor = pageData.cursor
    page++
  }
  return null
}

// --- Monday helpers
async function listGroupItems(boardId, groupId, token, limit = 200) {
  const q = `query($boardId:[ID!], $groupId:[String!]!, $limit:Int){
    boards(ids:$boardId){
      id groups(ids:$groupId){
        id title
        items_page(limit:$limit){
          items { id name column_values { id text value } }
          cursor
        }
      }
    }
  }`
  const d = await gql(q, { boardId: [Number(boardId)], groupId: [groupId], limit }, token)
  const page = d?.boards?.[0]?.groups?.[0]?.items_page
  return page?.items || []
}
async function getItemWithColumns(itemId, token) {
  const q = `
    query($id:[ID!]) {
      items (ids:$id) {
        id
        name
        board { id }
        group { id title }
        column_values { id text value }
      }
    }
  `
  const d = await gql(q, { id: [Number(itemId)] }, token, false)
  return d?.items?.[0] || null
}
async function getItemColumnsWithTitles(itemId, token) {
  const it = await getItemWithColumns(Number(itemId), token)
  if (!it) return null
  const cols = await getBoardColumns(Number(it.board.id), token)
  const meta = new Map(cols.map(c => [c.id, { title: c.title, type: c.type }]))
  const merged = (it.column_values || []).map(cv => {
    const m = meta.get(cv.id) || {}
    return {
      id: cv.id,
      title: m.title || '(?)',
      type: m.type || '(?)',
      text: (cv.text || '').trim(),
      hasValue: !!cv.value,
      value: cv.value || null,
    }
  })
  return { item: { id: it.id, name: it.name, boardId: it.board.id, groupId: it.group?.id }, columns: merged }
}
async function getBoardColumns(boardId, token) {
  const q = `
    query($bid:[ID!]) {
      boards(ids:$bid) {
        id
        columns { id title type }
      }
    }
  `
  const d = await gql(q, { bid: [Number(boardId)] }, token, false)
  return d?.boards?.[0]?.columns || []
}
function barcodeFromItem(item, barcodeColumnId) {
  const cv = (item.column_values || []).find(c => c.id === barcodeColumnId)
  return safeText(cv)
}
async function findCatalogItemByBarcode(boardId, barcodeColumnId, barcode, token) {
  const target = String(barcode).trim()
  if (!target) return null
  const q = `
    query($boardId:[ID!], $limit:Int, $cursor:String) {
      boards(ids:$boardId){
        id
        items_page(limit:$limit, cursor:$cursor){
          items { id name column_values { id text value } }
          cursor
        }
      }
    }
  `
  let cursor = null, page = 0
  while (page < 30) {
    const d = await gql(q, { boardId: [Number(boardId)], limit: 200, cursor }, token, false)
    const pageData = d?.boards?.[0]?.items_page
    const items = pageData?.items || []
    for (const it of items) {
      const bc = barcodeFromItem(it, barcodeColumnId)
      if (bc && String(bc).trim() === target) return it
    }
    if (!pageData?.cursor) break
    cursor = pageData.cursor
    page++
  }
  return null
}
async function findItemByNameInBoard(boardId, name, token) {
  const target = String(name || '').trim()
  if (!target) return null

  const q = `
    query($boardId:[ID!], $limit:Int, $cursor:String) {
      boards(ids:$boardId) {
        id
        items_page(limit:$limit, cursor:$cursor) {
          items { id name }
          cursor
        }
      }
    }
  `
  let cursor = null, page = 0
  while (page < 30) {
    const d = await gql(q, { boardId: [Number(boardId)], limit: 200, cursor }, token, false)
    const pageData = d?.boards?.[0]?.items_page
    const items = pageData?.items || []
    const hit = items.find(it => String(it.name || '').trim().toLowerCase() === target.toLowerCase())
    if (hit) return hit
    if (!pageData?.cursor) break
    cursor = pageData.cursor
    page++
  }
  return null
}

// stok + silme
async function updateStock(itemId, boardId, stockColumnId, newNumber, token) {
  const cols = {}; cols[stockColumnId] = String(newNumber)
  const colStr = JSON.stringify(cols)
  const q = `mutation($itemId:ID!, $boardId:ID!, $cols: JSON!){
    change_multiple_column_values(item_id:$itemId, board_id:$boardId, column_values:$cols){ id }
  }`
  await gql(q, { itemId: Number(itemId), boardId: Number(boardId), cols: colStr }, token)
}
async function deleteItem(itemId, token) {
  const q = `mutation($id:ID!){ delete_item(item_id:$id){ id } }`
  await gql(q, { id: Number(itemId) }, token, false)
}
async function archiveItem(itemId, token) {
  const q = `mutation($id:ID!){ archive_item(item_id:$id){ id } }`
  await gql(q, { id: Number(itemId) }, token, false)
}

// entry → rapor kopyalama (garantili)
async function copyEntryToReportBoard(entryItem, reportBoardId, reportGroupId, token, ensureRelation, extras, explicitMap = {}) {
  if (!reportBoardId) return null

  const srcBoardId = Number(entryItem?.board?.id || 0)
  const [srcCols, tgtCols] = await Promise.all([
    getBoardColumns(srcBoardId, token),
    getBoardColumns(reportBoardId, token),
  ])
  const srcIdToTitle = new Map(srcCols.map(c => [c.id, c.title]))
  const tgtTitleToCol = new Map(tgtCols.map(c => [normTitle(c.title), { id: c.id, type: c.type, title: c.title }]))

  if (ensureRelation && !ensureRelation.targetColId && ensureRelation.sourceColTitle) {
    const t = tgtTitleToCol.get(normTitle(ensureRelation.sourceColTitle))
    if (t) ensureRelation.targetColId = t.id
  }
  if (ensureRelation && !ensureRelation.targetColId && process.env.REPORT_PRODUCT_LINK_COLUMN_ID) {
    ensureRelation.targetColId = process.env.REPORT_PRODUCT_LINK_COLUMN_ID
  }

  const initialSet = {}
  const postSet = {}

  // 1) açık eşleme (ID→ID)
  const cvById = Object.create(null)
  for (const cv of (entryItem.column_values || [])) cvById[cv.id] = cv

  for (const [tgtId, map] of Object.entries(explicitMap || {})) {
    const srcId = map?.sourceColId
    if (!srcId) continue
    const cv = cvById[srcId]
    if (!cv) continue

    const tgtMeta = tgtCols.find(c => c.id === tgtId)
    const ttype = String(tgtMeta?.type || map.typeHint || '').toLowerCase()

    if (typeof cv.value === 'string' && cv.value.trim() !== '') {
      if (['text', 'long_text', 'numeric', 'numbers', 'status', 'dropdown', 'date', 'checkbox'].includes(ttype)) {
        initialSet[tgtId] = tryParse(cv.value)
      } else {
        postSet[tgtId] = tryParse(cv.value)
      }
      continue
    }

    const val = rawValueForType(cv, ttype)
    if (val !== null) {
      const parsed = tryParse(val)
      if (['text', 'long_text', 'numeric', 'numbers', 'status', 'dropdown', 'date', 'checkbox'].includes(ttype)) {
        initialSet[tgtId] = parsed
      } else {
        postSet[tgtId] = parsed
      }
    }
  }

  // 2) başlığa göre otomatik eşleme
  for (const cv of (entryItem.column_values || [])) {
    if (Object.values(explicitMap || {}).some(m => m.sourceColId === cv.id)) continue

    const title = srcIdToTitle.get(cv.id)
    if (!title) continue
    const tgt = tgtTitleToCol.get(normTitle(title))
    if (!tgt) continue
    if (!isCopyableType(tgt.type)) continue

    const ttype = String(tgt.type).toLowerCase()

    if (ttype === 'board_relation' || ttype === 'board-relation' || ttype === 'board_relation_column') {
      if (typeof cv.value === 'string' && cv.value.trim() !== '') {
        postSet[tgt.id] = tryParse(cv.value)
      } else if (ensureRelation && ensureRelation.catalogItemId && ensureRelation.targetColId === tgt.id) {
        postSet[tgt.id] = { linkedPulseIds: [{ linkedPulseId: Number(ensureRelation.catalogItemId) }] }
      }
      continue
    }

    if (typeof cv.value === 'string' && cv.value.trim() !== '') {
      const vParsed = tryParse(cv.value)
      if (['text', 'long_text', 'numeric', 'numbers', 'status', 'dropdown', 'date', 'checkbox'].includes(ttype)) {
        initialSet[tgt.id] = vParsed
      } else {
        postSet[tgt.id] = vParsed
      }
      continue
    }

    const val = rawValueForType(cv, ttype)
    if (val === null) continue
    const vParsed = tryParse(val)
    if (['text', 'long_text', 'numeric', 'numbers', 'status', 'dropdown', 'date', 'checkbox'].includes(ttype)) {
      initialSet[tgt.id] = vParsed
    } else {
      postSet[tgt.id] = vParsed
    }
  }

  // 3) ekstralar: tarih + kişi
  if (extras) {
    if (extras.dateColId) {
      const iso = extras.dateISO || new Date().toISOString()
      const ymd = iso.slice(0, 10)
      initialSet[extras.dateColId] = { date: ymd }
    }
    if (extras.personColId && extras.userId) {
      postSet[extras.personColId] = { personsAndTeams: [{ id: Number(extras.userId), kind: 'person' }] }
    }
  }

  // create
  const newId = await createItem(reportBoardId, reportGroupId, entryItem.name || '', initialSet, token)
  if (!newId) return null

  // post change
  if (Object.keys(postSet).length > 0) {
    await changeMultipleColumns(newId, reportBoardId, postSet, token)
  }

  // ÜRÜN relation hâlâ boş kaldıysa son kez zorla yaz
  if (ensureRelation && ensureRelation.catalogItemId && ensureRelation.targetColId) {
    const cols = {}
    cols[ensureRelation.targetColId] = { linkedPulseIds: [{ linkedPulseId: Number(ensureRelation.catalogItemId) }] }
    await changeMultipleColumns(newId, reportBoardId, cols, token)
  }

  return newId
}

// ENTRY batch (giriş “tamamla”)
async function processBatchFromGroup(groupIdOverride, context = {}) {
  const cfg = {
    TOKEN: process.env.MONDAY_API_TOKEN,
    ENTRY_BOARD_ID: Number(process.env.ENTRY_BOARD_ID),
    ENTRY_GROUP_ID: process.env.ENTRY_GROUP_ID,
    ENTRY_QTY_COLUMN_ID: process.env.ENTRY_QTY_COLUMN_ID,
    ENTRY_BARCODE_SOURCE: process.env.ENTRY_BARCODE_SOURCE || 'name',
    CATALOG_BOARD_ID: Number(process.env.CATALOG_BOARD_ID),
    CATALOG_BARCODE_COLUMN_ID: process.env.CATALOG_BARCODE_COLUMN_ID,
    CATALOG_STOCK_COLUMN_ID: process.env.CATALOG_STOCK_COLUMN_ID,
    REPORT_BOARD_ID: process.env.REPORT_BOARD_ID ? Number(process.env.REPORT_BOARD_ID) : null,
    CREATE_REPORT_GROUP: (process.env.CREATE_REPORT_GROUP || 'true') === 'true',
    DELETE_MODE: process.env.DELETE_MODE || 'archive',
    REPORT_DATE_COLUMN_ID: process.env.REPORT_DATE_COLUMN_ID || '',
    REPORT_PERSON_COLUMN_ID: process.env.REPORT_PERSON_COLUMN_ID || ''
  }

  const items = await listGroupItems(cfg.ENTRY_BOARD_ID, groupIdOverride || cfg.ENTRY_GROUP_ID, cfg.TOKEN);
  const toProcess = items.filter(i => {
    const nm = String(i.name || '').trim().toLowerCase();
    return nm !== '' && nm !== 'tamamla';
  });

  // === QC/COUNT TOPLU KAPI (yalnızca barkod görünümlü isimler) ===
  const itemsToCheck = items.filter(i => {
    const nm = String(i.name || '').trim().toLowerCase();
    return nm !== '' && nm !== 'tamamla';
  });

  // Eksik olanları tespit et (sadece barkod görünümlü isimler)
  const itemsWithMissing = itemsToCheck.filter(it => {
    if (!looksLikeBarcode(it.name)) return false;

    const cvQC = (it.column_values || []).find(c => c.id === process.env.ENTRY_QC_CHECKBOX_COLUMN_ID);
    const cvCnt = (it.column_values || []).find(c => c.id === process.env.ENTRY_COUNT_DONE_CHECKBOX_COLUMN_ID);

    const qcOK = isChecked(cvQC);
    const cntOK = isChecked(cvCnt);
    // qcOK ve cntOK durumlarınıa logla
    log(`Item ${it.id} - QC: ${qcOK}, Count: ${cntOK}`);

    return !(qcOK && cntOK); // en az bir tanesi işaretlenmemişse EKSİK
  });

  const anyMissing = itemsWithMissing.length > 0;

  if (anyMissing) {
    const alertUserIds = getAlertUserIdsFromEnv();
    const msgText = "Bu item için “Kontrol” ve/veya “Sayım” işaretlenmemiş. Lütfen tamamlayın.";

    // 1) Eksik olan item(ler)in içine update yaz (sadece eksik olanlara!)
    for (const it of itemsWithMissing) {
      try {
        await createUpdateOnItem(it.id, msgText, cfg.TOKEN);
      } catch (e) {
        log(`update warn item ${it.id} -> ${String(e)}`);
      }
    }

    // 2) Bildirim: sadece BİR KEZ gönder (ilk eksik item'i hedef yap)
    try {
      const firstProblemItemId = itemsWithMissing[0].id;
      await notifyUsersAboutItem(firstProblemItemId, alertUserIds,
        `Toplam ${itemsWithMissing.length} itemde eksik kontrol tespit edildi. İlk örnek için lütfen iteme bakın.`,
        cfg.TOKEN
      );
    } catch (e) {
      log(`notify error -> ${String(e)}`);
    }

    // (opsiyonel) People kolonuna atama da sadece eksik olanlara yapılabilir:
    if (process.env.ENTRY_ALERT_PEOPLE_COLUMN_ID && alertUserIds.length) {
      for (const it of itemsWithMissing) {
        try {
          await assignPeopleToItem(
            it.id,
            cfg.ENTRY_BOARD_ID,
            process.env.ENTRY_ALERT_PEOPLE_COLUMN_ID,
            alertUserIds,
            cfg.TOKEN
          );
        } catch (e) {
          log(`assign people warn item ${it.id} -> ${String(e)}`);
        }
      }
    }

    // 3) Tamamen durdur + “tamamla” satırını kaldır
    const completeItem = items.find(i => String(i.name || '').trim().toLowerCase() === 'tamamla');
    const completeMode = (process.env.COMPLETE_DELETE_MODE || 'delete');
    if (completeItem) {
      try {
        if (completeMode === 'delete') {
          await deleteItem(completeItem.id, cfg.TOKEN);
        } else if (completeMode === 'archive') {
          await archiveItem(completeItem.id, cfg.TOKEN);
        }
        log(`COMPLETE removed: ${completeItem.id} mode=${completeMode}`);
      } catch (e) {
        log(`WARN complete remove failed: ${String(e)}`);
      }
    }

    log(`ALERT & BLOCK: ${itemsWithMissing.length} itemde eksik var — işlem tamamen durduruldu`);
    return { ok: false, blocked: true, reason: 'qc_or_count_missing', missingCount: itemsWithMissing.length };
  }
  // === /QC/COUNT TOPLU KAPI ===






  let reportGroupId = null
  if (cfg.REPORT_BOARD_ID && cfg.CREATE_REPORT_GROUP) {
    const ts = new Date().toLocaleString('tr-TR', { hour12: false })
    reportGroupId = await createGroup(cfg.REPORT_BOARD_ID, ts, cfg.TOKEN)
  }

  const results = []
  for (const it of toProcess) {
    const barcode = pickBarcode(it, cfg.ENTRY_BARCODE_SOURCE)
    const qty = pickQty(it, cfg.ENTRY_QTY_COLUMN_ID)


    if (!barcode || !qty) {
      log(`SKIP: item ${it.id} barkod='${barcode}' qty='${qty}'`)
      results.push({ itemId: it.id, ok: false, barcode, qty })
      continue
    }




    const cat = await findCatalogItemByBarcode(cfg.CATALOG_BOARD_ID, cfg.CATALOG_BARCODE_COLUMN_ID, barcode, cfg.TOKEN)
    if (!cat) { log(`NOT FOUND: ${barcode}`); results.push({ itemId: it.id, ok: false, barcode, qty, reason: 'no-catalog' }); continue }

    // stok +
    const stockCv = (cat.column_values || []).find(c => c.id === cfg.CATALOG_STOCK_COLUMN_ID)
    const current = parseNumber(stockCv)
    const nextVal = current + qty
    await updateStock(cat.id, cfg.CATALOG_BOARD_ID, cfg.CATALOG_STOCK_COLUMN_ID, nextVal, cfg.TOKEN)

    // rapora kopyala + ekstra alanlar
    if (cfg.REPORT_BOARD_ID) {
      const entryFull = await getItemWithColumns(it.id, cfg.TOKEN)

      // Ürün kolon başlığını bul (raporla eşlemek için)
      let srcProductColTitle = 'Ürün'
      if (process.env.ENTRY_PRODUCT_LINK_COLUMN_ID) {
        try {
          const entryCols = await getBoardColumns(Number(entryFull?.board?.id || 0), cfg.TOKEN)
          srcProductColTitle = (entryCols.find(c => c.id === process.env.ENTRY_PRODUCT_LINK_COLUMN_ID)?.title) || srcProductColTitle
        } catch { }
      }

      // ID→ID garanti eşleme (Son Alış Fiyatı / Kontrol Edildi mi? / Sayım Yapıldı mı?)
      const explicitMap = {}
      if (process.env.ENTRY_LAST_PRICE_COLUMN_ID && process.env.REPORT_LAST_PRICE_COLUMN_ID) {
        explicitMap[process.env.REPORT_LAST_PRICE_COLUMN_ID] = { sourceColId: process.env.ENTRY_LAST_PRICE_COLUMN_ID, typeHint: 'numeric' }
      }
      if (process.env.ENTRY_QC_CHECKBOX_COLUMN_ID && process.env.REPORT_QC_CHECKBOX_COLUMN_ID) {
        explicitMap[process.env.REPORT_QC_CHECKBOX_COLUMN_ID] = { sourceColId: process.env.ENTRY_QC_CHECKBOX_COLUMN_ID, typeHint: 'checkbox' }
      }
      if (process.env.ENTRY_COUNT_DONE_CHECKBOX_COLUMN_ID && process.env.REPORT_COUNT_DONE_CHECKBOX_COLUMN_ID) {
        explicitMap[process.env.REPORT_COUNT_DONE_CHECKBOX_COLUMN_ID] = { sourceColId: process.env.ENTRY_COUNT_DONE_CHECKBOX_COLUMN_ID, typeHint: 'checkbox' }
      }
      // ... mevcut explicitMap tanımının hemen altına EKLEYİN:

      // Notlar (Text) — ENTRY -> REPORT
      if (process.env.ENTRY_NOTES_TEXT_ID && process.env.REPORT_NOTES_TEXT_ID) {
        explicitMap[process.env.REPORT_NOTES_TEXT_ID] = {
          sourceColId: process.env.ENTRY_NOTES_TEXT_ID,
          typeHint: 'text'
        }}
      


      await copyEntryToReportBoard(
        entryFull,
        cfg.REPORT_BOARD_ID,
        reportGroupId,
        cfg.TOKEN,
        { targetColId: process.env.REPORT_PRODUCT_LINK_COLUMN_ID || '', sourceColTitle: srcProductColTitle, catalogItemId: Number(cat.id) },
        { dateColId: cfg.REPORT_DATE_COLUMN_ID || '', personColId: cfg.REPORT_PERSON_COLUMN_ID || '', dateISO: new Date().toISOString(), userId: context.triggerUserId || null },
        explicitMap
      )
    }

    await (process.env.DELETE_MODE === 'delete' ? deleteItem(it.id, cfg.TOKEN) : archiveItem(it.id, cfg.TOKEN))
    log(`OK: ${barcode} +${qty} [${current}→${nextVal}]`)
    results.push({ itemId: it.id, ok: true, barcode, qty, from: current, to: nextVal, catalogId: cat.id })
  }

  return { ok: true, groupId: groupIdOverride || process.env.ENTRY_GROUP_ID, reportGroupId, count: results.length, results }
}

// EXIT tarafı: otomatik ürün link
async function autoLinkExitProductIfPossible(itemId, exitBoardId, token) {
  const productRelCol = process.env.EXIT_PRODUCT_REL_COLUMN_ID || ''
  const barcodeSource = process.env.EXIT_BARCODE_SOURCE || 'name'
  if (!productRelCol) return

  const it = await getItemWithColumns(itemId, token)
  if (!it || Number(it.board?.id) !== Number(exitBoardId)) return

  const nm = (barcodeSource === 'name')
    ? (it.name || '')
    : safeText((it.column_values || []).find(c => c.id === barcodeSource))

  if (!nm || !/^[A-Za-z0-9\-\_\.]{3,}$/.test(nm.trim())) return

  const cat = await findCatalogItemByBarcode(
    Number(process.env.CATALOG_BOARD_ID),
    process.env.CATALOG_BARCODE_COLUMN_ID,
    nm,
    token
  )
  if (!cat?.id) { log(`EXIT AUTO-LINK SKIP: barcode='${nm}' katalogda yok`); return }

  await changeMultipleColumns(itemId, exitBoardId, {
    [productRelCol]: { linkedPulseIds: [{ linkedPulseId: Number(cat.id) }] }
  }, token)

  log(`EXIT AUTO-LINK: ${itemId} -> catalog ${cat.id} (barcode=${nm})`)
}

// EXIT → rapor (oluştur, sonra relation’ları yaz)
async function copyExitToReportBoardSameAsEntry(
  exitItemFull,
  reportBoardId,
  reportGroupId,
  token,
  catalogItemId,        // Ürün (katalog) ID
  userId,               // Çıkışı yapan kişi
  targetItemId          // <<< YENİ: Çıkış noktası tek ID
) {

  if (!reportBoardId) return null
  if (!exitItemFull || String(exitItemFull.name || '').trim().toLowerCase() === 'tamamla') return null

  const colsInitial = {}
  const colsPost = {}

  // adet
  if (process.env.EXIT_QTY_COLUMN_ID && process.env.EXIT_REPORT_QTY_COLUMN_ID) {
    const srcCv = (exitItemFull.column_values || []).find(c => c.id === process.env.EXIT_QTY_COLUMN_ID)
    if (srcCv?.value) colsInitial[process.env.EXIT_REPORT_QTY_COLUMN_ID] = JSON.parse(srcCv.value)
    else if (srcCv?.text) colsInitial[process.env.EXIT_REPORT_QTY_COLUMN_ID] = String(parseFloat(srcCv.text.replace(',', '.')) || 0)
  }
  // birim
  if (process.env.EXIT_UNIT_DROPDOWN_ID && process.env.EXIT_REPORT_UNIT_DROPDOWN_ID) {
    const srcCv = (exitItemFull.column_values || []).find(c => c.id === process.env.EXIT_UNIT_DROPDOWN_ID)
    if (srcCv?.value) colsInitial[process.env.EXIT_REPORT_UNIT_DROPDOWN_ID] = JSON.parse(srcCv.value)
    else if (srcCv?.text) colsInitial[process.env.EXIT_REPORT_UNIT_DROPDOWN_ID] = JSON.stringify(srcCv.text)
  }
  // tarih
  if (process.env.EXIT_REPORT_DATE_COLUMN_ID) {
    colsInitial[process.env.EXIT_REPORT_DATE_COLUMN_ID] = { date: new Date().toISOString().slice(0, 10) }
  }

  // create
  const newId = await createItem(reportBoardId, reportGroupId, exitItemFull.name || '', colsInitial, token)
  if (!newId) return null

  // ürün relation (raporda garanti yaz)
  if (process.env.EXIT_REPORT_PRODUCT_REL_COLUMN_ID && catalogItemId) {
    colsPost[process.env.EXIT_REPORT_PRODUCT_REL_COLUMN_ID] = {
      linkedPulseIds: [{ linkedPulseId: Number(catalogItemId) }]
    }
  }

  // kişi
  if (process.env.EXIT_REPORT_PEOPLE_COLUMN_ID && userId) {
    colsPost[process.env.EXIT_REPORT_PEOPLE_COLUMN_ID] = {
      personsAndTeams: [{ id: Number(userId), kind: 'person' }]
    }
  }

  // çıkış noktası relation (raporda garanti yaz) — ÜRÜN ile aynı mantık
  if (process.env.EXIT_REPORT_TARGET_REL_COLUMN_ID && targetItemId) {
    colsPost[process.env.EXIT_REPORT_TARGET_REL_COLUMN_ID] = {
      linkedPulseIds: [{ linkedPulseId: Number(targetItemId) }]
    }
  }

  if (Object.keys(colsPost).length > 0) {
    await changeMultipleColumns(newId, reportBoardId, colsPost, token)
  }

  return newId
}

// EXIT batch (çıkış “tamamla”)
async function processExitBatchFromGroup(groupIdOverride, context = {}) {
  const cfg = {
    TOKEN: process.env.MONDAY_API_TOKEN,
    EXIT_BOARD_ID: Number(process.env.EXIT_BOARD_ID),
    EXIT_GROUP_ID: process.env.EXIT_GROUP_ID,
    EXIT_BARCODE_SOURCE: process.env.EXIT_BARCODE_SOURCE || 'name',
    EXIT_QTY_COLUMN_ID: process.env.EXIT_QTY_COLUMN_ID,
    EXIT_PRODUCT_REL_COLUMN_ID: process.env.EXIT_PRODUCT_REL_COLUMN_ID,
    EXIT_TARGET_REL_COLUMN_ID: process.env.EXIT_TARGET_REL_COLUMN_ID,
    EXIT_UNIT_DROPDOWN_ID: process.env.EXIT_UNIT_DROPDOWN_ID,
    EXIT_REPORT_BOARD_ID: process.env.EXIT_REPORT_BOARD_ID ? Number(process.env.EXIT_REPORT_BOARD_ID) : null,
    CREATE_EXIT_REPORT_GROUP: (process.env.CREATE_EXIT_REPORT_GROUP || 'true') === 'true',
    EXIT_COMPLETE_DELETE_MODE: process.env.EXIT_COMPLETE_DELETE_MODE || 'delete',

    CATALOG_BOARD_ID: Number(process.env.CATALOG_BOARD_ID),
    CATALOG_BARCODE_COLUMN_ID: process.env.CATALOG_BARCODE_COLUMN_ID,
    CATALOG_STOCK_COLUMN_ID: process.env.CATALOG_STOCK_COLUMN_ID
  }

  const items = await listGroupItems(cfg.EXIT_BOARD_ID, groupIdOverride || cfg.EXIT_GROUP_ID, cfg.TOKEN)
  const toProcess = items.filter(i => {
    const nm = String(i.name || '').trim().toLowerCase()
    return nm !== '' && nm !== 'tamamla'
  })

  let reportGroupId = null
  if (cfg.EXIT_REPORT_BOARD_ID && cfg.CREATE_EXIT_REPORT_GROUP) {
    const ts = new Date().toLocaleString('tr-TR', { hour12: false })
    reportGroupId = await createGroup(cfg.EXIT_REPORT_BOARD_ID, ts, cfg.TOKEN)
  }

  const results = []
  for (const it of toProcess) {
    const barcode = (cfg.EXIT_BARCODE_SOURCE === 'name')
      ? (it.name || '')
      : safeText((it.column_values || []).find(c => c.id === cfg.EXIT_BARCODE_SOURCE))

    const qtyCv = (it.column_values || []).find(c => c.id === cfg.EXIT_QTY_COLUMN_ID)
    const qty = parseNumber(qtyCv)

    if (!barcode || !qty) {
      log(`EXIT SKIP: item ${it.id} barkod/qty eksik`)
      results.push({ itemId: it.id, ok: false, reason: 'missing-barcode-or-qty' })
      continue
    }
   

    const cat = await findCatalogItemByBarcode(cfg.CATALOG_BOARD_ID, cfg.CATALOG_BARCODE_COLUMN_ID, barcode, cfg.TOKEN)
    if (!cat) { log(`EXIT NOT FOUND in catalog: ${barcode}`); results.push({ itemId: it.id, ok: false, reason: 'catalog-not-found' }); continue }

    // stok -
    const stockCv = (cat.column_values || []).find(c => c.id === cfg.CATALOG_STOCK_COLUMN_ID)
    const current = parseNumber(stockCv)
    const nextVal = Math.max(0, current - qty)
    await changeMultipleColumns(cat.id, cfg.CATALOG_BOARD_ID, { [cfg.CATALOG_STOCK_COLUMN_ID]: String(nextVal) }, cfg.TOKEN)

    let targetItemId = null
    if (process.env.EXIT_TARGET_REL_COLUMN_ID) {
      const srcTargetCv = (it.column_values || []).find(c => c.id === process.env.EXIT_TARGET_REL_COLUMN_ID)
      if (srcTargetCv && typeof srcTargetCv.value === 'string' && srcTargetCv.value.trim() !== '') {
        try {
          const v = JSON.parse(srcTargetCv.value)
          targetItemId = v?.linkedPulseIds?.[0]?.linkedPulseId ? Number(v.linkedPulseIds[0].linkedPulseId) : null
        } catch { }
      }
    }


    if (cfg.EXIT_REPORT_BOARD_ID) {
      const full = await getItemWithColumns(it.id, cfg.TOKEN)
      await copyExitToReportBoardSameAsEntry(
        full,
        cfg.EXIT_REPORT_BOARD_ID,
        reportGroupId,
        cfg.TOKEN,
        cat.id,                 // ürün ID (katalog)
        context.triggerUserId || null,
        targetItemId            // <<< ÇIKIŞ NOKTASI ID (yeni parametre)
      )
    }


    await (cfg.EXIT_COMPLETE_DELETE_MODE === 'delete' ? deleteItem(it.id, cfg.TOKEN) : archiveItem(it.id, cfg.TOKEN))
    log(`EXIT OK: ${barcode} -${qty} [${current}→${nextVal}]`)
    results.push({ itemId: it.id, ok: true, barcode, qty, from: current, to: nextVal, catalogId: cat.id })
  }

  return { ok: true, groupId: groupIdOverride || process.env.EXIT_GROUP_ID, reportGroupId, count: results.length, results }
}

// ---- Health & Logs
app.get('/health', (req, res) => res.json({ ok: true, version: 'v0.1', author: 'Mehmet Barut' }))
app.get('/api/logs', (req, res) => {
  try {
    if (!fs.existsSync(outPath)) return res.json({ text: '' })
    const buf = fs.readFileSync(outPath, 'utf8')
    const lines = buf.split('\n')
    const tail = lines.slice(-500).join('\n')
    res.json({ text: tail })
  } catch (e) { res.status(500).json({ error: String(e) }) }
})

// ---- Manual batch (giriş)
app.post('/api/process', async (req, res) => {
  try {
    const groupId = req.body?.groupId
    const out = await processBatchFromGroup(groupId, { triggerUserId: null })
    res.json(out)
  } catch (e) { console.error(e); log('ERR /api/process ' + String(e)); res.status(500).json({ error: String(e) }) }
})

// ---- Setup endpoints (kısaltılmış)
app.post('/api/setup/testToken', async (req, res) => {
  try {
    const token = req.body?.token?.trim()
    if (!token) return res.status(400).json({ error: 'token required' })
    const q = `query { me { id name email } }`
    const d = await gql(q, {}, token)
    res.json({ ok: true, me: d?.me })
  } catch (e) { res.status(400).json({ ok: false, error: String(e) }) }
})
app.post('/api/setup/workspaces', async (req, res) => {
  try {
    const token = req.body?.token?.trim()
    if (!token) return res.status(400).json({ error: 'token required' })
    const q = `query { workspaces { id name kind } }`
    const d = await gql(q, {}, token, false)
    res.json({ ok: true, workspaces: d?.workspaces || [] })
  } catch (e) { res.status(400).json({ ok: false, error: String(e) }) }
})
app.post('/api/setup/boardsByWorkspace', async (req, res) => {
  try {
    const token = req.body?.token?.trim()
    const workspaceId = req.body?.workspaceId
    if (!token || !workspaceId) return res.status(400).json({ error: 'token and workspaceId required' })
    const collected = []
    try {
      const q1 = `query($limit:Int){ boards(limit:$limit){ id name state workspace { id name } } }`
      const d1 = await gql(q1, { limit: 500 }, token, false)
      collected.push(...(d1?.boards || []))
    } catch { }
    if (collected.length === 0) {
      const q2 = `query($limit:Int){ boards_page(limit:$limit){ boards { id name state workspace { id name } } cursor } }`
      const d2 = await gql(q2, { limit: 500 }, token, false)
      collected.push(...(d2?.boards_page?.boards || []))
    }
    if (collected.length === 0) {
      const q3 = `query { me { boards(limit: 500) { id name state workspace { id name } } } }`
      const d3 = await gql(q3, {}, token, false)
      collected.push(...(d3?.me?.boards || []))
    }
    const filtered = collected.filter(b => String(b?.workspace?.id) === String(workspaceId))
    res.json({ ok: true, boards: filtered })
  } catch (e) { res.status(400).json({ ok: false, error: String(e) }) }
})
app.post('/api/setup/boards', async (req, res) => {
  try {
    const token = req.body?.token?.trim()
    const search = req.body?.search || ''
    if (!token) return res.status(400).json({ error: 'token required' })
    try {
      const q1 = `query($limit:Int,$search:String){ boards(limit:$limit, search:$search){ id name board_kind state workspace { id name } } }`
      const d1 = await gql(q1, { limit: 200, search }, token, false)
      const arr1 = d1?.boards || []
      if (arr1.length) return res.json({ ok: true, via: 'boards', boards: arr1 })
    } catch { }
    try {
      const q2 = `query($limit:Int){ boards_page(limit:$limit){ boards { id name state workspace { id name } } cursor } }`
      const d2 = await gql(q2, { limit: 200 }, token, false)
      const arr2 = d2?.boards_page?.boards || []
      if (arr2.length) return res.json({ ok: true, via: 'boards_page', boards: arr2 })
    } catch { }
    try {
      const q3 = `query { me { boards(limit: 200) { id name state workspace { id name } } } }`
      const d3 = await gql(q3, {}, token, false)
      const arr3 = d3?.me?.boards || []
      if (arr3.length) return res.json({ ok: true, via: 'me.boards', boards: arr3 })
    } catch { }
    res.json({ ok: true, boards: [], via: 'none' })
  } catch (e) { res.status(400).json({ ok: false, error: String(e) }) }
})
app.post('/api/setup/groups', async (req, res) => {
  try {
    const token = req.body?.token?.trim()
    const boardId = Number(req.body?.boardId)
    if (!token || !boardId) return res.status(400).json({ error: 'token and boardId required' })
    const q = `query($boardId:[ID!]){ boards(ids:$boardId){ id groups { id title } } }`
    const d = await gql(q, { boardId: [boardId] }, token)
    const groups = d?.boards?.[0]?.groups || []
    res.json({ ok: true, groups })
  } catch (e) { res.status(400).json({ ok: false, error: String(e) }) }
})
app.post('/api/setup/columns', async (req, res) => {
  try {
    const token = req.body?.token?.trim()
    const boardId = Number(req.body?.boardId)
    if (!token || !boardId) return res.status(400).json({ error: 'token and boardId required' })
    const q = `query($boardId:[ID!]){ boards(ids:$boardId){ id columns { id title type } } }`
    const d = await gql(q, { boardId: [boardId] }, token)
    const columns = d?.boards?.[0]?.columns || []
    res.json({ ok: true, columns })
  } catch (e) { res.status(400).json({ ok: false, error: String(e) }) }
})
app.post('/api/setup/saveConfig', async (req, res) => {
  try {
    const {
      token,
      entryBoardId, entryGroupId, entryQtyColumnId, entryBarcodeSource,
      catalogBoardId, catalogBarcodeColumnId, catalogStockColumnId,
      reportBoardId, createReportGroup, deleteMode,
      entryProductLinkColumnId, reportCopyColumns,
      reportDateColumnId, reportPersonColumnId, completeDeleteMode,
      entryNotesTextId,       // ENTRY tarafındaki Notlar kolonu (Text)
      reportNotesTextId,      // RAPOR tarafındaki Notlar kolonu (Text)
    } = req.body || {}

    const envPath = path.join(__dirname, '.env')
    const merged = {
      PORT: process.env.PORT || '8080',
      MONDAY_API_TOKEN: token || process.env.MONDAY_API_TOKEN || '',
      ENTRY_BOARD_ID: entryBoardId || process.env.ENTRY_BOARD_ID || '',
      ENTRY_GROUP_ID: entryGroupId || process.env.ENTRY_GROUP_ID || 'topics',
      ENTRY_QTY_COLUMN_ID: entryQtyColumnId || process.env.ENTRY_QTY_COLUMN_ID || '',
      ENTRY_BARCODE_SOURCE: entryBarcodeSource || process.env.ENTRY_BARCODE_SOURCE || 'name',
      CATALOG_BOARD_ID: catalogBoardId || process.env.CATALOG_BOARD_ID || '',
      CATALOG_BARCODE_COLUMN_ID: catalogBarcodeColumnId || process.env.CATALOG_BARCODE_COLUMN_ID || '',
      CATALOG_STOCK_COLUMN_ID: catalogStockColumnId || process.env.CATALOG_STOCK_COLUMN_ID || '',
      REPORT_BOARD_ID: reportBoardId ?? (process.env.REPORT_BOARD_ID || ''),
      CREATE_REPORT_GROUP: (createReportGroup ?? (process.env.CREATE_REPORT_GROUP ?? 'true')) + '',
      DELETE_MODE: deleteMode || process.env.DELETE_MODE || 'archive',
      ALLOWED_ORIGIN: process.env.ALLOWED_ORIGIN || '*',
      LOG_TO_FILE: process.env.LOG_TO_FILE || 'true',
      ENTRY_PRODUCT_LINK_COLUMN_ID: entryProductLinkColumnId || process.env.ENTRY_PRODUCT_LINK_COLUMN_ID || '',
      REPORT_COPY_COLUMNS: (reportCopyColumns ?? (process.env.REPORT_COPY_COLUMNS ?? 'true')) + '',
      REPORT_DATE_COLUMN_ID: reportDateColumnId || process.env.REPORT_DATE_COLUMN_ID || '',
      REPORT_PERSON_COLUMN_ID: reportPersonColumnId || process.env.REPORT_PERSON_COLUMN_ID || '',
      COMPLETE_DELETE_MODE: completeDeleteMode || process.env.COMPLETE_DELETE_MODE || 'delete',
      ENTRY_NOTES_TEXT_ID: entryNotesTextId || process.env.ENTRY_NOTES_TEXT_ID || '',
      REPORT_NOTES_TEXT_ID: reportNotesTextId || process.env.REPORT_NOTES_TEXT_ID || '',
    }
    const envText = Object.entries(merged).map(([k, v]) => `${k}=${v}`).join('\n')
    fs.writeFileSync(envPath, envText)

    res.json({ ok: true, saved: merged, note: 'Değişiklik etkin olsun diye servisi yeniden başlat.' })
  } catch (e) { res.status(500).json({ ok: false, error: String(e) }) }
})

// -----------------------------
// WEBHOOK
// -----------------------------
app.post('/webhook', async (req, res) => {
  try {
    const body = req.body || {}
    if (body.challenge) return res.status(200).json({ challenge: body.challenge })

    const ev = body.event || {}
    const type = ev.type
    const boardId = Number(ev.boardId)
    const groupId = ev.groupId
    const name = ev.pulseName
    const userId = Number(ev.userId || ev.user_id || 0) || null
    const itemId = Number(ev.pulseId || ev.itemId || 0) || null

    const isCreate = type === 'create_pulse' || type === 'create_item'
    const isNameChange = type === 'change_name'
    const isCompleteName = (name || '').trim().toLowerCase() === 'tamamla'

    // ENTRY board
    if (process.env.ENTRY_BOARD_ID && boardId === Number(process.env.ENTRY_BOARD_ID)) {
      // barkod isimli item → ürün auto-link
      if (isCreate && itemId && process.env.ENTRY_PRODUCT_LINK_COLUMN_ID) {
        const created = await getItemWithColumns(itemId, process.env.MONDAY_API_TOKEN)
        if (created && Number(created.board?.id) === Number(process.env.ENTRY_BOARD_ID)) {
          const nm = (process.env.ENTRY_BARCODE_SOURCE === 'name')
            ? (created.name || '')
            : safeText((created.column_values || []).find(c => c.id === process.env.ENTRY_BARCODE_SOURCE))
          if (nm && /^[A-Za-z0-9\-\_\.]{3,}$/.test(nm.trim())) {
            const cat = await findCatalogItemByBarcode(Number(process.env.CATALOG_BOARD_ID), process.env.CATALOG_BARCODE_COLUMN_ID, nm, process.env.MONDAY_API_TOKEN)
            if (cat?.id) {
              await changeMultipleColumns(itemId, Number(process.env.ENTRY_BOARD_ID), {
                [process.env.ENTRY_PRODUCT_LINK_COLUMN_ID]: { linkedPulseIds: [{ linkedPulseId: Number(cat.id) }] }
              }, process.env.MONDAY_API_TOKEN)
              log(`ENTRY AUTO-LINK: ${itemId} -> ${cat.id} (${nm})`)
            }
          }
        }
      }

      // tamamla
      if ((isNameChange && isCompleteName) || (isCreate && isCompleteName)) {
        log(`ENTRY webhook trigger: group=${groupId}`)
        const out = await processBatchFromGroup(groupId || process.env.ENTRY_GROUP_ID, { triggerUserId: userId })


        // "tamamla" satırını SADECE batch bloklanmadıysa kaldır
        if (!out?.blocked) {
          const completeMode = (process.env.COMPLETE_DELETE_MODE || 'delete')
          if (itemId) {
            if (completeMode === 'delete') await deleteItem(itemId, process.env.MONDAY_API_TOKEN)
            else if (completeMode === 'archive') await archiveItem(itemId, process.env.MONDAY_API_TOKEN)
          }
        }

        return res.json(out)
      }
      return res.json({ ok: true, ignored: true, board: 'ENTRY', type, name })
    }

    // EXIT board
    if (process.env.EXIT_BOARD_ID && boardId === Number(process.env.EXIT_BOARD_ID)) {
      if (isCreate && itemId) {
        await autoLinkExitProductIfPossible(itemId, Number(process.env.EXIT_BOARD_ID), process.env.MONDAY_API_TOKEN)
      }
      if ((isNameChange && isCompleteName) || (isCreate && isCompleteName)) {
        log(`EXIT webhook trigger: group=${groupId}`)
        const out = await processExitBatchFromGroup(groupId || process.env.EXIT_GROUP_ID, { triggerUserId: userId })

        const completeMode = (process.env.EXIT_COMPLETE_DELETE_MODE || 'delete')
        if (itemId) {
          if (completeMode === 'delete') await deleteItem(itemId, process.env.MONDAY_API_TOKEN)
          else if (completeMode === 'archive') await archiveItem(itemId, process.env.MONDAY_API_TOKEN)
        }

        return res.json(out)
      }
      return res.json({ ok: true, ignored: true, board: 'EXIT', type, name })
    }

    res.json({ ok: true, ignored: true, type, name })
  } catch (e) {
    console.error(e); log('ERR /webhook ' + String(e))
    res.status(500).json({ error: String(e) })
  }
})

// ---- Statik client (varsa)
const clientDist = path.join(__dirname, '..', 'client', 'dist')
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist))
  app.get('*', (req, res) => res.sendFile(path.join(clientDist, 'index.html')))
}

// ---- Run ----
app.listen(PORT, () => log(`[ACO Stock Suite] listening on :${PORT}`))
