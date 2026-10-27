/**
 * The copy of /e-mail-eingang/ (/en/project-mail/): the help page for project
 * mail (ADR-0137). Two readers land here: a member of an office that uses
 * Piloti, from „Anleitung“ in the address dialog, and somebody whose mail was
 * bounced, from the link in the bounce text (`shared/public-site.json`,
 * `mailInbox`). So it says plainly what happens to a mail sent to a project
 * address, and for which offices.
 *
 * Same rules as ui.ts: both locales, German typography, and only what the
 * product does. The `dkim` section keeps its id: the address dialog links to
 * `#dkim` (`frontends/ui/src/i18n/dictionaries/{de,en}/inbound-mail.ts`).
 */
import type { Locale } from './ui'

interface Section {
  /** The section's anchor, stable: links point at it. */
  id: string
  heading: string
  paragraphs: string[]
}

const de = {
  heading: 'E-Mails an ein Projekt',
  lede: 'Für Büros, die die Funktion freigeschaltet haben, hat jedes Projekt in Piloti eine eigene E-Mail-Adresse. Was dort ankommt, wartet im E-Mail-Eingang des Projekts, bis eine Person es ablegt.',
  sections: [
    {
      id: 'ablauf',
      heading: 'Was mit einer E-Mail geschieht',
      paragraphs: [
        'Eine E-Mail an die Adresse eines Projekts (etwa bauplatz-12.k3x7q2m9p4ab@piloti.at) wird nicht automatisch Teil des Projekts. Sie wartet bis zu 30 Tage im E-Mail-Eingang. Eine Person im Büro, die Unterlagen in das Projekt ablegen darf, entscheidet über jeden Teil: den Text der E-Mail und jeden Anhang.',
        'Der Text kommt in den E-Mail-Verlauf des Gesprächs: ein Dokument je Konversation, in dem jede abgelegte E-Mail ein Abschnitt ist. Anhänge kommen in die Ordner des Projekts. Was niemand ablegt, wird verworfen oder läuft ab und wird gelöscht.',
        'Piloti verschickt keine Antworten und keine Eingangsbestätigungen.',
      ],
    },
    {
      id: 'zweck',
      heading: 'Wofür die Adresse da ist',
      paragraphs: [
        'Setzen Sie die Adresse des Projekts in Cc, wenn Sie an Behörde, Statik oder Bauherrschaft schreiben: die Antworten landen im E-Mail-Eingang des Projekts. Unterlagen aus Ihrem Mailprogramm können Sie an sie weiterleiten. Abgelegt wird nichts, bevor jemand es bestätigt.',
        'Sie finden die Adresse auf der Projektübersicht, unter „Adresse“ im E-Mail-Eingang, unter „Per E-Mail senden …“ beim Hochladen und in den Projekteinstellungen unter Dokumente.',
      ],
    },
    {
      id: 'bereit',
      heading: 'Bereit und Braucht Sie',
      paragraphs: [
        'Im E-Mail-Eingang stehen die wartenden E-Mails unter zwei Überschriften. „Bereit“ heißt: die Domain des Absenders ist bestätigt, für jeden Teil ist ein Ziel vorgeschlagen, und nichts ist zu prüfen. Ein Klick auf „Wie vorgeschlagen ablegen“ legt eine solche E-Mail ab; „Alle … ablegen“ legt mehrere ab und fragt vorher nach.',
        'Unter „Braucht Sie“ steht bei jeder E-Mail, was noch fehlt: „Absender prüfen“, „Anhang prüfen“, „Anhang wird noch geprüft …“, „E-Mail-Verlauf wählen“, „Ordner wählen“ oder „Projekt ist abgeschlossen“.',
      ],
    },
    {
      id: 'nach-dem-ablegen',
      heading: 'Nach dem Ablegen',
      paragraphs: [
        'Bei jedem abgelegten Teil steht, wo er liegt und welche Fassung er geworden ist, etwa „Abgelegt in Behörde · Fassung 1“ oder „In E-Mail-Verlauf „Stellplatznachweis“ abgelegt · Fassung 4“. „Öffnen“ führt hin. Rückgängig machen lässt sich eine Ablage nicht.',
      ],
    },
    {
      id: 'folgen',
      heading: 'Einem E-Mail-Verlauf folgen',
      paragraphs: [
        'Wer einem E-Mail-Verlauf folgt, lässt den Text späterer Antworten von bestätigten Absendern ohne eigenen Klick anfügen; Anhänge warten weiter auf eine Person. Das Folgen endet nach höchstens 180 Tagen, wenn die Adresse des Projekts ersetzt wird, wenn eine E-Mail aus dem Verlauf herausgelöst wird, und wenn das Projekt abgeschlossen wird. Wird es wieder geöffnet, folgt niemand von selbst wieder.',
      ],
    },
    {
      id: 'sicherheit',
      heading: 'Prüfungen vor der Ablage',
      paragraphs: [
        'Jeder Anhang und jede E-Mail als Ganzes werden auf Schadsoftware geprüft, bevor jemand sie öffnen oder ablegen kann. Jede E-Mail zeigt, ob die Domain des Absenders sie signiert hat („Domain bestätigt“). Das belegt die Domain, nicht die Person.',
        'Solange eine E-Mail wartet, liest kein KI-Modell ihren Text oder ihre Anhänge. Für einen Ablagevorschlag sieht Piloti nur Dateinamen, den Betreff und die Domain des Absenders. Das Original der E-Mail (.eml) wird als Nachweis aufbewahrt und von keinem Modell gelesen.',
      ],
    },
    {
      id: 'abgewiesen',
      heading: 'Ihre E-Mail kam zurück',
      paragraphs: [
        'Eine E-Mail wird abgewiesen, wenn die Adresse nicht (mehr) existiert, das Büro die Funktion nicht nutzt oder die E-Mail größer als etwa 25 MB ist. Die Meldung nennt den Grund absichtlich nicht. Fragen Sie im Büro nach der aktuellen Adresse des Projekts; eine Adresse kann ersetzt worden sein.',
      ],
    },
    {
      id: 'dkim',
      heading: 'Domain bestätigt: E-Mails signieren (DKIM)',
      paragraphs: [
        'Piloti erkennt eine Domain als bestätigt, wenn sie die E-Mail mit DKIM signiert hat und die Signatur zur Absenderadresse passt. E-Mails Ihrer Kolleginnen und Kollegen, die Ihre Domain nicht signiert, brauchen vor dem Ablegen eine eigene Bestätigung, und Piloti schlägt für sie keinen E-Mail-Verlauf vor.',
        'Ob Ihre Domain signiert, sagt Ihnen, wer Ihre E-Mail betreut: Microsoft 365, Google Workspace und die meisten Anbieter bieten DKIM an und brauchen dafür einen Eintrag im DNS Ihrer Domain. Wer das Projekt verwaltet, sieht in den Projekteinstellungen unter Dokumente, wie viele E-Mails Ihres Büros der letzten 30 Tage bestätigt waren.',
      ],
    },
    {
      id: 'tipps',
      heading: 'Tipps',
      paragraphs: [
        'Setzen Sie die Adresse des Projekts in Cc oder Bcc, wenn Sie selbst schreiben: eine Kopie Ihrer eigenen, signierten E-Mail wird als „Ihre eigene E-Mail (Bcc)“ erkannt.',
        'Senden Sie keine Honorar-, Vertrags- oder Personalfragen an die Adresse des Projekts: Alle, die Unterlagen in das Projekt ablegen dürfen, sehen, was dort wartet.',
        'Ein Bescheid, der per E-Mail kommt, ist eine Kopie, keine Zustellung. Fristen laufen ab der Zustellung.',
      ],
    },
  ] satisfies Section[],
  privacyLink: 'Datenschutzerklärung',
}

