'use client'

/**
 * Fixture sections for the atoms preview: surfaces (cards, quotes, menus,
 * popovers, tooltips, dialogs, sheets). Surfaces are square (0); the only
 * radii on this page are the 4px controls inside them.
 */

import type { JSX } from 'react'
import { FileText, Folder, Layers, Pencil, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Quote } from '@/components/ui/quote'
import { RaisedCard, RaisedCardBody, RaisedCardFooter, RaisedCardMedia } from '@/components/ui/raised-card'
import { StatCard, StatCardIcon, StatCardSkeleton } from '@/components/ui/stat-card'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import { Section } from './section'

export function SurfacesSection(): JSX.Element {
  return (
    <>
      <Section title="Cards" description="Cards and raised cards are surfaces: square, hairline-separated.">
        <div className="grid gap-4 sm:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Projektübersicht</CardTitle>
              <CardDescription>Wohnhaus Lindenweg, Phase 3</CardDescription>
            </CardHeader>
            <CardContent className="text-sm">Vier offene Punkte, zwei Fristen.</CardContent>
          </Card>
          <RaisedCard>
            <RaisedCardMedia className="flex h-24 items-center justify-center text-muted-foreground">
              <Layers aria-hidden />
            </RaisedCardMedia>
            <RaisedCardBody>
              <p className="text-sm font-medium">Lageplan_2026.pdf</p>
              <p className="text-xs text-muted-foreground">Fassung 3, geprüft</p>
            </RaisedCardBody>
            <RaisedCardFooter className="text-xs text-muted-foreground">Vor 2 Tagen</RaisedCardFooter>
          </RaisedCard>
          <StatCard label="Dokumente" value="128" hint="+12 diese Woche" icon={<StatCardIcon icon={FileText} tone="muted" />} />
          <StatCardSkeleton />
        </div>
      </Section>

      <Section title="Quotes" description="An excerpt and a paraphrase are both surfaces.">
        <Quote variant="excerpt">„Die Abstandsfläche beträgt mindestens 3 m.“</Quote>
        <Quote variant="paraphrase">Sinngemäß: Abstände zur Grenze sind einzuhalten.</Quote>
      </Section>

      <Section title="Menus, popovers, tooltips" description="Menu and popover containers are surfaces; their items are controls.">
        <div className="flex flex-wrap items-start gap-6">
          <DropdownMenu modal={false} defaultOpen>
            <DropdownMenuTrigger asChild>
              <Button variant="outline">Aktionen</Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuLabel>Dokument</DropdownMenuLabel>
              <DropdownMenuItem>
                <Pencil aria-hidden /> Umbenennen
              </DropdownMenuItem>
              <DropdownMenuItem>
                <Folder aria-hidden /> Verschieben
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive">
                <Trash2 aria-hidden /> Löschen
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Popover defaultOpen>
            <PopoverTrigger asChild>
              <Button variant="secondary">Filter</Button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-64 text-sm">
              Nur Dokumente mit offenem Befund anzeigen.
            </PopoverContent>
          </Popover>
          <TooltipProvider>
            <Tooltip open>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" aria-label="Ebenen">
                  <Layers aria-hidden />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Ebenen</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
      </Section>

      <Section title="Dialog and sheet" description="Open these to see the overlay surfaces. Both are square.">
        <div className="flex flex-wrap gap-3">
          <Dialog>
            <DialogTrigger asChild>
              <Button variant="outline">Dialog öffnen</Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Dokument löschen?</DialogTitle>
                <DialogDescription>Diese Aktion kann nicht rückgängig gemacht werden.</DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button variant="outline">Abbrechen</Button>
                <Button variant="destructive">Löschen</Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
          <Sheet>
            <SheetTrigger asChild>
              <Button variant="outline">Sheet öffnen</Button>
            </SheetTrigger>
            <SheetContent>
              <SheetHeader>
                <SheetTitle>Details</SheetTitle>
                <SheetDescription>Fassung, Prüfstatus und Verlauf.</SheetDescription>
              </SheetHeader>
            </SheetContent>
          </Sheet>
        </div>
      </Section>
    </>
  )
}
