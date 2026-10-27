# Project mail: the E-Mail-Eingang and the E-Mail-Verläufe

Every project can have its own e-mail address. Put it in Cc when you write to
the Behörde, the Statiker or the Bauherr, or forward a mail to it, and the mail
lands in the project's **E-Mail-Eingang** in Dateien. There it waits until
someone files it: its text into the conversation's **E-Mail-Verlauf**, its
attachments into the project's folders, each as a new document or the next
Fassung of one.

**Nothing is filed automatically**, except the text of an E-Mail-Verlauf you
chose to follow. Piloti reads a mail only once it is filed.

Project mail is switched on per office. If you do not see „E-Mail-Eingang“ in
Dateien, your office does not have it yet.

---

## The project's address

The address looks like `bauplatz-12.k3x7q2m9p4ab@piloti.at`: the project's
name and a random part. Find it in Dateien under the upload menu, **Per E-Mail
senden …**, with **Kopieren** and **Als Kontakt sichern** (a contact card for
your mail program).

- Whoever manages the project creates the address, in the dialog or under
  **Einstellungen › Dokumente**. Until then the dialog says the project has
  none.
- Anyone who knows the address can send mail to it. That is the point: when
  the project is in Cc, the Statiker's reply-all arrives too. It is also why
  nothing that arrives goes into the project by itself.
- A leaked address is replaced with **Neue Adresse erzeugen …**. The old
  address stops working at once (mail to it bounces), and everyone who follows
  an E-Mail-Verlauf of the project stops following it. Give the new address to
  everyone who sends documents to the project.
- **Ausschalten …** switches the address off. Mail already waiting stays.

Do not send fee, contract or personnel mail to the project address: everyone
who may add documents to the project sees what waits there.

## Who sees the E-Mail-Eingang

Everyone who may add documents to the project sees the E-Mail-Eingang and may
file or dismiss what waits there. Where a file goes still depends on the
folder: you can only file into folders you may write in. Suggestions never name
a folder you cannot see.

You are told in the **Postfach** when mail waits: „2 E-Mails an Bauplatz 12
warten auf Ablage“. The notice never shows a sender, a subject or a file name.
When you sent the mail yourself, from your office address, the notice and the
outcome come to you; otherwise to the people who manage the project.

## What a mail shows

Each mail says whether its sender's domain confirmed it:

| Label | Meaning |
|---|---|
| **Domain bestätigt: statik-weber.at** | The sender's domain signed the mail (DKIM). This proves the domain, not the person who wrote it |
| **Domain nicht bestätigt** | The domain did not sign it. Piloti makes no suggestion, and no E-Mail-Verlauf is pre-selected |
| **Mitglied · Domain nicht bestätigt** | The address is a colleague's, but your domain did not sign it. You confirm before filing |
| **Ihre eigene E-Mail (Bcc)** | A copy of a mail you sent to others, with the project in Bcc |
| **Gibt sich als … aus** | The signature was rejected, or a colleague's name appears on an address that is not theirs |

**A mail that poses as someone is a stop.** It opens behind a warning, „Verwerfen“
is the first button, nothing is pre-selected, Piloti suggests nothing, and it
can never be filed together with other mails. This is how payment-change fraud
starts: check any change of bank details by phone, never by replying.

