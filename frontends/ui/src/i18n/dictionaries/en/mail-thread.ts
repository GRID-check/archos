/**
 * mailThread namespace: the E-Mail-Verlauf, one conversation filed as one
 * document (ADR-0137). The „Mails“ tab, following and detaching (D16) add to
 * it; the closed code lists of `lib/mail-thread` are worded here so every
 * surface says them the same way.
 *
 * The rendition's own words (section headings, „received …“, „quoted in the
 * mail of …“) are NOT here: they live in `lib/mail-thread/render-copy.ts`,
 * versioned, because changing them would rewrite every thread's sections.
 */
export const mailThread = {
  /** Why a reply's text waited although someone follows the mail thread (`FOLLOW_INELIGIBILITY_REASONS`). */
  followIneligible: {
    no_active_follow: 'Nobody follows this mail thread',
    sender_not_verified: 'The sender’s domain is not verified',
    match_not_reference: 'The mail does not refer to a mail of this mail thread',
    header_not_signed: 'The reference to the mail thread is not signed by the domain',
    flagged: 'The mail is addressed to others, or its date is not plausible',
    automatic: 'The mail was sent automatically',
    new_participant_domain: 'New participants: {domains}',
    recipients_unchecked: 'The mail has more recipients than can be checked',
    name_stop: 'The name check stopped the subject',
    content_finding: 'The content check found something in the text',
  },
  /** Why a follow ended (`MAIL_THREAD_FOLLOW_END_REASONS`). */
  followEnd: {
    unfollowed: 'You stopped following',
    expired: 'The follow ran out',
    access_lost: 'Access to the mail thread was lost',
    address_rotated: 'The project mail address was replaced',
    detached: 'A mail was detached from the mail thread',
    document_gone: 'The mail thread was deleted',
    revoked_by_manager: 'Ended by a project manager',
    project_closed: 'The project was closed',
  },

  /** The „E-Mails“ tab of a thread document's preview (D16). */
  tab: {
    label: 'Mails',
    views: 'View',
    timeline: 'Mails in this mail thread',
    count: '{count, plural, one {# mail} other {# mails}}',
    loadFailed: 'The mails of this mail thread could not be loaded.',
    retry: 'Try again',
    empty: 'This mail thread holds no mail you may see.',
    waiting: '{count, plural, one {# mail of this mail thread waits} other {# mails of this mail thread wait}} in Project mail',
    waitingOpen: 'View',
  },
  /** One filed mail in the tab. */
  entry: {
    fromRevision: 'from revision {number}',
    received: 'received {time}',
    trust: {
      verified: 'Domain verified: {domain}',
      verifiedNoDomain: 'Domain verified',
      unverified: 'Domain not verified',
      notChecked: 'From the mail archive · not checked',
    },
    /** How it was filed, said only where it is not a person deciding in the app. */
    filedVia: {
      agent: 'Filed by an agent on a person’s behalf',
      piloti_proposal: 'Filed on Piloti’s suggestion',
      follow: 'Added because someone follows this mail thread',
      archive_import: 'Taken over from the mail archive',
    },
    compare: 'Compare',
    compareLabel: 'Compare revision {from} with revision {to}',
    comparing: 'Comparing …',
    compareFailed: 'The comparison did not work.',
    compareClose: 'Close the comparison',
    menu: 'More for the mail of {heading}',
    detach: 'Detach …',
  },
  /** What came with a mail (D36). */
  attachments: {
    label: 'Attachments',
    hidden: 'An attachment in a folder you cannot see',
    unnamed: 'Attachment {position}',
    alreadyPresent: 'was already in the project',
    notFiled: 'not filed · {reason}',
    inOriginal: 'kept in the original',
    reasons: {
      pending: 'waits in Project mail',
      dismissed: 'dismissed',
      expired: 'expired',
      infected: 'contains malware',
      scan_failed: 'the malware check failed',
      type_not_accepted: 'this office does not file this file type',
      encrypted: 'encrypted',
      archive: 'archive file, not unpacked',
      size: 'too large',
      limit: 'too many attachments',
      empty: 'empty',
      screened: 'held by the content check',
      access: 'no access to the folder',
      name_taken: 'the name was taken',
      unreadable: 'not readable',
    },
  },
  /** The original `.eml` of one filed mail, kept as evidence. */
  original: {
    download: 'Original (.eml)',
    downloading: 'Checking …',
    hint: 'Opens in a mail program, which loads images from outside.',
    notClean: 'The original contains malware and cannot be downloaded',
    scanning: 'The original is being checked for malware',
    gone: 'No original: taken over from the mail archive',
    failed: 'The download did not work. Try again.',
  },
  /** „Verlauf folgen“ in the tab: the viewer's own follow, and for managers everybody's. */
  follow: {
    offer: 'Follow this mail thread',
    start: 'Follow',
    explain:
      'Replies from verified domains already writing in the mail thread are added without a click. Attachments keep waiting in Project mail.',
    following: 'You follow this mail thread until {date}',
    followingUndated: 'You follow this mail thread',
    renew: 'Renew',
    renewLabel: 'Renew following until {date}',
    renewLimit: 'A follow lasts at most 180 days from its start. Follow again after it ends.',
    unfollow: 'Stop following',
    followed: 'You follow “{name}” until {date}',
    renewed: 'Renewed until {date}',
    unfollowed: 'You no longer follow “{name}”',
    undo: 'Undo',
    others: '{count, plural, one {# other person follows} other {# other people follow}}',
    followers: 'Who follows',
    follower: 'until {date}',
    someone: 'A project member',
    end: 'End',
    endLabel: 'End the follow of {name}',
    ended: 'Ended the follow of {name}',
    failed: 'That did not work. Try again.',
    closed: 'The project is closed. Reopen it to follow.',
  },
  /** „Herauslösen …“: a mail filed into the wrong mail thread (D34). */
  detach: {
    title: 'Detach this mail?',
    description: 'The mail of {heading} moves into another mail thread.',
    keeps: 'Revisions {first} to {last} keep this mail. This mail thread gets revision {next} without it.',
    keepsOne: 'Revision {first} keeps this mail. This mail thread gets revision {next} without it.',
    followsEnd: 'Whoever follows this mail thread stops following it.',
    target: 'Where to',
    toExisting: 'Into another mail thread',
    existing: 'Mail thread',
    choose: 'Choose a mail thread',
    noOther: 'The project has no other mail thread you can see.',
    loadingTargets: 'Loading the mail threads …',
    toNew: 'As a new mail thread',
    name: 'Name',
    nameHint: 'In the same folder as this mail thread.',
    confirm: 'Detach',
    cancel: 'Cancel',
    done: 'Mail moved into “{name}”',
    doneNew: 'Mail moved into a new mail thread',
    followsEnded: '{count, plural, one {# follow ended} other {# follows ended}}',
    open: 'Open',
  },
  /** Why a write on a mail thread was refused (`MAIL_THREAD_REFUSALS`, and a follow in a closed project). */
  refusals: {
    last_entry: 'This is the only mail of the mail thread. Delete the document instead.',
    busy: 'A mail is being filed into this mail thread right now. Try again in a moment.',
    target_unknown: 'The chosen mail thread or folder is gone, or you may not file there.',
    thread_full: 'The chosen mail thread is full.',
    name_stop: 'The name check stopped this name. Choose another one.',
    name_taken: 'A document of this name is already in the project.',
    upload_refused: 'The new revision could not be uploaded.',
    gone: 'The mail is gone.',
    original_not_clean: 'The original did not pass the malware check and cannot be downloaded.',
    project_closed: 'The project is closed. Reopen it first.',
    unknown: 'That did not work. Try again.',
  },
  /** Where a Fassung came from (D36): the header row of a document a mail brought, and a row of its timeline. */
  provenance: {
    label: 'Origin',
    cameWith: 'Came with the mail from {name} on {date}',
    cameWithAnonymous: 'Came with a mail on {date}',
    open: 'View in the mail thread',
    openLabel: 'View the mail from {date} in its mail thread',
    openFailed: 'The mail thread cannot be opened. You may no longer see it.',
    more: '+{count} more',
  },
}
