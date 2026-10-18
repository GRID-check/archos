'use client'

/**
 * Dev preview for the viewer's chrome.
 *
 * The canvas needs WebGPU and headless Chromium has none, so the 3D picture
 * itself cannot be captured here — `/dev/bim-model` pins the no-WebGPU
 * fallback for that reason. What CAN be captured, now that every control is an
 * atom that owns no canvas, is the whole of the chrome: the dock, the rail,
 * the selection card, the loading veil. That is all of the copy and all of the
 * layout decisions.
 *
 * Rendered over the muted panel the stage uses, so contrast is judged against
 * the real backdrop rather than against white.
 *
 * Not linked from anywhere and 404s outside development.
 */

import type { JSX } from 'react'
import { useState } from 'react'
import { notFound } from 'next/navigation'
import {
  Eye,
  Home,
  Layers,
  PanelLeft,
  Scissors,
  SlidersHorizontal,
  Undo2,
  Video,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { I18nProvider } from '@/i18n'
import { cn } from '@/lib/utils'
import { ModelInspector } from '@/features/bim/components/model-inspector'
import { PhoneMoreRows, PhoneTools } from '@/features/bim/components/stage-phone-chrome'
import type { BimElementDetail } from '@/features/bim/hooks/use-bim-model'
import type { BimCameraView } from '@/features/bim/lib/viewer-camera'
import {
  ViewerDock,
  ViewerDockSeparator,
  ViewerField,
  ViewerFieldGroup,
  ViewerIconButton,
  ViewerPanel,
  ViewerProgress,
  ViewerRail,
  ViewerRailItem,
  ViewerRailSection,
  ViewerSheet,
  ViewerSlider,
  type ViewerSheetSnap,
} from '@/features/bim/components/viewer'

/** The model's vertical extent, as the loaded fixture reports it. */
const CUT_RANGE = { minMetres: -0.25, maxMetres: 6.25 }

/** The wall the selection stages are about. */
const SELECTED_WALL: BimElementDetail = {
  globalId: '2O2Fr$t4X7Zf8NOew3FLKU',
  expressId: 21,
  ifcType: 'IfcWallStandardCase',
  name: 'AW 38',
  description: null,
  predefinedType: null,
  objectType: null,
  tag: null,
  typeName: null,
  storeyName: 'Erdgeschoss',
  materials: ['Stahlbeton', 'Mineralwolle'],
  classifications: [],
  properties: {},
  quantities: { Qto_WallBaseQuantities: { NetSideArea: 18.44, Width: 0.38 } },
}

/** The wall as the phone sheet shows it: a 22-character id that used to be clipped. */
const PHONE_WALL: BimElementDetail = {
  ...SELECTED_WALL,
  globalId: '1kTvXnbbzCWw8lcMd1dR4o',
  name: 'Außenwand Nord — Stahlbeton mit WDVS',
  typeName: 'AW 38 Stahlbeton mit Wärmedämmverbundsystem',
}

function Stage({
  title,
  description,
  desktopOnly = false,
  children,
}: {
  title: string
  description: string
  /** A desktop arrangement: drawn at desktop width and scrolled sideways on a phone, never squeezed into it. */
  desktopOnly?: boolean
  children: React.ReactNode
}): JSX.Element {
  return (
    <section className="space-y-2">
      <div>
        <h2 className="text-sm font-semibold">{title}</h2>
        <p className="text-muted-foreground text-xs">
          {description}
          {desktopOnly ? ' Desktop only: drawn at desktop width, scroll sideways on a phone.' : ''}
        </p>
      </div>
      <div className={desktopOnly ? 'overflow-x-auto' : undefined}>
        <div
          className={cn(
            'bg-muted/30 relative h-[34rem] overflow-hidden rounded-2xl border',
            desktopOnly && 'min-w-[48rem]'
          )}
        >
          {children}
        </div>
      </div>
    </section>
  )
}

export default function BimViewportDevPage(): JSX.Element {
  const [cut, setCut] = useState<number | null>(1)
  const [xray, setXray] = useState(false)
  const [railOpen, setRailOpen] = useState(true)
  const [storey, setStorey] = useState<string | null>('Erdgeschoss')
  // Starts pressed: the state that had no drawing at all is the one worth
  // capturing, and one click shows the other.
  const [isolated, setIsolated] = useState(true)

  if (process.env.NODE_ENV !== 'development') {
    notFound()
  }

  return (
    <main className="mx-auto flex max-w-4xl flex-col gap-6 p-4 sm:p-8" data-testid="bim-viewport-preview">
      <div>
        <h1 className="text-lg font-semibold">Model — viewer chrome</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          A handful of controls and two lists, floating over the building. Everything analytical
          is one button away rather than in front of the model, and the selection card does not
          exist until something is selected. The leading pill holds the two ways back — Undo, one
          act at a time, and the camera — and the trailing one the reset that drops every hide and
          isolation at once.
        </p>
      </div>

      <Stage
        title="The stage (desktop arrangement)"
        desktopOnly
        description="Rail on the left, dock at the bottom, nothing in the middle. Interactive."
      >
        {railOpen && (
          <div className="absolute top-4 left-4 z-20 flex max-h-[calc(100%-2rem)]">
            <ViewerRail>
              <ViewerRailSection label="Modelle">
                <ViewerRailItem label="Haus-A_v3" selected />
                <ViewerRailItem label="Haus-A_v2" />
                <ViewerRailItem label="Nebengebäude" meta="wird gelesen" disabled />
              </ViewerRailSection>
              <ViewerRailSection label="Geschoße">
                <ViewerRailItem
                  label="Alle Geschoße"
                  selected={storey === null}
                  onClick={() => setStorey(null)}
                />
                <ViewerRailItem
                  label="Dachgeschoss"
                  meta="+6.25 m"
                  ariaLabel="Dachgeschoss"
                  selected={storey === 'Dachgeschoss'}
                  onClick={() => setStorey('Dachgeschoss')}
                />
                <ViewerRailItem
                  label="Erdgeschoss"
                  meta="±0.00 m"
                  ariaLabel="Erdgeschoss"
                  selected={storey === 'Erdgeschoss'}
                  onClick={() => setStorey('Erdgeschoss')}
                />
                <ViewerRailItem
                  label="Keller"
                  meta="−2.80 m"
                  ariaLabel="Keller"
                  selected={storey === 'Keller'}
                  onClick={() => setStorey('Keller')}
                />
              </ViewerRailSection>
            </ViewerRail>
          </div>
        )}

        <ViewerDock
          /*
            The pair that answers "get me back", and the preview was missing
            half of it — with the other half under a name the product had
            already dropped. "Alles anzeigen" is what the camera button used
            to be called, until it collided with the restore button beside it
            and a screen reader read out two near-identical names for two
            unrelated acts.
          */
          lead={
            <>
              <ViewerIconButton label="Letzte Änderung rückgängig machen" icon={Undo2} />
              <ViewerIconButton label="Ganzes Modell einpassen" icon={Home} />
            </>
          }
          above={
            cut !== null && (
              <ViewerSlider
                label="Schnitthöhe"
                min={CUT_RANGE.minMetres}
                max={CUT_RANGE.maxMetres}
                value={cut}
                display={`${cut.toFixed(2)} m`}
                onChange={setCut}
                action={
                  <Button type="button" size="sm" variant="ghost" className="h-7 px-2 text-xs">
                    Blick nach unten
                  </Button>
                }
              />
            )
          }
          trail={
            <>
              {/*
                The reset. In the stage it appears only once something is out
                of the way; here it is always drawn, because the point of this
                route is to pin the chrome and its copy — and this is the one
                control whose name has to stay clearly apart from both Undo
                and the camera's "Ganzes Modell einpassen".
              */}
              <ViewerIconButton label="Alle Bauteile wieder einblenden" icon={Layers} />
              <ViewerIconButton
                label="Leiste ausblenden"
                icon={PanelLeft}
                active={railOpen}
                onClick={() => setRailOpen((open) => !open)}
              />
              <ViewerIconButton label="Details & Prüfung" icon={SlidersHorizontal} />
            </>
          }
        >
          <ViewerIconButton label="Ansicht" icon={Video} />
          <ViewerDockSeparator />
          <ViewerIconButton
            label="Schnitt"
            icon={Scissors}
            active={cut !== null}
            onClick={() => setCut((current) => (current === null ? 1 : null))}
          />
          <ViewerIconButton
            label="Durchsichtig"
            icon={Eye}
            active={xray}
            onClick={() => setXray((on) => !on)}
          />
        </ViewerDock>
      </Stage>

      <Stage
        title="Something is selected"
        desktopOnly
        description="The only time metadata is on screen at all — and it leads with the noun, not the schema."
      >
        <div className="absolute top-4 right-4 z-20 flex max-h-[calc(100%-2rem)]">
          <ViewerPanel
            title="AW 38"
            subtitle="Wall · Erdgeschoss"
            closeLabel="Schließen"
            onClose={() => {}}
            footer={
              <Button variant="ghost" size="sm" className="w-full justify-start">
                Piloti dazu fragen
              </Button>
            }
          >
            <ViewerFieldGroup label="Bauteil">
              <ViewerField label="Typ">Wall</ViewerField>
              <ViewerField label="Geschoss">Erdgeschoss</ViewerField>
              <ViewerField label="Materialien">Stahlbeton, Mineralwolle</ViewerField>
            </ViewerFieldGroup>
            <ViewerFieldGroup label="Qto_WallBaseQuantities">
              <ViewerField label="NetSideArea">18,44</ViewerField>
              <ViewerField label="Width">0,38</ViewerField>
            </ViewerFieldGroup>
          </ViewerPanel>
        </div>
      </Stage>

      {/*
        The real card, not the atoms above it, because the thing being pinned
        here is a STATE and a state that only the component knows how to draw.
        Isolieren is the one control on the card that stays put after it is
        pressed — hiding takes its own card away with it — so it is the one
        that has to look different afterwards. It used to look identical,
        which is how "nothing else is on screen any more" arrived with no
        indication of what had done it or what would take it back.
      */}
      <Stage
        title="Isolieren is a toggle"
        desktopOnly
        description="Pressed: everything else is off. The same press puts the building back. Interactive."
      >
        {/*
          Pinned to German, like every other string on this page. The card
          reads its copy from the dictionary rather than from props, and
          without a provider it would fall back to English — half a preview in
          the wrong language, which is exactly the kind of thing these
          captures exist to catch.
        */}
        <I18nProvider initialLocale="de" fixedLocale>
          <div className="absolute top-4 right-4 z-20 flex max-h-[calc(100%-2rem)]">
            <ModelInspector
              element={SELECTED_WALL}
              isLoading={false}
              error={null}
              projectId="p-preview"
              modelFilename="Haus-A_v3.ifc"
              onClose={() => {}}
              onHide={() => {}}
              isolated={isolated}
              onIsolate={() => setIsolated((on) => !on)}
            />
          </div>
        </I18nProvider>
      </Stage>

      <Stage
        title="Loading"
        description="A real percentage while the file downloads; no claimed position while it is parsed."
      >
        <ViewerProgress label="Modell wird geladen…" percent={62} />
      </Stage>

      <Stage title="Building geometry" description="No number, because there is no honest one.">
        <ViewerProgress label="Gebäude wird aufgebaut…" percent={null} />
      </Stage>

      <section className="space-y-2">
        <div>
          <h2 className="text-sm font-semibold">Phone — portrait</h2>
          <p className="text-muted-foreground text-xs">
            The same stage on a 393 px phone: six labelled tools that fit, and the selection as a
            sheet with a peek size, so the building stays above it. Tap the sheet header to open it;
            Mehr and Geschoße each put their own sheet in the same seat. Interactive.
          </p>
        </div>
        <I18nProvider initialLocale="de" fixedLocale>
          <PhonePortraitDemo />
        </I18nProvider>
      </section>

      <section className="space-y-2">
        <div>
          <h2 className="text-sm font-semibold">Phone — landscape</h2>
          <p className="text-muted-foreground text-xs">
            852 × 393, drawn at 46 %. The tools become a column on the left edge, the selection a
            narrow panel on the right, and the building keeps the middle.
          </p>
        </div>
        <div className="h-[181px] w-[393px] max-w-full overflow-hidden rounded-2xl border">
          <div className="h-[393px] w-[852px] origin-top-left scale-[0.461]">
            <I18nProvider initialLocale="de" fixedLocale>
              <PhoneLandscapeDemo />
            </I18nProvider>
          </div>
        </div>
      </section>
    </main>
  )
}

/** Fixed stand-ins for the stage's own state: the preview pins the chrome, not the logic. */
function usePhoneToolState() {
  const [sheet, setSheet] = useState<'levels' | 'more' | null>(null)
  const [cameraView, setCameraView] = useState<BimCameraView>('iso')
  const [section, setSection] = useState(false)
  const [measuring, setMeasuring] = useState(false)
  return { sheet, setSheet, cameraView, setCameraView, section, setSection, measuring, setMeasuring }
}

function PhoneMoreDemo(): JSX.Element {
  return (
    <PhoneMoreRows
      ready
      canUndo
      onUndo={() => {}}
      onCapture={() => {}}
      captureFailed={false}
      xray={false}
      xrayHint="Zuerst ein Bauteil auswählen"
      xrayDisabled={false}
      onToggleXray={() => {}}
      edited
      onShowEverything={() => {}}
      advancedDisabled={false}
      onOpenAdvanced={() => {}}
    />
  )
}

function PhoneLevelsDemo(): JSX.Element {
  return (
    <>
      <ViewerRailSection label="Geschoße">
        <ViewerRailItem label="Alle Geschoße" selected />
        <ViewerRailItem label="Dachgeschoss" meta="+6,25 m" ariaLabel="Dachgeschoss" />
        <ViewerRailItem label="Erdgeschoss" meta="±0,00 m" ariaLabel="Erdgeschoss" />
        <ViewerRailItem label="Keller" meta="−2,80 m" ariaLabel="Keller" />
      </ViewerRailSection>
    </>
  )
}

function PhonePortraitDemo(): JSX.Element {
  const state = usePhoneToolState()
  const [snap, setSnap] = useState<ViewerSheetSnap>('peek')
  const [selected, setSelected] = useState(true)
  const [cut, setCut] = useState<number | null>(null)

  const sheet =
    state.sheet === 'more' ? (
      <ViewerSheet title="Weitere Werkzeuge" closeLabel="Schließen" onClose={() => state.setSheet(null)} bodyClassName="p-0">
        <PhoneMoreDemo />
      </ViewerSheet>
    ) : state.sheet === 'levels' ? (
      <ViewerSheet title="Geschoße" closeLabel="Schließen" onClose={() => state.setSheet(null)} bodyClassName="p-0">
        <PhoneLevelsDemo />
      </ViewerSheet>
    ) : selected ? (
      <ModelInspector
        element={PHONE_WALL}
        isLoading={false}
        error={null}
        projectId="p-preview"
        modelFilename="Haus-A_v3.ifc"
        onClose={() => setSelected(false)}
        onHide={() => {}}
        onIsolate={() => {}}
        sheet={{
          placement: 'bottom',
          collapse: {
            snap,
            onSnapChange: setSnap,
            expandLabel: 'Details einblenden',
            collapseLabel: 'Details ausblenden',
          },
        }}
      />
    ) : null

  return (
    <div
      data-testid="bim-phone-portrait"
      className="bg-muted/30 relative mx-auto h-[44rem] w-full max-w-[393px] overflow-hidden rounded-3xl border"
    >
      <ViewerDock
        layout="bar"
        sheet={sheet}
        above={
          cut !== null ? (
            <ViewerSlider
              label="Schnitthöhe"
              min={CUT_RANGE.minMetres}
              max={CUT_RANGE.maxMetres}
              value={cut}
              display={`${cut.toFixed(2)} m`}
              onChange={setCut}
            />
          ) : null
        }
      >
        <PhoneTools
          placement="bar"
          ready
          onFit={() => {}}
          cameraView={state.cameraView}
          orthographic={false}
          onViewChange={state.setCameraView}
          onOrthographicChange={() => {}}
          sectionOn={cut !== null}
          onToggleSection={() => setCut((current) => (current === null ? 1 : null))}
          measuring={state.measuring}
          onToggleMeasure={() => state.setMeasuring((on) => !on)}
          hasLevels
          sheet={state.sheet}
          onToggleSheet={(next) => state.setSheet((current) => (current === next ? null : next))}
          edited
        />
      </ViewerDock>
    </div>
  )
}

function PhoneLandscapeDemo(): JSX.Element {
  const state = usePhoneToolState()
  return (
    <div className="bg-muted/30 relative size-full overflow-hidden pt-0">
      <ViewerDock layout="side">
        <PhoneTools
          placement="side"
          ready
          onFit={() => {}}
          cameraView={state.cameraView}
          orthographic={false}
          onViewChange={state.setCameraView}
          onOrthographicChange={() => {}}
          sectionOn={false}
          onToggleSection={() => {}}
          measuring={false}
          onToggleMeasure={() => {}}
          hasLevels
          sheet={state.sheet}
          onToggleSheet={() => {}}
          edited={false}
        />
      </ViewerDock>
      <div className="absolute top-3 right-3 bottom-3 z-20 flex">
        <ModelInspector
          element={PHONE_WALL}
          isLoading={false}
          error={null}
          projectId="p-preview"
          modelFilename="Haus-A_v3.ifc"
          onClose={() => {}}
          onHide={() => {}}
          onIsolate={() => {}}
          sheet={{
            placement: 'side',
            collapse: { snap: 'full', onSnapChange: () => {}, expandLabel: '', collapseLabel: '' },
          }}
        />
      </div>
    </div>
  )
}
