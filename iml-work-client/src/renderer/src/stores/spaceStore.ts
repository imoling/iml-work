import { create } from 'zustand'

export interface SpaceFile {
  name: string
  path: string
  summary?: string
  synced: boolean
  syncProgress?: number
}

interface SpaceState {
  files: SpaceFile[]
  searchQuery: string
  setSearchQuery: (query: string) => void
  loadFiles: () => Promise<void>
  syncFile: (name: string) => Promise<void>
  initSpaceListeners: () => () => void
}

export const useSpaceStore = create<SpaceState>((set) => ({
  files: [],
  searchQuery: '',

  setSearchQuery: (query: string) => {
    set({ searchQuery: query })
  },

  loadFiles: async () => {
    try {
      const list = await window.api.invoke('files:list')
      if (list) {
        set({ files: list.map((f: any) => ({ ...f, syncProgress: f.synced ? 100 : 0 })) })
      }
    } catch (error) {
      console.error("Failed to load files:", error)
    }
  },

  syncFile: async (name: string) => {
    set((state) => ({
      files: state.files.map(f => f.name === name ? { ...f, syncProgress: 10 } : f)
    }))
    try {
      // Start mock sync process (main will send progress = 100 after 1.5s)
      await window.api.invoke('files:sync', name)
    } catch (error) {
      console.error("Failed to sync file:", error)
    }
  },

  initSpaceListeners: () => {
    const unsubWatch = window.api.on('files:watch-event', (data: { action: string; file: any }) => {
      if (data.action === 'add') {
        set((state) => {
          // Check if already exists to avoid duplication
          if (state.files.some(f => f.name === data.file.name)) return state
          return {
            files: [...state.files, { ...data.file, syncProgress: data.file.synced ? 100 : 0 }]
          }
        })
      }
    })

    const unsubProgress = window.api.on('files:sync-progress', (data: { name: string; progress: number }) => {
      set((state) => ({
        files: state.files.map(f => 
          f.name === data.name 
            ? { ...f, synced: data.progress === 100, syncProgress: data.progress } 
            : f
        )
      }))
    })

    return () => {
      unsubWatch()
      unsubProgress()
    }
  }
}))
