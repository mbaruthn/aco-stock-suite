import { useEffect, useMemo, useState } from 'react'
import './styles.css'
import {
    testToken,
    fetchBoards,
    fetchGroups,
    fetchColumns,
    saveConfig,
    fetchWorkspaces,
    fetchBoardsByWorkspace,
} from './api'

type Board = { id: number | string; name: string; state?: string; workspace?: { id: string; name: string } }
type Group = { id: string; title: string }
type Column = { id: string; title: string; type: string }
type Workspace = { id: string; name: string; kind?: string }

export default function SetupWizard() {
    const [token, setToken] = useState('')
    const [me, setMe] = useState<any>(null)
    const [step, setStep] = useState(1)

    // workspace & boards
    const [workspaces, setWorkspaces] = useState<Workspace[]>([])
    const [selectedWsId, setSelectedWsId] = useState<string>('') // seçilen workspace
    const [boards, setBoards] = useState<Board[]>([])
    const [boardsVia, setBoardsVia] = useState<string>('') // server 'via' bilgisi
    const [boardsLoading, setBoardsLoading] = useState(false)

    // selections
    const [entryBoard, setEntryBoard] = useState<Board | null>(null)
    const [entryGroup, setEntryGroup] = useState<Group | null>(null)
    const [entryQtyCol, setEntryQtyCol] = useState<Column | null>(null)
    const [entryBarcodeSource, setEntryBarcodeSource] = useState<'name' | string>('name')

    const [catalogBoard, setCatalogBoard] = useState<Board | null>(null)
    const [catalogBarcodeCol, setCatalogBarcodeCol] = useState<Column | null>(null)
    const [catalogStockCol, setCatalogStockCol] = useState<Column | null>(null)

    const [reportBoard, setReportBoard] = useState<Board | null>(null)
    const [createReportGroup, setCreateReportGroup] = useState(true)
    const [deleteMode, setDeleteMode] = useState('archive')

    // options
    const [entryGroups, setEntryGroups] = useState<Group[]>([])
    const [entryColumns, setEntryColumns] = useState<Column[]>([])
    const [catalogColumns, setCatalogColumns] = useState<Column[]>([])

    const [entryProductRelCol, setEntryProductRelCol] = useState<Column | null>(null)
    const [reportCopyColumns, setReportCopyColumns] = useState(true)


    // İlk token doğrulama ve başlangıç veri yükü
    async function doTest() {
        const r = await testToken(token)
        setMe(r.me)
        setStep(2)

        // Workspace'leri çek
        const ws = await fetchWorkspaces(token)
        setWorkspaces(ws.workspaces || [])

        // Genel board listesini (fallback'li) bir kere çek
        await loadBoardsGlobal()
    }

    // Genel board listesi (server fallback'li / via döner)
    async function loadBoardsGlobal() {
        setBoardsLoading(true)
        try {
            const b = await fetchBoards(token)
            setBoards(b.boards || [])
            setBoardsVia(b.via || 'unknown')
        } finally {
            setBoardsLoading(false)
        }
    }

    // Workspace değişince o workspace'e özel boardları sunucudan iste
    useEffect(() => {
        if (!token) return
            ; (async () => {
                setBoardsLoading(true)
                try {
                    if (!selectedWsId) {
                        // tüm boardlar
                        await loadBoardsGlobal()
                    } else {
                        const r = await fetchBoardsByWorkspace(token, selectedWsId)
                        // boardsByWorkspace zaten sunucuda filtreliyor; yine de boş dönerse global fallback'e dönelim
                        if ((r.boards || []).length > 0) {
                            setBoards(r.boards)
                            setBoardsVia('byWorkspace')
                        } else {
                            // Fallback: global çek, client-side filtre uygula
                            const b = await fetchBoards(token)
                            const all = b.boards || []
                            const filtered = all.filter((x: any) => String(x?.workspace?.id) === String(selectedWsId))
                            setBoards(filtered)
                            setBoardsVia(b.via ? `fallback:${b.via}` : 'fallback')
                        }
                    }
                } finally {
                    setBoardsLoading(false)
                }
            })()
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selectedWsId, token])

    async function onChooseEntryBoard(idStr: string) {
        const id = Number(idStr)
        const groups = (await fetchGroups(token, id)).groups || []
        const cols = (await fetchColumns(token, id)).columns || []
        const chosen = boards.find(b => Number(b.id) === id) || null
        setEntryBoard(chosen)
        setEntryGroups(groups)
        setEntryColumns(cols)
    }

    async function onChooseCatalogBoard(idStr: string) {
        const id = Number(idStr)
        const cols = (await fetchColumns(token, id)).columns || []
        const chosen = boards.find(b => Number(b.id) === id) || null
        setCatalogBoard(chosen)
        setCatalogColumns(cols)
    }

    function onChooseReportBoard(idStr: string) {
        const id = Number(idStr)
        const chosen = boards.find(b => Number(b.id) === id) || null
        setReportBoard(chosen)
    }

    async function onSave() {
        if (!token || !entryBoard || !entryGroup || !entryQtyCol || !catalogBoard || !catalogBarcodeCol || !catalogStockCol) {
            alert('Zorunlu alanlar eksik.')
            return
        }
        const payload = {
            token,
            entryBoardId: entryBoard.id,
            entryGroupId: entryGroup.id,
            entryQtyColumnId: entryQtyCol.id,
            entryBarcodeSource,
            catalogBoardId: catalogBoard.id,
            catalogBarcodeColumnId: catalogBarcodeCol.id,
            catalogStockColumnId: catalogStockCol.id,
            reportBoardId: reportBoard?.id ?? '',
            createReportGroup,
            deleteMode,
            entryProductLinkColumnId: entryProductRelCol?.id || '',
            reportCopyColumns
        }
        const r = await saveConfig(payload)
        alert('Kaydedildi. Servisi yeniden başlatmanız gerekir.\n\n' + JSON.stringify(r.saved, null, 2))
    }

    // küçük yardımcı metin
    const boardsInfo = useMemo(() => {
        const count = boards?.length || 0
        return `Boards: ${count} ${boardsVia ? `(via: ${boardsVia})` : ''}`
    }, [boards, boardsVia])

    return (
        <div className="panel">
            <h3>Kurulum Sihirbazı</h3>

            {step === 1 && (
                <>
                    <div className="row">
                        <div className="col" style={{ minWidth: 380 }}>
                            <label>Monday API Token</label>
                            <input value={token} onChange={e => setToken(e.target.value)} placeholder="eyJhbGciOi..." />
                        </div>
                        <div className="col" style={{ alignSelf: 'end', maxWidth: 160 }}>
                            <button onClick={doTest}>Token Doğrula</button>
                        </div>
                    </div>
                    <small>Token doğrulanınca kullanıcı bilgisi + workspace/board listeleri yüklenir.</small>
                </>
            )}

            {step >= 2 && me && (
                <div className="panel" style={{ marginTop: 12 }}>
                    <b>Hesap:</b> {me.name} &lt;{me.email}&gt;
                </div>
            )}

            {step >= 2 && (
                <>
                    {/* Workspace seçimi */}
                    <div className="row" style={{ marginTop: 8 }}>
                        <div className="col">
                            <label>Workspace (opsiyonel – listeyi daraltır)</label>
                            <select value={selectedWsId} onChange={e => setSelectedWsId(e.target.value)}>
                                <option value="">Tümü</option>
                                {workspaces.map(w => (
                                    <option key={w.id} value={w.id}>
                                        {w.name}
                                    </option>
                                ))}
                            </select>
                            <small style={{ display: 'block', marginTop: 6 }}>{boardsLoading ? 'Yükleniyor…' : boardsInfo}</small>
                            {(!boards || boards.length === 0) && !boardsLoading && (
                                <small style={{ display: 'block', color: '#ef4444' }}>
                                    Bu workspace altında board görünmüyor. Yukarıdan “Tümü”nü seçip tekrar deneyin veya Monday’de bu kullanıcıyı ilgili board’a üye yapın.
                                </small>
                            )}
                        </div>
                    </div>

                    <h4 style={{ marginTop: 10 }}>1) Depo Girişleri (Entry)</h4>
                    <div className="row">
                        <div className="col">
                            <label>Board</label>
                            <select onChange={e => onChooseEntryBoard(e.target.value)} value={entryBoard ? String(entryBoard.id) : ''}>
                                <option value="" disabled>
                                    Seç...
                                </option>
                                {boards.map(b => (
                                    <option key={String(b.id)} value={String(b.id)}>
                                        {b.name} {b.workspace?.name ? `— ${b.workspace.name}` : ''}
                                    </option>
                                ))}
                            </select>
                        </div>
                        <div className="col">
                            <label>Group</label>
                            <select onChange={e => setEntryGroup(entryGroups.find(g => g.id === e.target.value) || null)} value={entryGroup?.id || ''}>
                                <option value="" disabled>
                                    Seç...
                                </option>
                                {entryGroups.map(g => (
                                    <option key={g.id} value={g.id}>
                                        {g.title}
                                    </option>
                                ))}
                            </select>
                        </div>
                        <div className="col">
                            <label>Giriş Adeti (number)</label>
                            <select onChange={e => setEntryQtyCol(entryColumns.find(c => c.id === e.target.value) || null)} value={entryQtyCol?.id || ''}>
                                <option value="" disabled>
                                    Seç...
                                </option>
                                {entryColumns
                                    .filter(c => c.type === 'numeric' || c.type === 'numbers')
                                    .map(c => (
                                        <option key={c.id} value={c.id}>
                                            {c.title} ({c.type})
                                        </option>
                                    ))}
                            </select>
                        </div>
                        <div className="col">
                            <label>Barkod Kaynağı</label>
                            <select onChange={e => setEntryBarcodeSource(e.target.value as any)} value={entryBarcodeSource}>
                                <option value="name">İlk sütun (Name)</option>
                                {entryColumns.map(c => (
                                    <option key={c.id} value={c.id}>
                                        {c.title} ({c.type})
                                    </option>
                                ))}
                            </select>
                        </div>
                    </div>
                    <div className="col">
                        <label>Ürün (board relation) kolonu</label>
                        <select onChange={e => setEntryProductRelCol(entryColumns.find(c => c.id === e.target.value) || null)} value={entryProductRelCol?.id || ''}>
                            <option value="">— Seç (opsiyonel) —</option>
                            {entryColumns
                                .filter(c => c.type === 'board_relation' || c.type === 'board-relation' || c.type === 'board_relation_column')
                                .map(c => (
                                    <option key={c.id} value={c.id}>
                                        {c.title} ({c.type})
                                    </option>
                                ))}
                        </select>
                    </div>

                    <h4 style={{ marginTop: 16 }}>2) Ürün Kataloğu (Catalog)</h4>
                    <div className="row">
                        <div className="col">
                            <label>Board</label>
                            <select onChange={e => onChooseCatalogBoard(e.target.value)} value={catalogBoard ? String(catalogBoard.id) : ''}>
                                <option value="" disabled>
                                    Seç...
                                </option>
                                {boards.map(b => (
                                    <option key={String(b.id)} value={String(b.id)}>
                                        {b.name} {b.workspace?.name ? `— ${b.workspace.name}` : ''}
                                    </option>
                                ))}
                            </select>
                        </div>
                        <div className="col">
                            <label>Barkod Kolonu (text/barcode)</label>
                            <select onChange={e => setCatalogBarcodeCol(catalogColumns.find(c => c.id === e.target.value) || null)} value={catalogBarcodeCol?.id || ''}>
                                <option value="" disabled>
                                    Seç...
                                </option>
                                {catalogColumns
                                    .filter(c => ['text', 'name', 'short_text', 'numeric', 'numbers', 'barcode'].includes(c.type))
                                    .map(c => (
                                        <option key={c.id} value={c.id}>
                                            {c.title} ({c.type})
                                        </option>
                                    ))}
                            </select>
                        </div>
                        <div className="col">
                            <label>Stok Kolonu (number)</label>
                            <select onChange={e => setCatalogStockCol(catalogColumns.find(c => c.id === e.target.value) || null)} value={catalogStockCol?.id || ''}>
                                <option value="" disabled>
                                    Seç...
                                </option>
                                {catalogColumns
                                    .filter(c => c.type === 'numeric' || c.type === 'numbers')
                                    .map(c => (
                                        <option key={c.id} value={c.id}>
                                            {c.title} ({c.type})
                                        </option>
                                    ))}
                            </select>
                        </div>
                    </div>

                    <h4 style={{ marginTop: 16 }}>3) Raporlar (opsiyonel)</h4>
                    <div className="row">
                        <div className="col">
                            <label>Rapor Board</label>
                            <select onChange={e => onChooseReportBoard(e.target.value)} value={reportBoard ? String(reportBoard.id) : ''}>
                                <option value="">— Yok —</option>
                                {boards.map(b => (
                                    <option key={String(b.id)} value={String(b.id)}>
                                        {b.name} {b.workspace?.name ? `— ${b.workspace.name}` : ''}
                                    </option>
                                ))}
                            </select>
                        </div>
                        <div className="col">
                            <label>Grup otomatik oluştur</label>
                            <select value={createReportGroup ? 'true' : 'false'} onChange={e => setCreateReportGroup(e.target.value === 'true')}>
                                <option value="true">Evet</option>
                                <option value="false">Hayır</option>
                            </select>
                        </div>
                        <div className="col">
                            <label>İşlem sonrası</label>
                            <select value={deleteMode} onChange={e => setDeleteMode(e.target.value)}>
                                <option value="archive">Archive</option>
                                <option value="delete">Delete</option>
                                <option value="keep">Keep</option>
                            </select>
                        </div>
                    </div>
                    <div className="col">
                        <label>Raporlara kolonları kopyala</label>
                        <select value={reportCopyColumns ? 'true' : 'false'} onChange={e => setReportCopyColumns(e.target.value === 'true')}>
                            <option value="true">Evet (önerilir)</option>
                            <option value="false">Hayır (sadece ad)</option>
                        </select>
                    </div>

                    <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
                        <button onClick={onSave}>Kaydet (.env yaz)</button>
                    </div>
                </>
            )}
        </div>
    )
}