const en: typeof de = {
  heading: 'Mail to a project',
  lede: 'For offices that have switched it on, every project in Piloti has its own e-mail address. What arrives there waits in the project until a person files it.',
  sections: [
    {
      id: 'ablauf',
      heading: 'What happens to a mail',
      paragraphs: [
        'A mail sent to a project’s address (such as bauplatz-12.k3x7q2m9p4ab@piloti.at) does not become part of the project by itself. It waits for up to 30 days. A person in the office who may add documents to the project decides on each part: the mail’s text and each attachment.',
        'The text goes into the conversation’s mail thread: one document per conversation, each filed mail a section of it. Attachments go into the project’s folders. What nobody files is dismissed or expires and is deleted.',
        'Piloti sends no replies and no receipts.',
      ],
    },
    {
      id: 'zweck',
      heading: 'What the address is for',
      paragraphs: [
        'Put the project’s address in Cc when you write to the authority, the structural engineer or the client: the replies land in the project’s mail. You can forward documents from your mail program to it. Nothing is filed before someone confirms it.',
        'You find the address on the project overview, under “Address” in the project’s mail, under “Send by mail …” when uploading, and in the project settings under Documents.',
      ],
    },
    {
      id: 'bereit',
      heading: 'Ready and Needs you',
      paragraphs: [
        'The waiting mails stand under two headings. “Ready” means the sender’s domain is verified, every part has a suggested place, and nothing needs checking. “File as suggested” files such a mail in one press; “File all …” files several and asks first.',
        'Under “Needs you” each mail says what it still needs: checking the sender or an attachment, an attachment still being scanned, choosing a mail thread or a folder, or a closed project.',
      ],
    },
    {
      id: 'nach-dem-ablegen',
      heading: 'After filing',
      paragraphs: [
        'Each filed part says where it went and which Fassung (version) it became, and “Open” takes you there. A filing cannot be undone.',
      ],
    },
    {
      id: 'folgen',
      heading: 'Following a mail thread',
      paragraphs: [
        'Whoever follows a mail thread lets the text of later replies from verified senders be added without a press of their own; attachments still wait for a person. Following ends after at most 180 days, when the project’s address is replaced, when a mail is detached from the thread, and when the project is closed. Reopening the project starts no follow again.',
      ],
    },
    {
      id: 'sicherheit',
      heading: 'Checks before filing',
      paragraphs: [
        'Every attachment and every mail as a whole is scanned for malware before anyone can open or file it. Each mail shows whether the sender’s domain signed it (“Domain verified”). That proves the domain, not the person.',
        'While a mail waits, no AI model reads its text or its attachments. For a filing suggestion Piloti sees only file names, the subject and the sender’s domain. The mail’s original (.eml) is kept as evidence and read by no model.',
      ],
    },
    {
      id: 'abgewiesen',
      heading: 'Your mail came back',
      paragraphs: [
        'A mail is refused when the address does not exist (any more), the office does not use the feature, or the mail is larger than about 25 MB. The message deliberately does not say which. Ask the office for the project’s current address; an address may have been replaced.',
      ],
    },
    {
      id: 'dkim',
      heading: 'Domain verified: signing your mail (DKIM)',
      paragraphs: [
        'Piloti treats a domain as verified when it signed the mail with DKIM and the signature matches the sender’s address. Mail from your colleagues that your domain does not sign needs its own confirmation before filing, and Piloti suggests no mail thread for it.',
        'Whoever runs your e-mail can tell you whether your domain signs: Microsoft 365, Google Workspace and most providers offer DKIM and need an entry in your domain’s DNS for it. Whoever manages the project sees in the project settings under Documents how much of your office’s mail of the last 30 days was verified.',
      ],
    },
    {
      id: 'tipps',
      heading: 'Tips',
      paragraphs: [
        'Put the project’s address in Cc or Bcc when you write yourself: a copy of your own signed mail is recognised as “Your own mail (Bcc)”.',
        'Do not send fee, contract or personnel matters to the project’s address: everyone who may add documents to the project sees what waits there.',
        'A Bescheid that arrives by e-mail is a copy, not its formal delivery (Zustellung). Deadlines run from the Zustellung.',
      ],
    },
  ],
  privacyLink: 'Privacy policy',
}

export const projectMail: Record<Locale, typeof de> = { de, en }
