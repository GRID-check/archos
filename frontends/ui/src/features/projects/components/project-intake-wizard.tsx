'use client'

import { useProjectIntakeWizardController, type ProjectIntakeWizardProps } from './use-project-intake-wizard-controller'
import { ProjectIntakeWizardView } from './project-intake-wizard-view'

export function ProjectIntakeWizard(props: ProjectIntakeWizardProps) {
  const controller = useProjectIntakeWizardController(props)
  return <ProjectIntakeWizardView controller={controller} />
}
