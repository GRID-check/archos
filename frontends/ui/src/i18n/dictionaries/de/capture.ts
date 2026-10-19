import type { en } from '../en'

/**
 * Erfassen, wo man gerade steht: das Anhängen-Menü des Eingabefelds, Fotos aus
 * Kamera und Mediathek, und die sichtbaren Zustände der Spracheingabe.
 */
export const capture: typeof en.capture = {
  attach: {
    menuLabel: 'Zu diesem Chat hinzufügen',
    takePhoto: 'Foto aufnehmen',
    takePhotoHint: 'Öffnet die Kamera',
    photoLibrary: 'Aus Mediathek',
    photoLibraryHint: 'Fotos auf diesem Gerät',
    chooseFile: 'Datei auswählen',
    chooseFileHint: 'PDF, Office und weitere',
    destinationChat: 'Landet nur in diesem Chat. Für die Projektdateien unter „Dateien“ hochladen.',
  },
  photos: {
    fileNamePrefix: 'Foto',
    unavailableVision:
      'Fotos gehen hier noch nicht: Piloti braucht ein Bildmodell, um sie zu lesen, und für Ihr Büro ist keins eingerichtet.',
    unavailableNotEnabled: 'Fotos sind für Ihr Büro noch nicht freigeschaltet.',
    heicUnconvertible:
      '„{name}“ ist ein HEIC-Foto, das dieser Browser nicht in JPEG umwandeln kann. Über „Aus Mediathek“ gewählt, kommt es als JPEG an.',
    folderDestination: 'Landet im Ordner, in dem Sie gerade sind.',
  },
  dictation: {
    recording: 'Aufnahme läuft',
    tapToInsert: 'Tippen zum Einfügen',
    elapsedOfLimit: '{elapsed} von {limit}',
    transcribing: 'Wird verschriftlicht …',
    dismiss: 'Ausblenden',
  },
}
