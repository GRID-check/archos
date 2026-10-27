import type { en } from '../en'

/**
 * mailThread namespace: der E-Mail-Verlauf, eine Korrespondenz als ein
 * Dokument (ADR-0134). Der Reiter „E-Mails“, das Folgen und das Herauslösen
 * (D16) ergänzen ihn; die festen Codelisten aus `lib/mail-thread` werden hier
 * formuliert, damit jede Fläche sie gleich sagt.
 *
 * Die Worte der Darstellung selbst (Abschnittsüberschriften, „eingegangen …“,
 * „Zitat in der Nachricht von …“) stehen NICHT hier, sondern versioniert in
 * `lib/mail-thread/render-copy.ts`: eine Änderung schriebe jeden Abschnitt neu.
 */
export const mailThread: typeof en.mailThread = {
  followIneligible: {
    no_active_follow: 'Niemand folgt diesem E-Mail-Verlauf',
    sender_not_verified: 'Die Domain des Absenders ist nicht bestätigt',
    match_not_reference: 'Die E-Mail verweist auf keine E-Mail dieses E-Mail-Verlaufs',
    header_not_signed: 'Der Verweis auf den E-Mail-Verlauf ist nicht von der Domain signiert',
    flagged: 'Die E-Mail ist an andere adressiert, oder ihr Datum ist nicht plausibel',
    automatic: 'Die E-Mail wurde automatisch gesendet',
    new_participant_domain: 'Neue Beteiligte: {domains}',
    name_stop: 'Die Namensprüfung hat den Betreff angehalten',
    content_finding: 'Die Inhaltsprüfung hat im Text etwas gefunden',
  },
  followEnd: {
    unfollowed: 'Sie folgen nicht mehr',
    expired: 'Das Folgen ist abgelaufen',
    access_lost: 'Der Zugriff auf den E-Mail-Verlauf ist weggefallen',
    address_rotated: 'Die E-Mail-Adresse des Projekts wurde ersetzt',
    detached: 'Eine E-Mail wurde aus dem E-Mail-Verlauf herausgelöst',
    document_gone: 'Der E-Mail-Verlauf wurde gelöscht',
    revoked_by_manager: 'Von der Projektverwaltung beendet',
  },

  /** Der Reiter „E-Mails“ in der Vorschau eines E-Mail-Verlaufs (D16). */
  tab: {
    label: 'E-Mails',
    views: 'Ansicht',
    timeline: 'E-Mails in diesem E-Mail-Verlauf',
    count: '{count, plural, one {# E-Mail} other {# E-Mails}}',
    loadFailed: 'Die E-Mails dieses E-Mail-Verlaufs ließen sich nicht laden.',
    retry: 'Erneut versuchen',
    empty: 'Dieser E-Mail-Verlauf enthält keine E-Mail, die Sie sehen dürfen.',
    waiting:
      '{count, plural, one {# E-Mail dieses E-Mail-Verlaufs wartet} other {# E-Mails dieses E-Mail-Verlaufs warten}} im E-Mail-Eingang',
    waitingOpen: 'Ansehen',
  },
  /** Eine abgelegte E-Mail im Reiter. */
  entry: {
    fromRevision: 'ab Fassung {number}',
    received: 'eingegangen {time}',
    trust: {
      verified: 'Domain bestätigt: {domain}',
      verifiedNoDomain: 'Domain bestätigt',
      unverified: 'Domain nicht bestätigt',
      notChecked: 'Aus dem E-Mail-Archiv · nicht geprüft',
    },
    /** Wie sie abgelegt wurde, nur genannt, wo nicht eine Person in der App entschieden hat. */
    filedVia: {
      agent: 'Von einem Agenten im Namen einer Person abgelegt',
      piloti_proposal: 'Auf Vorschlag von Piloti abgelegt',
      follow: 'Angefügt, weil jemand diesem E-Mail-Verlauf folgt',
      archive_import: 'Aus dem E-Mail-Archiv übernommen',
    },
    compare: 'Vergleichen',
    compareLabel: 'Fassung {from} mit Fassung {to} vergleichen',
    comparing: 'Wird verglichen …',
    compareFailed: 'Der Vergleich hat nicht geklappt.',
    compareClose: 'Vergleich schließen',
    menu: 'Mehr zur E-Mail vom {heading}',
    detach: 'Herauslösen …',
  },
  /** Was mit einer E-Mail kam (D36). */
  attachments: {
    label: 'Anhänge',
    hidden: 'Ein Anhang in einem Ordner, den Sie nicht sehen',
    unnamed: 'Anhang {position}',
    alreadyPresent: 'lag schon im Projekt',
    notFiled: 'nicht abgelegt · {reason}',
    inOriginal: 'im Original enthalten',
    reasons: {
      pending: 'wartet im E-Mail-Eingang',
      dismissed: 'verworfen',
      expired: 'abgelaufen',
      infected: 'enthält Schadsoftware',
      scan_failed: 'Prüfung auf Schadsoftware fehlgeschlagen',
      type_not_accepted: 'Dateityp wird in diesem Büro nicht abgelegt',
      encrypted: 'verschlüsselt',
      archive: 'Archivdatei, nicht entpackt',
      size: 'zu groß',
      limit: 'zu viele Anhänge',
      empty: 'leer',
      screened: 'von der Inhaltsprüfung zurückgehalten',
      access: 'kein Zugriff auf den Ordner',
      name_taken: 'Name schon vergeben',
      unreadable: 'nicht lesbar',
    },
  },
  /** Das Original (`.eml`) einer abgelegten E-Mail, als Beleg aufbewahrt. */
  original: {
    download: 'Original (.eml)',
    downloading: 'Wird geprüft …',
    hint: 'Öffnet sich im Mailprogramm; Bilder von außen werden dort geladen.',
    notClean: 'Das Original enthält Schadsoftware und kann nicht heruntergeladen werden',
    scanning: 'Das Original wird auf Schadsoftware geprüft',
    gone: 'Kein Original: aus dem E-Mail-Archiv übernommen',
    failed: 'Das Herunterladen hat nicht geklappt. Bitte erneut versuchen.',
  },
  /** „Verlauf folgen“ im Reiter: das eigene Folgen, und für die Projektverwaltung das aller. */
  follow: {
    offer: 'Diesem E-Mail-Verlauf folgen',
    start: 'Folgen',
    explain:
      'Antworten von bestätigten Domains, die schon im E-Mail-Verlauf schreiben, werden ohne Klick angefügt. Anhänge warten weiter im E-Mail-Eingang.',
    following: 'Sie folgen diesem E-Mail-Verlauf bis {date}',
    followingUndated: 'Sie folgen diesem E-Mail-Verlauf',
    renew: 'Verlängern',
    renewLabel: 'Folgen verlängern bis {date}',
    renewLimit: 'Folgen gilt höchstens 180 Tage ab Beginn. Danach erneut folgen.',
    unfollow: 'Nicht mehr folgen',
    followed: 'Sie folgen „{name}“ bis {date}',
    renewed: 'Verlängert bis {date}',
    unfollowed: 'Sie folgen „{name}“ nicht mehr',
    undo: 'Rückgängig',
    others: '{count, plural, one {# weitere Person folgt} other {# weitere Personen folgen}}',
    followers: 'Wer folgt',
    follower: 'bis {date}',
    someone: 'Ein Projektmitglied',
    end: 'Beenden',
    endLabel: 'Folgen von {name} beenden',
    ended: 'Folgen von {name} beendet',
    failed: 'Das hat nicht geklappt. Bitte erneut versuchen.',
    closed: 'Das Projekt ist abgeschlossen. Wieder öffnen, um zu folgen.',
  },
  /** „Herauslösen …“: eine E-Mail, die im falschen E-Mail-Verlauf liegt (D34). */
  detach: {
    title: 'E-Mail herauslösen?',
    description: 'Die E-Mail vom {heading} kommt in einen anderen E-Mail-Verlauf.',
    keeps: 'Fassung {first} bis {last} behalten diese E-Mail. Dieser E-Mail-Verlauf bekommt Fassung {next} ohne sie.',
    keepsOne: 'Fassung {first} behält diese E-Mail. Dieser E-Mail-Verlauf bekommt Fassung {next} ohne sie.',
    followsEnd: 'Wer diesem E-Mail-Verlauf folgt, folgt ihm danach nicht mehr.',
    target: 'Wohin',
    toExisting: 'In einen anderen E-Mail-Verlauf',
    existing: 'E-Mail-Verlauf',
    choose: 'E-Mail-Verlauf wählen',
    noOther: 'Im Projekt gibt es keinen anderen E-Mail-Verlauf, den Sie sehen.',
    loadingTargets: 'E-Mail-Verläufe werden geladen …',
    toNew: 'Als neuen E-Mail-Verlauf',
    name: 'Name',
    nameHint: 'Im selben Ordner wie dieser E-Mail-Verlauf.',
    confirm: 'Herauslösen',
    cancel: 'Abbrechen',
    done: 'E-Mail in „{name}“ verschoben',
    doneNew: 'E-Mail in einen neuen E-Mail-Verlauf verschoben',
    followsEnded: '{count, plural, one {# Folgen beendet} other {# Folgen beendet}}',
    open: 'Öffnen',
  },
  /** Warum ein Schreiben in einen E-Mail-Verlauf abgelehnt wurde (`MAIL_THREAD_REFUSALS`, und Folgen im abgeschlossenen Projekt). */
  refusals: {
    last_entry: 'Das ist die einzige E-Mail dieses E-Mail-Verlaufs. Löschen Sie stattdessen das Dokument.',
    busy: 'Gerade wird eine E-Mail in diesen E-Mail-Verlauf abgelegt. Bitte gleich noch einmal versuchen.',
    target_unknown: 'Den gewählten E-Mail-Verlauf oder Ordner gibt es nicht mehr, oder Sie dürfen dort nicht ablegen.',
    thread_full: 'Der gewählte E-Mail-Verlauf ist voll.',
    name_stop: 'Die Namensprüfung hat diesen Namen angehalten. Bitte einen anderen wählen.',
    name_taken: 'Ein Dokument dieses Namens liegt schon im Projekt.',
    upload_refused: 'Die neue Fassung ließ sich nicht hochladen.',
    gone: 'Die E-Mail ist nicht mehr da.',
    original_not_clean: 'Das Original hat die Prüfung auf Schadsoftware nicht bestanden und lässt sich nicht herunterladen.',
    project_closed: 'Das Projekt ist abgeschlossen. Bitte zuerst wieder öffnen.',
    unknown: 'Das hat nicht geklappt. Bitte erneut versuchen.',
  },
  /** Woher eine Fassung kam (D36): die Zeile unter dem Kopf eines Dokuments, das eine E-Mail brachte, und eine Zeile seiner Fassungen. */
  provenance: {
    label: 'Herkunft',
    cameWith: 'Kam mit der E-Mail von {name} am {date}',
    cameWithAnonymous: 'Kam mit einer E-Mail am {date}',
    open: 'Im E-Mail-Verlauf ansehen',
    openLabel: 'E-Mail vom {date} im E-Mail-Verlauf ansehen',
    openFailed: 'Der E-Mail-Verlauf lässt sich nicht öffnen. Vielleicht sehen Sie ihn nicht mehr.',
    more: '+{count} weitere',
  },
}
