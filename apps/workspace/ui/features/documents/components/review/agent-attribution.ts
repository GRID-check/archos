import { useTranslations } from '@/i18n'
import { filesCopy } from '@/i18n/namespaces/files'

/**
 * How the Prüfansicht names Piloti's own marks and replies: always with the
 * person it wrote them for („Piloti · für Anna"), because on a shared document
 * a reader must see whose request an AI's words answer (ADR-0105; EU AI Act
 * Art. 50). The name is `createdBy`'s: Piloti works in the asker's session.
 * A name the directory does not know leaves the plain „Piloti" rather than
 * inventing a person; a proposal keeps saying it is one.
 */
export function useAgentByline(): (forName: string | null | undefined, options?: { proposal?: boolean }) => string {
  const t = useTranslations(filesCopy)
  return (forName, options) => {
    const name = forName?.trim()
    if (!name) return 'Piloti'
    return options?.proposal ? t('review.attribution.proposalFor', { name }) : t('review.attribution.agentFor', { name })
  }
}
