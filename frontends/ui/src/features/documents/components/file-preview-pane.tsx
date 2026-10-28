'use client'

import { useFilePreviewController, type FilePreviewPaneProps } from './use-file-preview-controller'
import { FilePreviewChrome } from './file-preview-pane-chrome'
import { FilePreviewBody } from './file-preview-pane-body'
import { FilePreviewFooter } from './file-preview-pane-footer'

export function FilePreviewPane(props: FilePreviewPaneProps) {
  const controller = useFilePreviewController(props)
  return (
    <div className="@container bg-card flex h-full min-h-0 flex-col">
      <FilePreviewChrome controller={controller} />
      <FilePreviewBody controller={controller} />
      <FilePreviewFooter controller={controller} />
    </div>
  )
}
