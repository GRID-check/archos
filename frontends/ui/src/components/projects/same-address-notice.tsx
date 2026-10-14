'use client'

/**
 * „An dieser Adresse gibt es schon ein Projekt": under the chosen address, the
 * projects the person may open that sit there, as links. An earlier project on
 * the plot is often the best source for the new one, and a duplicate is cheaper
 * to avoid than to merge. Silent when there is none or the lookup fails: it
 * advises, it never blocks.
 */

import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import { ExternalLink, Info } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { useTranslations } from '@/i18n'
import type { GeocodeResult } from '@/lib/geocoding/types'
import type { SameAddressClient, SameAddressResponse } from '@/lib/projects/same-address-client'

export function SameAddressNotice({
  place,
  client,
}: {
  place: Pick<GeocodeResult, 'label' | 'lat' | 'lon'>
  client: SameAddressClient
}): JSX.Element | null {
  const t = useTranslations('projects')
  const [found, setFound] = useState<SameAddressResponse['projects']>([])

  useEffect(() => {
    const controller = new AbortController()
    setFound([])
    client
      .find({ label: place.label, lat: place.lat, lon: place.lon }, { signal: controller.signal })
      .then((answer) => {
        if (!controller.signal.aborted) setFound(answer.projects)
      })
      .catch(() => {
        // Advice only: a failed lookup says nothing.
      })
    return () => controller.abort()
  }, [client, place.label, place.lat, place.lon])

  if (found.length === 0) return null
  return (
    <Alert role="status" data-testid="create-project-same-address">
      <Info aria-hidden />
      <AlertTitle className="line-clamp-none">{t('form.sameAddress.heading')}</AlertTitle>
      <AlertDescription>
        <ul className="flex flex-col gap-1">
          {found.map((project) => (
            <li key={project.id}>
              <a
                href={`/app/projects/${project.id}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary inline-flex max-w-full items-center gap-1.5 underline-offset-4 hover:underline"
                aria-label={`${project.name}. ${t('form.sameAddress.opensInNewTab')}`}
              >
                <span className="truncate">{project.name}</span>
                {project.status === 'closed' && (
                  <span className="text-muted-foreground shrink-0 text-xs">({t('form.sameAddress.closed')})</span>
                )}
                <ExternalLink className="size-3 shrink-0" aria-hidden />
              </a>
            </li>
          ))}
        </ul>
        <p className="text-xs">{t('form.sameAddress.hint')}</p>
      </AlertDescription>
    </Alert>
  )
}
