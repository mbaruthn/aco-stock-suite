import axios from 'axios'
const api = axios.create()

// mevcutlar
export async function getHealth(){ return (await api.get('/health')).data }
export async function getLogs(){ return (await api.get('/api/logs')).data }
export async function processBatch(groupId?:string){ return (await api.post('/api/process', { groupId })).data }

// kurulum sihirbazı
export async function testToken(token:string){ return (await api.post('/api/setup/testToken', { token })).data }

// Genel board listesi (fallback'li, server 'via' döndürüyor)
export async function fetchBoards(token:string, search?:string){
  return (await api.post('/api/setup/boards', { token, search })).data
}

// Workspace listesi
export async function fetchWorkspaces(token:string){
  return (await api.post('/api/setup/workspaces', { token })).data
}

// Workspace'e göre board listesi (server tarafında da fallback + filtre var)
export async function fetchBoardsByWorkspace(token:string, workspaceId:string){
  return (await api.post('/api/setup/boardsByWorkspace', { token, workspaceId })).data
}

export async function fetchGroups(token:string, boardId:number){
  return (await api.post('/api/setup/groups', { token, boardId })).data
}

export async function fetchColumns(token:string, boardId:number){
  return (await api.post('/api/setup/columns', { token, boardId })).data
}

export async function saveConfig(payload:any){
  return (await api.post('/api/setup/saveConfig', payload)).data
}
