'use client'

import type { JSX } from 'react'

import { useModelStageController, type ModelStageProps } from './use-model-stage-controller'
import { ModelStageView } from './model-stage-view'
export type { ModelStageProps } from './use-model-stage-controller'

export function ModelStage(props: ModelStageProps): JSX.Element {
  const controller = useModelStageController(props)
  return <ModelStageView controller={controller} />
}
