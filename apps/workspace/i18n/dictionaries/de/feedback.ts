import type { en } from '../en'

/** Produkt-Feedback: das Formular in der App und Plattform → Feedback. */
export const feedback: typeof en.feedback = {
  open: 'Feedback senden',
  openHint: 'Fehler melden oder Idee teilen',
  dialog: {
    title: 'Sagen Sie uns Ihre Meinung',
    description:
      'Ihre Nachricht geht direkt an das Team, das {productName} baut. Jede Meldung wird gelesen.',
    kindLabel: 'Worum geht es?',
    messageLabel: 'Ihre Nachricht',
    counter: '{count} / {max}',
    tooShort: 'Bitte noch ein paar Worte mehr – mindestens {min} Zeichen.',
    context: {
      summary: 'Wird automatisch mitgeschickt',
      page: 'Seite',
      browser: 'Browser',
      screen: 'Bildschirm',
      locale: 'Sprache',
      timeZone: 'Zeitzone',
      none: '–',
    },
    allowContact: 'Sie dürfen mich dazu kontaktieren',
    allowContactHint: 'Wir antworten an {email}, wenn wir eine Rückfrage oder Neuigkeiten haben.',
    cancel: 'Abbrechen',
    send: 'Feedback senden',
    sending: 'Wird gesendet …',
    shortcut: 'zum Senden',
    error: 'Ihr Feedback konnte nicht gesendet werden. Bitte versuchen Sie es erneut.',
    rateLimited:
      'Sie haben in der letzten Stunde schon viel Feedback gesendet. Bitte versuchen Sie es später erneut.',
  },
  kinds: {
    bug: {
      label: 'Fehler',
      hint: 'Etwas funktioniert nicht',
      placeholder: 'Was haben Sie gemacht, was ist passiert und was hätten Sie erwartet?',
    },
    idea: {
      label: 'Idee',
      hint: 'Etwas fehlt',
      placeholder: 'Was würde Ihnen die Arbeit erleichtern? Beschreiben Sie die Situation.',
    },
    praise: {
      label: 'Lob',
      hint: 'Etwas gefällt',
      placeholder: 'Was gefällt Ihnen? Wir hören es gern.',
    },
    question: {
      label: 'Frage',
      hint: 'Etwas ist unklar',
      placeholder: 'Was möchten Sie wissen?',
    },
  },
  /** Die Ticketstatus von PostHog Support, Schlüssel unverändert. */
  statuses: {
    new: 'Neu',
    open: 'Offen',
    pending: 'Wartet auf Antwort',
    on_hold: 'Pausiert',
    resolved: 'Erledigt',
  },
  /** Die eigenen Meldungen: was gesendet wurde und was das Team geantwortet hat. */
  threads: {
    open: 'Mein Feedback',
    title: 'Mein Feedback',
    description: 'Was Sie gemeldet haben und was das {productName}-Team antwortet. Sie können direkt hier zurückschreiben.',
    newCount: '{count} neu',
    empty: {
      title: 'Noch kein Feedback',
      description: 'Sobald Sie Feedback senden, erscheint hier Ihr Chat mit dem Team.',
    },
    send: 'Feedback senden',
    new: 'Neues Feedback',
    pick: {
      title: 'Meldung auswählen',
      description: 'Wählen Sie links eine Meldung, um den Chat mit dem Team zu lesen, oder senden Sie neues Feedback.',
    },
    sent: 'Vielen Dank! Ihr Feedback ist beim {productName}-Team angekommen. Die Antwort erscheint hier.',
    loadError: 'Ihr Feedback konnte nicht geladen werden.',
    threadLoadError: 'Dieser Chat konnte nicht geladen werden.',
    retry: 'Erneut versuchen',
    loadMore: 'Mehr laden',
    loadingMore: 'Wird geladen …',
    loadMoreFailed: 'Konnte nicht mehr laden. Erneut versuchen',
    back: 'Alle Meldungen',
    hasUpdate: 'Neu',
    me: 'Sie',
    team: '{productName}-Team',
    teamMember: '{name}, {productName}-Team',
    notLive: 'Die Antworten des Teams können gerade nicht geladen werden. Ihre Meldung ist angekommen und sicher.',
    cannotReply: 'Auf diese Meldung kann hier nicht geantwortet werden. Senden Sie neues Feedback, um den Chat fortzusetzen.',
    waiting: 'Das Team hat noch nicht geantwortet. Die Antwort erscheint hier.',
    replyPlaceholder: 'Antwort schreiben …',
    replySend: 'Senden',
    replyError: 'Ihre Antwort konnte nicht gesendet werden. Bitte versuchen Sie es erneut.',
    replyRateLimited: 'Sie haben in der letzten Stunde schon viele Antworten gesendet. Bitte versuchen Sie es später erneut.',
    /** Der Punkt auf dem Avatar und auf „Mehr“, für Screenreader. */
    newsDot: 'Neue Antworten auf Ihr Feedback',
    /** Umschalter über der Liste, nur für Büro-Admins. */
    scopeLabel: 'Ansicht',
    scope: {
      mine: 'Meine',
      office: 'Unser Büro',
    },
    officeTitle: 'Feedback unseres Büros',
    officeDescription: 'Alle Meldungen aus Ihrem Büro und wo sie stehen. Antworten kann nur, wer gemeldet hat.',
    officeEmpty: {
      title: 'Noch kein Feedback aus Ihrem Büro',
      description: 'Sobald jemand aus Ihrem Büro Feedback sendet, steht es hier.',
    },
    officeLoadError: 'Das Feedback Ihres Büros konnte nicht geladen werden.',
    /** Die zwei Gruppen der Liste: offene Fälle zuerst. */
    groups: {
      active: 'Aktiv',
      done: 'Erledigt',
    },
    /** Die Nummer, unter der das Team den Fall führt. */
    ticketNumber: 'Nr. {number}',
    /** Vor einer relativen Zeit: „Aktualisiert vor 3 Stunden“. */
    updated: 'Aktualisiert',
    unknownReporter: 'Unbekannt',
    readOnly: 'Nur {name} kann auf diese Meldung antworten.',
    readOnlyUnnamed: 'Nur die Person, die gemeldet hat, kann hier antworten.',
    /** Der Stand eines Falls, in einfachen Worten, aus Sicht der Person, die gemeldet hat. */
    statuses: {
      new: 'Eingegangen',
      open: 'In Bearbeitung',
      pending: 'Wartet auf Sie',
      on_hold: 'Pausiert',
      resolved: 'Erledigt',
      /** Ohne lesbares Ticket: gesendet, aber kein Stand bekannt. */
      unknown: 'Gesendet',
    },
    /** Derselbe Stand in der Büroansicht, wo „Sie“ die falsche Person wäre. */
    officeStatuses: {
      pending: 'Wartet auf Rückmeldung',
    },
  },
  platform: {
    filters: {
      label: 'Nach Status filtern',
      active: 'Aktiv',
      all: 'Alle',
      kindLabel: 'Art',
      allKinds: 'Alle Arten',
      assigneeLabel: 'Nach Zuständigkeit filtern',
      assignees: {
        all: 'Alle Personen',
        mine: 'Meine',
        unassigned: 'Nicht zugewiesen',
      },
    },
    case: {
      unassigned: 'Nicht zugewiesen',
      assignedToYou: 'Ihnen zugewiesen',
      assignedTo: 'Bei {name}',
      unnamedAssignee: 'jemandem im Team',
      lastActivity: 'Zuletzt aktiv',
      awaiting: {
        team: 'Unsere Antwort fehlt',
        reporter: 'Wartet auf Rückmeldung',
      },
      claim: 'Übernehmen',
    },
    viewerNotInPosthog: {
      title: 'Ihnen ist in PostHog nichts zugewiesen.',
      description:
        'Niemand in PostHog hat Ihre {productName}-E-Mail. Melden Sie sich mit derselben Adresse bei PostHog an, dann erscheinen Ihre Tickets hier.',
    },
    openInPosthog: 'In PostHog öffnen',
    empty: {
      title: 'Hier ist kein Feedback',
      description: 'Sobald ein Mitglied Feedback sendet, erscheint es hier und in Ihrem Postfach.',
    },
    loadError: 'Das Feedback konnte nicht geladen werden.',
    retry: 'Erneut versuchen',
    loadMore: 'Mehr laden',
    from: '{name} · {organization}',
    unknownReporter: 'Unbekanntes Mitglied',
    unknownOrganization: 'Unbekannte Organisation',
    onPage: 'auf {page}',
    contact: 'Per E-Mail antworten',
    noContact: 'Möchte nicht kontaktiert werden',
    claimed: 'Ticket #{number} ist Ihnen jetzt in PostHog zugewiesen.',
    claimedUnnumbered: 'Das Ticket ist Ihnen jetzt in PostHog zugewiesen.',
    claimError: 'Das Ticket konnte Ihnen nicht zugewiesen werden. Ist Ihre {productName}-E-Mail auch Ihr PostHog-Login?',
    statusLabel: 'Status',
    triaged: 'Auf „{status}“ gesetzt.',
    triageError: 'Der Status konnte nicht geändert werden.',
    details: 'Browserdetails',
    listTitle: 'Meldungen',
    linked: 'Aus dem Postfach',
    recordingsLink: 'Aufzeichnungen in PostHog',
    localSource: {
      title: 'PostHog Support kann gerade nicht gelesen werden.',
      description:
        'Entweder ist es hier nicht eingerichtet oder PostHog ist nicht erreichbar. Dies ist das lokale Protokoll aller Meldungen, neueste zuerst; den Status verwalten Sie in PostHog.',
    },
    unticketed: {
      title: 'Noch nicht in PostHog',
      description: 'Für diese Meldungen konnte kein Ticket angelegt werden. Sie bleiben hier, damit keine verloren geht.',
    },
    focusMissing: {
      title: 'Die verlinkte Meldung wurde nicht gefunden.',
      description: 'Sie wurde gelöscht oder ist für Sie nicht sichtbar. Die übrigen Meldungen stehen unten.',
    },
  },
}
