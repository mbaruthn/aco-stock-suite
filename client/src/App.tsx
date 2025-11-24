import { useEffect, useState } from 'react'
import './styles.css'
import { getHealth, getLogs, processBatch } from './api'
import SetupWizard from './SetupWizard'

export default function App(){
  const [health,setHealth]=useState<any>(null)
  const [logs,setLogs]=useState<string>('')
  const [groupId,setGroupId]=useState<string>('')
  const [busy,setBusy]=useState(false)

  async function refresh(){
    try{ setHealth(await getHealth()) }catch{ setHealth({ok:false}) }
    try{ const d=await getLogs(); setLogs(d?.text||'') }catch{ setLogs('') }
  }
  useEffect(()=>{ refresh() }, [])

  async function run(){
    setBusy(true)
    try{
      const res=await processBatch(groupId || undefined)
      await refresh()
      alert('Tamamlandı: ' + JSON.stringify(res))
    }catch(e:any){
      alert('Hata: ' + (e?.response?.data?.error || e.message))
    }finally{ setBusy(false) }
  }

  return (
    <div className="container">
      <h1>ACO Stock Suite</h1>

      <SetupWizard />

      <div className="panel">
        <h3>Manuel İşlem (Batch)</h3>
        <div className="row">
          <div className="col">
            <label>Group ID (opsiyonel)</label>
            <input placeholder="boş bırakılırsa .env ENTRY_GROUP_ID kullanılır" value={groupId} onChange={e=>setGroupId(e.target.value)} />
          </div>
          <div className="col" style={{alignSelf:'end', maxWidth:160}}>
            <button disabled={busy} onClick={run}>Çalıştır</button>
          </div>
        </div>
      </div>

      <div className="panel">
        <h3>Log</h3>
        <pre>{logs || 'Log boş.'}</pre>
      </div>
    </div>
  )
}
