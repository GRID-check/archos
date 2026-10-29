'use client'

/**
 * Fixture sections for the atoms preview: badges and chips, alerts, progress,
 * skeletons, the stepper and list items. Chips and badges are controls (4px);
 * the count pill is a numeric chip (4px); avatars and status dots stay round.
 */

import type { JSX } from 'react'
import { useState } from 'react'
import { Check, FileText, Info } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Chip, ChipCount, ChipLabel } from '@/components/ui/chip'
import { CountPill } from '@/components/ui/count-pill'
import { Item, ItemActions, ItemContent, ItemDescription, ItemList, ItemMedia, ItemTitle } from '@/components/ui/item'
import { Kbd, KbdGroup } from '@/components/ui/kbd'
import { Progress } from '@/components/ui/progress'
import { SegmentMeter } from '@/components/ui/segment-meter'
import { Skeleton } from '@/components/ui/skeleton'
import { Stepper } from '@/components/ui/stepper'
import { Button } from '@/components/ui/button'
import { Section } from './section'

const STEPS = [
  { key: 'projekt', label: 'Projekt' },
  { key: 'dokumente', label: 'Dokumente', note: '2 Befunde' },
  { key: 'pruefung', label: 'Prüfung' },
  { key: 'versand', label: 'Versand' },
]

export function StatusSection(): JSX.Element {
  const [step, setStep] = useState(1)
  return (
    <>
      <Section title="Badges, chips and counts" description="Status labels are controls: 4px. Only the avatar and dots are round.">
        <div className="flex flex-wrap items-center gap-2">
          <Badge>Default</Badge>
          <Badge variant="secondary">Secondary</Badge>
          <Badge variant="outline">Outline</Badge>
          <Badge variant="success">Freigegeben</Badge>
          <Badge variant="warning">Offen</Badge>
          <Badge variant="info">Neu</Badge>
          <Badge variant="danger">Fehlgeschlagen</Badge>
          <Badge variant="destructive">Destructive</Badge>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Chip variant="muted">Muted chip</Chip>
          <Chip variant="outline">
            <FileText aria-hidden /> Plan
          </Chip>
          <Chip variant="success">Geprüft</Chip>
          <Chip variant="warning">Ausstehend</Chip>
          <Chip variant="info">Hinweis</Chip>
          <Chip variant="destructive">Fehler</Chip>
          <Chip variant="default" size="sm">
            <ChipLabel>Klein</ChipLabel>
            <ChipCount count={3} />
          </Chip>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <CountPill count={7} />
          <CountPill count={250} />
          <CountPill tone="attention" count={3} />
          <span className="text-sm">
            Tastatur: <Kbd>⌘</Kbd> <Kbd>K</Kbd> · <KbdGroup><Kbd>Shift</Kbd><Kbd>Enter</Kbd></KbdGroup>
          </span>
          <Avatar>
            <AvatarFallback>MB</AvatarFallback>
          </Avatar>
        </div>
      </Section>

      <Section title="Alerts" description="Alerts are surfaces: square.">
        <Alert>
          <Info aria-hidden />
          <AlertTitle>Hinweis</AlertTitle>
          <AlertDescription>Die Frist für den Lageplan endet am Freitag.</AlertDescription>
        </Alert>
        <Alert variant="destructive">
          <Info aria-hidden />
          <AlertTitle>Fehler beim Import</AlertTitle>
          <AlertDescription>Zwei Dateien konnten nicht gelesen werden.</AlertDescription>
        </Alert>
      </Section>

      <Section title="Progress, meters, skeletons" description="Bars are not controls and not surfaces: no radius.">
        <Progress value={62} className="max-w-md" />
        <SegmentMeter
          label="Befunde"
          segments={[
            { value: 4, tone: 'success' },
            { value: 2, tone: 'warning' },
            { value: 1, tone: 'destructive' },
          ]}
          className="max-w-md"
        />
        <div className="grid max-w-md gap-2">
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-16 w-full" />
        </div>
      </Section>

      <Section title="Stepper" description="Step markers are round; the rail is a hairline.">
        <Stepper
          steps={STEPS}
          current={step}
          furthest={2}
          onSelect={setStep}
          label="Schritte"
          progressLabel={`Schritt ${step + 1} von ${STEPS.length}`}
        />
      </Section>

      <Section title="List items" description="ItemList is the surface; each row is a control-level item.">
        <ItemList className="max-w-xl">
          <Item>
            <ItemMedia>
              <FileText aria-hidden />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>Lageplan_2026.pdf</ItemTitle>
              <ItemDescription>Aktualisiert vor 2 Tagen</ItemDescription>
            </ItemContent>
            <ItemActions>
              <Button variant="ghost" size="sm">
                <Check aria-hidden /> Öffnen
              </Button>
            </ItemActions>
          </Item>
          <Item>
            <ItemContent>
              <ItemTitle>Baubeschreibung.docx</ItemTitle>
              <ItemDescription>Entwurf</ItemDescription>
            </ItemContent>
          </Item>
        </ItemList>
      </Section>
    </>
  )
}
