/** Shared disclosure for every progress card in one Session view. */
import { defineStore } from '@deepseek-ai/dsh-client-store'

/**
 * Declare an initially expanded store owned by the renderer's Session scope.
 * @returns a handle shared by existing and newly rendered cards in that Session.
 */
export function createExpansionStore() {
  return defineStore({
    init: () => ({ expanded: true }),
    actions: { toggle: state => { state.expanded = !state.expanded } },
  })
}
