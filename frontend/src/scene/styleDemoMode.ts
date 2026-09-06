export type ShanghaiSceneMode = 'mvp' | 'visual'

export function getShanghaiSceneMode(search = window.location.search): ShanghaiSceneMode {
  return new URLSearchParams(search).get('view') === '3d-demo' ? 'visual' : 'mvp'
}

export function isShanghaiVisualDemo(search = window.location.search) {
  return getShanghaiSceneMode(search) === 'visual'
}