Other lines you may see: „An andere Empfänger adressiert“ (the project was not
among the signed recipients), „Datum liegt mehr als 7 Tage vor dem Eingang“,
„Liegt schon in einem E-Mail-Verlauf“ (this mail's text is filed already), and
„Ursprünglich von … · nicht geprüft“ for a forwarded mail, read from the
forwarded text and checked by nobody.

The mail's text is shown as plain text: links are not opened, and nothing from
outside is loaded. Long text folds; „Zitierten Text anzeigen“ shows what the
sender quoted.

## Filing a mail

Open a mail and decide each part:

- **The mail's text** („E-Mail-Text“) goes into an E-Mail-Verlauf: „In
  E-Mail-Verlauf „Stellplatznachweis“ ablegen (wird Fassung 4)“ when the mail
  answers a conversation the project already has, or „Als neuen E-Mail-Verlauf
  ablegen“ with a name you confirm. Leave the text unchecked to file only the
  attachments; the original of the mail is then deleted after filing, and the
  decision bar says so.
- **Each attachment** goes into a folder, under a name and a Dokumentart, or as
  the next Fassung of a document the project already has („wird Fassung 3 von
  S-101_B.pdf“). „Liegt schon im Projekt: …“ means the same file is already
  there; it is unchecked.
- The button says what happens: „2 Dateien und den E-Mail-Text ablegen“.
  „Verwerfen“ dismisses the whole mail.

Filing is an ordinary upload in your name: the office's name check, content
check, accepted file types, storage quota and folder rights apply. It is
quiet: no upload summary and no „Neue Fassung“ notice per reply. A filed
document is published with you as the person who approved it, like any upload;
its preview says which mail it came with.

**When something needs your confirmation.** A colleague's address without your
domain's signature, a mail not addressed to the project, an old date, a file
with macros or a name that does not match its content, and a thread match the
sender's signature does not cover each need a tick before filing. These mails
are filed one at a time, never in a group.

**When the content check finds something in the text** (an IBAN, a social
security number, one of your office's terms), you choose how the text is filed:
„Unkenntlich ablegen“ (the default: the findings are masked in the
E-Mail-Verlauf, the original stays unchanged), „Als eigenen E-Mail-Verlauf
ablegen“, or „Ungekürzt in den E-Mail-Verlauf“, which holds the whole Verlauf
until someone checks it.

**When the name check stops a file name**, the attachment is unchecked with
„Namensprüfung: „…““ and you may file it anyway with „Trotzdem ablegen“. The
override is recorded.

**Several mails at once.** Select mails (or press X) and use „Wie vorgeschlagen
ablegen“: it files every selected mail as its defaults and Piloti's suggestions
say, after a confirmation grouped by destination. It is offered only when every
selected mail is complete: nothing to confirm, a folder for every attachment.
Mails of one conversation are grouped: „4 E-Mails in E-Mail-Verlauf „…“
ablegen (wird Fassung 4–7)“.

## Dismissing, expiring, restoring

- „Verwerfen“ dismisses a mail. It can be restored for **7 days** under
  „Bearbeitet › Verworfen“, then it is deleted. A dismissed mail from an
  unconfirmed domain is deleted at once.
- A mail nobody decides **expires after 30 days**. You are told five days
  before. An expired mail can still be restored for 7 days.
- A closed project still receives mail and shows „Projekt ist abgeschlossen –
  wieder öffnen, um abzulegen“. Dismissing is possible; reopen the project to
  file.

## Malware checks

Every attachment, and every mail as a whole, is checked for malware on
Piloti's own servers before anyone can file or open it: „Auf Schadsoftware
geprüft“. An infected attachment („Schadsoftware gefunden“) cannot be filed;
the mail can only be dismissed. A check that failed is repeated by itself.
Previews before filing are drawn for images and PDFs only; other files show
their icon until filed.

## Files the office does not accept

A file type your office does not file (a DWG, a ZIP archive, an Outlook
attachment) is listed as „… · Dateityp wird in diesem Büro nicht abgelegt · im
Original enthalten“. It cannot be filed, but it stays inside the mail's
original when you file the text.

## Piloti's suggestion

For a mail from a confirmed domain, Piloti suggests a folder and a Dokumentart
for each attachment („Vorschlag von Piloti“), and a folder for a new
E-Mail-Verlauf. It reads only the file names, the subject (masked by your
office's content check) and the sender's domain, never the text or the files.
There is no suggestion for unconfirmed or automatic mail.

## The E-Mail-Verlauf

A filed conversation is one document of Dokumentart *Korrespondenz*. Each
filed e-mail is a section headed with its time, its sender and the confirmed
domain („14.10.2026 09:12 · Mag. Huber (ma37.wien.gv.at)“), or „Domain nicht
bestätigt“ when it was not confirmed. Each section says when it arrived
(„eingegangen …“). Each later e-mail adds a Fassung, and the newest Fassung
holds the whole conversation. Piloti answers from it and cites one e-mail:
„laut E-Mail von … vom …“.

A Bescheid that arrived by e-mail is a **copy** („Kopie per E-Mail“), not its
Zustellung. Fristen run from the Zustellung.

Open the Verlauf in Dateien and choose the **E-Mails** tab in its preview:

- one row per e-mail, newest first, with „ab Fassung N“, when it arrived, the
  domain label and how it was filed;
- its attachments, each linked to the document it became, or „nicht abgelegt“
  with the reason;
- **Original (.eml)**: the mail exactly as it arrived (below);
- **Vergleichen**: this e-mail's Fassung against the one before;
- **Herauslösen …**: move an e-mail filed into the wrong conversation into
  another Verlauf or a new one. The Verlauf gets a new Fassung without it; its
  earlier Fassungen keep it.

A file that came by e-mail shows under its preview header which e-mail it
came with, and „Im E-Mail-Verlauf ansehen“ leads there.

## The original (.eml)

Piloti keeps every filed e-mail exactly as it arrived, beside its section, as
evidence: the signature can be checked again on these bytes, and pictures in
the text and files that could not be filed are in it. Whoever may read the
E-Mail-Verlauf may download it. It is checked for malware again on every
download, and refused if it is not clean. It opens in your mail program, which
may load pictures from outside. No AI model ever reads it. It is kept as long
as the E-Mail-Verlauf.

## Following an E-Mail-Verlauf

After filing, or in the E-Mails tab, „Diesem E-Mail-Verlauf folgen“ makes
later replies' **text** join the Verlauf without a click, in your name. It
applies only to replies from confirmed domains that already write in the
conversation, whose reference to it is signed, with nobody new in it, and with
nothing the name or content check would stop. Everything else waits as usual.
**Attachments always wait** in the E-Mail-Eingang.

- A follow runs 60 days; „Verlängern“ extends it, up to 180 days from its
  start. You are told five days before it ends.
- „Nicht mehr folgen“ ends it. Whoever manages the project can end anyone's
  follow („Beenden“ under „Wer folgt“).
- It also ends when you lose access to the project or the Verlauf's folder,
  when the project's address is replaced, when an e-mail is herausgelöst from
  that Verlauf, or when the Verlauf is deleted.
- The Postfach tells you, once a day per Verlauf, when replies were added („Eine Antwort wurde einem E-Mail-Verlauf in … angefügt“).

## Tips

- **Bcc the project on your own mail.** A copy of a mail you sent, signed by
  your domain, is recognised as „Ihre eigene E-Mail (Bcc)“ and needs no extra
  confirmation.
- **Let your domain sign its mail.** The address dialog shows how much of your
  office's own mail was „Domain bestätigt“ in the last 30 days. Unsigned mail
  from colleagues needs a confirmation each time; ask whoever runs your mail
  to enable DKIM (the „so richten Sie es ein“ link in the dialog).
- Large plan sets do not fit: a mail may be at most about 25 MB.

## Outlook archives

An Outlook archive you import (Dateien › Outlook-Archiv importieren) files its
e-mails' text into the same E-Mail-Verläufe, and skips any e-mail the project
already has. Importing is your decision, so an archive does not wait in the
E-Mail-Eingang. Its sections say „aus dem Outlook-Archiv“ and have no
original.

## For agents

Everything here is also an operation of Piloti's agent door, in the `mail`
domain: an outside agent acting for you can list and read waiting mail and
file it, but only on your own yes, and it never gets an original. Piloti
proposes a filing as a card you accept. See
[Connect your agent](connect-your-agent.md).
