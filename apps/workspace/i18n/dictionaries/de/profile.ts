import type { en } from '../en'

/** The profile / account settings page. */
export const profile: typeof en.profile = {
  title: 'Profil',
  subtitle: 'Verwalten Sie Ihr Konto, das Erscheinungsbild und Ihre Spracheinstellungen.',
  loading: 'Profil wird geladen…',
  backToApp: 'Zurück zu den Projekten',
  savedToast: 'Einstellungen gespeichert',
  saveError: 'Ihre Einstellungen konnten nicht gespeichert werden. Bitte versuchen Sie es erneut.',
  account: {
    title: 'Konto',
    description: 'Ihre Identität innerhalb von {productName}.',
    name: 'Name',
    email: 'E-Mail',
    organization: 'Organisation',
    role: 'Rolle',
    noName: 'Nicht festgelegt',
    noOrganization: 'Keine Organisation',
    roles: {
      'org-platform-owner': 'Plattform-Inhaber',
      admin: 'Administrator',
      member: 'Mitglied',
    },
  },
  appearance: {
    title: 'Erscheinungsbild',
    description: 'Wählen Sie, wie {productName} aussieht. „System“ folgt der Einstellung Ihres Geräts.',
    theme: 'Design',
  },
  language: {
    title: 'Sprache',
    description: 'Die in der {productName}-Oberfläche verwendete Sprache.',
    label: 'Sprache der Oberfläche',
  },
  reasoning: {
    title: 'Herleitung',
    description: 'Wie viel von {productName}s Denkweg in der Antwort gezeigt wird.',
    label: 'Technische Herleitung anzeigen',
    hint: 'Zeigt die einzelnen technischen Schritte (welcher Agent bzw. welches Werkzeug lief). Standardmäßig aus — normalerweise sehen Sie die verständliche Herleitung.',
  },
  viewerActions: {
    title: 'Stellen im Viewer',
    description:
      'Wenn eine Antwort auf einer Stelle in einem Dokument beruht, kann {productName} sie neben dem Chat öffnen, mit der Stelle markiert. Unter der Antwort steht, was geöffnet wurde, mit „Zurücknehmen“.',
    label: 'Automatisch öffnen',
    hint: 'Gilt für diesen Browser. Aus: {productName} schlägt die Stelle unter der Antwort nur vor.',
  },
  usageAnalytics: {
    title: 'Nutzungsanalyse',
    description:
      '{productName} misst, wie das Produkt genutzt wird (Seitenaufrufe, Klicks, Fehler und maskierte Bildschirmaufzeichnungen), um Probleme zu finden und zu beheben.',
    label: 'Nutzungsanalyse teilen',
    hint: 'Gilt für diesen Browser und wirkt sofort. Ausgeschaltet sendet dieser Browser nichts.',
  },
  security: {
    title: 'Sicherheit & Sitzungen',
    description: 'Wo Sie angemeldet sind und wie Ihr Konto geschützt ist.',
    currentSession: 'Aktuelle Sitzung',
    signedInAs: 'Angemeldet als {email}',
    thisDevice: 'Dieses Gerät',
    signOutEverywhere: 'Abmelden',
    managedByWorkos: 'Sitzungen und Sicherheitsfaktoren werden von WorkOS verwaltet.',
    unavailable: 'Sitzungsdetails sind nicht verfügbar, während die Authentifizierung deaktiviert ist.',
    activeSessions: 'Aktive Sitzungen',
    activeSessionsDescription: 'Geräte und Browser, die derzeit bei Ihrem Konto angemeldet sind. Melden Sie alle ab, die Sie nicht kennen.',
    securityFactors: 'Anmeldung & Sicherheit',
    securityFactorsDescription: 'Verwalten Sie Ihr Passwort und die Zwei-Faktor-Authentifizierung.',
    widgetError: 'Dieser Bereich konnte nicht geladen werden. Bitte laden Sie die Seite neu und versuchen Sie es erneut.',
  },
  connectAgent: {
    title: 'Agent verbinden',
    description:
      'Ihr eigener KI-Assistent (Claude, ChatGPT, Cursor und weitere MCP-fähige Clients) kann in {productName} für Sie arbeiten: alles, was Sie hier tun können, mit Ihren Rechten. Er fragt Sie, bevor er etwas ändert oder löscht, und {productName} gibt ihm nie mehr, als Sie selbst haben.',
    urlLabel: 'Adresse des MCP-Servers',
    urlHint: 'Tragen Sie diese Adresse in Ihrem Client ein. Sie melden sich mit Ihrem {productName}-Konto an.',
    urlCode: 'MCP-URL',
    notice: {
      orgDisabledTitle: 'Für Ihre Organisation noch nicht eingeschaltet',
      orgDisabledBody:
        'Der Agent-Zugang wird pro Organisation eingeschaltet. Sobald das geschehen ist, können Sie hier Ihren Assistenten verbinden.',
      orgDisabledAdmin:
        'Sie dürfen diese Organisation verwalten. Wenn Sie den Zugang einschalten lassen, kann jedes Mitglied seinen eigenen Assistenten verbinden, jeweils mit den eigenen Rechten. Für niemanden ändert sich etwas, solange niemand einen verbindet.',
      orgDisabledMember: 'Bitten Sie eine Administratorin oder einen Administrator Ihrer Organisation, ihn einzuschalten.',
      notConfiguredTitle: 'In dieser Installation nicht verfügbar',
      notConfiguredBody:
        'Die externe Anmeldung für Agenten ist in dieser {productName}-Installation noch nicht eingerichtet. Deshalb kann sich kein Assistent verbinden.',
      notConfiguredAdmin:
        'Zuerst muss der Betrieb dieser Installation sie einrichten. Danach gilt die Einstellung Ihrer Organisation.',
      notConfiguredMember: 'Fragen Sie eine Administratorin oder einen Administrator Ihrer Organisation.',
    },
    steps: {
      title: 'Client verbinden',
      signIn: '{productName} öffnet im Browser die gewohnte Anmeldung. Wählen Sie dort bei Bedarf Ihre Organisation.',
    },
    clients: {
      claude: {
        name: 'Claude',
        hint: 'claude.ai und Claude Desktop',
        s1: 'Öffnen Sie Einstellungen, dann Konnektoren.',
        s2: 'Wählen Sie „Benutzerdefinierten Konnektor hinzufügen“.',
        s3: 'Fügen Sie die Adresse von oben ein und nennen Sie ihn {productName}.',
        s4: 'Melden Sie sich mit Ihrem {productName}-Konto an, sobald sich der Browser öffnet.',
      },
      claudeCode: {
        name: 'Claude Code',
        hint: 'Im Terminal',
        s1: 'Fügen Sie den Server mit diesem Befehl hinzu:',
        s2: 'Starten Sie Claude Code, geben Sie /mcp ein und wählen Sie piloti.',
        s3: 'Melden Sie sich mit Ihrem {productName}-Konto an, sobald sich der Browser öffnet.',
      },
      cursor: {
        name: 'Cursor',
        hint: 'mcp.json',
        s1: 'Tragen Sie den Server in ~/.cursor/mcp.json ein (oder .cursor/mcp.json im Projekt):',
        s2: 'Cursor startet die Anmeldung, wenn es den Server zum ersten Mal nutzt.',
      },
      chatgpt: {
        name: 'ChatGPT',
        hint: 'Konnektoren',
        s1: 'Wo Ihr Tarif Konnektoren für MCP-Server anbietet (oft im Entwicklermodus), legen Sie einen neuen an.',
        s2: 'Fügen Sie die Adresse von oben ein und wählen Sie OAuth als Anmeldung.',
        s3: 'Melden Sie sich auf Nachfrage mit Ihrem {productName}-Konto an.',
      },
      other: {
        name: 'Andere Clients',
        hint: 'MCP-fähige Clients',
        s1: 'Jeder Client, der MCP über HTTP spricht und die Anmeldung per OAuth unterstützt, kann sich verbinden.',
        s2: 'Fügen Sie einen entfernten Server hinzu, tragen Sie die Adresse von oben ein und melden Sie sich mit Ihrem {productName}-Konto an.',
        s3: 'Ein Client ohne OAuth-Anmeldung kann sich noch nicht verbinden.',
      },
    },
    can: {
      title: 'Was Ihr Agent kann',
      intro: 'Alles, was Sie in {productName} tun können, im Rahmen Ihrer Rechte:',
      projects: 'Ihre Projekte öffnen und durchsuchen',
      documents: 'Dokumente lesen, hochladen, ablegen und teilen',
      shares: 'Fassungen zur Freigabe einreichen und freigeben',
      annotations: 'Anmerkungen lesen und schreiben',
      tasks: 'Aufgaben anlegen und bearbeiten',
      inbox: 'Ihr Postfach lesen und abarbeiten',
    },
    stays: {
      title: 'Was bei Ihnen bleibt',
      confirm: 'Alles, was etwas ändert oder löscht, bestätigen Sie zuerst im Client.',
      sensitive: 'Zugriffsänderungen und API-Schlüssel funktionieren erst, wenn Ihre Organisation sie freischaltet, und Ihr Agent fragt Sie immer zuerst.',
      rights: 'Ihr Agent bekommt nie mehr Rechte als Sie. Verlieren Sie den Zugang, verliert er ihn auch.',
    },
    guide: 'Zur ausführlichen Anleitung',
    guideHint: 'Je Client, was bei der Anmeldung passiert, Zugang widerrufen und Fehlersuche.',
  },
}
