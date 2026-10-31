'use client'

/**
 * Fixture sections for the atoms preview: the controls. Every control on this
 * page should show the 6px control radius; nothing here sets its own radius.
 */

import type { JSX } from 'react'
import { useState } from 'react'
import { ArrowRight, Bold, Italic, Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { TagInput } from '@/components/ui/tag-input'
import { Textarea } from '@/components/ui/textarea'
import { Toggle, ToggleSegments } from '@/components/ui/toggle'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Section } from './section'

export function ControlsSection(): JSX.Element {
  const [tags, setTags] = useState(['Brandschutz', 'Stellplätze'])
  const [checked, setChecked] = useState(true)
  const [segment, setSegment] = useState<'offen' | 'erledigt'>('offen')
  return (
    <>
      <Section title="Buttons" description="Every variant and size. Controls: 6px.">
        <div className="flex flex-wrap items-center gap-3">
          <Button>Default</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="outline">Outline</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="destructive">Destructive</Button>
          <Button variant="link">Link</Button>
          <Button variant="inline">Inline</Button>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button size="xs">Extra small</Button>
          <Button size="sm">Small</Button>
          <Button size="default">Default size</Button>
          <Button size="lg">Large</Button>
          <Button size="icon" aria-label="Add">
            <Plus aria-hidden />
          </Button>
          <Button variant="outline" size="icon" aria-label="Delete">
            <Trash2 aria-hidden />
          </Button>
          <Button variant="ghost" size="icon-sm" aria-label="Add, small">
            <Plus aria-hidden />
          </Button>
          <Button variant="ghost" size="icon-xs" aria-label="Add, extra small">
            <Plus aria-hidden />
          </Button>
          <Button>
            Continue <ArrowRight aria-hidden />
          </Button>
          <Button disabled>Disabled</Button>
          <Button loading>Saving</Button>
        </div>
      </Section>

      <Section title="Text fields" description="Input, textarea and tag input share the field radius.">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label htmlFor="atoms-name">Projektname</Label>
            <Input id="atoms-name" defaultValue="Wohnhaus Lindenweg" />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="atoms-search">Suche</Label>
            <Input id="atoms-search" placeholder="Dokument suchen" />
          </div>
          <div className="grid gap-1.5 sm:col-span-2">
            <Label htmlFor="atoms-notes">Notiz</Label>
            <Textarea id="atoms-notes" defaultValue="Stellplatznachweis fehlt noch." />
          </div>
          <div className="grid gap-1.5 sm:col-span-2">
            <Label>Schlagworte</Label>
            <TagInput value={tags} onChange={setTags} removeLabel={(tag) => `Entfernen ${tag}`} placeholder="Schlagwort" />
          </div>
        </div>
      </Section>

      <Section title="Select, checkbox, switch, radio" description="Triggers and toggles are controls.">
        <div className="flex flex-wrap items-center gap-6">
          <Select defaultValue="entwurf">
            <SelectTrigger className="w-44" aria-label="Status">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="entwurf">Entwurf</SelectItem>
              <SelectItem value="eingereicht">Eingereicht</SelectItem>
            </SelectContent>
          </Select>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={checked} onCheckedChange={(value) => setChecked(value === true)} />
            Geprüft
          </label>
          <label className="flex items-center gap-2 text-sm">
            <Switch defaultChecked />
            Benachrichtigen
          </label>
          <RadioGroup defaultValue="einmal" className="flex gap-4">
            <label className="flex items-center gap-2 text-sm">
              <RadioGroupItem value="einmal" /> Einmal
            </label>
            <label className="flex items-center gap-2 text-sm">
              <RadioGroupItem value="woechentlich" /> Wöchentlich
            </label>
          </RadioGroup>
        </div>
      </Section>

      <Section title="Toggles and segmented controls" description="Toggle groups are one control with a 6px tray.">
        <div className="flex flex-wrap items-center gap-4">
          <Toggle aria-label="Fett" variant="outline" defaultPressed>
            <Bold aria-hidden />
          </Toggle>
          <Toggle aria-label="Kursiv">
            <Italic aria-hidden />
          </Toggle>
          <ToggleGroup type="single" defaultValue="liste" segmented aria-label="Ansicht">
            <ToggleGroupItem value="liste">Liste</ToggleGroupItem>
            <ToggleGroupItem value="raster">Raster</ToggleGroupItem>
            <ToggleGroupItem value="karte">Karte</ToggleGroupItem>
          </ToggleGroup>
          <ToggleSegments aria-label="Status">
            {(['offen', 'erledigt'] as const).map((option) => (
              <Toggle key={option} variant="segment" size="xs" pressed={segment === option} onPressedChange={() => setSegment(option)}>
                {option === 'offen' ? 'Offen' : 'Erledigt'}
              </Toggle>
            ))}
          </ToggleSegments>
        </div>
      </Section>

      <Section title="Tabs" description="Tab strip and triggers.">
        <Tabs defaultValue="dokumente" className="w-full max-w-md">
          <TabsList>
            <TabsTrigger value="dokumente">Dokumente</TabsTrigger>
            <TabsTrigger value="aufgaben">Aufgaben</TabsTrigger>
            <TabsTrigger value="verlauf">Verlauf</TabsTrigger>
          </TabsList>
          <TabsContent value="dokumente" className="pt-3 text-sm text-muted-foreground">
            Sieben Dokumente in diesem Projekt.
          </TabsContent>
        </Tabs>
      </Section>
    </>
  )
}
