import type { JSX } from 'react'
import { type Metadata } from 'next'
import { getTranslations } from '@/i18n/server'
import { navCopy } from '@/i18n/namespaces/nav'

interface ChatLayoutProps {
  children: React.ReactNode
}

// Server-rendered base title for the chat route ("<Project> · Chat — Piloti").
// The chat page is a client component and can't export metadata itself.
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations(navCopy)
  return { title: t('sections.chat') }
}

export default function ChatLayout({ children }: ChatLayoutProps): JSX.Element {
  return <>{children}</>
}
