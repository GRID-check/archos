/**
 * Product feedback: the form any member opens from the shell, and Platform →
 * Feedback where the platform owners triage what arrives. Not the thumbs on an
 * answer — those live under `chat`.
 */
export const feedback = {
  open: 'Send feedback',
  openHint: 'Report a bug or share an idea',
  dialog: {
    title: 'Tell us what you think',
    description:
      'Your message goes straight to the people who build {productName}. Every report is read.',
    kindLabel: 'What is it about?',
    messageLabel: 'Your message',
    counter: '{count} / {max}',
    tooShort: 'A few more words, please — at least {min} characters.',
    context: {
      summary: 'Sent along automatically',
      page: 'Page',
      browser: 'Browser',
      screen: 'Screen',
      locale: 'Language',
      timeZone: 'Time zone',
      none: '—',
    },
    allowContact: 'You may contact me about this',
    allowContactHint: 'We reply to {email} if we have a question or news.',
    cancel: 'Cancel',
    send: 'Send feedback',
    sending: 'Sending…',
    shortcut: 'to send',
    error: 'Your feedback could not be sent. Please try again.',
    rateLimited: 'You have sent a lot of feedback in the last hour. Please try again later.',
  },
  kinds: {
    bug: {
      label: 'Bug',
      hint: 'Something is broken',
      placeholder: 'What did you do, what happened, and what did you expect instead?',
    },
    idea: {
      label: 'Idea',
      hint: 'Something is missing',
      placeholder: 'What would make your work easier? Describe the situation you are in.',
    },
    praise: {
      label: 'Praise',
      hint: 'Something works well',
      placeholder: 'What do you like? We love to hear it.',
    },
    question: {
      label: 'Question',
      hint: 'Something is unclear',
      placeholder: 'What would you like to know?',
    },
  },
  /** PostHog Support's ticket statuses, verbatim keys. */
  statuses: {
    new: 'New',
    open: 'Open',
    pending: 'Pending',
    on_hold: 'On hold',
    resolved: 'Resolved',
  },
  /** The reporter's own threads: what they sent and what the team answered. */
  threads: {
    open: 'My feedback',
    title: 'My feedback',
    description: 'What you reported and what the {productName} team answered. You can reply right here.',
    newCount: '{count} new',
    empty: {
      title: 'No feedback yet',
      description: 'When you send feedback, your chat with the team shows up here.',
    },
    send: 'Send feedback',
    /** Opens the form inside „My feedback”. */
    new: 'New feedback',
    /** Beside the list, while no case is open. */
    pick: {
      title: 'Pick a report',
      description: 'Choose a report on the left to read the chat with the team, or send new feedback.',
    },
    /** In the thread of a report sent a moment ago. */
    sent: 'Thank you! Your feedback has reached the {productName} team. You will see their answer here.',
    loadError: 'Your feedback could not be loaded.',
    threadLoadError: 'This chat could not be loaded.',
    retry: 'Try again',
    loadMore: 'Load more',
    loadingMore: 'Loading …',
    loadMoreFailed: 'Could not load more. Try again',
    back: 'All feedback',
    hasUpdate: 'New',
    me: 'You',
    team: '{productName} team',
    teamMember: '{name}, {productName} team',
    notLive: 'The team’s replies cannot be loaded right now. Your report is safe and has been received.',
    cannotReply: 'Replies to this report are not possible here. Send new feedback to continue the chat.',
    waiting: 'The team has not replied yet. You will see their answer here.',
    replyPlaceholder: 'Write a reply …',
    replySend: 'Send',
    replyError: 'Your reply could not be sent. Please try again.',
    replyRateLimited: 'You have sent a lot of replies in the last hour. Please try again later.',
    /** The dot on the avatar and on “More”, for screen readers. */
    newsDot: 'New replies on your feedback',
    /** The switch above the list, for office admins only. */
    scopeLabel: 'View',
    scope: {
      mine: 'Mine',
      office: 'Our office',
    },
    officeTitle: 'Our office’s feedback',
    officeDescription: 'Every report from your office and where it stands. Only the person who reported can reply.',
    officeEmpty: {
      title: 'No feedback from your office yet',
      description: 'When anyone in your office sends feedback, it shows up here.',
    },
    officeLoadError: 'Your office’s feedback could not be loaded.',
    /** The list's two groups: open cases first. */
    groups: {
      active: 'Active',
      done: 'Done',
    },
    /** The number the team files the case under. */
    ticketNumber: '#{number}',
    /** Before a relative time: “Updated 3 hours ago”. */
    updated: 'Updated',
    unknownReporter: 'Unknown member',
    readOnly: 'Only {name} can reply to this report.',
    readOnlyUnnamed: 'Only the person who reported this can reply here.',
    /** Where a case stands, in plain words, for the person who reported it. */
    statuses: {
      new: 'Received',
      open: 'In progress',
      pending: 'Waiting for you',
      on_hold: 'On hold',
      resolved: 'Resolved',
      /** Without a readable ticket: sent, no state known. */
      unknown: 'Sent',
    },
    /** The same state in the office view, where “you” would be the wrong person. */
    officeStatuses: {
      pending: 'Waiting for the reporter',
    },
  },
  platform: {
    filters: {
      label: 'Filter by status',
      active: 'Active',
      all: 'All',
      kindLabel: 'Kind',
      allKinds: 'All kinds',
      assigneeLabel: 'Filter by assignee',
      assignees: {
        all: 'Everyone',
        mine: 'Mine',
        unassigned: 'Unassigned',
      },
    },
    case: {
      unassigned: 'Unassigned',
      assignedToYou: 'Assigned to you',
      assignedTo: 'With {name}',
      unnamedAssignee: 'someone on the team',
      lastActivity: 'Last activity',
      awaiting: {
        team: 'We owe an answer',
        reporter: 'Waiting on the reporter',
      },
      claim: 'Take it',
    },
    viewerNotInPosthog: {
      title: 'Nothing is assigned to you in PostHog.',
      description:
        'Nobody in PostHog has your {productName} email. Sign in to PostHog with the same address and your tickets show up here.',
    },
    openInPosthog: 'Open in PostHog',
    empty: {
      title: 'No feedback here',
      description: 'When a member sends feedback, it shows up here and in your inbox.',
    },
    loadError: 'Feedback could not be loaded.',
    retry: 'Try again',
    loadMore: 'Load more',
    from: '{name} · {organization}',
    unknownReporter: 'Unknown member',
    unknownOrganization: 'Unknown organization',
    onPage: 'on {page}',
    contact: 'Reply by email',
    noContact: 'Does not want to be contacted',
    claimed: 'Ticket #{number} is now assigned to you in PostHog.',
    claimedUnnumbered: 'The ticket is now assigned to you in PostHog.',
    claimError: 'The ticket could not be assigned to you. Is your {productName} email also your PostHog login?',
    statusLabel: 'Status',
    triaged: 'Moved to “{status}”.',
    triageError: 'The status could not be changed.',
    details: 'Browser details',
    listTitle: 'Reports',
    linked: 'From your inbox',
    recordingsLink: 'Recordings in PostHog',
    localSource: {
      title: 'PostHog Support cannot be read right now.',
      description:
        'Either it is not configured here or PostHog is not reachable. This is the local log of every report, newest first; statuses are managed in PostHog.',
    },
    unticketed: {
      title: 'Not in PostHog yet',
      description: 'No ticket could be opened for these reports. They are kept here so none is lost.',
    },
    focusMissing: {
      title: 'The linked report was not found.',
      description: 'It was deleted or is not visible to you. The other reports are listed below.',
    },
  },
}
