import { create } from 'zustand'

type TrimStore = {
  trimImageId: number | null
  open: (id: number) => void
  close: () => void
}

export const useTrimStore = create<TrimStore>((set) => ({
  trimImageId: null,
  open: (id) => set({ trimImageId: id }),
  close: () => set({ trimImageId: null }),
}))
